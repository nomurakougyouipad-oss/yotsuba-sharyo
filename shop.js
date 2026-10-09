// よつば車両 整備（トラストワン用ページ）
// - 修理：依頼が来た車を「預かる」→ 修理中、「修理完了」→ 完了・置き場所を記録
// - 車検：30日以内の車を「預かる」→ 車検中（社員用PCの「車検に出す」と同じ）、「車検完了」→ 新しい満了日（「車検から戻す」と同じ）
// - データは社員用アプリと同じ Firestore。押したらすぐ社員用アプリにも出る
import { firebaseConfig, FIREBASE_SDK_VERSION, VAPID_KEY } from "./firebase-config.js";

const $ = id => document.getElementById(id);
const SHOP = "トラストワン"; // 会社名（右上の表示・操作した人の記録に使う）

/* ---------- Firebase ---------- */
const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
let fb;
try {
  const [app, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`), import(`${SDK}/firebase-firestore.js`),
  ]);
  fb = { ...app, ...auth, ...fs };
} catch (e) {
  console.error(e);
  $("main").innerHTML = `<div class="empty">読み込めませんでした。電波のよい所でもう一度開いてください。</div>`;
  throw e;
}
const {
  initializeApp, getAuth, signInAnonymously, onAuthStateChanged,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, onSnapshot, setDoc, updateDoc, deleteDoc, writeBatch, serverTimestamp,
} = fb;
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const pd = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const md = s => { const d = pd(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const ymd = s => { const d = pd(s); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
const days = s => Math.round((pd(s) - today()) / 864e5);
const WD = "日月火水木金土";
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動く */ } };
const millis = t => (t && t.toMillis ? t.toMillis() : Number.MAX_SAFE_INTEGER);
const plate = v => `${v.plateArea} ${v.plateClass} ${v.plateKana} ${v.plateNum}`;

/* ---------- 自分の名前（手入力。このスマホに保存） ---------- */
const NAME_KEY = "sharyo_shop_name";
let ME = lsGet(NAME_KEY) || "";
const operator = () => `${ME}（${SHOP}）`; // 操作した人・通知の宛先の名前（例：山岡（トラストワン））

/* ---------- データ ---------- */
const S = {
  vehicles: [], repairs: [], reservations: [], settings: { lots: [], shakenAlertDays: 30 }, notify: {},
  loaded: new Set(), tab: "fix",
};
const ready = () => ["v", "p", "r", "s"].every(k => S.loaded.has(k));
const byId = id => S.vehicles.find(v => v.id === id);
const usable = v => v && !v.retired && !v.sample;
const alertDays = () => Number(S.settings.shakenAlertDays) || 30;
const lots = () => (S.settings.lots || []).filter(Boolean).slice(0, 5);

/* ---------- 車の写真（社員用アプリと同じ。なければ車の絵） ---------- */
const CAR_COLORS = ["#dfe4ea", "#f3f3f3", "#cfd6de", "#f7f7f7", "#c9d1d9", "#eef1f4", "#e5e9ee", "#f0f0f0"];
function carColor(v) { let h = 0; for (const c of v.id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CAR_COLORS[h % CAR_COLORS.length]; }
function carSvg(color) {
  return `<svg viewBox="0 0 120 56" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path d="M14 40h92a4 4 0 0 0 4-4v-9c0-3-2-5-5-6l-14-3-12-11a6 6 0 0 0-4-2H38a6 6 0 0 0-5 3l-8 11-11 3c-3 1-5 3-5 6v8a4 4 0 0 0 4 4z" fill="${color}" stroke="#39424d" stroke-width="2.5" stroke-linejoin="round"/><path d="M42 12h28l9 10H35z" fill="#b8d8ee" stroke="#39424d" stroke-width="2"/><circle cx="34" cy="42" r="8" fill="#2a2f36"/><circle cx="34" cy="42" r="3.5" fill="#9aa4ae"/><circle cx="90" cy="42" r="8" fill="#2a2f36"/><circle cx="90" cy="42" r="3.5" fill="#9aa4ae"/></svg>`;
}
function picHtml(v) {
  const src = v.thumbUrl || v.photoUrl;
  return src ? `<div class="pic has-photo"><img src="${esc(src)}" alt="" loading="lazy" decoding="async"></div>` : `<div class="pic">${carSvg(carColor(v))}</div>`;
}

/* ---------- 画面（試作と同じ並び） ---------- */
const wishHtml = w => (w
  ? `<div class="wish"><span>預けられる日</span><b>${md(w)}（${WD[pd(w).getDay()]}）</b></div>`
  : `<div class="wish none"><span>預けられる日</span><span>未定（会社に確認）</span></div>`);
const chipsHtml = r => ((r.symptoms || []).length ? `<div class="chips">${r.symptoms.map(s => `<span>${esc(s)}</span>`).join("")}</div>` : "");
const period = x => `${md(x.from)}〜${x.until ? `（戻り予定 ${md(x.until)}）` : ""}`;
const repairAt = r => { const d = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate() : new Date(); return `${d.getMonth() + 1}/${d.getDate()}`; };

function card({ v, color, left, right, inner, btn, btnColor }) {
  return `<div class="card"><div class="band" style="background:var(${color})"><span>${left}</span><span class="r">${right || ""}</span></div>
  <div class="body">${picHtml(v)}<div class="top"><span class="plate">${esc(plate(v))}</span><span class="kind">${esc(v.kind)}</span></div>${inner || ""}
  ${btn ? `<button class="btn" style="background:var(${btnColor || color})" data-act="${btn.act}" data-id="${btn.id}">${btn.label}</button>` : ""}</div></div>`;
}
function sec(title, items, emptyText) {
  return `<section><h2>${title}<span class="n">${items.length}</span></h2><div class="list">${items.length ? items.join("") : `<div class="empty">${emptyText}</div>`}</div></section>`;
}
// 一覧に出すもの
function lists() {
  const withCar = r => usable(byId(r.vehicleId));
  const open = S.repairs.filter(r => r.status === "open" && withCar(r)).sort((a, b) => millis(a.createdAt) - millis(b.createdAt));
  const shop = S.repairs.filter(r => r.status === "in_repair" && r.shop && withCar(r));
  const cars = S.vehicles.filter(v => usable(v) && !v.hidden);
  const due = cars.filter(v => !v.inspection && v.shakenDate && days(v.shakenDate) <= alertDays()).sort((a, b) => a.shakenDate.localeCompare(b.shakenDate));
  const insp = cars.filter(v => v.inspection).sort((a, b) => a.inspection.from.localeCompare(b.inspection.from));
  return { open, shop, due, insp };
}

function render() {
  const main = $("main");
  $("who").hidden = !ME; $("nav").hidden = !ME;
  if (!ME) { if (!$("nameForm")) main.innerHTML = helloHtml(); return; } // 入力中に描き直さない
  if (!ready()) { main.innerHTML = `<div class="loading">読み込み中…</div>`; return; }
  const { open, shop, due, insp } = lists();
  let h = pushBar();
  if (S.tab === "fix") {
    h += sec("修理の依頼が来た車", open.map(r => { const v = byId(r.vehicleId); return card({ v, color: "--fix", left: "修理依頼", right: `${repairAt(r)} ${esc(r.reportedBy || "")}さん`,
      inner: `${wishHtml(r.availDate)}${chipsHtml(r)}${r.memo ? `<p class="memo">${esc(r.memo)}</p>` : ""}`,
      btn: { act: "takeFix", id: r.id, label: "預かる" } }); }), "いま依頼はありません");
    h += sec("預かり中の車", shop.map(r => { const v = byId(r.vehicleId); return card({ v, color: "--shop", left: "預かり中", right: period(r.shop),
      inner: `${chipsHtml(r)}${r.memo ? `<p class="memo">${esc(r.memo)}</p>` : ""}`,
      btn: { act: "doneFix", id: r.id, label: "修理完了" }, btnColor: "--free" }); }), "預かっている車はありません");
  } else {
    h += sec(`車検が${alertDays()}日以内の車`, due.map(v => { const n = days(v.shakenDate), over = n < 0;
      return card({ v, color: over ? "--fix" : "--use", left: over ? `車検切れ ${-n}日` : (n === 0 ? "車検は今日まで" : `車検まで あと${n}日`), right: `満了 ${ymd(v.shakenDate)}`,
        inner: wishHtml(v.availDate), btn: { act: "takeInsp", id: v.id, label: "預かる" }, btnColor: "--insp" }); }), `${alertDays()}日以内の車はありません`);
    h += sec("車検中の車", insp.map(v => card({ v, color: "--insp", left: "車検中", right: period(v.inspection),
      inner: `<p class="meta">今の満了日 ${ymd(v.shakenDate)}</p>`, btn: { act: "doneInsp", id: v.id, label: "車検完了" }, btnColor: "--free" })), "車検中の車はありません");
  }
  main.innerHTML = h;
  const bf = open.length, bi = due.length;
  $("b-fix").hidden = !bf; $("b-fix").textContent = bf;
  $("b-insp").hidden = !bi; $("b-insp").textContent = bi;
  $("t-fix").setAttribute("aria-selected", S.tab === "fix"); $("t-insp").setAttribute("aria-selected", S.tab === "insp");
}
// 画面を開いたまま入力しているときは描き直さない（シートは別の場所なので一覧だけ描き直す）
const refresh = () => render();

function helloHtml() {
  return `<div class="hello"><h2>お名前を入れてください</h2><p>このスマホに覚えておきます。預かったときの記録に「${SHOP}」と一緒に残ります</p>
    <form id="nameForm" class="field"><label for="nm">お名前</label><input type="text" id="nm" maxlength="20" autocomplete="name" placeholder="例：山岡" enterkeyhint="done">
    <p class="err" id="nmErr" hidden></p><button class="btn main" type="submit" style="margin-top:8px">はじめる</button></form></div>`;
}
function saveName(v) {
  const n = String(v || "").trim().replace(/[（）()]/g, "").slice(0, 20);
  if (!n) return "お名前を入れてください";
  ME = n; lsSet(NAME_KEY, n);
  // PCの通知の設定に「トラストワン」の人として出す
  setDoc(doc(db, "shopUsers", encodeURIComponent(operator())), { name: operator(), shop: SHOP, updatedAt: serverTimestamp() }, { merge: true })
    .catch(e => console.warn("名前を登録できません", e));
  if (pushState() === "on") saveToken().catch(e => console.warn(e)); // 通知の端末を新しい名前にひもづけ直す
  render();
  return "";
}

/* ---------- 通知（PCの「通知」で、この人に修理依頼・車検がオンになっているとき） ---------- */
const TOKEN_KEY = "sharyo_push_token";
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
function pushState() {
  if (!VAPID_KEY) return "off";
  if (isIOS && !isStandalone()) return "ios-browser";
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && lsGet(TOKEN_KEY) ? "on" : "ask";
}
const notifyOn = () => ME && ["repair", "shaken"].some(t => (S.notify[t] || []).includes(operator()));
function pushBar() {
  if (!notifyOn()) return "";
  const st = pushState();
  if (st === "ask") return `<button class="pushbtn" data-act="pushOn">🔔 通知をオンにする</button>`;
  if (st === "ios-browser") return `<p class="pushnote">ホーム画面に追加すると通知が届きます</p>`;
  return "";
}
let messaging = null;
function getMessagingMod() {
  if (!messaging) messaging = import(`${SDK}/firebase-messaging.js`)
    .then(async m => ((await m.isSupported()) ? { m, inst: m.getMessaging(fbApp) } : null))
    .catch(e => { console.warn(e); messaging = null; return null; });
  return messaging;
}
async function saveToken() {
  const ms = await getMessagingMod(); if (!ms || !ME) return false;
  await navigator.serviceWorker.register("./sw.js");
  const reg = await navigator.serviceWorker.ready;
  const token = await ms.m.getToken(ms.inst, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) return false;
  const old = lsGet(TOKEN_KEY);
  // app: "shop" → 通知を押したらこのページ（shop.html）が開く
  setDoc(doc(db, "pushTokens", token), { name: operator(), app: "shop", platform: isIOS ? "ios" : (/Android/.test(navigator.userAgent) ? "android" : "pc"), updatedAt: serverTimestamp() })
    .catch(e => console.warn("通知の端末を保存できません", e));
  if (old && old !== token) deleteDoc(doc(db, "pushTokens", old)).catch(() => {});
  lsSet(TOKEN_KEY, token);
  return true;
}
function enablePush() {
  const ask = Notification.permission === "granted" ? Promise.resolve("granted") : Notification.requestPermission(); // 押した直後に呼ぶ（iPhone）
  ask.then(async p => {
    if (p !== "granted") { toast("通知は許可されませんでした"); render(); return; }
    let ok = false;
    try { ok = await saveToken(); } catch (e) { console.error(e); }
    toast(ok ? "通知をオンにしました" : "通知をオンにできませんでした。電波のよい所でもう一度押してください");
    render();
  });
}

/* ---------- 下から出る入力の画面（試作と同じ） ---------- */
let onOk = null;
function closeSheet() { $("veil").hidden = true; $("sheet").innerHTML = ""; onOk = null; }
function openSheet(html, ok, okLabel = "確定する") {
  $("sheet").innerHTML = html + `<p class="err" id="err" hidden></p><div style="display:flex;flex-direction:column;gap:8px"><button class="btn" id="ok" data-act="ok" style="background:var(--free)">${okLabel}</button><button class="btn ghost" data-act="cancel">やめる</button></div>`;
  $("veil").hidden = false; onOk = ok;
}
function showErr(msg) { const e = $("err"); e.textContent = msg; e.hidden = false; }
const lotsHtml = () => `<div class="field"><span class="lb">どこに戻しましたか？</span><div class="lots">${lots().map(l => `<button class="lot" type="button" aria-pressed="false" data-act="lot" data-val="${esc(l)}">${esc(l)}</button>`).join("")}</div></div>`;
const pickedLot = () => { const b = $("sheet").querySelector(".lot[aria-pressed='true']"); return b && b.dataset.val; };
const datesHtml = w => `${wishHtml(w)}
  <div class="field"><label for="d1">預かった日</label><input id="d1" type="date" value="${iso(today())}" max="${iso(today())}"></div>
  <div class="field"><label for="d2">戻せる予定の日（わかれば）</label><input id="d2" type="date"></div>`;
function readDates() {
  const d1 = $("d1").value, d2 = $("d2").value || null;
  if (!d1) return { err: "預かった日を入れてください" };
  if (d1 > iso(today())) return { err: "預かった日は今日までの日にしてください" };
  if (d2 && d2 < d1) return { err: "戻せる予定の日は、預かった日より後にしてください" };
  return { d1, d2 };
}
const fail = msg => e => { console.error(e); toast(msg); };

// 修理で預かる → 修理依頼を「修理中」にする（社員用の「修理中にする」と同じ）。預かった日・戻せる予定の日・預かった人を残す
function takeFix(r) {
  const v = byId(r.vehicleId); if (!v) return;
  openSheet(`<h3>修理で預かる</h3><p class="meta">${esc(plate(v))}　${esc(v.kind)}</p>${datesHtml(r.availDate)}`, () => {
    const x = readDates(); if (x.err) return x.err;
    updateDoc(doc(db, "repairs", r.id), {
      status: "in_repair", inRepairAt: serverTimestamp(), updatedAt: serverTimestamp(),
      shop: { from: x.d1, until: x.d2, by: operator(), shop: SHOP },
      prev: { status: r.status, currentLot: v.currentLot || null }, // 預かる前の状態（会社のPCの「修理中を取り消す」で戻す）
    }).catch(fail("記録できませんでした。もう一度お試しください"));
    toast("預かり中にしました。会社のアプリにも出ます");
    return "";
  });
}
// 修理完了 → 修理依頼を完了にし、置き場所を記録（ほかに修理中・使用中がなければ「空き」に戻る）
function doneFix(r) {
  const v = byId(r.vehicleId); if (!v) return;
  openSheet(`<h3>修理完了</h3><p class="meta">${esc(plate(v))}　${esc(v.kind)}</p>
    <div class="field"><label for="memo">やったこと（なくてもOK）</label><textarea id="memo" maxlength="2000" placeholder="例：左後ろタイヤ交換"></textarea></div>${lotsHtml()}`, () => {
    const lot = pickedLot(); if (!lot) return "戻した場所を選んでください";
    const b = writeBatch(db);
    b.update(doc(db, "repairs", r.id), {
      status: "done", doneAt: serverTimestamp(), updatedAt: serverTimestamp(),
      shopDone: { date: iso(today()), memo: $("memo").value.trim(), lot, by: operator() },
    });
    b.update(doc(db, "vehicles", v.id), { currentLot: lot, updatedAt: serverTimestamp() });
    b.commit().catch(fail("記録できませんでした。もう一度お試しください"));
    toast(`修理完了を記録しました（${lot}）`);
    return "";
  });
}

// 車検で預かる → 社員用PCの「車検に出す」と同じ（車検中になる・車検の記録を残す）
const effTo = r => (!r.returnedAt && r.to < iso(today()) ? "9999-12-31" : r.to); // 返却予定を過ぎて返していない予約は、返すまで続く
function clashes(v, from, until) {
  const to = until || iso(today());
  return S.reservations.filter(r => r.vehicleId === v.id && !r.returnedAt && !r.canceled && r.from <= to && from <= effTo(r))
    .sort((a, b) => (a.from > b.from ? 1 : -1));
}
const rangeText = r => (r.from === r.to ? md(r.from) : `${md(r.from)}〜${md(r.to)}`);
function takeInsp(v) {
  let confirmed = false;
  openSheet(`<h3>車検で預かる</h3><p class="meta">${esc(plate(v))}　${esc(v.kind)}</p>${datesHtml(v.availDate)}<div id="clash"></div>`, () => {
    const x = readDates(); if (x.err) return x.err;
    // その期間に予約があれば、一覧を出して確かめる（もう一度押すと預かる）
    const c = clashes(v, x.d1, x.d2);
    if (c.length && !confirmed) {
      $("clash").innerHTML = `<div class="clash"><b>この期間に会社の予約が入っています</b>${c.map(r => `<span>${rangeText(r)}　${esc(r.who)}さん</span>`).join("")}<span>このまま車検で預かりますか？</span></div>`;
      $("ok").textContent = "このまま預かる"; confirmed = true;
      return null; // シートは閉じない
    }
    const rec = doc(collection(db, "inspections"));
    const b = writeBatch(db);
    b.set(rec, {
      vehicleId: v.id, outDate: x.d1, expectedBack: x.d2, backDate: null,
      oldShakenDate: v.shakenDate, newShakenDate: null, outBy: operator(), backBy: null, returnedLot: null, shop: SHOP,
      outAt: serverTimestamp(), backAt: null,
      prev: { currentLot: v.currentLot || null, availDate: v.availDate || null }, // 預かる前の状態（会社のPCの「車検を取り消す」で戻す）
    });
    b.update(doc(db, "vehicles", v.id), { inspection: { id: rec.id, from: x.d1, until: x.d2 }, availDate: null, updatedAt: serverTimestamp() });
    b.commit().catch(fail("記録できませんでした。もう一度お試しください"));
    toast("車検中にしました。この車は予約できなくなります");
    return "";
  });
  // 日付を変えたら確認し直す
  $("sheet").addEventListener("change", e => { if (/^d[12]$/.test(e.target.id) && confirmed) { confirmed = false; $("clash").innerHTML = ""; $("ok").textContent = "確定する"; } });
}
// 車検完了 → 社員用PCの「車検から戻す」と同じ（新しい満了日・置き場所。車検中が終わる）
let sheetCar = null; // 「車検完了」で開いている車
function doneInsp(v) {
  sheetCar = v.id;
  openSheet(`<h3>車検完了</h3><p class="meta">${esc(plate(v))}　${esc(v.kind)}</p>
    <div class="field"><label for="nx">新しい車検満了日</label><input id="nx" type="date"><span class="now">今の満了日 ${ymd(v.shakenDate)}</span>
    <div class="plusrow"><button class="plus" type="button" data-act="plus" data-val="1">＋1年</button><button class="plus" type="button" data-act="plus" data-val="2">＋2年</button></div></div>${lotsHtml()}`, () => {
    const cur = byId(v.id); if (!cur || !cur.inspection) return "この車はもう車検から戻っています";
    const nx = $("nx").value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nx)) return "新しい車検満了日を入れてください";
    if (nx <= cur.shakenDate) return "新しい満了日は、今の満了日より後の日にしてください";
    const lot = pickedLot(); if (!lot) return "戻した場所を選んでください";
    const b = writeBatch(db);
    b.update(doc(db, "vehicles", v.id), { shakenDate: nx, currentLot: lot, inspection: null, availDate: null, updatedAt: serverTimestamp() });
    if (cur.inspection.id) b.set(doc(db, "inspections", cur.inspection.id), {
      vehicleId: v.id, backDate: iso(today()), newShakenDate: nx, backBy: operator(), returnedLot: lot, backAt: serverTimestamp(),
    }, { merge: true });
    b.commit().catch(fail("記録できませんでした。もう一度お試しください"));
    toast(`車検完了。満了日を ${ymd(nx)} にしました`);
    return "";
  });
}
// 名前を変える（右上の「トラストワン」を押す）
function nameSheet() {
  openSheet(`<h3>お名前</h3><div class="field"><label for="nm2">お名前</label><input type="text" id="nm2" maxlength="20" value="${esc(ME)}" autocomplete="name"></div>`,
    () => saveName($("nm2").value), "保存する");
}

/* ---------- お知らせ ---------- */
let toastTimer;
function toast(t) { const el = $("toast"); el.textContent = t; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600); }

/* ---------- 操作 ---------- */
document.addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) { if (e.target.id === "veil") closeSheet(); return; }
  const { act, id, val } = b.dataset;
  switch (act) {
    case "tab": S.tab = val; render(); scrollTo(0, 0); break;
    case "name": nameSheet(); break;
    case "pushOn": enablePush(); break;
    case "takeFix": { const r = S.repairs.find(x => x.id === id); if (r) takeFix(r); break; }
    case "doneFix": { const r = S.repairs.find(x => x.id === id); if (r) doneFix(r); break; }
    case "takeInsp": { const v = byId(id); if (v) takeInsp(v); break; }
    case "doneInsp": { const v = byId(id); if (v) doneInsp(v); break; }
    case "lot": $("sheet").querySelectorAll(".lot").forEach(x => x.setAttribute("aria-pressed", String(x === b))); break;
    case "plus": { const v = sheetCar && byId(sheetCar); if (!v) break; const d = pd(v.shakenDate); d.setFullYear(d.getFullYear() + Number(val)); $("nx").value = iso(d); break; } // 今の満了日から＋1年・＋2年
    case "cancel": closeSheet(); break;
    case "ok": { if (!onOk) break; const err = onOk(); if (err) showErr(err); else if (err === "") closeSheet(); break; }
  }
});
document.addEventListener("submit", e => {
  if (e.target.id !== "nameForm") return;
  e.preventDefault();
  const err = saveName($("nm").value);
  if (err) { $("nmErr").textContent = err; $("nmErr").hidden = false; }
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("veil").hidden) closeSheet(); });

/* ---------- Firestore と同期（社員用アプリと同じデータ） ---------- */
const snapList = snap => snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
function onErr(e) { console.error(e); $("main").innerHTML = `<div class="empty">データを読み込めませんでした。電波のよい所でもう一度開いてください</div>`; }
let started = false;
function startSync() {
  if (started) return; started = true;
  const done = k => { S.loaded.add(k); refresh(); };
  onSnapshot(collection(db, "vehicles"), s => { S.vehicles = snapList(s); done("v"); }, onErr);
  onSnapshot(collection(db, "repairs"), s => { S.repairs = snapList(s); done("p"); }, onErr);
  onSnapshot(query(collection(db, "reservations"), where("returnedAt", "==", null)), s => { S.reservations = snapList(s).filter(r => !r.canceled); done("r"); }, onErr);
  onSnapshot(doc(db, "settings", "app"), d => { S.settings = { lots: [], shakenAlertDays: 30, ...(d.data() || {}) }; done("s"); }, onErr);
  onSnapshot(doc(db, "settings", "notify"), d => { S.notify = d.data() || {}; refresh(); }, e => console.warn(e));
  if (ME && pushState() === "on") saveToken().catch(e => console.warn(e)); // 開くたびに通知の端末を保存し直す
}

render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(e => console.warn(e));
onAuthStateChanged(auth, user => { if (user) startSync(); });
signInAnonymously(auth).catch(e => { console.error(e); $("main").innerHTML = `<div class="empty">接続できませんでした。電波のよい所でもう一度開いてください</div>`; });
