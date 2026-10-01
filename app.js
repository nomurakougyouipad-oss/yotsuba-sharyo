// 社用車管理アプリ（段階1: 車両一覧・詳細・PC版の登録／修正／廃車・Firestore同期・サンプル投入）
import { firebaseConfig, FIREBASE_SDK_VERSION, VAPID_KEY } from "./firebase-config.js";

const $ = id => document.getElementById(id);

/* ---------- Firebase ---------- */
const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
let fb;
try {
  const [app, auth, fs, st] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
    import(`${SDK}/firebase-storage.js`),
  ]);
  fb = { ...app, ...auth, ...fs, storageMod: st };
} catch (e) {
  console.error(e);
  $("ph-screen").innerHTML = `<div class="errbar">読み込めませんでした。電波のよい所でもう一度開いてください。</div>`;
  throw e;
}
const {
  initializeApp, getAuth, signInAnonymously, onAuthStateChanged,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, onSnapshot, getDocs, setDoc, updateDoc, writeBatch,
  serverTimestamp, Timestamp, runTransaction, getDocsFromServer, increment,
  deleteDoc, arrayUnion, arrayRemove,
} = fb;
const { getStorage, ref: storageRef, uploadBytesResumable, getDownloadURL, deleteObject } = fb.storageMod;

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// 電波が悪い現場でも前回の内容が見えるよう、端末にも保存しておく
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const storage = getStorage(fbApp);

/* ---------- 定数 ---------- */
const TYPES = ["トラック", "バン", "普通車"];
const LABEL = { free: "空き", use: "使用中", fix: "修理中", own: "専用", insp: "車検中" };
const DEFAULT_SETTINGS = {
  sites: ["東レ 定修", "太陽石油", "黒藤川発電所", "熊本 浄化センター", "松前工場 内作"],
  lots: ["本社", "松前工場", "伊予工場"],
  shakenAlertDays: 30,
};
const CAR_COLORS = ["#dfe4ea", "#f3f3f3", "#cfd6de", "#f7f7f7", "#c9d1d9", "#eef1f4", "#e5e9ee", "#f0f0f0"];

/* ---------- データ（Firestore から届いたもの） ---------- */
const S = {
  vehicles: [], reservations: [], repairs: [],
  settings: { ...DEFAULT_SETTINGS }, settingsExists: false,
  members: [], membersLoaded: false, // 名簿（日報アプリと同じ形：name / kubun / shozoku / active）
  notify: {}, notifyLoaded: false, // 通知を届ける人（PCで選ぶ）：{ shaken: [名前…], due: […], overdue: […], repair: […] }
  prefs: new Map(), // 本人がスマホでオフにした通知：名前 → Set(種類)
  tokenNames: new Set(), // 通知を許可した端末がある人の名前
  ready: false, error: "",
};

/* ---------- 画面の状態 ---------- */
const wide = matchMedia("(min-width: 900px)");
const ui = { view: "phone", tab: "cars", screen: { name: "list" }, filter: "all", tfilter: "all", retiredOpen: false, backTo: null };
const form = {}; // 予約フォームの入力中の内容（画面を描き直しても消えないように）
const resetForm = () => { for (const k of Object.keys(form)) delete form[k]; };

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const pad = n => String(n).padStart(2, "0");
const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = String(s).split("-").map(Number); return new Date(y, m - 1, d); };
const today = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const fmt = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}`; };
const jp = s => { const d = parse(s); return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`; };
const DOW = "日月火水木金土";
const daysTo = s => Math.round((parse(s) - today()) / 86400000);
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* 保存できなくても動く */ } };
const millis = t => (t && t.toMillis ? t.toMillis() : Number.MAX_SAFE_INTEGER);

/* ---------- 名簿（日報アプリと同じ区分・並び順） ---------- */
const MGROUPS = ["自社", "常駐協力", "外注協力"];
// 日報アプリと同じく、古い「協力」や空欄は「常駐協力」として扱う
const mGroupOf = w => (!w || w.kubun === "自社") ? "自社" : (w.kubun === "外注協力" ? "外注協力" : "常駐協力");
const isKana = x => /^[ァ-ヴー]+$/.test(x);
const byLen = (a, b) => (isKana(a) - isKana(b)) || (a.length - b.length) || a.localeCompare(b, "ja");
const activeMembers = () => S.members.filter(m => m.active !== false);
// 区分ごとに分けた名前のボタン（日報アプリと同じ並び）。act は押したときの動き
function nameChips(q, selected, act) {
  // 名簿が届くまでは名前のボタンを出さない
  if (!S.membersLoaded) return `<div class="loading">読み込み中…</div>`;
  q = String(q || "").trim();
  let html = "";
  MGROUPS.forEach(g => {
    const names = activeMembers().filter(m => mGroupOf(m) === g).map(m => m.name).filter(n => !q || n.includes(q)).sort(byLen);
    if (!names.length) return;
    html += `<div class="mgroup">${g}</div><div class="ngrid">${names.map(n =>
      `<button class="nchip${selected === n ? " on" : ""}" data-act="${act}" data-val="${esc(n)}">${esc(n)}</button>`).join("")}</div>`;
  });
  if (html) return html;
  return `<div class="empty">${q ? "該当する名前がありません" : "名簿がまだありません。事務所のPCで名簿を取り込んでください"}</div>`;
}

/* ---------- 自分の名前（このスマホに覚えておく） ---------- */
let ME = lsGet("sharyo_me") || "";
function saveMe(n) {
  n = String(n || "").trim().slice(0, 40); if (!n) return;
  ME = n; lsSet("sharyo_me", n); resetForm(); meQuery = "";
  if (pushState() === "on") saveToken(); // この端末の通知を新しい名前にひもづけ直す
  go({ name: "list" });
}

/* ---------- 車の状態（README「状態の決め方」） ---------- */
const active = () => S.vehicles.filter(v => !v.retired);
const byId = id => S.vehicles.find(v => v.id === id);
function currentUse(v) {
  const t = ymd(today());
  // 返却予定を過ぎても返却していなければ使用中（返却待ち）。いちばん早く終わる予定のものを使う
  return S.reservations.filter(r => r.vehicleId === v.id && !r.returnedAt && r.from <= t)
    .sort((a, b) => (a.to > b.to ? 1 : a.to < b.to ? -1 : 0))[0] || null;
}
// 返却予定を過ぎて、まだ返却していない予約
const isOverdue = r => !!r && !r.returnedAt && r.to < ymd(today());
function fixRepair(v) { return S.repairs.find(r => r.vehicleId === v.id && r.status === "in_repair") || null; }
function nextRes(v) {
  const t = ymd(today());
  return S.reservations.filter(r => r.vehicleId === v.id && !r.returnedAt && r.from > t).sort((a, b) => (a.from > b.from ? 1 : -1))[0] || null;
}
// 優先順：車検中 → 修理中 → 使用中 → 空き（廃車は一覧に出さない）
function status(v) { return v.inspection ? "insp" : fixRepair(v) ? "fix" : (currentUse(v) ? "use" : "free"); }
function repairText(r) { const s = (r.symptoms || []).join("・"); return s && r.memo ? `${s}：${r.memo}` : (s || r.memo || ""); }
const lotOf = v => v.currentLot || v.homeLot || "";
const alertDays = () => Number(S.settings.shakenAlertDays) || 30;

/* ---------- 必要な免許・専用の車・一時的に隠す ---------- */
const LICENSES = ["普通", "準中型5t", "準中型", "中型8t", "中型", "大型"];
const LICENSE_NOTE = {
  "普通": "普通免許で運転できます",
  "準中型5t": "平成29年3月11日までに普通免許を取った人（平成19年6月2日〜平成29年3月11日に取った人は準中型5t限定、平成19年6月1日までに取った人は中型8t限定）、または準中型以上の免許の人",
  "準中型": "平成19年6月1日までに普通免許を取った人（中型8t限定）、または準中型（限定なし）・中型以上の免許の人",
  "中型8t": "平成19年6月1日までに普通免許を取った人（中型8t限定）、または中型（限定なし）・大型の免許の人",
  "中型": "中型（限定なし）または大型の免許の人",
  "大型": "大型免許の人",
};
const licOf = v => (LICENSES.includes(v.license) ? v.license : "普通");
const shown = () => active().filter(v => !v.hidden); // 一時的に隠した車は一覧・車検・上のパネルに出さない
// 専用の車は、専用の人と PC（広い画面）からだけ予約できる
const canReserve = v => !v.owner || v.owner === ME || wide.matches;
function vehicleTags(v) {
  const l = licOf(v);
  const t = (v.owner ? `<span class="vtag own">${esc(v.owner)}さん専用</span>` : "")
    + (l !== "普通" ? `<span class="vtag lic" title="${esc(l)}：${esc(LICENSE_NOTE[l])}">${l}</span>` : "");
  return t ? `<div class="vtags">${t}</div>` : "";
}

// 専用の車が使われていない（空き）
const isOwnFree = v => !!v.owner && status(v) === "free";
// PC の区分：使用中・空き・専用・修理中（専用の空きは「空き」に入れない）
const groupOf = v => (isOwnFree(v) ? "own" : status(v));
// スマホの「空き」に入れるか：専用の車は本人だけ
const freeForMe = v => status(v) === "free" && !v.owner;
// 絞り込み（スマホ・PC 共通）：専用は、専用の車すべて（使用中も含む）
const matchFilter = (v, k) => k === "all" || (k === "free" ? freeForMe(v) : k === "own" ? !!v.owner : status(v) === k);
// スマホの色帯・詳細の状態の見え方
function statusView(v, st, use) {
  if (st === "use" && isOverdue(use)) return { cls: "use over", label: "使用中（返却待ち）" };
  if (isOwnFree(v)) return v.owner === ME ? { cls: "mine", label: "あなた専用" } : { cls: "own", label: `${v.owner}さん専用` };
  return { cls: st, label: LABEL[st] };
}

// 車検中の期間の文字（例：10/1〜（戻り予定 10/4））
const inspText = x => `${fmt(x.from)}〜${x.until ? `（戻り予定 ${fmt(x.until)}）` : ""}`;

/* ---------- 部品（試作と同じ見た目） ---------- */
function carColor(v) { let h = 0; for (const c of v.id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CAR_COLORS[h % CAR_COLORS.length]; }
function carSvg(color) {
  return `<svg viewBox="0 0 120 56" xmlns="http://www.w3.org/2000/svg"><path d="M14 40h92a4 4 0 0 0 4-4v-9c0-3-2-5-5-6l-14-3-12-11a6 6 0 0 0-4-2H38a6 6 0 0 0-5 3l-8 11-11 3c-3 1-5 3-5 6v8a4 4 0 0 0 4 4z" fill="${color}" stroke="#39424d" stroke-width="2.5" stroke-linejoin="round"/><path d="M42 12h28l9 10H35z" fill="#b8d8ee" stroke="#39424d" stroke-width="2"/><circle cx="34" cy="42" r="8" fill="#2a2f36"/><circle cx="34" cy="42" r="3.5" fill="#9aa4ae"/><circle cx="90" cy="42" r="8" fill="#2a2f36"/><circle cx="90" cy="42" r="3.5" fill="#9aa4ae"/></svg>`;
}
// big：大きい写真を使う（詳細）。zoom：押すと画面いっぱいに開く
function thumbHtml(v, big, zoom) {
  const small = v.thumbUrl || v.photoUrl;
  if (!small) return `<div class="thumb" aria-hidden="true">${carSvg(carColor(v))}</div>`;
  // 大きい写真：まず一覧用の小さい写真をすぐ出し、大きい写真が届いたら差し替える
  // 小さい写真（一覧・表）：画面に入る少し手前から読み込む
  const img = big
    ? `<img src="${esc(small)}"${v.photoUrl && v.photoUrl !== small ? ` data-full="${esc(v.photoUrl)}"` : ""} alt="" decoding="async">`
    : `<img data-src="${esc(small)}" alt="" decoding="async">`;
  return zoom && v.photoUrl
    ? `<div class="thumb has-photo zoomable" data-act="viewPhoto" data-val="${esc(v.photoUrl)}" role="button" tabindex="0" aria-label="写真を大きく見る">${img}</div>`
    : `<div class="thumb has-photo" aria-hidden="true">${img}</div>`;
}
function plateHtml(v, small) {
  return `<span class="plate"${small ? ' style="font-size:15px"' : ""}><small>${esc(v.plateArea)} ${esc(v.plateClass)}</small>${esc(v.plateKana)} ${esc(v.plateNum)}</span>`;
}
function shakenClass(v) { const d = daysTo(v.shakenDate); return d < 0 ? "over" : (d <= alertDays() ? "soon" : ""); }
function shakenTag(v) {
  const d = daysTo(v.shakenDate); if (d > alertDays() || v.inspection) return "";
  return `<span class="shk ${d < 0 ? "over" : ""}"><span>🔔 車検</span><b>${d < 0 ? `${-d}日超過` : (d === 0 ? "今日" : `あと${d}日`)}</b></span>`;
}
// 車検の残り日数の札（車検に出している車は「車検中」）
const shakenDays = (v, attr = "") => (v.inspection ? `<span class="days insp"${attr}>車検中</span>` : `<span class="days ${shakenClass(v)}"${attr}>${shakenText(v)}</span>`);
const byShaken = list => [...list].sort((a, b) => (a.shakenDate > b.shakenDate ? 1 : -1));
function shakenText(v) { const d = daysTo(v.shakenDate); return d < 0 ? `${-d}日 超過` : (d === 0 ? "今日" : `あと ${d}日`); }
function bandExtra(v, st, use) {
  if (st === "insp") return `<span class="period">${inspText(v.inspection)}</span>`;
  if (use && isOverdue(use)) return `<span class="period">返却予定を過ぎています</span>`;
  if (use) return `<span class="period">${fmt(use.from)}〜${fmt(use.to)}</span>`;
  const next = nextRes(v);
  if (st !== "fix" && next) return `<span class="period"><small>次の予約</small>${fmt(next.from)}〜</span>`;
  return "";
}
function useText(v, use, fix) {
  if (v.inspection) return "車検に出しています";
  return use ? `${esc(use.who)}さん → ${esc(use.site)}` : (fix ? `修理待ち：${esc(repairText(fix))}` : `${esc(lotOf(v))} にあります`);
}
const errBar = () => (S.error ? `<div class="errbar">${esc(S.error)}</div>` : "");

/* ---------- 画面の切り替え ---------- */
function applyView() {
  ui.view = wide.matches ? (lsGet("sharyo_view") || "pc") : "phone";
  $("switch").hidden = !wide.matches;
  $("phone").hidden = ui.view !== "phone";
  $("pc").hidden = ui.view !== "pc";
  $("swPhone").classList.toggle("on", ui.view === "phone");
  $("swPc").classList.toggle("on", ui.view === "pc");
  if (ui.view !== "pc") closeModal();
  render();
}
function go(s) { ui.screen = s; ui.menu = false; form.err = ""; render(); $("ph-screen").scrollTop = 0; }
function setTab(t) { ui.tab = t; go({ name: "list" }); }

function render() { if (ui.view === "phone") renderPhone(); else renderPc(); loadImages(); }

/* ---------- 写真の読み込み（一覧は画面に入る少し手前から、詳細は小さい写真→大きい写真） ---------- */
const LAZY_MARGIN = "600px 0px";
const lazyObservers = new Map();
function lazyObserver(root) {
  if (!lazyObservers.has(root)) {
    const obs = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      const img = e.target; obs.unobserve(img);
      if (img.dataset.src) { img.src = img.dataset.src; img.removeAttribute("data-src"); }
    }), { root, rootMargin: LAZY_MARGIN });
    lazyObservers.set(root, obs);
  }
  return lazyObservers.get(root);
}
function loadImages(scope = document) {
  scope.querySelectorAll("img[data-src]").forEach(img => {
    if (!("IntersectionObserver" in window)) { img.src = img.dataset.src; img.removeAttribute("data-src"); return; }
    lazyObserver(img.closest("#ph-screen") || null).observe(img); // スマホは一覧の枠、PC は画面全体を基準に
  });
  scope.querySelectorAll("img[data-full]").forEach(img => {
    const full = img.dataset.full; img.removeAttribute("data-full");
    const pre = new Image(); pre.decoding = "async";
    pre.onload = () => { if (img.isConnected) img.src = full; };
    pre.src = full;
  });
}
// データが届いたときの描き直し。スマホで入力中なら、キーボードが閉じないよう後回しにする
function refresh() {
  const a = document.activeElement;
  const typing = a && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName) && !["file", "radio", "checkbox", "button", "submit"].includes(a.type);
  if (ui.view === "phone" && typing && $("ph-screen").contains(a)) return;
  render();
}

/* ================= スマホ版 ================= */
function renderPhone() {
  const h = $("ph-header"), s = $("ph-screen"), t = $("ph-tabs");
  // 初回は名前を選んでもらう
  if (!ME) { h.innerHTML = S.membersLoaded ? `<h1>はじめに</h1>` : `<h1>社用車</h1>`; s.innerHTML = errBar() + nameScreen(true); t.hidden = true; return; }
  t.hidden = false;
  t.innerHTML = [["cars", "🚐", "車両"], ["shaken", "📋", "車検"], ["repair", "🔧", "修理"]].map(([k, ic, l]) =>
    `<button class="${ui.tab === k ? "on" : ""}" data-act="tab" data-val="${k}"><span class="ic">${ic}</span>${l}${k === "repair" && openCount() ? `<span class="badge">${openCount()}</span>` : ""}</button>`).join("");
  if (ui.screen.name === "me" || ui.screen.name === "notify") {
    ui.backTo = { name: "list" }; ui.menu = false;
    h.innerHTML = `<button class="back" data-act="back" aria-label="戻る">‹</button><h1>${ui.screen.name === "me" ? "あなたの名前" : "🔔 通知"}</h1>`;
    s.innerHTML = ui.screen.name === "me" ? nameScreen(false) : notifyScreen(); return;
  }

  let title = "社用車", back = null, body = "", pill = "";
  const d = today(), sc = ui.screen;
  if (sc.name === "list") {
    pill = `<button class="me-pill" data-act="meMenu" aria-haspopup="menu" aria-expanded="${!!ui.menu}">${esc(ME)}</button>`
      + (ui.menu ? `<div class="me-menu" role="menu"><button role="menuitem" data-act="meEdit">名前を変える</button><button role="menuitem" data-act="goNotify">🔔 通知</button></div>` : "");
    if (ui.tab === "cars") body = listCars();
    else if (ui.tab === "shaken") { title = "車検"; body = listShaken(); }
    else { title = "修理依頼"; body = listRepairs(); }
    body = (ui.tab === "cars" ? pushBar() : "") + myBar() + body;
  } else if (sc.name === "done") {
    title = ""; body = doneScreen(sc);
  } else {
    const v = byId(sc.id);
    if (!v || v.retired || v.hidden) { ui.screen = { name: "list" }; return renderPhone(); }
    back = sc.name === "detail" ? { name: "list" } : { name: "detail", id: v.id };
    if (sc.name === "detail") { title = esc(v.kind); body = detail(v); }
    if (sc.name === "reserve") { title = "予約"; body = reserveForm(v); }
    if (sc.name === "return") { title = "返却"; body = returnForm(v); }
    if (sc.name === "repair") { title = "修理を頼む"; body = repairForm(v); }
  }
  ui.backTo = back;
  h.innerHTML = `${back ? `<button class="back" data-act="back" aria-label="戻る">‹</button>` : ""}<h1>${title}</h1><span class="today">${d.getMonth() + 1}/${d.getDate()}（${DOW[d.getDay()]}）</span>${pill}`;
  s.innerHTML = errBar() + body;
}

let meQuery = "";
function nameScreen(first) {
  if (!S.membersLoaded) return `<div class="loading">読み込み中…</div>`; // 名簿が届くまでは「読み込み中…」だけ
  return `<div class="welcome">${first
    ? `<h2>あなたの名前を選んでください</h2><p class="sub" style="margin:0 0 14px">このスマホに覚えておきます。予約するとき自動で入ります</p>`
    : `<p class="sub" style="margin:0 0 14px">今は「${esc(ME)}」です。変えるなら選んでください</p>`}
  <input type="search" id="meSearch" class="nsearch" placeholder="名前で探す" value="${esc(meQuery)}" autocomplete="off" aria-label="名前で探す">
  <div id="meList">${nameChips(meQuery, ME, "me")}</div></div>`;
}

function listShaken() {
  if (!S.ready) return `<div class="loading">読み込み中…</div>`;
  const vs = byShaken(shown());
  if (!vs.length) return `<div class="empty">まだ車が登録されていません</div>`;
  return `<p class="sub" style="margin-top:0">期限が近い順</p>` + vs.map(v => `
  <div class="li tap" data-act="detail" data-id="${v.id}" role="button" tabindex="0">
    ${plateHtml(v, true)}<div class="grow"><div class="t">${esc(v.kind)}</div><div class="s">${jp(v.shakenDate)}</div></div>
    ${shakenDays(v)}</div>`).join("");
}

function listCars() {
  if (!S.ready) return `<div class="loading">読み込み中…</div>`;
  const all = shown();
  if (!all.length) return `<div class="empty">まだ車が登録されていません。<br>事務所のPCから登録してください</div>`;
  const byType = all.filter(v => ui.tfilter === "all" || v.type === ui.tfilter);
  const match = matchFilter;
  const n = k => byType.filter(v => match(v, k)).length;
  const nt = t => all.filter(v => (t === "all" || v.type === t) && match(v, ui.filter)).length;
  const list = byType.filter(v => match(v, ui.filter));
  return `<div class="chips four">
    ${[["all", "全部"], ["free", "空き"], ["use", "使用中"], ["own", "専用"]].map(([k, l]) => `<button class="chip ${ui.filter === k ? "on" : ""}" data-act="filter" data-val="${k}">${l}<span class="n">${n(k)}</span></button>`).join("")}
  </div><div class="chips types">
    ${[["all", "全種類"], ...TYPES.map(t => [t, t])].map(([k, l]) => `<button class="chip ${ui.tfilter === k ? "on" : ""}" data-act="tfilter" data-val="${k}">${l}<span class="n">${nt(k)}</span></button>`).join("")}
  </div>` + (list.length ? "" : `<div class="empty">この条件の車はありません</div>`) + list.map(v => {
    const st = status(v), use = currentUse(v), fix = fixRepair(v);
    return `
  <button class="card" data-act="detail" data-id="${v.id}">
    <div class="band ${statusView(v, st, use).cls}"><span>${esc(statusView(v, st, use).label)}</span>${bandExtra(v, st, use)}</div>
    <div class="body">
      ${thumbHtml(v)}
      <div class="meta"><div class="r1">${plateHtml(v, true)}${shakenTag(v)}</div><div class="kind">${esc(v.kind)}</div>${vehicleTags(v)}<div class="who">${useText(v, use, fix)}</div></div>
    </div>
  </button>`;
  }).join("");
}

function detail(v) {
  const st = status(v), fix = fixRepair(v), insp = st === "insp";
  const use = insp ? null : currentUse(v); // 車検中は、使っている人・置いてある場所を出さない
  const rows = [
    ["状態", `<span class="status-pill ${statusView(v, st, use).cls}">${esc(statusView(v, st, use).label)}</span>${insp ? `<div class="insnote">${inspText(v.inspection)}</div>` : ""}`],
    use ? ["使っている人", esc(use.who) + "さん"] : null,
    use ? ["現場", esc(use.site)] : null,
    use ? ["いつまで", isOverdue(use) ? `<span class="warn">${fmt(use.to)} まで（返却予定を過ぎています）</span>` : `${fmt(use.to)} まで`] : null,
    !use && !insp ? ["置いてある場所", esc(lotOf(v))] : null,
    fix ? ["修理", `<span class="warn">${esc(repairText(fix))}</span>`] : null,
    [insp ? "車検満了日" : "車検", `<span class="${shakenClass(v) ? "warn" : ""}">${jp(v.shakenDate)}（${shakenText(v)}）</span>`],
    v.owner ? ["専用", `${esc(v.owner)}さん専用`] : null,
    licOf(v) !== "普通" ? ["必要な免許", `${licOf(v)}以上<div class="licnote">${esc(LICENSE_NOTE[licOf(v)])}</div>`] : null,
  ].filter(Boolean);
  const actions = insp
    ? `<button class="btn primary" disabled>この車を予約する</button><p class="ownnote">車検中のため予約できません</p>`
    : st === "use"
    ? `<button class="btn primary" data-act="goto" data-val="return" data-id="${v.id}">返却する</button>`
    : (st === "free" ? (canReserve(v) ? `<button class="btn primary" data-act="goto" data-val="reserve" data-id="${v.id}">この車を予約する</button>`
      : `<p class="ownnote">この車は${esc(v.owner)}さん専用です</p>`) : "");
  return `<div class="hero">${thumbHtml(v, true, true)}${plateHtml(v)}${vehicleTags(v)}${photoBtn(v)}</div>
  <div class="rows">${rows.map(([k, val]) => `<div class="row"><span class="k">${k}</span><span class="v">${val}</span></div>`).join("")}</div>
  <div class="actions">${actions}<button class="btn ghost" data-act="goto" data-val="repair" data-id="${v.id}">修理を頼む</button></div>
  ${calendar(v)}
  ${resList(v)}`;
}

// 今月のカレンダー（予約・使用中の日をオレンジ、今日を枠線）
// 車の詳細のカレンダー（月を前後に切り替えられる。予約の日だけ色を付けるので飛び飛びでも分かる）
let detMonth = 0; // 今月から何か月先か
function calendar(v) {
  const td = today(), base = new Date(td.getFullYear(), td.getMonth() + detMonth, 1), y = base.getFullYear(), m = base.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const lo = ymd(first), hi = ymd(last), busy = new Set();
  S.reservations.filter(r => r.vehicleId === v.id && !r.returnedAt && (r.to >= lo || isOverdue(r)) && r.from <= hi).forEach(r => {
    const end = isOverdue(r) ? ymd(today()) : r.to;
    for (let d = parse(r.from > lo ? r.from : lo); ymd(d) <= end && ymd(d) <= hi; d.setDate(d.getDate() + 1)) busy.add(ymd(d));
  });
  let cells = [..."日月火水木金土"].map(d => `<div class="d dow">${d}</div>`).join("");
  for (let i = 0; i < first.getDay(); i++) cells += `<div class="d blank"></div>`;
  for (let d = 1; d <= last.getDate(); d++) {
    const k = ymd(new Date(y, m, d));
    cells += `<div class="d ${busy.has(k) ? "use" : ""} ${k === ymd(td) ? "today" : ""}">${d}</div>`;
  }
  const next = nextRes(v);
  return `<div class="cal"><div class="cal-head"><button type="button" class="pcal-nav" data-act="detMonth" data-val="-1"${detMonth <= 0 ? " disabled" : ""} aria-label="前の月">‹</button><h3>${y !== td.getFullYear() ? `${y}年` : ""}${m + 1}月の予定</h3><button type="button" class="pcal-nav" data-act="detMonth" data-val="1"${detMonth >= 12 ? " disabled" : ""} aria-label="次の月">›</button></div><div class="grid">${cells}</div>
  <div class="legend"><i></i>予約・使用中${next ? ` ／ 次の予約：${rangeText(next)} ${esc(next.who)}さん（${esc(next.site)}）` : ""}</div></div>`;
}

// この車のこれからの予約（使用中は除く）。取り消せるものには「取り消す」
function resList(v) {
  const t = ymd(today());
  const list = S.reservations.filter(r => r.vehicleId === v.id && !r.returnedAt && r.from > t).sort((a, b) => (a.from > b.from ? 1 : -1));
  if (!list.length) return "";
  return `<div class="reslist"><h3>この車の予約</h3>${list.map(r => `<div class="resrow"><div class="grow"><b>${rangeText(r)}</b><span>${esc(r.who)}さん　${esc(r.site)}</span></div>
    ${canCancel(r) ? `<button class="btn ghost small" data-act="cancelRes" data-id="${r.id}">取り消す</button>` : ""}</div>`).join("")}</div>`;
}

/* ---------- 予約 ---------- */
const SITE_OTHER = "__other";
const plateText = v => `${esc(v.plateArea)} ${esc(v.plateClass)} ${esc(v.plateKana)} ${esc(v.plateNum)}`;
// 同じ車で日付が重なる予約（返却済みは除く）
const effTo = r => (!r.returnedAt && r.to < ymd(today()) ? "9999-12-31" : r.to);
const findClash = (list, vid, from, to) => list.find(r => r.vehicleId === vid && !r.returnedAt && !r.canceled && r.from <= to && from <= effTo(r)) || null;
const clashMsg = r => (effTo(r) !== r.to
  ? `この車は返却予定（${fmt(r.to)}）を過ぎて、まだ返却されていません（${r.who}さん）。返却されるまで予約できません`
  : `その日は予約が入っています：${fmt(r.from)}〜${fmt(r.to)} ${r.who}さん（${r.site}）`);
class ClashError extends Error {}
// 車検中で予約できない日：出した日〜戻り予定日（戻り予定を過ぎても戻していなければ今日まで）。戻り予定日がなければ今日だけ
function inspBlock(v) {
  const x = v && v.inspection; if (!x) return null;
  const t = ymd(today());
  return x.until ? { from: x.from, to: x.until > t ? x.until : t } : { from: t, to: t };
}
const inspClash = (v, from, to) => { const b = inspBlock(v); return !!b && from <= b.to && b.from <= to; };
const inspMsg = v => `この車は車検中です${v.inspection.until ? `（戻り予定 ${fmt(v.inspection.until)}）` : ""}。その日は予約できません`;
const rangeText = r => (r.from === r.to ? fmt(r.from) : `${fmt(r.from)}〜${fmt(r.to)}`);
// 取り消せるのは、まだ始まっていない予約。スマホは予約した本人（使う人か予約した人）、PC（広い画面）は全部
const canCancel = r => r.from > ymd(today()) && (wide.matches || (!!ME && (r.who === ME || r.createdBy === ME)));
function cancelReservation(id) {
  const r = S.reservations.find(x => x.id === id); if (!r) return;
  if (!canCancel(r)) { toast("この予約は取り消せません"); return; }
  const v = byId(r.vehicleId);
  if (!confirm(`${rangeText(r)} ${v ? v.kind : ""}の予約を取り消しますか？`)) return;
  // データは消さずに「取り消し済み」の印と、取り消した人・日時を残す
  updateDoc(doc(db, "reservations", id), { canceled: true, canceledBy: ME || "事務所（PC）", canceledAt: serverTimestamp() })
    .catch(e => { console.error(e); toast("取り消せませんでした。もう一度お試しください", "err"); });
  toast("予約を取り消しました");
}
// 選んだ日を、続いている日ごとの予約（from〜to）にまとめる
function toRanges(days) {
  const out = [];
  [...days].sort().forEach(d => {
    const last = out[out.length - 1];
    if (last && ymd(addDays(parse(last.to), 1)) === d) last.to = d; else out.push({ from: d, to: d });
  });
  return out;
}
// この車で、もう予約・使用中の日（返却待ちは返却されるまでずっと）
function takenDays(vid) {
  const set = new Set(), limit = ymd(addDays(today(), 400));
  const b = inspBlock(byId(vid));
  if (b) for (let d = parse(b.from); ymd(d) <= b.to && ymd(d) <= limit; d.setDate(d.getDate() + 1)) set.add(ymd(d));
  S.reservations.filter(r => r.vehicleId === vid && !r.returnedAt).forEach(r => {
    const end = isOverdue(r) ? limit : r.to;
    for (let d = parse(r.from); ymd(d) <= end && ymd(d) <= limit; d.setDate(d.getDate() + 1)) set.add(ymd(d));
  });
  return set;
}
// 予約画面のカレンダー（押して選ぶ、もう一度押すと外れる。過去の日と、予約・使用中の日は押せない）
function pickCalendar(v) {
  const td = today(), t = ymd(td);
  const [y, m] = form.month;
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const taken = takenDays(v.id), sel = new Set(form.days);
  const atFirst = y === td.getFullYear() && m === td.getMonth();
  let cells = [..."日月火水木金土"].map(d => `<div class="pd dow">${d}</div>`).join("");
  for (let i = 0; i < first.getDay(); i++) cells += `<div class="pd blank"></div>`;
  for (let d = 1; d <= last.getDate(); d++) {
    const k = ymd(new Date(y, m, d)), past = k < t, busy = taken.has(k), on = sel.has(k);
    cells += `<button type="button" class="pd${on ? " on" : ""}${busy ? " taken" : ""}${past ? " past" : ""}${k === t ? " today" : ""}" data-act="pickDay" data-val="${k}"${past || busy ? " disabled" : ""} aria-pressed="${on}" aria-label="${m + 1}月${d}日${busy ? "（予約あり）" : ""}">${d}</button>`;
  }
  const days = [...form.days].sort();
  return `<div class="pcal">
    <div class="pcal-head"><button type="button" class="pcal-nav" data-act="calMonth" data-val="-1"${atFirst ? " disabled" : ""} aria-label="前の月">‹</button>
      <b>${y}年${m + 1}月</b><button type="button" class="pcal-nav" data-act="calMonth" data-val="1" aria-label="次の月">›</button></div>
    <div class="pcal-grid">${cells}</div>
    <div class="pcal-legend"><span><i class="lg-on"></i>選んだ日</span><span><i class="lg-taken"></i>予約・使用中</span></div>
    <div class="pcal-sel">${days.length ? `選んだ日：${days.map(fmt).join("、")}（${days.length}日）` : "予約する日を押して選んでください（何日でも選べます）"}</div>
  </div>`;
}

function reserveForm(v) {
  const t = ymd(today());
  if (form.vid !== v.id) { resetForm(); form.vid = v.id; }
  if (!form.days) form.days = [];
  if (!form.month) { const td = today(); form.month = [td.getFullYear(), td.getMonth()]; }
  form.site = form.site || "";
  const sites = S.settings.sites || [];
  const lic = licOf(v);
  return `<div class="sheet-title">${esc(v.kind)}</div><p class="sub">${plateText(v)}</p>
  ${lic !== "普通" ? `<div class="licwarn">⚠ この車は${lic}以上の免許が必要です<small>${esc(LICENSE_NOTE[lic])}</small></div>` : ""}
  <div class="field"><label>使う日（押して選ぶ。飛び飛びでもOK）</label>${pickCalendar(v)}</div>
  <div class="field"><label>使う人</label>${!form.other
    ? `<div class="mine"><span>${esc(ME)}さん（自分）</span><button class="sw" data-act="whoOther">別の人にする</button></div>`
    : (form.who && !form.picking
      ? `<div class="mine"><span>${esc(form.who)}さん</span><button class="sw" data-act="whoOther">変える</button></div><button class="chip" style="margin-top:8px" data-act="whoMe">自分に戻す</button>`
      : `<div class="picker"><input type="search" id="whoSearch" class="nsearch" placeholder="名前で探す" value="${esc(form.whoQ || "")}" autocomplete="off" aria-label="使う人を名前で探す">
          <div id="whoList">${nameChips(form.whoQ, form.who, "pickWho")}</div>
          <button class="chip" style="margin-top:4px" data-act="whoMe">自分に戻す</button></div>`)}</div>
  <div class="field"><label for="f-site">行く現場</label><select id="f-site" name="site"><option value="">選んでください</option>${sites.map(p => `<option value="${esc(p)}"${form.site === p ? " selected" : ""}>${esc(p)}</option>`).join("")}<option value="${SITE_OTHER}"${form.site === SITE_OTHER ? " selected" : ""}>その他（入力する）</option></select>
    ${form.site === SITE_OTHER ? `<input name="siteOther" style="margin-top:8px" placeholder="現場の名前を入力" maxlength="100" value="${esc(form.siteOther || "")}" aria-label="現場の名前">` : ""}</div>
  ${form.err ? `<p class="ferr">${esc(form.err)}</p>` : ""}
  <div class="actions"><button class="btn primary big" data-act="reserve" data-id="${v.id}"${form.busy ? " disabled" : ""}>${form.busy ? "予約しています…" : "予約する"}</button></div>`;
}

async function doReserve(v) {
  if (form.busy) return;
  if (!canReserve(v)) { form.err = `この車は${v.owner}さん専用です`; render(); return; }
  const t = ymd(today());
  const who = form.other ? (form.picking ? "" : (form.who || "")) : ME;
  const site = form.site === SITE_OTHER ? String(form.siteOther || "").trim() : form.site;
  const ranges = toRanges(form.days || []);
  let err = "";
  if (!ranges.length) err = "予約する日を選んでください";
  else if (ranges[0].from < t) err = "過ぎた日は予約できません";
  else if (!who || !site) err = "使う人と現場を選んでください";
  else if (ranges.some(g => inspClash(v, g.from, g.to))) err = inspMsg(v);
  else { for (const g of ranges) { const c = findClash(S.reservations, v.id, g.from, g.to); if (c) { err = clashMsg(c); break; } } }
  if (err) { form.err = err; render(); return; }

  form.err = ""; form.busy = true; render();
  const base = { vehicleId: v.id, who, site, createdBy: ME, returnedAt: null, returnedLot: null };
  try {
    // 2台のスマホで同時に予約しても重ならないよう、サーバーの最新の予約で確かめてから登録する
    await runTransaction(db, async tx => {
      const vref = doc(db, "vehicles", v.id);
      const vs = await tx.get(vref);
      if (!vs.exists() || vs.data().retired) throw new ClashError("この車は予約できません");
      const cur = vs.data();
      if (ranges.some(g => inspClash(cur, g.from, g.to))) throw new ClashError(inspMsg(cur));
      const snap = await getDocsFromServer(query(collection(db, "reservations"), where("vehicleId", "==", v.id), where("returnedAt", "==", null)));
      const list = snap.docs.map(d => d.data());
      for (const g of ranges) { const c = findClash(list, v.id, g.from, g.to); if (c) throw new ClashError(clashMsg(c)); }
      tx.update(vref, { resSeq: increment(1), updatedAt: serverTimestamp() });
      // 続いている日ごとに1つの予約。全部まとめて登録する（途中で1つだけ入ることはない）
      ranges.forEach(g => tx.set(doc(collection(db, "reservations")), { ...base, from: g.from, to: g.to, createdAt: serverTimestamp() }));
    });
  } catch (e) {
    console.error(e);
    form.busy = false;
    form.err = e instanceof ClashError ? e.message : "予約できませんでした。電波のよい所でもう一度押してください";
    if (ui.screen.name === "reserve") render();
    return;
  }
  resetForm();
  go({ name: "done", title: "予約しました", msg: `${ranges.map(rangeText).join("、")}　${who}さん　${site}` });
}

/* ---------- 自分が使用中の車（返し忘れ防止の帯） ---------- */
const dayLabel = s => { const d = parse(s); return `${d.getMonth() + 1}/${d.getDate()}（${DOW[d.getDay()]}）`; };
// 自分の予約のうち、始まっていて返却していないもの（返却予定を過ぎたものも含む）
function myUses() {
  const t = ymd(today());
  return S.reservations.filter(r => r.who === ME && !r.returnedAt && r.from <= t && byId(r.vehicleId) && !byId(r.vehicleId).retired)
    .sort((a, b) => (a.to > b.to ? 1 : a.to < b.to ? -1 : 0));
}
function myBar() {
  if (!ME || !S.ready) return "";
  const uses = myUses(); if (!uses.length) return "";
  const t = ymd(today());
  const next = S.reservations.filter(r => r.who === ME && !r.returnedAt && r.from > t && byId(r.vehicleId) && !byId(r.vehicleId).retired)
    .sort((a, b) => (a.from > b.from ? 1 : a.from < b.from ? -1 : 0))[0];
  return `<div class="mybar">${uses.map(r => {
    const v = byId(r.vehicleId), over = r.to < t;
    return `<div class="myuse${over ? " over" : ""}">
      <div class="mu-head">${over ? "⚠ 返却予定を過ぎています" : "あなたが使用中の車"}</div>
      <div class="mu-body"><div class="mu-info"><b>${esc(v.kind)}</b><span class="mu-plate">${plateText(v)}</span><span class="mu-to">${dayLabel(r.to)}まで</span></div>
        <button class="mu-btn" data-act="myReturn" data-id="${v.id}" data-val="${r.id}">返却する</button></div></div>`;
  }).join("")}${next ? `<div class="mynext-row"><button class="mynext" data-act="detail" data-id="${next.vehicleId}">次の予約：${rangeText(next)} ${esc(byId(next.vehicleId).kind)}<span>›</span></button>${canCancel(next) ? `<button class="mu-cancel" data-act="cancelRes" data-id="${next.id}">取り消す</button>` : ""}</div>` : ""}</div>`;
}

/* ---------- プッシュ通知（届く人は PC で選ぶ。本人はスマホでオフにできる） ---------- */
const NTYPES = [
  // 種類, PCの列の見出し, いつ, スマホのスイッチ
  ["shaken", "車検", () => `${alertDays()}日前 8時`, "車検が近い"],
  ["due", "返却予定日", () => "当日 17時", "今日が返却予定日"],
  ["overdue", "返却遅れ", () => "翌日 9時", "返却予定を過ぎた"],
  ["repair", "修理依頼", () => "すぐ", "修理依頼が来た"],
];
const TOKEN_KEY = "sharyo_push_token";
const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const isStandalone = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
const prefId = name => encodeURIComponent(name);
// PC でオンにされている通知（この人の分）と、本人がオフにしたもの
const adminOn = name => NTYPES.map(t => t[0]).filter(t => (S.notify[t] || []).includes(name));
const myOff = () => S.prefs.get(ME) || new Set();
// この端末の通知の状態
function pushState() {
  if (!VAPID_KEY) return "off"; // まだ準備できていない（公開鍵が入っていない）
  if (isIOS && !isStandalone()) return "ios-browser"; // iPhone はホーム画面に追加したときだけ通知が届く
  if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  return Notification.permission === "granted" && lsGet(TOKEN_KEY) ? "on" : "ask";
}
let messaging = null;
function getMessagingMod() {
  if (!messaging) messaging = import(`${SDK}/firebase-messaging.js`)
    .then(async m => ((await m.isSupported()) ? { m, inst: m.getMessaging(fbApp) } : null))
    .catch(e => { console.warn(e); messaging = null; return null; });
  return messaging;
}
// この端末の通知トークンを取り、名前とひもづけて保存する（前のトークンは片づける）
async function saveToken() {
  const ms = await getMessagingMod(); if (!ms || !ME) return false;
  await navigator.serviceWorker.register("./sw.js");
  const reg = await navigator.serviceWorker.ready; // 動き出してからでないとトークンを取れない
  const token = await ms.m.getToken(ms.inst, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) return false;
  const old = lsGet(TOKEN_KEY);
  setDoc(doc(db, "pushTokens", token), { name: ME, platform: isIOS ? "ios" : (/Android/.test(navigator.userAgent) ? "android" : "pc"), updatedAt: serverTimestamp() })
    .catch(e => console.warn("通知の端末を保存できません", e));
  if (old && old !== token) deleteDoc(doc(db, "pushTokens", old)).catch(() => {});
  lsSet(TOKEN_KEY, token);
  return true;
}
// 「🔔 通知をオンにする」：許可のダイアログを出す（iPhone では押した直後に呼ぶ必要がある）
function enablePush() {
  const ask = Notification.permission === "granted" ? Promise.resolve("granted") : Notification.requestPermission();
  ask.then(async p => {
    if (p !== "granted") { toast("通知は許可されませんでした"); render(); return; }
    let ok = false;
    try { ok = await saveToken(); } catch (e) { console.error(e); }
    toast(ok ? "通知をオンにしました" : "通知をオンにできませんでした。電波のよい所でもう一度押してください", ok ? "" : "err");
    render();
  });
}
// 本人のオン・オフ（スマホの「🔔 通知」画面）
function setMyPref(type, on) {
  const off = new Set(myOff()); on ? off.delete(type) : off.add(type); S.prefs.set(ME, off); // すぐ画面に出す
  setDoc(doc(db, "notifyPrefs", prefId(ME)), { name: ME, off: on ? arrayRemove(type) : arrayUnion(type), updatedAt: serverTimestamp() }, { merge: true })
    .catch(e => { console.error(e); toast("変更できませんでした。もう一度お試しください", "err"); });
}
// 車両一覧のいちばん上：PC でオンにされているのに、この端末でまだ許可していない人に出す
function pushBar() {
  if (!S.notifyLoaded || !adminOn(ME).some(t => !myOff().has(t))) return "";
  const st = pushState();
  if (st === "ask") return `<button class="pushbtn" data-act="pushOn">🔔 通知をオンにする</button>`;
  if (st === "ios-browser") return `<p class="pushnote">ホーム画面に追加すると通知が届きます</p>`;
  return "";
}
function notifyScreen() {
  const types = NTYPES.filter(t => adminOn(ME).includes(t[0]));
  if (!S.notifyLoaded) return `<div class="loading">読み込み中…</div>`;
  if (!types.length) return `<div class="empty">届く通知はありません</div>`;
  const st = pushState(), off = myOff();
  const top = st === "ask" ? `<button class="pushbtn" data-act="pushOn">🔔 通知をオンにする</button>`
    : st === "ios-browser" ? `<p class="pushnote">ホーム画面に追加すると通知が届きます</p>`
    : st === "denied" ? `<p class="pushnote">この端末では通知が止められています。端末の設定で許可してください</p>`
    : st === "unsupported" ? `<p class="pushnote">この端末では通知を使えません</p>` : "";
  return top + `<div class="nsw">${types.map(([k, , , label]) => `
    <label class="nsw-row"><span>${label}</span><input type="checkbox" role="switch" class="switch-in" data-pref="${k}"${off.has(k) ? "" : " checked"}></label>`).join("")}</div>`;
}

/* ---------- 返却 ---------- */
function returnForm(v) {
  return `<div class="sheet-title">どこに止めましたか？</div><p class="sub">${esc(v.kind)}　${esc(v.plateKana)} ${esc(v.plateNum)}</p>
  <div class="opts${(S.settings.lots || []).length > 3 ? " compact" : ""}">${(S.settings.lots || []).filter(Boolean).slice(0, LOT_MAX).map(l => `<button class="opt" data-act="return" data-id="${v.id}" data-val="${esc(l)}" data-rid="${esc(ui.screen.rid || "")}">${esc(l)}<span>›</span></button>`).join("")}</div>`;
}
function doReturn(v, lot, rid) {
  const use = rid ? S.reservations.find(r => r.id === rid && !r.returnedAt) : currentUse(v);
  if (!use) { toast("この車はもう返却されています"); go({ name: "detail", id: v.id }); return; }
  // 押した瞬間に返却完了（電波が悪くても、つながったときに送られる）
  const b = writeBatch(db);
  b.update(doc(db, "reservations", use.id), { returnedAt: serverTimestamp(), returnedLot: lot });
  b.update(doc(db, "vehicles", v.id), { currentLot: lot, updatedAt: serverTimestamp() });
  b.commit().catch(e => { console.error(e); toast("返却を記録できませんでした。もう一度お試しください"); });
  go({ name: "done", title: "返却しました", msg: `${lot} に置いてある、と記録しました` });
}

/* ---------- 修理依頼 ---------- */
const SYMPTOMS = ["エンジン警告灯", "異音がする", "タイヤ", "ブレーキ", "エアコン", "傷・へこみ", "その他"];
const REPAIR_TAG = { open: ["", "未対応"], in_repair: ["inrep", "修理中"], done: ["done", "対応済み"] };
const MAX_REPAIR_PHOTOS = 10;
const openCount = () => S.repairs.filter(r => r.status === "open").length;
const repairDate = r => { const d = r.createdAt && r.createdAt.toDate ? r.createdAt.toDate() : new Date(); return `${d.getMonth() + 1}/${d.getDate()}`; };
const repairKind = r => { const v = byId(r.vehicleId); return v ? esc(v.kind) : "（削除された車）"; };
// 未対応・修理中を上に、それぞれ新しい順
const sortedRepairs = list => [...list].sort((a, b) => ((a.status === "done") - (b.status === "done")) || (millis(b.createdAt) - millis(a.createdAt)));

function listRepairs() {
  if (!S.ready) return `<div class="loading">読み込み中…</div>`;
  if (!S.repairs.length) return `<div class="empty">修理依頼はありません</div>`;
  return sortedRepairs(S.repairs).map(r => {
    const [cls, label] = REPAIR_TAG[r.status] || REPAIR_TAG.open;
    return `
  <div class="li"><div class="grow"><div class="t">${esc(repairText(r))}</div><div class="s">${repairKind(r)}　${repairDate(r)}　${esc(r.reportedBy || "")}</div></div>
    <span class="tag ${cls}">${label}</span></div>`;
  }).join("");
}

// 「修理を頼む」の入力中の内容
const rform = { vid: null, sym: new Set(), memo: "", photos: [], err: "", busy: false, pct: 0 };
function resetRform(vid) {
  rform.photos.forEach(p => URL.revokeObjectURL(p.url));
  Object.assign(rform, { vid, sym: new Set(), memo: "", photos: [], err: "", busy: false, pct: 0 });
}
function repairForm(v) {
  if (rform.vid !== v.id) resetRform(v.id);
  return `<div class="sheet-title">${esc(v.kind)}</div><p class="sub">${plateText(v)}</p>
  <div class="field"><label>どこが悪い？（複数OK）</label><div class="sympt">${SYMPTOMS.map(x => `<button class="chip ${rform.sym.has(x) ? "on" : ""}" data-act="sym" data-val="${x}">${x}</button>`).join("")}</div></div>
  <div class="field"><label for="r-memo">くわしく（任意）</label><textarea id="r-memo" name="memo" rows="3" maxlength="2000" placeholder="例：右に曲がるときにゴトゴト鳴る">${esc(rform.memo)}</textarea></div>
  <div class="field">${rform.photos.length < MAX_REPAIR_PHOTOS
    ? `<label class="photo-box">📷 写真をつける${rform.photos.length ? `（${rform.photos.length}枚）` : ""}<input type="file" id="r-photo" accept="image/*,.heic,.heif" multiple hidden></label>` : ""}
    ${rform.photos.length ? `<div class="rphotos">${rform.photos.map((p, i) => `<div class="rphoto"><img src="${p.url}" alt=""><button class="rm" data-act="rmPhoto" data-val="${i}" aria-label="この写真をはずす">×</button></div>`).join("")}</div>` : ""}</div>
  ${rform.err ? `<p class="ferr">${esc(rform.err)}</p>` : ""}
  <div class="actions"><button class="btn primary big" data-act="sendRepair" data-id="${v.id}"${rform.busy ? " disabled" : ""}>${rform.busy ? (rform.photos.length ? `写真を送っています… ${rform.pct}%` : "送っています…") : "修理を頼む"}</button></div>`;
}
function toggleSym(x) { if (rform.busy) return; rform.sym.has(x) ? rform.sym.delete(x) : rform.sym.add(x); rform.err = ""; render(); }
function addRepairPhotos(files) {
  for (const f of files || []) {
    if (rform.photos.length >= MAX_REPAIR_PHOTOS) { toast(`写真は${MAX_REPAIR_PHOTOS}枚までです`); break; }
    if (f.type && !f.type.startsWith("image/")) continue;
    rform.photos.push({ file: f, url: URL.createObjectURL(f) });
  }
  render();
}
function removeRepairPhoto(i) {
  if (rform.busy) return;
  const p = rform.photos.splice(i, 1)[0]; if (p) URL.revokeObjectURL(p.url);
  render();
}

async function doRepair(v) {
  if (rform.busy) return;
  const memo = rform.memo.trim();
  if (!rform.sym.size && !memo) { rform.err = "どこが悪いか選んでください"; render(); return; }
  rform.err = ""; rform.busy = true; rform.pct = 0; render();
  const ref = doc(collection(db, "repairs"));
  let photos = [];
  try {
    if (rform.photos.length) {
      photos = await uploadRepairPhotos(ref.id, rform.photos.map(p => p.file), pct => {
        rform.pct = pct;
        const b = document.querySelector('[data-act="sendRepair"]'); if (b) b.textContent = `写真を送っています… ${pct}%`;
      });
    }
  } catch (e) {
    console.error(e);
    rform.busy = false; rform.err = "写真を送れませんでした。電波のよい所でもう一度押してください";
    if (ui.screen.name === "repair") render();
    return;
  }
  // 頼んだ人は自分の名前。出しただけでは「修理中」にしない（事務所が決める）
  setDoc(ref, {
    vehicleId: v.id, symptoms: SYMPTOMS.filter(x => rform.sym.has(x)), memo,
    photoUrls: photos.map(p => p.photoUrl), photos, reportedBy: ME, status: "open",
    createdAt: serverTimestamp(), doneAt: null,
  }).catch(e => { console.error(e); toast("修理依頼を送れませんでした。もう一度お試しください"); });
  resetRform(null);
  go({ name: "done", title: "修理を頼みました", msg: "事務所に届きました" });
}

// PC: 修理依頼の処理
function setRepairStatus(id, st) {
  const r = S.repairs.find(x => x.id === id); if (!r) return;
  const data = { status: st, updatedAt: serverTimestamp() };
  if (st === "in_repair") data.inRepairAt = serverTimestamp();
  if (st === "done") data.doneAt = serverTimestamp();
  updateDoc(doc(db, "repairs", id), data).catch(e => { console.error(e); toast("変更できませんでした。もう一度お試しください"); });
  toast(st === "in_repair" ? "修理中にしました" : (r.status === "in_repair" ? "修理完了にしました" : "対応済みにしました"));
}

function doneScreen(sc) {
  return `<div class="done"><div class="ok">✓</div><h2>${esc(sc.title)}</h2><p>${esc(sc.msg)}</p>
  <button class="btn primary" data-act="tab" data-val="cars">車両一覧へ戻る</button></div>`;
}

/* ================= PC版ダッシュボード ================= */
/* ---------- PC の表示の状態（絞り込み・グループの開閉・パネルの開閉。開き直しても覚えておく） ---------- */
const pcUi = (() => {
  const def = { filter: "all", type: "all", groups: { use: true, free: false, own: false, fix: true, insp: true }, panels: { shaken: false, repair: false, future: false } };
  let p = {}; try { p = JSON.parse(lsGet("sharyo_pc_ui") || "{}") || {}; } catch (e) { p = {}; }
  return { filter: p.filter || def.filter, type: p.type || def.type, groups: { ...def.groups, ...(p.groups || {}) }, panels: { ...def.panels, ...(p.panels || {}) } };
})();
const savePcUi = () => lsSet("sharyo_pc_ui", JSON.stringify(pcUi));
const PC_FILTERS = [["all", "全部"], ["free", "空き"], ["use", "使用中"], ["fix", "修理中"], ["insp", "車検中"], ["own", "専用"]];
const PANEL_LIMIT = 3;
// パネルの中身を3件まで出し、残りは「＋ ほか○台を表示」で開く
function foldList(key, items, unit) {
  const open = !!pcUi.panels[key], hidden = items.length - PANEL_LIMIT;
  return {
    shown: open ? items : items.slice(0, PANEL_LIMIT),
    more: hidden > 0 ? `<button class="more" data-act="pcPanel" data-val="${key}" aria-expanded="${open}">${open ? `− ${PANEL_LIMIT}${unit}だけ表示` : `＋ ほか${hidden}${unit}を表示`}</button>` : "",
  };
}

function renderPc() {
  const vs = shown(), d = today();
  const n = k => vs.filter(v => groupOf(v) === k).length;
  const retired = S.vehicles.filter(v => v.retired);
  const hiddenV = active().filter(v => v.hidden);
  const hasSample = S.vehicles.some(v => v.sample);

  let table;
  if (!S.ready) table = `<div class="loading">読み込み中…</div>`;
  else if (!vs.length) table = `<div class="empty">まだ車が登録されていません。「＋ 車両を追加」から登録してください${
    !S.vehicles.length ? `<div style="margin-top:12px"><button class="btn ghost small" data-act="seed">サンプルデータ（8台）を入れて試す</button></div>` : ""}</div>`;
  else {
    const typeOK = v => pcUi.type === "all" || v.type === pcUi.type;
    const stOK = v => (["fix", "insp"].includes(pcUi.filter) ? status(v) === pcUi.filter : matchFilter(v, pcUi.filter));
    const byType = vs.filter(typeOK), list = byType.filter(stOK);
    const n1 = k => byType.filter(v => (["fix", "insp"].includes(k) ? status(v) === k : matchFilter(v, k))).length;
    const n2 = t => vs.filter(v => (t === "all" || v.type === t) && stOK(v)).length;
    const tabs = `<div class="pcfilter"><div class="chips six">${PC_FILTERS.map(([k, l]) =>
      `<button class="chip ${pcUi.filter === k ? "on" : ""}" data-act="pcFilter" data-val="${k}">${l}<span class="n">${n1(k)}</span></button>`).join("")}</div>
      <div class="chips types four">${[["all", "全種類"], ...TYPES.map(t => [t, t])].map(([k, l]) =>
      `<button class="chip ${pcUi.type === k ? "on" : ""}" data-act="pcType" data-val="${k}">${l}<span class="n">${n2(k)}</span></button>`).join("")}</div></div>`;
    table = tabs + (!list.length ? `<div class="empty">この条件の車はありません</div>` : `<table class="table"><thead><tr><th>状態</th><th>写真</th><th>ナンバー</th><th>車種</th><th>使っている人</th><th>現場</th><th>置き場所</th><th>車検</th></tr></thead><tbody>
      ${["use", "free", "own", "fix", "insp"].map(g => {
        const rows = list.filter(v => groupOf(v) === g); if (!rows.length) return "";
        const open = !!pcUi.groups[g];
        return `<tr class="grp ${g}${open ? "" : " closed"}" data-act="pcGroup" data-val="${g}" tabindex="0" role="button" aria-expanded="${open}" title="押すと${open ? "閉じます" : "開きます"}"><td colspan="8"><span class="caret">${open ? "▼" : "▶"}</span>${LABEL[g]}<span>${rows.length}台</span>${g === "use" && rows.some(v => isOverdue(currentUse(v))) ? `<span class="tag overdue">うち返却待ち ${rows.filter(v => isOverdue(currentUse(v))).length}台</span>` : ""}</td></tr>` + (!open ? "" : rows.map(v => {
          const insp = g === "insp", use = insp ? null : currentUse(v), over = isOverdue(use);
          return `<tr class="vrow ${g}${over ? " over" : ""}" data-act="edit" data-id="${v.id}" title="押すと修正できます">
        <td class="st"><span class="dot ${g}"></span>${LABEL[g]}${over ? '<div><span class="tag overdue">返却待ち</span></div>' : ""}</td>
        <td>${thumbHtml(v, false, true)}</td><td>${plateHtml(v, true)}</td><td class="kind">${esc(v.kind)}${vehicleTags(v)}</td>
        <td>${use ? esc(use.who) : "—"}</td><td>${use ? `${esc(use.site)}<div class="s${over ? " overdue-s" : ""}" style="font-size:12px">${fmt(use.from)}〜${fmt(use.to)}${over ? "（返却予定を過ぎています）" : ""}</div>` : insp ? `車検<div class="s" style="font-size:12px">${inspText(v.inspection)}</div>` : "—"}</td>
        <td>${use || insp ? "—" : esc(lotOf(v))}</td><td>${shakenDays(v, ' style="font-size:13px"')}</td></tr>`;
        }).join(""));
      }).join("")}
      </tbody></table>`);
  }

  $("pc").innerHTML = `
  <div class="top"><h1>社用車 今日の状況</h1><span class="today">${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${DOW[d.getDay()]}）</span>
    <div class="counts"><div class="count free">${n("free")}<span>空き</span></div><div class="count use">${n("use")}<span>使用中</span></div><div class="count fix">${n("fix")}<span>修理中</span></div><div class="count insp">${n("insp")}<span>車検中</span></div></div>
    <button class="btn ghost small" data-act="settings">⚙ 設定</button></div>
  ${errBar()}
  <div class="grid2">
    <div class="stack">
      ${shakenPanel()}
      ${repairPanel()}
      ${futurePanel()}
    </div>
    <div class="panel wide"><h2>全車両 <button class="btn primary small" data-act="add">＋ 車両を追加</button></h2>${table}</div>
    ${hiddenV.length ? `<details class="panel retired hiddenv"${ui.hiddenOpen ? " open" : ""}><summary>非表示中（${hiddenV.length}台）</summary>
      <table class="table"><tbody>${hiddenV.map(v => `<tr>
        <td>${thumbHtml(v)}</td><td>${plateHtml(v, true)}</td><td class="kind">${esc(v.kind)}${vehicleTags(v)}</td><td>${esc(v.type)}</td>
        <td style="text-align:right"><button class="btn ghost small" data-act="unhide" data-id="${v.id}">表示に戻す</button></td></tr>`).join("")}</tbody></table>
    </details>` : ""}
    ${retired.length ? `<details class="panel retired"${ui.retiredOpen ? " open" : ""}><summary>廃車済み（${retired.length}台）</summary>
      <table class="table"><tbody>${retired.map(v => `<tr>
        <td>${thumbHtml(v)}</td><td>${plateHtml(v, true)}</td><td class="kind">${esc(v.kind)}</td><td>${esc(v.type)}</td>
        <td style="text-align:right"><button class="btn ghost small" data-act="restore" data-id="${v.id}">戻す</button></td></tr>`).join("")}</tbody></table>
    </details>` : ""}
  </div>
  ${hasSample ? `<p class="sample-note">サンプルデータが入っています。本番の車を登録する前に <button class="linkbtn" data-act="unseed">サンプルデータを消す</button></p>` : ""}`;
}

/* ---------- 写真（ブラウザで縮小してから Storage へ送る） ---------- */
const PHOTO_MAX = 1280, THUMB_MAX = 480;

// 画像を読み込む（スマホで縦に撮った写真の向きも正しく直す）
async function decodeImage(file) {
  if (window.createImageBitmap) {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch (e) { /* 下の方法で読む */ }
  }
  const url = URL.createObjectURL(file);
  try {
    return await new Promise((ok, ng) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ng(new Error("画像を読めません")); i.src = url; });
  } finally { URL.revokeObjectURL(url); }
}
// iPhone の HEIC 写真は、パソコンの Chrome / Edge では読めない。そのときだけ変換の部品（heic-to。新しい iPhone の HEIC にも対応）を読み込んで JPEG にする
const HEIC_LIB_URL = "https://cdn.jsdelivr.net/npm/heic-to@1.5.2/dist/iife/heic-to.js";
const isHeic = f => /image\/hei[cf]/i.test(f.type || "") || /\.(heic|heif)$/i.test(f.name || "");
let heicLib = null;
function loadHeicLib() {
  if (!heicLib) heicLib = new Promise((ok, ng) => {
    if (window.HeicTo) return ok(window.HeicTo);
    const sc = document.createElement("script"); sc.src = HEIC_LIB_URL; sc.async = true;
    sc.onload = () => (window.HeicTo ? ok(window.HeicTo) : ng(new Error("heic-lib")));
    sc.onerror = () => { heicLib = null; ng(new Error("heic-lib")); };
    document.head.appendChild(sc);
  });
  return heicLib;
}
// 写真を読み込む。読めない形式なら Error("bad-image")、HEIC の変換部品が読めなければ Error("heic-lib")
async function readPhoto(file) {
  if (file.type && !file.type.startsWith("image/") && !isHeic(file)) throw new Error("bad-image");
  try { return await decodeImage(file); } catch (e) { if (!isHeic(file)) throw new Error("bad-image"); }
  const HeicTo = await loadHeicLib();
  let jpeg;
  try { jpeg = await HeicTo({ blob: file, type: "image/jpeg", quality: 0.9 }); }
  catch (e) { console.error(e); throw new Error("bad-image"); }
  try { return await decodeImage(jpeg); } catch (e) { throw new Error("bad-image"); }
}
const photoErrMsg = e => (e && e.message === "bad-image" ? "この形式の写真は使えません。JPEGかPNGを選んでください"
  : e && e.message === "heic-lib" ? "iPhoneの写真（HEIC）を変換できませんでした。電波のよい所でもう一度選ぶか、JPEGかPNGを選んでください"
  : "写真を送れませんでした。電波のよい所でもう一度お試しください");

// 長い辺が max px になるよう縮めて JPEG にする
function toJpeg(img, max, quality) {
  const w0 = img.naturalWidth || img.width, h0 = img.naturalHeight || img.height;
  const k = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement("canvas");
  c.width = Math.round(w0 * k); c.height = Math.round(h0 * k);
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); // 透明な部分は白に
  g.drawImage(img, 0, 0, c.width, c.height);
  return new Promise((ok, ng) => c.toBlob(b => (b ? ok(b) : ng(new Error("画像を変換できません"))), "image/jpeg", quality));
}
function uploadBlob(path, blob, onBytes) {
  return new Promise((ok, ng) => {
    const task = uploadBytesResumable(storageRef(storage, path), blob, { contentType: "image/jpeg", cacheControl: "public,max-age=31536000" });
    task.on("state_changed", s => onBytes(s.bytesTransferred), ng, () => getDownloadURL(task.snapshot.ref).then(ok, ng));
  });
}
// 1枚の写真から「大（1280px）」と「一覧用の小（480px）」を作って送る。dir は "vehicles/{id}" など
async function makePhotos(file, dir, onProgress) {
  const img = await readPhoto(file);
  let big, small;
  try { big = await toJpeg(img, PHOTO_MAX, 0.85); small = await toJpeg(img, THUMB_MAX, 0.8); }
  finally { if (img.close) img.close(); }
  const name = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const photoPath = `${dir}/${name}.jpg`, thumbPath = `${dir}/${name}_s.jpg`;
  const sent = [0, 0], total = big.size + small.size;
  const report = () => onProgress && onProgress(Math.min(99, Math.round((sent[0] + sent[1]) / total * 100)));
  const [photoUrl, thumbUrl] = await Promise.all([
    uploadBlob(photoPath, big, n => { sent[0] = n; report(); }),
    uploadBlob(thumbPath, small, n => { sent[1] = n; report(); }),
  ]);
  return { photoUrl, thumbUrl, photoPath, thumbPath };
}

// 車両の写真を登録・変更（スマホの車両詳細と、PCの車両の修正・追加から）
const uploading = {}; // 車ID → 送信中の％
function photoBtn(v) {
  const pct = uploading[v.id];
  if (pct != null) return `<span class="photo-btn busy" data-upl="${v.id}">📷 送っています… ${pct}%</span>`;
  return `<label class="photo-btn">📷 ${v.photoUrl ? "写真を変える" : "写真を登録"}<input type="file" accept="image/*,.heic,.heif" hidden data-photo="${v.id}"></label>`;
}
async function setVehiclePhoto(vid, file) {
  if (uploading[vid] != null) { toast("この車の写真を送っているところです"); return; }
  const old = byId(vid) || {};
  const oldPaths = [old.photoPath, old.thumbPath].filter(Boolean);
  uploading[vid] = 0; refresh();
  if (ui.view === "pc") toast("写真を送っています…");
  try {
    const p = await makePhotos(file, `vehicles/${vid}`, pct => {
      uploading[vid] = pct;
      document.querySelectorAll(`[data-upl="${vid}"]`).forEach(el => { el.textContent = `📷 送っています… ${pct}%`; });
      if (ui.view === "pc") toast(`写真を送っています… ${pct}%`);
    });
    await updateDoc(doc(db, "vehicles", vid), { ...p, updatedAt: serverTimestamp() });
    oldPaths.forEach(x => deleteObject(storageRef(storage, x)).catch(() => {})); // 前の写真は片づける
    toast("写真を登録しました");
  } catch (e) {
    console.error(e);
    toast(photoErrMsg(e), "err"); // 失敗したら赤いお知らせを長めに出す
  } finally {
    delete uploading[vid]; refresh();
  }
}

// 修理依頼の写真（段階4の「修理を頼む」画面で使う）
// 例: const photos = await uploadRepairPhotos(repairRef.id, files, pct => …);
//     → [{ photoUrl, thumbUrl, photoPath, thumbPath }, …] を repairs/{id}.photos に保存する
async function uploadRepairPhotos(repairId, files, onProgress) {
  const list = [...files], out = [];
  for (let i = 0; i < list.length; i++) {
    out.push(await makePhotos(list[i], `repairs/${repairId}`, pct => onProgress && onProgress(Math.round((i + pct / 100) / list.length * 100))));
  }
  return out;
}

// PC: 車検が近い車（60日以内。通知日数を60日より長くしたときはその日数まで）
function shakenPanel() {
  const lim = Math.max(60, alertDays());
  const soon = byShaken(shown().filter(v => daysTo(v.shakenDate) <= lim));
  const f = foldList("shaken", soon, "台");
  return `<div class="panel"><h2>車検が近い車 <span class="tag">${soon.length}台</span></h2>
    ${soon.length ? f.shown.map(v => `<div class="li tap" data-act="edit" data-id="${v.id}" title="押すと車検満了日を変えられます">${plateHtml(v, true)}<div class="grow"><div class="t">${esc(v.kind)}</div><div class="s">${jp(v.shakenDate)}</div></div>${shakenDays(v)}</div>`).join("")
      + f.more : `<div class="empty">${lim}日以内の車検はありません</div>`}
  </div>`;
}
// PC: この先の予約（今日より後、日付順）
function futurePanel() {
  const t = ymd(today());
  const list = S.reservations.filter(r => !r.returnedAt && r.from > t && byId(r.vehicleId) && !byId(r.vehicleId).retired && !byId(r.vehicleId).hidden)
    .sort((a, b) => (a.from > b.from ? 1 : a.from < b.from ? -1 : 0));
  const f = foldList("future", list, "件");
  return `<div class="panel"><h2>この先の予約 <span class="tag plain">${list.length}件</span></h2>
    ${f.shown.map(r => { const v = byId(r.vehicleId); return `<div class="li"><div class="days" style="background:var(--bg);color:var(--ink)">${rangeText(r)}</div><div class="grow"><div class="t">${esc(v.kind)}</div><div class="s">${esc(r.who)}さん　${esc(r.site)}</div></div><button class="btn ghost small" data-act="cancelRes" data-id="${r.id}">取り消す</button></div>`; }).join("") + f.more || `<div class="empty">予約はありません</div>`}
  </div>`;
}

// PC: 修理依頼パネル（未対応と修理中。対応済みは出さない）
function repairPanel() {
  const list = sortedRepairs(S.repairs.filter(r => r.status !== "done" && !(byId(r.vehicleId) || {}).hidden))
    .sort((a, b) => (a.status === "in_repair") - (b.status === "in_repair")); // 未対応を上に
  const n = openCount(), f = foldList("repair", list, "件");
  return `<div class="panel rpanel"><h2>修理依頼 <span class="tag">${n}件 未対応</span></h2>
    ${list.length ? f.shown.map(r => {
      const photos = r.photos || [];
      const btns = r.status === "in_repair"
        ? `<button class="btn free small" data-act="repairSet" data-id="${r.id}" data-val="done">修理完了（空きに戻す）</button>`
        : `<button class="btn ghost small" data-act="repairSet" data-id="${r.id}" data-val="done">対応済みにする</button>
           <button class="btn danger small" data-act="repairSet" data-id="${r.id}" data-val="in_repair">修理中にする</button>`;
      return `<div class="li"><div class="grow">
          <div class="t">${r.status === "in_repair" ? '<span class="tag inrep">修理中</span> ' : ""}${esc(repairText(r))}</div>
          <div class="s">${repairKind(r)}　${repairDate(r)}　${esc(r.reportedBy || "")}</div>
          ${photos.length ? `<div class="rthumbs">${photos.map(p => `<a href="${esc(p.photoUrl)}" target="_blank" rel="noopener" title="大きく見る"><img src="${esc(p.thumbUrl || p.photoUrl)}" alt="修理の写真" loading="lazy"></a>`).join("")}</div>` : ""}
        </div><div class="rbtns">${btns}</div></div>`;
    }).join("") + f.more : `<div class="empty">未対応の依頼はありません</div>`}
  </div>`;
}

/* ---------- 車両の登録・修正（PCのみ） ---------- */
let modalId = null; // null=追加, 文字列=修正中の車
function openModal(id) {
  const v = id ? byId(id) : null;
  modalId = v ? v.id : null;
  const lots = [...S.settings.lots];
  [v && v.homeLot, v && v.currentLot].forEach(l => { if (l && !lots.includes(l)) lots.push(l); });
  const val = k => esc(v ? v[k] : "");
  $("modal").innerHTML = `<div class="overlay"><form class="modal panel" id="vform" novalidate>
    <h2>${v ? "車両を修正" : "車両を追加"}<button type="button" class="x" data-act="close" aria-label="閉じる">×</button></h2>
    <div class="mbody">
      <div class="mhero">
        <div id="f-prev">${formPhotoHtml(v && v.photoUrl, v)}</div>
        ${v ? plateHtml(v) : ""}
        <label class="photo-btn">📷 ${v && v.photoUrl ? "写真を変える" : "写真を登録"}<input type="file" accept="image/*,.heic,.heif" hidden id="f-photo"></label>
      </div>
      <p class="ferr" id="ferr" hidden></p>
      <div class="field"><label>ナンバー</label>
        <div class="plate-in">
          <input name="plateArea" value="${val("plateArea")}" placeholder="愛媛" aria-label="地域" autocomplete="off">
          <input name="plateClass" value="${val("plateClass")}" placeholder="300" aria-label="分類番号" inputmode="numeric" autocomplete="off">
          <input name="plateKana" value="${val("plateKana")}" placeholder="あ" aria-label="ひらがな" maxlength="1" autocomplete="off">
          <input name="plateNum" value="${val("plateNum")}" placeholder="12-34" aria-label="番号" autocomplete="off">
        </div>
        <div class="hint">地域・分類番号・ひらがな・番号（例：愛媛 300 あ 12-34）</div></div>
      <div class="field"><label for="f-kind">車種</label><input id="f-kind" name="kind" value="${val("kind")}" placeholder="例：ハイエース（バン）" autocomplete="off"></div>
      <div class="field"><label>種類</label><div class="seg">${TYPES.map(t =>
        `<label class="chip"><input type="radio" name="type" value="${t}"${v && v.type === t ? " checked" : ""}>${t}</label>`).join("")}</div></div>
      <div class="field"><label for="f-shaken">車検満了日</label><input id="f-shaken" type="date" name="shakenDate" value="${val("shakenDate")}">
        ${v ? `<div class="hint">車検を受けたら、新しい満了日に変えて保存してください</div>` : ""}</div>
      <div class="field"><label for="f-lic">必要な免許</label><select id="f-lic" name="license">
        ${LICENSES.map(l => `<option${(v ? licOf(v) : "普通") === l ? " selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="field"><label for="f-owner">専用（任意）</label><select id="f-owner" name="owner">
        <option value="">（なし：だれでも使える）</option>
        ${MGROUPS.map(g => { const names = activeMembers().filter(m => mGroupOf(m) === g).map(m => m.name).sort(byLen);
          return names.length ? `<optgroup label="${g}">${names.map(n => `<option${v && v.owner === n ? " selected" : ""}>${esc(n)}</option>`).join("")}</optgroup>` : ""; }).join("")}
        ${v && v.owner && !activeMembers().some(m => m.name === v.owner) ? `<option selected>${esc(v.owner)}</option>` : ""}</select></div>
      <div class="field"><label for="f-lot">置き場所</label><select id="f-lot" name="lot">
        ${lots.map(l => `<option${(v ? lotOf(v) === l : l === lots[0]) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
    </div>
    <div class="mfoot">
      ${v ? `<button type="button" class="btn danger" data-act="retire">廃車にする</button><button type="button" class="btn ghost" data-act="hideCar">${v.hidden ? "表示に戻す" : "一時的に隠す"}</button>
        <button type="button" class="btn insp" data-act="${v.inspection ? "inspBack" : "inspOut"}" data-id="${v.id}">${v.inspection ? "車検から戻す" : "車検に出す"}</button>` : ""}
      <span class="sp"></span>
      <button type="button" class="btn ghost" data-act="close">やめる</button>
      <button type="submit" class="btn primary">${v ? "保存する" : "登録する"}</button>
    </div>
  </form></div>`;
  $("modal").hidden = false;
  loadImages($("modal"));
  $("vform").plateArea.focus();
}
// フォームの上の大きい写真。url があれば押すと画面いっぱいに開く。なければ車のイラスト
function formPhotoHtml(url, v) {
  const first = v && v.thumbUrl && url === v.photoUrl ? v.thumbUrl : url; // 小さい写真をすぐ出して、大きい写真に差し替える
  return url
    ? `<div class="mhero-img zoomable" data-act="viewPhoto" data-val="${esc(url)}" role="button" tabindex="0" aria-label="写真を大きく見る"><img src="${esc(first)}"${first !== url ? ` data-full="${esc(url)}"` : ""} alt="" decoding="async"></div>`
    : `<div class="mhero-img empty" aria-hidden="true">${carSvg(v ? carColor(v) : CAR_COLORS[0])}</div>`;
}
let pendingPhoto = null; // フォームで選んだ写真（保存するときに送る）
function closeModal() {
  $("modal").hidden = true; $("modal").innerHTML = ""; modalId = null;
  if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.preview);
  pendingPhoto = null;
}

/* ---------- 設定（PCのみ） ---------- */
const LOT_MAX = 5; // 駐車場は5ヶ所まで（空欄は使わない）
function openSettings() {
  const st = S.settings;
  const lines = a => esc((a || []).join("\n"));
  const lots = [...(st.lots || [])].slice(0, LOT_MAX); while (lots.length < LOT_MAX) lots.push("");
  modalId = null;
  $("modal").innerHTML = `<div class="overlay"><form class="modal panel" id="sform" novalidate>
    <h2>設定<button type="button" class="x" data-act="close" aria-label="閉じる">×</button></h2>
    <div class="stabs" role="tablist">${[["basic", "基本"], ["notify", "通知"]].map(([k, l]) =>
      `<button type="button" role="tab" class="${setTabNow === k ? "on" : ""}" data-act="setTab" data-val="${k}" aria-selected="${setTabNow === k}">${l}</button>`).join("")}</div>
    <div class="mbody" id="s-notify"${setTabNow === "notify" ? "" : " hidden"}>
      <div class="mtools"><input type="search" id="nSearch" placeholder="名前で探す" value="${esc(nQuery)}" autocomplete="off" aria-label="名前で探す"></div>
      <div class="hint">オンにした人のスマホに届きます（最初は全員オフ）。返却予定日・返却遅れは、本人の予約の分だけ届きます。押したときにすぐ保存されます</div>
      <div id="ntable" class="ntable-wrap"></div>
    </div>
    <div class="mbody" id="s-basic"${setTabNow === "basic" ? "" : " hidden"}>
      <p class="ferr" id="ferr" hidden></p>
      <div class="field"><label>名簿</label>
        <div class="mtools">
          <button type="button" class="btn primary small" data-act="memImport">日報の名簿から取り込む</button>
          <input type="search" id="memSearch" placeholder="名前・所属で探す" value="${esc(memQuery)}" autocomplete="off" aria-label="名簿を探す">
        </div>
        <div class="hint">スマホの「あなたの名前」と、予約の「別の人にする」に出ます。車を使わない人は「隠す」にしてください。<br>名簿の変更（取り込み・隠す・追加）は、押したときにすぐ保存されます</div>
        <div id="mlist" class="mlist"></div>
        <div class="madd">
          <input id="madd-name" placeholder="名前" maxlength="30" autocomplete="off" aria-label="追加する人の名前">
          <select id="madd-kubun" aria-label="区分">${MGROUPS.map(g => `<option>${g}</option>`).join("")}</select>
          <input id="madd-shozoku" placeholder="所属（例：よつば建設）" maxlength="30" autocomplete="off" aria-label="所属">
          <button type="button" class="btn ghost small" data-act="memAdd">＋ 1人追加</button>
        </div></div>
      <div class="field"><label for="s-sites">現場リスト</label>
        <textarea id="s-sites" name="sites" rows="6">${lines(st.sites)}</textarea>
        <div class="hint">1行に1つ。予約の「行く現場」に出ます（リストにない現場は「その他」で入力できます）</div></div>
      <div class="field"><label>駐車場（${LOT_MAX}ヶ所まで）</label>
        <div class="lots-in">${lots.map((l, i) => `<input name="lot${i}" value="${esc(l)}" aria-label="駐車場${i + 1}" maxlength="30" autocomplete="off">`).join("")}</div>
        <div class="hint">返却のときのボタンに、入っている駐車場だけが出ます（空欄は使いません。1ヶ所は必要）。名前を変えると、その駐車場にある車の置き場所も新しい名前になります</div></div>
      <div class="field"><label for="s-days">車検の通知（何日前から）</label>
        <div class="days-in"><input id="s-days" name="shakenAlertDays" type="number" inputmode="numeric" min="1" max="365" value="${esc(st.shakenAlertDays || 30)}"><span>日前から</span></div>
        <div class="hint">スマホの車両カードに「🔔 車検」が出始める日数です（はじめは30日）</div></div>
    </div>
    <div class="mfoot"><span class="sp"></span>
      <button type="button" class="btn ghost" data-act="close" id="s-cancel">${setTabNow === "notify" ? "閉じる" : "やめる"}</button>
      <button type="submit" class="btn primary" id="s-save"${setTabNow === "notify" ? " hidden" : ""}>保存する</button>
    </div>
  </form></div>`;
  $("modal").hidden = false;
  renderMemberList();
  renderNotifyTable();
}
// 設定のタブ（基本・通知）。入力中の内容が消えないよう、描き直さずに切り替える
let setTabNow = "basic";
function showSetTab(k) {
  setTabNow = k;
  document.querySelectorAll(".stabs [data-act=setTab]").forEach(b => { b.classList.toggle("on", b.dataset.val === k); b.setAttribute("aria-selected", b.dataset.val === k); });
  $("s-basic").hidden = k !== "basic"; $("s-notify").hidden = k !== "notify";
  $("s-save").hidden = k === "notify"; $("s-cancel").textContent = k === "notify" ? "閉じる" : "やめる";
}

// 設定 → 通知：名簿の人が行、4つの通知が列。チェックでオン・オフ（すぐ保存）
let nQuery = "";
const nVisible = () => { const q = nQuery.trim(); return activeMembers().filter(m => !q || m.name.includes(q)); };
function renderNotifyTable() {
  const el = $("ntable"); if (!el) return;
  const list = nVisible();
  if (!activeMembers().length) { el.innerHTML = `<div class="empty">名簿がまだありません。「基本」タブで名簿を取り込んでください</div>`; return; }
  const rows = MGROUPS.map(g => {
    const ms = list.filter(m => mGroupOf(m) === g).sort((a, b) => byLen(a.name, b.name));
    return !ms.length ? "" : `<tr class="ngrp"><td colspan="5">${g}</td></tr>` + ms.map(m => `<tr>
      <td class="nname"><b>${esc(m.name)}</b><small class="pst${S.tokenNames.has(m.name) ? " ok" : ""}">${S.tokenNames.has(m.name) ? "スマホ許可済み" : "未許可"}</small></td>
      ${NTYPES.map(([k, l]) => `<td><input type="checkbox" data-ntype="${k}" data-name="${esc(m.name)}"${(S.notify[k] || []).includes(m.name) ? " checked" : ""} aria-label="${esc(m.name)} ${l}"></td>`).join("")}</tr>`).join("");
  }).join("");
  el.innerHTML = `<table class="ntable"><thead><tr><th>名前</th>${NTYPES.map(([k, l, when]) =>
    `<th>${l}<small>${when()}</small><div class="nall"><button type="button" class="btn ghost small" data-act="nAll" data-val="${k}" data-id="on">全員オン</button><button type="button" class="btn ghost small" data-act="nAll" data-val="${k}" data-id="off">全員オフ</button></div></th>`).join("")}</tr></thead>
    <tbody>${rows || `<tr><td colspan="5"><div class="empty">該当する名前がありません</div></td></tr>`}</tbody></table>`;
}
function setNotify(type, names, on) {
  if (!names.length) return;
  setDoc(doc(db, "settings", "notify"), { [type]: on ? arrayUnion(...names) : arrayRemove(...names), updatedAt: serverTimestamp() }, { merge: true })
    .catch(e => { console.error(e); toast("変更できませんでした。もう一度お試しください", "err"); });
}
// 列ごとの「全員オン」「全員オフ」（名前で探しているときは、出ている人だけ）
function setNotifyAll(type, on) {
  const names = nVisible().map(m => m.name);
  const label = NTYPES.find(t => t[0] === type)[1];
  if (!confirm(`「${label}」の通知を、${nQuery.trim() ? `表示している ${names.length}人` : `全員（${names.length}人）`}${on ? "オン" : "オフ"}にしますか？`)) return;
  setNotify(type, names, on);
}

let memQuery = "";
// 設定画面の名簿一覧（区分ごと。隠した人も「隠し中」で出す）
function renderMemberList() {
  const el = $("mlist"); if (!el) return;
  const q = memQuery.trim();
  const all = S.members;
  const hidden = all.filter(m => m.active === false).length;
  if (!all.length) { el.innerHTML = `<div class="empty">名簿はまだありません。「日報の名簿から取り込む」を押してください</div>`; return; }
  let html = `<div class="mcount">${all.length}人（隠し中 ${hidden}人）</div>`;
  MGROUPS.forEach(g => {
    const list = all.filter(m => mGroupOf(m) === g && (!q || m.name.includes(q) || (m.shozoku || "").includes(q)))
      .sort((a, b) => ((a.active === false) - (b.active === false)) || (a.shozoku || "").localeCompare(b.shozoku || "", "ja") || byLen(a.name, b.name));
    if (!list.length) return;
    html += `<div class="mgroup">${g}<span>${list.length}人</span></div>` + list.map(m => `
      <div class="mrow${m.active === false ? " off" : ""}"><b>${esc(m.name)}</b><span class="mso">${esc(m.shozoku || "")}</span>
        ${m.active === false ? '<span class="tag">隠し中</span>' : ""}
        <button type="button" class="btn ${m.active === false ? "primary" : "ghost"} small" data-act="memToggle" data-id="${m.id}">${m.active === false ? "表示する" : "隠す"}</button></div>`).join("");
  });
  el.innerHTML = html;
}
function toggleMember(id) {
  const m = S.members.find(x => x.id === id); if (!m) return;
  updateDoc(doc(db, "members", id), { active: m.active === false, updatedAt: serverTimestamp() })
    .catch(e => { console.error(e); toast("変更できませんでした。もう一度お試しください"); });
}
function addMember() {
  const name = $("madd-name").value.trim(), kubun = $("madd-kubun").value, shozoku = $("madd-shozoku").value.trim();
  if (!name) { toast("名前を入れてください"); $("madd-name").focus(); return; }
  if (/[.#$[\]/]/.test(name)) { toast("名前に使えない記号が入っています"); return; }
  const dup = S.members.find(m => m.name === name);
  if (dup) { toast(`「${name}」はもう名簿にあります${dup.active === false ? "（隠し中）" : ""}`); return; }
  setDoc(doc(collection(db, "members")), { name, kubun, shozoku, active: true, source: "manual", createdAt: serverTimestamp(), updatedAt: serverTimestamp() })
    .catch(e => { console.error(e); toast("追加できませんでした。もう一度お試しください"); });
  $("madd-name").value = ""; $("madd-shozoku").value = "";
  toast(`「${name}」を追加しました`);
}
// 日報アプリの名簿（Realtime Database の master/workers）を読んで、まだいない人だけ足す
const NIPPO_WORKERS_URL = "https://yotsuba-nippo-default-rtdb.firebaseio.com/master/workers.json";
async function importFromNippo() {
  let workers;
  try {
    const res = await fetch(NIPPO_WORKERS_URL, { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    workers = Object.entries(await res.json() || {}).map(([key, w]) => ({ key, ...w }))
      .filter(w => w && typeof w.name === "string" && w.name.trim());
  } catch (e) {
    console.error(e); toast("日報の名簿を読めませんでした。電波や日報アプリの設定を確認してください"); return;
  }
  const have = new Set(S.members.map(m => m.name));
  const add = workers.filter(w => !have.has(w.name.trim()));
  if (!add.length) { toast(`日報の名簿 ${workers.length}人は、全員もう入っています`); return; }
  const hiddenNew = add.filter(w => w.active === false).length;
  if (!confirm(`日報の名簿 ${workers.length}人のうち、まだいない ${add.length}人を足します。
（すでにいる ${workers.length - add.length}人はそのまま。日報で隠している人は、ここでも隠した状態で入ります：${hiddenNew}人）

取り込みますか？`)) return;
  try {
    for (let i = 0; i < add.length; i += 400) {
      const b = writeBatch(db);
      add.slice(i, i + 400).forEach(w => b.set(doc(collection(db, "members")), {
        name: w.name.trim().slice(0, 30), kubun: mGroupOf(w), shozoku: String(w.shozoku || "").trim().slice(0, 30),
        active: w.active !== false, source: "nippo", nippoKey: w.key, createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      }));
      await b.commit();
    }
    toast(`${add.length}人を名簿に足しました`);
  } catch (e) { console.error(e); toast("取り込めませんでした。Firebase のルールを確認してください"); }
}

function saveSettings(form) {
  const f = new FormData(form);
  const list = k => [...new Set(String(f.get(k) || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean))];
  const sites = list("sites").map(x => x.slice(0, 100));
  const slots = Array.from({ length: LOT_MAX }, (_, i) => String(f.get(`lot${i}`) || "").trim()); // 欄ごとの値（空欄あり）
  const lots = slots.filter(Boolean);
  const days = Number(toHalf(String(f.get("shakenAlertDays") || "")));
  let err = "";
  if (!lots.length) err = "駐車場を1ヶ所以上入れてください";
  else if (new Set(lots).size < lots.length) err = "同じ名前の駐車場があります";
  else if (!Number.isInteger(days) || days < 1 || days > 365) err = "車検の通知は 1〜365 の数字で入れてください";
  if (err) { const e = $("ferr"); e.textContent = err; e.hidden = false; return; }

  // 駐車場の名前を変えたら（同じ欄で名前が変わったら）、その名前の車の「置き場所」も書きかえる
  const old = S.settings.lots || [];
  const renames = new Map(old.map((o, i) => [o, slots[i]]).filter(([o, n]) => o && n && o !== n && !lots.includes(o)));
  // 消した駐車場に車が残っているときは確かめる（車の置き場所は、その名前のまま残る）
  const removed = old.filter(o => !lots.includes(o) && !renames.has(o));
  const left = S.vehicles.filter(v => !v.retired && (removed.includes(v.homeLot) || removed.includes(v.currentLot)));
  if (left.length && !confirm(`「${removed.join("」「")}」を駐車場から外します。
この駐車場が置き場所になっている車が ${left.length}台あります（置き場所の名前はそのまま残ります）。
あとで「車両を修正」で置き場所を直してください。

保存しますか？`)) return;

  const b = writeBatch(db);
  b.set(doc(db, "settings", "app"), { sites, lots, shakenAlertDays: days, updatedAt: serverTimestamp() }, { merge: true });
  if (renames.size) {
    S.vehicles.forEach(v => {
      const up = {};
      if (renames.has(v.homeLot)) up.homeLot = renames.get(v.homeLot);
      if (renames.has(v.currentLot)) up.currentLot = renames.get(v.currentLot);
      if (Object.keys(up).length) b.update(doc(db, "vehicles", v.id), { ...up, updatedAt: serverTimestamp() });
    });
  }
  b.commit().catch(e => { console.error(e); toast("設定を保存できませんでした。もう一度お試しください"); });
  closeModal();
  toast("設定を保存しました");
}

// 全角の数字・ハイフンを半角に（入力ゆれ対策）
const toHalf = s => s.replace(/[０-９Ａ-Ｚａ-ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)).replace(/[－ー−‐]/g, "-");

function saveVehicle(form) {
  const f = new FormData(form);
  const g = k => String(f.get(k) || "").trim();
  const data = {
    plateArea: g("plateArea"), plateClass: toHalf(g("plateClass")).toUpperCase(), plateKana: g("plateKana"),
    plateNum: toHalf(g("plateNum")), kind: g("kind"), type: g("type"), shakenDate: g("shakenDate"), homeLot: g("lot"), currentLot: g("lot"), // 置き場所は1つ（通常・今の両方に同じ値）
    license: LICENSES.includes(g("license")) ? g("license") : "普通", owner: g("owner") || null,
  };
  let err = "";
  if (!data.plateArea || !data.plateClass || !data.plateKana || !data.plateNum) err = "ナンバーを4つとも入れてください";
  else if (!/^[0-9A-Z]{1,3}$/.test(data.plateClass)) err = "分類番号は3けたまでの数字で入れてください（例：300）";
  else if (!data.kind) err = "車種を入れてください";
  else if (!TYPES.includes(data.type)) err = "種類（トラック／バン／普通車）を選んでください";
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(data.shakenDate)) err = "車検満了日を入れてください";
  else if (!data.homeLot) err = "置き場所を選んでください";
  else {
    const key = x => [x.plateArea, x.plateClass, x.plateKana, x.plateNum].join(" ");
    const dup = S.vehicles.find(x => x.id !== modalId && key(x) === key(data));
    if (dup) err = `同じナンバーの車がすでにあります（${dup.kind}${dup.retired ? "・廃車済み" : ""}）`;
  }
  if (!err && $("f-prev") && $("f-prev").querySelector(".loading-thumb")) err = "写真を読み込んでいます。少し待ってから保存してください";
  if (err) { const e = $("ferr"); e.textContent = err; e.hidden = false; return; }

  // 電波が悪くても画面はすぐ閉じる（Firestore が裏で送る）
  const ref = modalId ? doc(db, "vehicles", modalId) : doc(collection(db, "vehicles"));
  const p = modalId
    ? updateDoc(ref, { ...data, updatedAt: serverTimestamp() })
    : setDoc(ref, {
        ...data, photoUrl: null, status: "free", retired: false, hidden: false,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
  const file = pendingPhoto && pendingPhoto.file;
  toast(modalId ? "保存しました" : "登録しました");
  closeModal();
  p.catch(e => { console.error(e); toast("保存できませんでした。もう一度お試しください"); });
  if (file) setVehiclePhoto(ref.id, file);
}

function retireVehicle(id) {
  const v = byId(id); if (!v) return;
  if (!confirm(`「${v.kind}（${v.plateKana} ${v.plateNum}）」を廃車にしますか？\n\n一覧から消えますが、データは残ります。\nあとで「廃車済み」から戻すこともできます。`)) return;
  closeModal();
  updateDoc(doc(db, "vehicles", id), { retired: true, retiredAt: serverTimestamp(), updatedAt: serverTimestamp() })
    .catch(e => { console.error(e); toast("廃車にできませんでした"); });
  toast("廃車にしました");
}
// 一時的に隠す（廃車とは別。データ・予約・修理の記録はそのまま）
function setHidden(id, on) {
  const v = byId(id); if (!v) return;
  if (on && !confirm(`「${v.kind}（${v.plateKana} ${v.plateNum}）」を一時的に隠しますか？\n\nスマホの一覧・車検タブと、PCの上のパネルに出なくなります。\n車のデータ・予約・修理の記録はそのまま残り、「非表示中」から戻せます。`)) return;
  closeModal();
  updateDoc(doc(db, "vehicles", id), { hidden: on, updatedAt: serverTimestamp() })
    .catch(e => { console.error(e); toast("変更できませんでした"); });
  toast(on ? "一時的に隠しました" : "表示に戻しました");
}
function restoreVehicle(id) {
  updateDoc(doc(db, "vehicles", id), { retired: false, retiredAt: null, updatedAt: serverTimestamp() })
    .catch(e => { console.error(e); toast("戻せませんでした"); });
  toast("一覧に戻しました");
}

/* ---------- 車検に出す・車検から戻す（PCのみ） ---------- */
// 記録は inspections に残す（どの車・出した日・戻した日・前と新しい満了日・操作した人）
const operator = () => ME || "事務所（PC）";
function inspHead(v, title) {
  return `<div class="overlay"><form class="modal panel imodal" id="${title === "車検に出す" ? "ioform" : "ibform"}" data-id="${v.id}" novalidate>
    <h2>${title}<button type="button" class="x" data-act="close" aria-label="閉じる">×</button></h2>
    <div class="mbody"><div class="ihead">${plateHtml(v, true)}<b>${esc(v.kind)}</b></div><p class="ferr" id="ferr" hidden></p>`;
}
const inspFoot = (v, ok) => `</div><div class="mfoot"><span class="sp"></span>
    <button type="button" class="btn ghost" data-act="edit" data-id="${v.id}">やめる</button>
    <button type="submit" class="btn primary" id="i-ok">${ok}</button></div></form></div>`;
function showFerr(msg) { const e = $("ferr"); e.textContent = msg; e.hidden = false; }

function openInspOut(id) {
  const v = byId(id); if (!v) return;
  closeModal();
  const t = ymd(today());
  $("modal").innerHTML = inspHead(v, "車検に出す") + `
    <div class="field"><label for="io-from">出した日</label><input type="date" id="io-from" name="from" value="${t}" max="${t}"></div>
    <div class="field"><label for="io-until">戻り予定日（任意）</label><input type="date" id="io-until" name="until" min="${t}"></div>
    <div id="io-clash"></div>` + inspFoot(v, "車検に出す");
  $("modal").hidden = false;
}
// 車検に出す期間にかかる予約（戻り予定日がなければ、出した日〜今日）
function inspClashes(v, from, until) {
  const to = until || ymd(today());
  return S.reservations.filter(r => r.vehicleId === v.id && !r.returnedAt && !r.canceled && r.from <= to && from <= effTo(r))
    .sort((a, b) => (a.from > b.from ? 1 : -1));
}
function saveInspOut(f) {
  const v = byId(f.dataset.id); if (!v) return;
  const from = f.from.value, until = f.until.value || null, t = ymd(today());
  if (!from) return showFerr("出した日を入れてください");
  if (from > t) return showFerr("出した日は今日までの日にしてください");
  if (until && until < from) return showFerr("戻り予定日は出した日より後にしてください");
  // その期間に予約があれば、一覧を出して確かめる（もう一度押すと出す）
  const clash = inspClashes(v, from, until);
  if (clash.length && f.dataset.ok !== "1") {
    $("io-clash").innerHTML = `<div class="iclash"><b>この期間に入っている予約があります</b>${clash.map(r =>
      `<div>${rangeText(r)}　${esc(r.who)}さん　${esc(r.site)}</div>`).join("")}<p>このまま車検に出しますか？</p></div>`;
    $("i-ok").textContent = "このまま車検に出す"; f.dataset.ok = "1";
    return;
  }
  const rec = doc(collection(db, "inspections"));
  const b = writeBatch(db);
  b.set(rec, {
    vehicleId: v.id, outDate: from, expectedBack: until, backDate: null,
    oldShakenDate: v.shakenDate, newShakenDate: null, outBy: operator(), backBy: null, returnedLot: null,
    outAt: serverTimestamp(), backAt: null,
  });
  b.update(doc(db, "vehicles", v.id), { inspection: { id: rec.id, from, until }, updatedAt: serverTimestamp() });
  b.commit().catch(e => { console.error(e); toast("車検に出せませんでした。もう一度お試しください", "err"); });
  closeModal();
  toast("車検に出しました");
}
// 日付の入力を変えたら、予約の確認をやり直す
function resetInspConfirm() {
  const f = $("ioform"); if (!f || f.dataset.ok !== "1") return;
  delete f.dataset.ok; $("io-clash").innerHTML = ""; $("i-ok").textContent = "車検に出す";
}

function openInspBack(id) {
  const v = byId(id); if (!v || !v.inspection) return;
  closeModal();
  const lots = (S.settings.lots || []).filter(Boolean).slice(0, LOT_MAX);
  $("modal").innerHTML = inspHead(v, "車検から戻す") + `
    <div class="field"><label for="ib-date">新しい車検満了日</label>
      <div class="shk-in"><input type="date" id="ib-date" name="shakenDate">
        <button type="button" class="btn ghost small" data-act="shkPlus" data-val="1">＋1年</button>
        <button type="button" class="btn ghost small" data-act="shkPlus" data-val="2">＋2年</button>
        <span class="shk-now">今：${jp(v.shakenDate)}</span></div></div>
    <div class="field"><label>置き場所</label><div class="seg">${lots.map(l =>
      `<label class="chip"><input type="radio" name="lot" value="${esc(l)}">${esc(l)}</label>`).join("")}</div></div>` + inspFoot(v, "戻す");
  $("modal").hidden = false;
}
// 「＋1年」「＋2年」：今の満了日から
function shakenPlus(n) {
  const f = $("ibform"), v = f && byId(f.dataset.id); if (!v) return;
  const d = parse(v.shakenDate); d.setFullYear(d.getFullYear() + Number(n));
  f.shakenDate.value = ymd(d);
}
function saveInspBack(f) {
  const v = byId(f.dataset.id); if (!v || !v.inspection) { closeModal(); return; }
  const date = f.shakenDate.value, lot = (f.querySelector("input[name=lot]:checked") || {}).value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return showFerr("新しい車検満了日を入れてください");
  if (date <= v.shakenDate) return showFerr(`新しい車検満了日は、今の満了日（${jp(v.shakenDate)}）より後にしてください`);
  if (!lot) return showFerr("置き場所を選んでください");
  const b = writeBatch(db);
  b.update(doc(db, "vehicles", v.id), { shakenDate: date, currentLot: lot, inspection: null, updatedAt: serverTimestamp() });
  if (v.inspection.id) b.set(doc(db, "inspections", v.inspection.id), {
    vehicleId: v.id, backDate: ymd(today()), newShakenDate: date, backBy: operator(), returnedLot: lot, backAt: serverTimestamp(),
  }, { merge: true });
  b.commit().catch(e => { console.error(e); toast("戻せませんでした。もう一度お試しください", "err"); });
  closeModal();
  toast(`車検から戻しました（次の満了日 ${fmt(date)}）`);
}

/* ---------- サンプル投入（試作と同じ8台。日付は今日を基準にずらす） ---------- */
async function seed() {
  if (S.vehicles.length) return;
  if (!confirm("試しに使うためのサンプル（車8台と、予約・修理の例）を入れます。\nあとで「サンプルデータを消す」で消せます。\n\n入れますか？")) return;
  const t = today(), D = n => ymd(addDays(t, n)), base = Date.now();
  const b = writeBatch(db);
  //        地域   分類   かな 番号     車種                     種類       車検(今日から) 置き場所
  const cars = [
    ["愛媛", "300", "あ", "12-34", "ハイエース（バン）", "バン", 18, "本社"],
    ["愛媛", "400", "い", "56-78", "ハイゼット（軽トラ）", "トラック", 162, "松前工場"],
    ["愛媛", "100", "う", "90-12", "ダイナ 2t（平ボディ）", "トラック", 67, "伊予工場"],
    ["愛媛", "500", "え", "34-56", "プロボックス", "普通車", 6, "本社"],
    ["愛媛", "100", "お", "78-90", "エルフ 3t（ユニック）", "トラック", 116, "松前工場"],
    ["愛媛", "580", "か", "11-22", "N-BOX", "普通車", 251, "本社"],
    ["愛媛", "400", "き", "33-44", "キャラバン（バン）", "バン", 81, "伊予工場"],
    ["愛媛", "300", "く", "55-66", "タウンエース（バン）", "バン", 156, "松前工場"],
  ];
  const ids = cars.map(([plateArea, plateClass, plateKana, plateNum, kind, type, sh, lot], i) => {
    const ref = doc(collection(db, "vehicles"));
    b.set(ref, {
      plateArea, plateClass, plateKana, plateNum, kind, type, shakenDate: D(sh), photoUrl: null,
      homeLot: lot, currentLot: lot, status: "free", retired: false, sample: true,
      createdAt: Timestamp.fromMillis(base + i), updatedAt: serverTimestamp(),
    });
    return ref.id;
  });
  [
    [0, "田中", "東レ 定修", -2, 2], [3, "佐藤", "太陽石油", 0, 0], [5, "山本", "黒藤川発電所", -1, 1],
    [1, "鈴木", "熊本 浄化センター", 4, 8], [2, "高橋", "東レ 定修", 1, 1], [6, "田中", "太陽石油", 12, 14],
  ].forEach(([i, who, site, f, to]) => b.set(doc(collection(db, "reservations")), {
    vehicleId: ids[i], who, site, from: D(f), to: D(to), createdBy: who,
    returnedAt: null, returnedLot: null, sample: true, createdAt: serverTimestamp(),
  }));
  [
    [4, [], "クレーン警報が鳴る", "佐藤", "in_repair", -3],
    [0, ["タイヤ"], "左後ろタイヤ空気が減りやすい", "山本", "done", -14],
  ].forEach(([i, symptoms, memo, reportedBy, st, ago]) => b.set(doc(collection(db, "repairs")), {
    vehicleId: ids[i], symptoms, memo, photoUrls: [], reportedBy, status: st, sample: true,
    createdAt: Timestamp.fromDate(addDays(t, ago)), doneAt: st === "done" ? Timestamp.fromDate(addDays(t, ago + 2)) : null,
  }));
  if (!S.settingsExists) b.set(doc(db, "settings", "app"), { ...DEFAULT_SETTINGS });
  toast("サンプルを入れました");
  try { await b.commit(); } catch (e) { console.error(e); toast("サンプルを入れられませんでした"); }
}

async function unseed() {
  if (!confirm("サンプルデータ（サンプルの車と、その車で試しに入れた予約・修理）をすべて消します。\n自分で登録した車は消えません。\n\n消しますか？")) return;
  try {
    const refs = new Map(); // 同じ記録を2回消さないよう、場所で重複をまとめる
    const paths = []; // 写真ファイルの場所（車の写真・修理の写真）
    const add = snap => snap.forEach(d => {
      refs.set(d.ref.path, d.ref);
      const x = d.data();
      paths.push(x.photoPath, x.thumbPath, ...(x.photos || []).flatMap(p => [p.photoPath, p.thumbPath]));
    });
    const cars = await getDocs(query(collection(db, "vehicles"), where("sample", "==", true)));
    const ids = cars.docs.map(d => d.id);
    for (const c of ["reservations", "repairs", "inspections"]) {
      add(await getDocs(query(collection(db, c), where("sample", "==", true))));
      for (let i = 0; i < ids.length; i += 30) add(await getDocs(query(collection(db, c), where("vehicleId", "in", ids.slice(i, i + 30)))));
    }
    add(cars); // 車は最後に消す（ルールが「サンプルの車の予約か」を確かめるため）
    const all = [...refs.values()];
    for (let i = 0; i < all.length; i += 400) {
      const b = writeBatch(db);
      all.slice(i, i + 400).forEach(r => b.delete(r));
      await b.commit();
    }
    // 写真ファイルも消す（消せなくても続ける）
    await Promise.all(paths.filter(Boolean).map(p => deleteObject(storageRef(storage, p)).catch(() => {})));
    toast("サンプルデータを消しました");
  } catch (e) { console.error(e); toast("消せませんでした"); }
}

// PCの登録フォームで写真を選んだとき：その場で読み込んで見本を出す（HEIC は JPEG に変換）。読めなければ案内を出して保存させない
async function pickFormPhoto(input) {
  const f = input.files && input.files[0]; input.value = ""; if (!f) return;
  const prev = $("f-prev"), err = $("ferr"), form = $("vform");
  if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.preview);
  pendingPhoto = null;
  err.hidden = true;
  prev.innerHTML = `<div class="mhero-img empty loading-thumb">写真を読み込んでいます…</div>`;
  try {
    const img = await readPhoto(f);
    let jpeg; try { jpeg = await toJpeg(img, PHOTO_MAX, 0.9); } finally { if (img.close) img.close(); }
    if ($("vform") !== form) return; // 読み込み中にフォームを閉じた
    pendingPhoto = { file: jpeg, preview: URL.createObjectURL(jpeg) };
    prev.innerHTML = formPhotoHtml(pendingPhoto.preview);
  } catch (e) {
    console.error(e);
    if ($("vform") !== form) return;
    const cur = modalId && byId(modalId); prev.innerHTML = formPhotoHtml(cur && cur.photoUrl, cur); loadImages(prev);
    err.textContent = photoErrMsg(e); err.hidden = false;
  }
}

/* ---------- 写真を見る画面（画面いっぱい。2本指で拡大・縮小、拡大中は1本指で動かす、2回タップで拡大／戻す） ---------- */
let viewer = null;
function openViewer(url) {
  closeViewer();
  const el = document.createElement("div");
  el.className = "viewer"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "写真");
  el.innerHTML = `<img src="${esc(url)}" alt="車の写真" draggable="false"><button type="button" class="vclose" aria-label="閉じる">×</button>`;
  document.body.appendChild(el);
  const img = el.querySelector("img");
  const st = { scale: 1, x: 0, y: 0 }, pts = new Map();
  let start = null, moved = false, lastTap = 0, onImg = false;
  const apply = () => { img.style.transform = `translate(${st.x}px,${st.y}px) scale(${st.scale})`; };
  const clamp = v => Math.min(5, Math.max(1, v));
  const reset = () => { st.scale = 1; st.x = 0; st.y = 0; apply(); };
  const zoomAt = (ns, cx, cy) => { // 指（マウス）の位置を中心に拡大・縮小
    const r = el.getBoundingClientRect(), ox = cx - r.width / 2, oy = cy - r.height / 2;
    ns = clamp(ns); const k = ns / st.scale;
    st.x = ox - (ox - st.x) * k; st.y = oy - (oy - st.y) * k; st.scale = ns;
    if (ns === 1) { st.x = 0; st.y = 0; }
    apply();
  };
  el.addEventListener("pointerdown", e => {
    if (e.target.closest(".vclose")) return;
    if (!pts.size) onImg = e.target === img;
    try { el.setPointerCapture(e.pointerId); } catch (err) { /* 押さえ続けの登録ができなくても動く */ }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved = false;
    const p = [...pts.values()];
    start = p.length >= 2
      ? { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), scale: st.scale }
      : { px: e.clientX, py: e.clientY, x: st.x, y: st.y };
  });
  el.addEventListener("pointermove", e => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = [...pts.values()];
    if (p.length >= 2 && start && start.d) {
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      zoomAt(start.scale * d / start.d, (p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2); moved = true;
    } else if (p.length === 1 && start && start.px != null && st.scale > 1) {
      st.x = start.x + e.clientX - start.px; st.y = start.y + e.clientY - start.py; apply();
      if (Math.abs(e.clientX - start.px) + Math.abs(e.clientY - start.py) > 6) moved = true;
    } else if (start && start.px != null && Math.abs(e.clientX - start.px) + Math.abs(e.clientY - start.py) > 6) moved = true;
  });
  const up = e => {
    pts.delete(e.pointerId);
    const p = [...pts.values()];
    start = p.length === 1 ? { px: p[0].x, py: p[0].y, x: st.x, y: st.y } : null;
    if (pts.size) return;
    if (moved) return;
    // 1本指で押しただけ：2回続けてなら拡大／戻す、背景なら閉じる
    const now = Date.now();
    if (onImg && now - lastTap < 320) { st.scale > 1 ? reset() : zoomAt(2.5, e.clientX, e.clientY); lastTap = 0; return; }
    lastTap = now;
    if (!onImg) closeViewer();
  };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", e => { pts.delete(e.pointerId); start = null; });
  el.addEventListener("wheel", e => { e.preventDefault(); zoomAt(st.scale * (e.deltaY < 0 ? 1.2 : 1 / 1.2), e.clientX, e.clientY); }, { passive: false });
  el.querySelector(".vclose").addEventListener("click", closeViewer);
  viewer = el;
  el.querySelector(".vclose").focus();
}
function closeViewer() { if (viewer) { viewer.remove(); viewer = null; } }

/* ---------- お知らせ ---------- */
let toastTimer;
function toast(msg, kind) {
  const el = $("toast"); el.textContent = msg; el.hidden = false;
  el.classList.toggle("err", kind === "err");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, kind === "err" ? 8000 : 2600);
}

/* ---------- 操作 ---------- */
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]");
  // 名前のメニューは、ほかの所を押したら閉じるだけ（押した所の動きはしない）
  if (ui.menu && !e.target.closest(".me-menu, .me-pill")) { ui.menu = false; render(); return; }
  if (!el) return;
  const { act, id, val } = el.dataset;
  switch (act) {
    case "meMenu": ui.menu = !ui.menu; render(); break;
    case "goNotify": go({ name: "notify" }); break;
    case "pushOn": enablePush(); break;
    case "setTab": showSetTab(val); break;
    case "nAll": setNotifyAll(val, id === "on"); break;
    case "view": lsSet("sharyo_view", val); applyView(); break;
    case "tab": setTab(val); break;
    case "filter": ui.filter = val; render(); break;
    case "pcFilter": pcUi.filter = val; if (val !== "all") pcUi.groups[val] = true; savePcUi(); render(); break; // 状態を選んだら、そのグループを開く
    case "pcType": pcUi.type = val; savePcUi(); render(); break;
    case "pcGroup": pcUi.groups[val] = !pcUi.groups[val]; savePcUi(); render(); break;
    case "pcPanel": pcUi.panels[val] = !pcUi.panels[val]; savePcUi(); render(); break;
    case "tfilter": ui.tfilter = val; render(); break;
    case "detail": detMonth = 0; go({ name: "detail", id }); break;
    case "back": go(ui.backTo || { name: "list" }); break;
    case "goto": go({ name: val, id }); break;
    case "me": saveMe(val); break;
    case "meEdit": go({ name: "me" }); break;
    case "whoOther": form.other = true; form.picking = true; form.whoQ = ""; form.err = ""; render(); break;
    case "whoMe": form.other = false; form.picking = false; form.who = ""; form.err = ""; render(); break;
    case "pickWho": form.who = val; form.picking = false; form.err = ""; render(); break;
    case "reserve": { const v = byId(id); if (v) doReserve(v); break; }
    case "pickDay": { if (form.busy) break; const i = (form.days || []).indexOf(val); form.days = i >= 0 ? form.days.filter(d => d !== val) : [...(form.days || []), val]; form.err = ""; render(); break; }
    case "calMonth": { const [y, m] = form.month; const d = new Date(y, m + Number(val), 1); form.month = [d.getFullYear(), d.getMonth()]; render(); break; }
    case "cancelRes": cancelReservation(id); break;
    case "detMonth": detMonth = Math.max(0, Math.min(12, detMonth + Number(val))); render(); break;
    case "return": { const v = byId(id); if (v) doReturn(v, val, el.dataset.rid); break; }
    case "myReturn": go({ name: "return", id, rid: val }); break;
    case "sym": toggleSym(val); break;
    case "rmPhoto": removeRepairPhoto(Number(val)); break;
    case "sendRepair": { const v = byId(id); if (v) doRepair(v); break; }
    case "repairSet": setRepairStatus(id, val); break;
    case "add": openModal(null); break;
    case "edit": openModal(id); break;
    case "close": closeModal(); break;
    case "viewPhoto": openViewer(val); break;
    case "settings": openSettings(); break;
    case "memImport": importFromNippo(); break;
    case "memToggle": toggleMember(id); break;
    case "memAdd": addMember(); break;
    case "retire": retireVehicle(modalId); break;
    case "restore": restoreVehicle(id); break;
    case "inspOut": openInspOut(id); break;
    case "inspBack": openInspBack(id); break;
    case "shkPlus": shakenPlus(val); break;
    case "hideCar": { const v = byId(modalId); if (v) setHidden(v.id, !v.hidden); break; }
    case "unhide": setHidden(id, false); break;
    case "seed": seed(); break;
    case "unseed": unseed(); break;
  }
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.id === "r-photo") { // 修理を頼む：写真をつける（複数OK）
    addRepairPhotos(el.files); el.value = "";
  }
  if (el.dataset && el.dataset.photo) { // スマホの車両詳細の「📷 写真を登録」
    const f = el.files && el.files[0]; el.value = "";
    if (f) setVehiclePhoto(el.dataset.photo, f);
  }
  if (el.id === "io-from" || el.id === "io-until") resetInspConfirm(); // 車検に出す：日付を変えたら確認し直す
  if (el.id === "f-photo") pickFormPhoto(el); // PCの登録フォーム（保存を押したときに送る）
  if (el.dataset && el.dataset.ntype) setNotify(el.dataset.ntype, [el.dataset.name], el.checked); // PCの設定 → 通知
  if (el.dataset && el.dataset.pref) setMyPref(el.dataset.pref, el.checked); // スマホの「🔔 通知」
});
// 設定画面：名簿・通知の検索、追加欄で Enter を押したとき
document.addEventListener("input", e => {
  if (e.target.id === "memSearch") { memQuery = e.target.value; renderMemberList(); }
  if (e.target.id === "nSearch") { nQuery = e.target.value; renderNotifyTable(); }
});
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || !e.target.id) return;
  if (e.target.id === "memSearch" || e.target.id === "nSearch") e.preventDefault();
  if (/^madd-/.test(e.target.id)) { e.preventDefault(); addMember(); }
});
document.addEventListener("submit", e => {
  if (e.target.id === "vform") { e.preventDefault(); saveVehicle(e.target); }
  if (e.target.id === "sform") { e.preventDefault(); saveSettings(e.target); }
  if (e.target.id === "ioform") { e.preventDefault(); saveInspOut(e.target); }
  if (e.target.id === "ibform") { e.preventDefault(); saveInspBack(e.target); }
});
// 予約フォームの入力を覚えておく
$("ph-screen").addEventListener("input", e => {
  if (e.target.id === "meSearch") { meQuery = e.target.value; $("meList").innerHTML = nameChips(meQuery, ME, "me"); return; }
  if (e.target.id === "whoSearch") { form.whoQ = e.target.value; $("whoList").innerHTML = nameChips(form.whoQ, form.who, "pickWho"); return; }
  const n = e.target.name;
  if (ui.screen.name === "repair" && n === "memo") rform.memo = e.target.value;
  if (ui.screen.name === "reserve" && ["who", "site", "siteOther"].includes(n)) form[n] = e.target.value;
});
$("ph-screen").addEventListener("change", e => {
  if (ui.screen.name !== "reserve") return;
  const n = e.target.name;
  if (form.err) { form.err = ""; if (n !== "site") render(); } // 直したら古いエラーは消す
  if (n === "site") { form.site = e.target.value; render(); } // 「その他」なら入力欄を出す
});
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.matches && e.target.matches(".li.tap")) e.target.click();
  if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches("tr.grp[data-act]")) { e.preventDefault(); e.target.click(); }
});
document.addEventListener("keydown", e => {
  if (e.key === "Escape") { if (viewer) closeViewer(); else if (!$("modal").hidden) closeModal(); }
  if (e.key === "Enter" && e.target.matches && e.target.matches(".zoomable")) e.target.click();
});
document.addEventListener("toggle", e => {
  if (!e.target.matches) return;
  if (e.target.matches("details.hiddenv")) ui.hiddenOpen = e.target.open;
  else if (e.target.matches("details.retired")) ui.retiredOpen = e.target.open;
}, true);
wide.addEventListener("change", applyView);
// 日付が変わったら表示（使用中／空き）を更新
let shownDay = ymd(today());
setInterval(() => { if (ymd(today()) !== shownDay) { shownDay = ymd(today()); render(); } }, 60000);

/* ---------- Firestore と同期（どの端末で変えても、すぐ全員に反映） ---------- */
function onErr(e) {
  console.error(e);
  S.error = e.code === "permission-denied"
    ? "データを読む権限がありません（Firebase のルール設定を確認してください）"
    : "データを読み込めませんでした。電波のよい所でもう一度開いてください";
  render();
}
const snapList = snap => snap.docs.map(d => ({ id: d.id, ...d.data({ serverTimestamps: "estimate" }) }));
let started = false;
function startSync() {
  if (started) return; started = true;
  const loaded = new Set();
  const done = k => { loaded.add(k); S.ready = loaded.size >= 3; S.error = ""; refresh(); };
  onSnapshot(collection(db, "vehicles"), snap => {
    S.vehicles = snapList(snap).sort((a, b) => millis(a.createdAt) - millis(b.createdAt));
    done("v");
  }, onErr);
  onSnapshot(query(collection(db, "reservations"), where("returnedAt", "==", null)), snap => {
    S.reservations = snapList(snap).filter(r => !r.canceled); done("r"); // 取り消した予約は使わない
  }, onErr);
  onSnapshot(collection(db, "repairs"), snap => { S.repairs = snapList(snap); done("p"); }, onErr);
  onSnapshot(collection(db, "members"), snap => {
    S.members = snapList(snap); S.membersLoaded = true;
    refresh(); renderMemberList();
  }, e => { console.warn("名簿を読めません", e); S.membersLoaded = true; refresh(); });
  onSnapshot(doc(db, "settings", "app"), d => {
    S.settingsExists = d.exists();
    S.settings = { ...DEFAULT_SETTINGS, ...(d.data() || {}) };
    refresh();
  }, onErr);
  // 通知：届ける人（PC）・本人のオフ（スマホ）・許可した端末がある人
  const nwarn = e => console.warn("通知の設定を読めません", e);
  onSnapshot(doc(db, "settings", "notify"), d => { S.notify = d.data() || {}; S.notifyLoaded = true; refresh(); renderNotifyTable(); }, nwarn);
  onSnapshot(collection(db, "notifyPrefs"), snap => {
    S.prefs = new Map(snap.docs.map(d => [d.get("name"), new Set(d.get("off") || [])])); refresh();
  }, nwarn);
  onSnapshot(collection(db, "pushTokens"), snap => {
    S.tokenNames = new Set(snap.docs.map(d => d.get("name")).filter(Boolean)); renderNotifyTable();
  }, nwarn);
  // 許可済みの端末は、開くたびにトークンを取り直して保存する（変わっていたり、無効として消されていても戻る）
  if (ME && pushState() === "on") saveToken().catch(e => console.warn(e));
}

applyView();
// ホーム画面に追加して使えるように（PWA）
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(e => console.warn(e));
onAuthStateChanged(auth, user => { if (user) startSync(); });
signInAnonymously(auth).catch(e => {
  console.error(e);
  S.error = e.code === "auth/unauthorized-domain"
    ? "このアドレスが Firebase に登録されていません（承認済みドメインを追加してください）"
    : "接続できませんでした。電波のよい所でもう一度開いてください";
  render();
});
