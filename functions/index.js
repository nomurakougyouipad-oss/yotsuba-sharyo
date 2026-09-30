// 社用車管理アプリ（yotsuba-sharyo）プッシュ通知
// 1. 車検：満了日まで shakenAlertDays 日以内になったら、朝8時に1回
// 2. 返却予定日：予約の to の日の17時、まだ返却されていなければ（使う人本人だけ）
// 3. 返却遅れ：to の翌日の朝9時、まだ返却されていなければ（使う人本人だけ）
// 4. 修理依頼：repairs に新しく登録されたとき、すぐ
//
// 届く人 = PCの設定（settings/notify）でオン かつ 本人がスマホでオフにしていない（notifyPrefs）かつ 通知を許可した端末がある（pushTokens）
// 同じ通知が2回届かないよう、notifyLog/{通知のキー} に送った人を残す
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated } = require("firebase-functions/v2/firestore");
const { setGlobalOptions, logger } = require("firebase-functions/v2");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "us-central1", maxInstances: 2 }); // Firestore（nam5）と同じ米国
const TZ = "Asia/Tokyo";

/* ---------- 日付（日本時間） ---------- */
const ymdJst = d => new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(d); // "2026-10-01"
const addDays = (s, n) => { const [y, m, d] = s.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const daysBetween = (a, b) => { const p = s => { const [y, m, d] = s.split("-").map(Number); return Date.UTC(y, m - 1, d); }; return Math.round((p(b) - p(a)) / 86400000); };

/* ---------- 車の表示 ---------- */
const plate = v => [v.plateArea, v.plateClass, v.plateKana, v.plateNum].filter(Boolean).join(" ");
const carText = v => `${v.kind || ""} ${plate(v)}`.trim();

/* ---------- 誰に届けるか ---------- */
// PC のオン・本人のオフ・名前ごとの端末（通知トークン）をまとめて読む
async function loadAudience() {
  const [cfg, prefs, tokens] = await Promise.all([
    db.doc("settings/notify").get(),
    db.collection("notifyPrefs").get(),
    db.collection("pushTokens").get(),
  ]);
  const off = new Map(prefs.docs.map(d => [d.get("name"), new Set(d.get("off") || [])]));
  const byName = new Map();
  tokens.forEach(d => { const n = d.get("name"); if (!n) return; if (!byName.has(n)) byName.set(n, []); byName.get(n).push(d.id); });
  const on = type => new Set(cfg.exists ? cfg.get(type) || [] : []);
  return {
    // この通知が届く人（端末がある人だけ）。only を渡すとその人たちの中から
    names(type, only) {
      const list = only ? only.filter(Boolean) : [...on(type)];
      const onSet = on(type);
      return [...new Set(list)].filter(n => onSet.has(n) && !(off.get(n) || new Set()).has(type) && byName.has(n));
    },
    tokensOf: names => names.flatMap(n => byName.get(n) || []),
  };
}

// まだ送っていない人だけを選んで「送った」と記録する（2回届かないように）
async function claim(key, names, info) {
  if (!names.length) return [];
  const ref = db.collection("notifyLog").doc(key);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref);
    const sent = new Set(s.exists ? s.get("sentTo") || [] : []);
    const fresh = names.filter(n => !sent.has(n));
    if (fresh.length) tx.set(ref, { ...info, sentTo: [...sent, ...fresh], updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return fresh;
  });
}

// 無効になった端末（アプリを消した・許可を取り消した など）
const DEAD = new Set(["messaging/registration-token-not-registered", "messaging/invalid-registration-token"]);

async function send(tokens, { title, body, tag }) {
  if (!tokens.length) return;
  for (let i = 0; i < tokens.length; i += 500) {
    const chunk = tokens.slice(i, i + 500);
    // data だけで送り、表示は sw.js が行う（iPhone でも同じ動きにするため）
    const res = await getMessaging().sendEachForMulticast({
      tokens: chunk,
      data: { title, body, tag, url: "./" },
      webpush: { headers: { Urgency: "high", TTL: String(24 * 3600) } },
    });
    const dead = [];
    res.responses.forEach((r, j) => {
      if (r.success) return;
      if (DEAD.has(r.error && r.error.code)) dead.push(chunk[j]);
      else logger.warn("送れませんでした", r.error && r.error.code, r.error && r.error.message);
    });
    await Promise.all(dead.map(t => db.collection("pushTokens").doc(t).delete().catch(() => {})));
    logger.info(`通知「${title}」${res.successCount}件送信、無効な端末 ${dead.length}件を削除`);
  }
}

// 届ける人を選んで、記録して、送る
async function notify(aud, key, names, msg, info) {
  const fresh = await claim(key, names, { ...info, title: msg.title });
  if (fresh.length) await send(aud.tokensOf(fresh), { ...msg, tag: key });
}

/* ---------- 1. 車検（毎朝8時） ---------- */
exports.shakenMorning = onSchedule({ schedule: "0 8 * * *", timeZone: TZ }, async () => {
  const today = ymdJst(new Date());
  const [app, cars, aud] = await Promise.all([db.doc("settings/app").get(), db.collection("vehicles").get(), loadAudience()]);
  const alert = Number(app.exists && app.get("shakenAlertDays")) || 30;
  const names = aud.names("shaken");
  if (!names.length) return;
  for (const c of cars.docs) {
    const v = c.data();
    if (v.retired || v.hidden || v.sample || !v.shakenDate) continue;
    const d = daysBetween(today, v.shakenDate);
    if (d < 0 || d > alert) continue;
    // 満了日ごとに1回（車検を受けて満了日が変われば、次の満了日でまた届く）
    await notify(aud, `shaken_${c.id}_${v.shakenDate}`, names,
      { title: d === 0 ? "🔔 車検は今日までです" : `🔔 車検まであと${d}日`, body: carText(v) },
      { type: "shaken", vehicleId: c.id });
  }
});

/* ---------- 2・3. 返却予定日（17時）・返却遅れ（翌朝9時） ---------- */
async function returnReminder(type, toDate, title) {
  const [snap, aud] = await Promise.all([
    db.collection("reservations").where("to", "==", toDate).where("returnedAt", "==", null).get(),
    loadAudience(),
  ]);
  for (const r of snap.docs) {
    const x = r.data();
    if (x.canceled || x.sample) continue;
    const car = await db.doc(`vehicles/${x.vehicleId}`).get();
    if (!car.exists || car.get("retired")) continue;
    await notify(aud, `${type}_${r.id}`, aud.names(type, [x.who]), { title, body: carText(car.data()) },
      { type, reservationId: r.id });
  }
}
exports.returnDueEvening = onSchedule({ schedule: "0 17 * * *", timeZone: TZ }, async () => {
  await returnReminder("due", ymdJst(new Date()), "今日が返却予定日です");
});
exports.returnOverdueMorning = onSchedule({ schedule: "0 9 * * *", timeZone: TZ }, async () => {
  await returnReminder("overdue", addDays(ymdJst(new Date()), -1), "返却予定を過ぎています");
});

/* ---------- 4. 修理依頼（登録されたらすぐ） ---------- */
exports.repairCreated = onDocumentCreated("repairs/{id}", async e => {
  const x = e.data && e.data.data();
  if (!x || x.sample) return;
  const [car, aud] = await Promise.all([db.doc(`vehicles/${x.vehicleId}`).get(), loadAudience()]);
  const what = [(x.symptoms || []).join("・"), x.memo].filter(Boolean).join("：");
  const short = what.length > 40 ? what.slice(0, 40) + "…" : what;
  // 頼んだ本人には送らない
  const names = aud.names("repair").filter(n => n !== x.reportedBy);
  await notify(aud, `repair_${e.params.id}`, names,
    { title: "🔧 修理依頼が来ました", body: [car.exists ? carText(car.data()) : "", short].filter(Boolean).join("　") },
    { type: "repair", repairId: e.params.id });
});
