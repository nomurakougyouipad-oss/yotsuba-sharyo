// 使い始め（版26）の決まり（index.js の startReminder・startCheck から使う）
// Firebase を使わない形にしてあるので、本物のデータにさわらずに試せる（node functions/starts.test.js）
//   8:30 startReminder：今日始まる予約で、まだ「使い始める」を押していない → 予約した本人へお知らせ
//   9:00 startCheck  ：始まる日が今日まで・まだ押していない・その日の 9:00 より前に入れた予約 → 取り消しの印を付けて残す（車は空きに戻る）
// 版25までに入れた予約（needStart がない）は、今までどおり予約の日になったら使用中（お知らせも取り消しもしない）
const START_HOUR = 9;

// 「使い始める」が要る予約で、まだ押していない
const needsStart = r => !!r && r.needStart === true && !r.startedAt;
// 取り消し・返却・サンプルではない
const isOpen = r => !r.canceled && !r.returnedAt && !r.sample;
// 時刻（Firestore の Timestamp・Date・ミリ秒）を日本時間の { day: "2026-10-22", hour: 8 } に
function jst(t) {
  const ms = t && typeof t.toMillis === "function" ? t.toMillis() : t instanceof Date ? t.getTime() : typeof t === "number" ? t : null;
  if (ms == null) return null;
  const d = new Date(ms + 9 * 3600 * 1000);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

// 8:30 にお知らせする予約か（今日始まる予約だけ）
const shouldRemind = (r, today) => needsStart(r) && isOpen(r) && r.from === today;
// 9:00 に取り消す予約か
function shouldCancel(r, today) {
  if (!needsStart(r) || !isOpen(r) || !(r.from <= today)) return false;
  // その日の 9:00 より後に入れた予約は取り消さない（アプリがそのまま使用中にしている）
  const c = jst(r.createdAt);
  return !(c && c.day >= r.from && (c.day > r.from || c.hour >= START_HOUR));
}

// 「ハイエース（愛媛 300 あ 12-34）」の形（番号の前の「・」は外す）
const carName = v => `${v.kind || "車"}（${[v.plateArea, v.plateClass, v.plateKana, String(v.plateNum || "").replace(/^[・･·\s]+/, "")].filter(Boolean).join(" ")}）`;
const remindMsg = v => ({ title: "🚗 今日は予約の日です", body: `${carName(v)}：9時までに「使い始める」を押してください` });
const cancelMsg = (r, v) => ({ title: "予約を取り消しました（使い始めなし）", body: `${r.who}さんの${carName(v)}の予約を取り消しました` });
// 取り消しの印（canceledAt はサーバーの時刻を index.js で足す）。予約は消さずに残す
const CANCEL_MARK = { canceled: true, canceledBy: "自動（使い始めなし）", noStart: true };

module.exports = { START_HOUR, needsStart, shouldRemind, shouldCancel, jst, carName, remindMsg, cancelMsg, CANCEL_MARK };
