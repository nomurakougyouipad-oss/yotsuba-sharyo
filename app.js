// 社用車管理アプリ（段階1: 車両一覧・詳細・PC版の登録／修正／廃車・Firestore同期・サンプル投入）
import { firebaseConfig, FIREBASE_SDK_VERSION } from "./firebase-config.js";

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
} = fb;
const { getStorage, ref: storageRef, uploadBytesResumable, getDownloadURL, deleteObject } = fb.storageMod;

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// 電波が悪い現場でも前回の内容が見えるよう、端末にも保存しておく
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
const storage = getStorage(fbApp);

/* ---------- 定数 ---------- */
const TYPES = ["トラック", "バン", "普通車"];
const LABEL = { free: "空き", use: "使用中", fix: "修理中" };
const DEFAULT_SETTINGS = {
  people: ["野村", "田中", "佐藤", "山本", "鈴木", "高橋"],
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
// 名簿がまだ空のときは、これまでの「名前リスト」を自社として使う
function roster() {
  if (S.members.length) return S.members;
  return (S.settings.people || []).map(name => ({ id: "", name, kubun: "自社", shozoku: "", active: true }));
}
const activeMembers = () => roster().filter(m => m.active !== false);
// 区分ごとに分けた名前のボタン（日報アプリと同じ並び）。act は押したときの動き
function nameChips(q, selected, act) {
  q = String(q || "").trim();
  let html = "";
  MGROUPS.forEach(g => {
    const names = activeMembers().filter(m => mGroupOf(m) === g).map(m => m.name).filter(n => !q || n.includes(q)).sort(byLen);
    if (!names.length) return;
    html += `<div class="mgroup">${g}</div><div class="ngrid">${names.map(n =>
      `<button class="nchip${selected === n ? " on" : ""}" data-act="${act}" data-val="${esc(n)}">${esc(n)}</button>`).join("")}</div>`;
  });
  if (html) return html;
  if (!S.membersLoaded && !S.settings.people) return `<div class="loading">名簿を読み込んでいます…</div>`;
  return `<div class="empty">${q ? "該当する名前がありません" : "名簿がまだありません。事務所のPCで名簿を取り込んでください"}</div>`;
}

/* ---------- 自分の名前（このスマホに覚えておく） ---------- */
let ME = lsGet("sharyo_me") || "";
function saveMe(n) {
  n = String(n || "").trim().slice(0, 40); if (!n) return;
  ME = n; lsSet("sharyo_me", n); resetForm(); meQuery = "";
  go({ name: "list" });
}

/* ---------- 車の状態（README「状態の決め方」） ---------- */
const active = () => S.vehicles.filter(v => !v.retired);
const byId = id => S.vehicles.find(v => v.id === id);
function currentUse(v) {
  const t = ymd(today());
  return S.reservations.find(r => r.vehicleId === v.id && !r.returnedAt && r.from <= t && t <= r.to) || null;
}
function fixRepair(v) { return S.repairs.find(r => r.vehicleId === v.id && r.status === "in_repair") || null; }
function nextRes(v) {
  const t = ymd(today());
  return S.reservations.filter(r => r.vehicleId === v.id && !r.returnedAt && r.from > t).sort((a, b) => (a.from > b.from ? 1 : -1))[0] || null;
}
function status(v) { return fixRepair(v) ? "fix" : (currentUse(v) ? "use" : "free"); }
function repairText(r) { const s = (r.symptoms || []).join("・"); return s && r.memo ? `${s}：${r.memo}` : (s || r.memo || ""); }
const lotOf = v => v.currentLot || v.homeLot || "";
const alertDays = () => Number(S.settings.shakenAlertDays) || 30;

/* ---------- 部品（試作と同じ見た目） ---------- */
function carColor(v) { let h = 0; for (const c of v.id) h = (h * 31 + c.charCodeAt(0)) >>> 0; return CAR_COLORS[h % CAR_COLORS.length]; }
function carSvg(color) {
  return `<svg viewBox="0 0 120 56" xmlns="http://www.w3.org/2000/svg"><path d="M14 40h92a4 4 0 0 0 4-4v-9c0-3-2-5-5-6l-14-3-12-11a6 6 0 0 0-4-2H38a6 6 0 0 0-5 3l-8 11-11 3c-3 1-5 3-5 6v8a4 4 0 0 0 4 4z" fill="${color}" stroke="#39424d" stroke-width="2.5" stroke-linejoin="round"/><path d="M42 12h28l9 10H35z" fill="#b8d8ee" stroke="#39424d" stroke-width="2"/><circle cx="34" cy="42" r="8" fill="#2a2f36"/><circle cx="34" cy="42" r="3.5" fill="#9aa4ae"/><circle cx="90" cy="42" r="8" fill="#2a2f36"/><circle cx="90" cy="42" r="3.5" fill="#9aa4ae"/></svg>`;
}
function thumbHtml(v, big) {
  const url = big ? v.photoUrl : (v.thumbUrl || v.photoUrl);
  return `<div class="thumb" aria-hidden="true">${url ? `<img src="${esc(url)}" alt="" decoding="async"${big ? "" : ' loading="lazy"'}>` : carSvg(carColor(v))}</div>`;
}
function plateHtml(v, small) {
  return `<span class="plate"${small ? ' style="font-size:15px"' : ""}><small>${esc(v.plateArea)} ${esc(v.plateClass)}</small>${esc(v.plateKana)} ${esc(v.plateNum)}</span>`;
}
function shakenClass(v) { const d = daysTo(v.shakenDate); return d < 0 ? "over" : (d <= alertDays() ? "soon" : ""); }
function shakenTag(v) {
  const d = daysTo(v.shakenDate); if (d > alertDays()) return "";
  return `<span class="shk ${d < 0 ? "over" : ""}"><span>🔔 車検</span><b>${d < 0 ? `${-d}日超過` : (d === 0 ? "今日" : `あと${d}日`)}</b></span>`;
}
const byShaken = list => [...list].sort((a, b) => (a.shakenDate > b.shakenDate ? 1 : -1));
function shakenText(v) { const d = daysTo(v.shakenDate); return d < 0 ? `${-d}日 超過` : (d === 0 ? "今日" : `あと ${d}日`); }
function bandExtra(v, st, use) {
  if (use) return `<span class="period">${fmt(use.from)}〜${fmt(use.to)}</span>`;
  const next = nextRes(v);
  if (st !== "fix" && next) return `<span class="period"><small>次の予約</small>${fmt(next.from)}〜</span>`;
  return "";
}
function useText(v, use, fix) {
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
function go(s) { ui.screen = s; form.err = ""; render(); $("ph-screen").scrollTop = 0; }
function setTab(t) { ui.tab = t; go({ name: "list" }); }

function render() { if (ui.view === "phone") renderPhone(); else renderPc(); }
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
  if (!ME) { h.innerHTML = `<h1>はじめに</h1>`; s.innerHTML = errBar() + nameScreen(true); t.hidden = true; return; }
  t.hidden = false;
  t.innerHTML = [["cars", "🚐", "車両"], ["shaken", "📋", "車検"], ["repair", "🔧", "修理"]].map(([k, ic, l]) =>
    `<button class="${ui.tab === k ? "on" : ""}" data-act="tab" data-val="${k}"><span class="ic">${ic}</span>${l}${k === "repair" && openCount() ? `<span class="badge">${openCount()}</span>` : ""}</button>`).join("");
  if (ui.screen.name === "me") {
    ui.backTo = { name: "list" };
    h.innerHTML = `<button class="back" data-act="back" aria-label="戻る">‹</button><h1>あなたの名前</h1>`;
    s.innerHTML = nameScreen(false); return;
  }

  let title = "社用車", back = null, body = "", pill = "";
  const d = today(), sc = ui.screen;
  if (sc.name === "list") {
    pill = `<button class="me-pill" data-act="meEdit">${esc(ME)}</button>`;
    if (ui.tab === "cars") body = listCars();
    else if (ui.tab === "shaken") { title = "車検"; body = listShaken(); }
    else { title = "修理依頼"; body = listRepairs(); }
  } else if (sc.name === "done") {
    title = ""; body = doneScreen(sc);
  } else {
    const v = byId(sc.id);
    if (!v || v.retired) { ui.screen = { name: "list" }; return renderPhone(); }
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
  return `<div class="welcome">${first
    ? `<h2>あなたの名前を選んでください</h2><p class="sub" style="margin:0 0 14px">このスマホに覚えておきます。予約するとき自動で入ります</p>`
    : `<p class="sub" style="margin:0 0 14px">今は「${esc(ME)}」です。変えるなら選んでください</p>`}
  <input type="search" id="meSearch" class="nsearch" placeholder="名前で探す" value="${esc(meQuery)}" autocomplete="off" aria-label="名前で探す">
  <div id="meList">${nameChips(meQuery, ME, "me")}</div></div>`;
}

function listShaken() {
  if (!S.ready) return `<div class="loading">読み込み中…</div>`;
  const vs = byShaken(active());
  if (!vs.length) return `<div class="empty">まだ車が登録されていません</div>`;
  return `<p class="sub" style="margin-top:0">期限が近い順</p>` + vs.map(v => `
  <div class="li tap" data-act="detail" data-id="${v.id}" role="button" tabindex="0">
    ${plateHtml(v, true)}<div class="grow"><div class="t">${esc(v.kind)}</div><div class="s">${jp(v.shakenDate)}</div></div>
    <span class="days ${shakenClass(v)}">${shakenText(v)}</span></div>`).join("");
}

function listCars() {
  if (!S.ready) return `<div class="loading">読み込み中…</div>`;
  const all = active();
  if (!all.length) return `<div class="empty">まだ車が登録されていません。<br>事務所のPCから登録してください</div>`;
  const byType = all.filter(v => ui.tfilter === "all" || v.type === ui.tfilter);
  const n = k => byType.filter(v => k === "all" || status(v) === k).length;
  const nt = t => all.filter(v => (t === "all" || v.type === t) && (ui.filter === "all" || status(v) === ui.filter)).length;
  const list = byType.filter(v => ui.filter === "all" || status(v) === ui.filter);
  return `<div class="chips">
    ${[["all", "全部"], ["free", "空き"], ["use", "使用中"]].map(([k, l]) => `<button class="chip ${ui.filter === k ? "on" : ""}" data-act="filter" data-val="${k}">${l}<span class="n">${n(k)}</span></button>`).join("")}
  </div><div class="chips types">
    ${[["all", "全種類"], ...TYPES.map(t => [t, t])].map(([k, l]) => `<button class="chip ${ui.tfilter === k ? "on" : ""}" data-act="tfilter" data-val="${k}">${l}<span class="n">${nt(k)}</span></button>`).join("")}
  </div>` + (list.length ? "" : `<div class="empty">この条件の車はありません</div>`) + list.map(v => {
    const st = status(v), use = currentUse(v), fix = fixRepair(v);
    return `
  <button class="card" data-act="detail" data-id="${v.id}">
    <div class="band ${st}"><span>${LABEL[st]}</span>${bandExtra(v, st, use)}</div>
    <div class="body">
      ${thumbHtml(v)}
      <div class="meta"><div class="r1">${plateHtml(v, true)}${shakenTag(v)}</div><div class="kind">${esc(v.kind)}</div><div class="who">${useText(v, use, fix)}</div></div>
    </div>
  </button>`;
  }).join("");
}

function detail(v) {
  const st = status(v), use = currentUse(v), fix = fixRepair(v);
  const rows = [
    ["状態", `<span class="status-pill ${st}">${LABEL[st]}</span>`],
    use ? ["使っている人", esc(use.who) + "さん"] : null,
    use ? ["現場", esc(use.site)] : null,
    use ? ["いつまで", `${fmt(use.to)} まで`] : null,
    !use ? ["置いてある場所", esc(lotOf(v))] : null,
    fix ? ["修理", `<span class="warn">${esc(repairText(fix))}</span>`] : null,
    ["車検", `<span class="${shakenClass(v) ? "warn" : ""}">${jp(v.shakenDate)}（${shakenText(v)}）</span>`],
  ].filter(Boolean);
  const actions = st === "use"
    ? `<button class="btn primary" data-act="goto" data-val="return" data-id="${v.id}">返却する</button>`
    : (st === "free" ? `<button class="btn primary" data-act="goto" data-val="reserve" data-id="${v.id}">この車を予約する</button>` : "");
  return `<div class="hero">${thumbHtml(v, true)}${plateHtml(v)}</div>
  <div class="rows">${rows.map(([k, val]) => `<div class="row"><span class="k">${k}</span><span class="v">${val}</span></div>`).join("")}</div>
  <div class="actions">${actions}<button class="btn ghost" data-act="goto" data-val="repair" data-id="${v.id}">修理を頼む</button></div>
  ${calendar(v)}`;
}

// 今月のカレンダー（予約・使用中の日をオレンジ、今日を枠線）
function calendar(v) {
  const td = today(), y = td.getFullYear(), m = td.getMonth();
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const lo = ymd(first), hi = ymd(last), busy = new Set();
  S.reservations.filter(r => r.vehicleId === v.id && !r.returnedAt && r.to >= lo && r.from <= hi).forEach(r => {
    for (let d = parse(r.from > lo ? r.from : lo); ymd(d) <= r.to && ymd(d) <= hi; d.setDate(d.getDate() + 1)) busy.add(ymd(d));
  });
  let cells = [..."日月火水木金土"].map(d => `<div class="d dow">${d}</div>`).join("");
  for (let i = 0; i < first.getDay(); i++) cells += `<div class="d blank"></div>`;
  for (let d = 1; d <= last.getDate(); d++) {
    const k = ymd(new Date(y, m, d));
    cells += `<div class="d ${busy.has(k) ? "use" : ""} ${k === ymd(td) ? "today" : ""}">${d}</div>`;
  }
  const next = nextRes(v);
  return `<div class="cal"><h3>${m + 1}月の予定</h3><div class="grid">${cells}</div>
  <div class="legend"><i></i>予約・使用中${next ? ` ／ 次の予約：${fmt(next.from)}〜 ${esc(next.who)}さん（${esc(next.site)}）` : ""}</div></div>`;
}

/* ---------- 予約 ---------- */
const SITE_OTHER = "__other";
const plateText = v => `${esc(v.plateArea)} ${esc(v.plateClass)} ${esc(v.plateKana)} ${esc(v.plateNum)}`;
// 同じ車で日付が重なる予約（返却済みは除く）
const findClash = (list, vid, from, to) => list.find(r => r.vehicleId === vid && !r.returnedAt && r.from <= to && from <= r.to) || null;
const clashMsg = r => `その日は予約が入っています：${fmt(r.from)}〜${fmt(r.to)} ${r.who}さん（${r.site}）`;
class ClashError extends Error {}

function reserveForm(v) {
  const t = ymd(today());
  if (form.vid !== v.id) { resetForm(); form.vid = v.id; }
  form.from = form.from || t; form.to = form.to || form.from; form.site = form.site || "";
  const sites = S.settings.sites || [];
  return `<div class="sheet-title">${esc(v.kind)}</div><p class="sub">${plateText(v)}</p>
  <div class="field"><label>いつからいつまで</label><div class="two">
    <input type="date" name="from" value="${form.from}" aria-label="いつから">
    <input type="date" name="to" value="${form.to}" min="${form.from}" aria-label="いつまで"></div></div>
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
  const t = ymd(today());
  const who = form.other ? (form.picking ? "" : (form.who || "")) : ME;
  const site = form.site === SITE_OTHER ? String(form.siteOther || "").trim() : form.site;
  const { from, to } = form;
  let err = "";
  if (!from || !to) err = "いつからいつまでを入れてください";
  else if (to < from) err = "「いつまで」は「いつから」と同じか後の日にしてください";
  else if (to < t) err = "過ぎた日は予約できません";
  else if (!who || !site) err = "使う人と現場を選んでください";
  else { const c = findClash(S.reservations, v.id, from, to); if (c) err = clashMsg(c); }
  if (err) { form.err = err; render(); return; }

  form.err = ""; form.busy = true; render();
  const r = { vehicleId: v.id, who, site, from, to, createdBy: ME, returnedAt: null, returnedLot: null };
  try {
    // 2台のスマホで同時に予約しても重ならないよう、サーバーの最新の予約で確かめてから登録する
    await runTransaction(db, async tx => {
      const vref = doc(db, "vehicles", v.id);
      const vs = await tx.get(vref);
      if (!vs.exists() || vs.data().retired) throw new ClashError("この車は予約できません");
      const snap = await getDocsFromServer(query(collection(db, "reservations"), where("vehicleId", "==", v.id), where("returnedAt", "==", null)));
      const c = findClash(snap.docs.map(d => d.data()), v.id, from, to);
      if (c) throw new ClashError(clashMsg(c));
      tx.update(vref, { resSeq: increment(1), updatedAt: serverTimestamp() });
      tx.set(doc(collection(db, "reservations")), { ...r, createdAt: serverTimestamp() });
    });
  } catch (e) {
    console.error(e);
    form.busy = false;
    form.err = e instanceof ClashError ? e.message : "予約できませんでした。電波のよい所でもう一度押してください";
    if (ui.screen.name === "reserve") render();
    return;
  }
  resetForm();
  go({ name: "done", title: "予約しました", msg: `${fmt(from)}〜${fmt(to)}　${who}さん　${site}` });
}

/* ---------- 返却 ---------- */
function returnForm(v) {
  return `<div class="sheet-title">どこに止めましたか？</div><p class="sub">${esc(v.kind)}　${esc(v.plateKana)} ${esc(v.plateNum)}</p>
  <div class="opts">${(S.settings.lots || []).map(l => `<button class="opt" data-act="return" data-id="${v.id}" data-val="${esc(l)}">${esc(l)}<span>›</span></button>`).join("")}</div>`;
}
function doReturn(v, lot) {
  const use = currentUse(v);
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
    ? `<label class="photo-box">📷 写真をつける${rform.photos.length ? `（${rform.photos.length}枚）` : ""}<input type="file" id="r-photo" accept="image/*" multiple hidden></label>` : ""}
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
function renderPc() {
  const vs = active(), d = today();
  const n = k => vs.filter(v => status(v) === k).length;
  const retired = S.vehicles.filter(v => v.retired);
  const hasSample = S.vehicles.some(v => v.sample);

  let table;
  if (!S.ready) table = `<div class="loading">読み込み中…</div>`;
  else if (!vs.length) table = `<div class="empty">まだ車が登録されていません。「＋ 車両を追加」から登録してください${
    !S.vehicles.length ? `<div style="margin-top:12px"><button class="btn ghost small" data-act="seed">サンプルデータ（8台）を入れて試す</button></div>` : ""}</div>`;
  else table = `<table class="table"><thead><tr><th>状態</th><th>写真</th><th>ナンバー</th><th>車種</th><th>使っている人</th><th>現場</th><th>置き場所</th><th>車検</th></tr></thead><tbody>
      ${["use", "free", "fix"].map(g => {
        const rows = vs.filter(v => status(v) === g); if (!rows.length) return "";
        return `<tr class="grp ${g}"><td colspan="8">${LABEL[g]}<span>${rows.length}台</span></td></tr>` + rows.map(v => {
          const use = currentUse(v);
          return `<tr class="vrow ${g}" data-act="edit" data-id="${v.id}" title="押すと修正できます">
        <td class="st"><span class="dot ${g}"></span>${LABEL[g]}</td>
        <td>${thumbHtml(v)}</td><td>${plateHtml(v, true)}</td><td class="kind">${esc(v.kind)}</td>
        <td>${use ? esc(use.who) : "—"}</td><td>${use ? `${esc(use.site)}<div class="s" style="color:var(--mute);font-size:12px">${fmt(use.from)}〜${fmt(use.to)}</div>` : "—"}</td>
        <td>${use ? "—" : esc(lotOf(v))}</td><td><span class="days ${shakenClass(v)}" style="font-size:13px">${shakenText(v)}</span></td></tr>`;
        }).join("");
      }).join("")}
      </tbody></table>`;

  $("pc").innerHTML = `
  <div class="top"><h1>社用車 今日の状況</h1><span class="today">${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${DOW[d.getDay()]}）</span>
    <div class="counts"><div class="count free">${n("free")}<span>空き</span></div><div class="count use">${n("use")}<span>使用中</span></div><div class="count fix">${n("fix")}<span>修理中</span></div></div>
    <button class="btn ghost small" data-act="settings">⚙ 設定</button></div>
  ${errBar()}
  <div class="grid2">
    <div class="stack">
      ${shakenPanel()}
      ${repairPanel()}
      ${futurePanel()}
    </div>
    <div class="panel wide"><h2>全車両 <button class="btn primary small" data-act="add">＋ 車両を追加</button></h2>${table}</div>
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
  if (file.type && !file.type.startsWith("image/")) throw new Error("not-image");
  const img = await decodeImage(file);
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

// 車両の写真を登録・変更（PCの登録・修正フォームからのみ。スマホは見るだけ）
const uploading = new Set(); // 送信中の車ID
async function setVehiclePhoto(vid, file) {
  if (uploading.has(vid)) { toast("この車の写真を送っているところです"); return; }
  const old = byId(vid) || {};
  const oldPaths = [old.photoPath, old.thumbPath].filter(Boolean);
  uploading.add(vid);
  toast("写真を送っています…");
  try {
    const p = await makePhotos(file, `vehicles/${vid}`, pct => toast(`写真を送っています… ${pct}%`));
    await updateDoc(doc(db, "vehicles", vid), { ...p, updatedAt: serverTimestamp() });
    oldPaths.forEach(x => deleteObject(storageRef(storage, x)).catch(() => {})); // 前の写真は片づける
    toast("写真を登録しました");
  } catch (e) {
    console.error(e);
    toast(e.message === "not-image" ? "写真（画像）を選んでください" : "写真を送れませんでした。電波のよい所でもう一度お試しください");
  } finally {
    uploading.delete(vid);
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
  const soon = byShaken(active().filter(v => daysTo(v.shakenDate) <= lim));
  return `<div class="panel"><h2>車検が近い車 <span class="tag">${soon.length}台</span></h2>
    ${soon.length ? soon.map(v => `<div class="li tap" data-act="edit" data-id="${v.id}" title="押すと車検満了日を変えられます">${plateHtml(v, true)}<div class="grow"><div class="t">${esc(v.kind)}</div><div class="s">${jp(v.shakenDate)}</div></div><span class="days ${shakenClass(v)}">${shakenText(v)}</span></div>`).join("")
      : `<div class="empty">${lim}日以内の車検はありません</div>`}
  </div>`;
}
// PC: この先の予約（今日より後、日付順）
function futurePanel() {
  const t = ymd(today());
  const list = S.reservations.filter(r => !r.returnedAt && r.from > t && byId(r.vehicleId) && !byId(r.vehicleId).retired)
    .sort((a, b) => (a.from > b.from ? 1 : a.from < b.from ? -1 : 0));
  return `<div class="panel"><h2>この先の予約</h2>
    ${list.map(r => { const v = byId(r.vehicleId); return `<div class="li"><div class="days" style="background:var(--bg);color:var(--ink)">${fmt(r.from)}〜${fmt(r.to)}</div><div class="grow"><div class="t">${esc(v.kind)}</div><div class="s">${esc(r.who)}さん　${esc(r.site)}</div></div></div>`; }).join("") || `<div class="empty">予約はありません</div>`}
  </div>`;
}

// PC: 修理依頼パネル（未対応と修理中。対応済みは出さない）
function repairPanel() {
  const list = sortedRepairs(S.repairs.filter(r => r.status !== "done"))
    .sort((a, b) => (a.status === "in_repair") - (b.status === "in_repair")); // 未対応を上に
  const n = openCount();
  return `<div class="panel rpanel"><h2>修理依頼 <span class="tag">${n}件 未対応</span></h2>
    ${list.length ? list.map(r => {
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
    }).join("") : `<div class="empty">未対応の依頼はありません</div>`}
  </div>`;
}

/* ---------- 車両の登録・修正（PCのみ） ---------- */
let modalId = null; // null=追加, 文字列=修正中の車
function openModal(id) {
  const v = id ? byId(id) : null;
  modalId = v ? v.id : null;
  const lots = [...S.settings.lots];
  if (v && v.homeLot && !lots.includes(v.homeLot)) lots.push(v.homeLot);
  const val = k => esc(v ? v[k] : "");
  $("modal").innerHTML = `<div class="overlay"><form class="modal panel" id="vform" novalidate>
    <h2>${v ? "車両を修正" : "車両を追加"}<button type="button" class="x" data-act="close" aria-label="閉じる">×</button></h2>
    <div class="mbody">
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
      <div class="field"><label for="f-lot">通常の置き場所</label><select id="f-lot" name="homeLot">
        ${lots.map(l => `<option${(v ? v.homeLot === l : l === lots[0]) ? " selected" : ""}>${esc(l)}</option>`).join("")}</select></div>
      <div class="field"><label>写真（任意）</label>
        <div class="photo-pick"><span id="f-prev">${v ? thumbHtml(v) : `<div class="thumb">${carSvg(CAR_COLORS[0])}</div>`}</span>
        <label class="photo-btn">📷 ${v && v.photoUrl ? "写真を変える" : "写真を選ぶ"}<input type="file" accept="image/*" hidden id="f-photo"></label></div></div>
    </div>
    <div class="mfoot">
      ${v ? `<button type="button" class="btn danger" data-act="retire">廃車にする</button>` : ""}
      <span class="sp"></span>
      <button type="button" class="btn ghost" data-act="close">やめる</button>
      <button type="submit" class="btn primary">${v ? "保存する" : "登録する"}</button>
    </div>
  </form></div>`;
  $("modal").hidden = false;
  $("vform").plateArea.focus();
}
let pendingPhoto = null; // フォームで選んだ写真（保存するときに送る）
function closeModal() {
  $("modal").hidden = true; $("modal").innerHTML = ""; modalId = null;
  if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.preview);
  pendingPhoto = null;
}

/* ---------- 設定（PCのみ） ---------- */
const LOT_COUNT = 3;
function openSettings() {
  const st = S.settings;
  const lines = a => esc((a || []).join("\n"));
  const lots = [...(st.lots || [])]; while (lots.length < LOT_COUNT) lots.push("");
  modalId = null;
  $("modal").innerHTML = `<div class="overlay"><form class="modal panel" id="sform" novalidate>
    <h2>設定<button type="button" class="x" data-act="close" aria-label="閉じる">×</button></h2>
    <div class="mbody">
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
      <div class="field"><label>駐車場（${LOT_COUNT}ヶ所）</label>
        <div class="lots-in">${lots.slice(0, LOT_COUNT).map((l, i) => `<input name="lot${i}" value="${esc(l)}" aria-label="駐車場${i + 1}" maxlength="30" autocomplete="off">`).join("")}</div>
        <div class="hint">返却のときのボタンに出ます。名前を変えると、その駐車場にある車の置き場所も新しい名前になります</div></div>
      <div class="field"><label for="s-days">車検の通知（何日前から）</label>
        <div class="days-in"><input id="s-days" name="shakenAlertDays" type="number" inputmode="numeric" min="1" max="365" value="${esc(st.shakenAlertDays || 30)}"><span>日前から</span></div>
        <div class="hint">スマホの車両カードに「🔔 車検」が出始める日数です（はじめは30日）</div></div>
    </div>
    <div class="mfoot"><span class="sp"></span>
      <button type="button" class="btn ghost" data-act="close">やめる</button>
      <button type="submit" class="btn primary">保存する</button>
    </div>
  </form></div>`;
  $("modal").hidden = false;
  renderMemberList();
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
  const lots = Array.from({ length: LOT_COUNT }, (_, i) => String(f.get(`lot${i}`) || "").trim());
  const days = Number(toHalf(String(f.get("shakenAlertDays") || "")));
  let err = "";
  if (lots.some(l => !l)) err = `駐車場を${LOT_COUNT}つとも入れてください`;
  else if (new Set(lots).size < lots.length) err = "同じ名前の駐車場があります";
  else if (!Number.isInteger(days) || days < 1 || days > 365) err = "車検の通知は 1〜365 の数字で入れてください";
  if (err) { const e = $("ferr"); e.textContent = err; e.hidden = false; return; }

  const b = writeBatch(db);
  b.set(doc(db, "settings", "app"), { sites, lots, shakenAlertDays: days, updatedAt: serverTimestamp() }, { merge: true });
  // 駐車場の名前を変えたら、その名前の車の「置き場所」も書きかえる
  const old = S.settings.lots || [];
  const renames = new Map(old.map((o, i) => [o, lots[i]]).filter(([o, n]) => o && n && o !== n && !lots.includes(o)));
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
    plateNum: toHalf(g("plateNum")), kind: g("kind"), type: g("type"), shakenDate: g("shakenDate"), homeLot: g("homeLot"),
  };
  let err = "";
  if (!data.plateArea || !data.plateClass || !data.plateKana || !data.plateNum) err = "ナンバーを4つとも入れてください";
  else if (!/^[0-9A-Z]{1,3}$/.test(data.plateClass)) err = "分類番号は3けたまでの数字で入れてください（例：300）";
  else if (!data.kind) err = "車種を入れてください";
  else if (!TYPES.includes(data.type)) err = "種類（トラック／バン／普通車）を選んでください";
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(data.shakenDate)) err = "車検満了日を入れてください";
  else if (!data.homeLot) err = "通常の置き場所を選んでください";
  else {
    const key = x => [x.plateArea, x.plateClass, x.plateKana, x.plateNum].join(" ");
    const dup = S.vehicles.find(x => x.id !== modalId && key(x) === key(data));
    if (dup) err = `同じナンバーの車がすでにあります（${dup.kind}${dup.retired ? "・廃車済み" : ""}）`;
  }
  if (err) { const e = $("ferr"); e.textContent = err; e.hidden = false; return; }

  // 電波が悪くても画面はすぐ閉じる（Firestore が裏で送る）
  const ref = modalId ? doc(db, "vehicles", modalId) : doc(collection(db, "vehicles"));
  const p = modalId
    ? updateDoc(ref, { ...data, updatedAt: serverTimestamp() })
    : setDoc(ref, {
        ...data, currentLot: data.homeLot, photoUrl: null, status: "free", retired: false,
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
function restoreVehicle(id) {
  updateDoc(doc(db, "vehicles", id), { retired: false, retiredAt: null, updatedAt: serverTimestamp() })
    .catch(e => { console.error(e); toast("戻せませんでした"); });
  toast("一覧に戻しました");
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
    for (const c of ["reservations", "repairs"]) {
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

/* ---------- お知らせ ---------- */
let toastTimer;
function toast(msg) {
  const el = $("toast"); el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ---------- 操作 ---------- */
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const { act, id, val } = el.dataset;
  switch (act) {
    case "view": lsSet("sharyo_view", val); applyView(); break;
    case "tab": setTab(val); break;
    case "filter": ui.filter = val; render(); break;
    case "tfilter": ui.tfilter = val; render(); break;
    case "detail": go({ name: "detail", id }); break;
    case "back": go(ui.backTo || { name: "list" }); break;
    case "goto": go({ name: val, id }); break;
    case "me": saveMe(val); break;
    case "meEdit": go({ name: "me" }); break;
    case "whoOther": form.other = true; form.picking = true; form.whoQ = ""; form.err = ""; render(); break;
    case "whoMe": form.other = false; form.picking = false; form.who = ""; form.err = ""; render(); break;
    case "pickWho": form.who = val; form.picking = false; form.err = ""; render(); break;
    case "reserve": { const v = byId(id); if (v) doReserve(v); break; }
    case "return": { const v = byId(id); if (v) doReturn(v, val); break; }
    case "sym": toggleSym(val); break;
    case "rmPhoto": removeRepairPhoto(Number(val)); break;
    case "sendRepair": { const v = byId(id); if (v) doRepair(v); break; }
    case "repairSet": setRepairStatus(id, val); break;
    case "add": openModal(null); break;
    case "edit": openModal(id); break;
    case "close": closeModal(); break;
    case "settings": openSettings(); break;
    case "memImport": importFromNippo(); break;
    case "memToggle": toggleMember(id); break;
    case "memAdd": addMember(); break;
    case "retire": retireVehicle(modalId); break;
    case "restore": restoreVehicle(id); break;
    case "seed": seed(); break;
    case "unseed": unseed(); break;
  }
});
document.addEventListener("change", e => {
  const el = e.target;
  if (el.id === "r-photo") { // 修理を頼む：写真をつける（複数OK）
    addRepairPhotos(el.files); el.value = "";
  }
  if (el.id === "f-photo") { // PCの登録フォーム（保存を押したときに送る）
    const f = el.files && el.files[0]; if (!f) return;
    if (pendingPhoto) URL.revokeObjectURL(pendingPhoto.preview);
    pendingPhoto = { file: f, preview: URL.createObjectURL(f) };
    $("f-prev").innerHTML = `<div class="thumb"><img src="${pendingPhoto.preview}" alt=""></div>`;
  }
});
// 設定画面：名簿の検索、追加欄で Enter を押したとき
document.addEventListener("input", e => { if (e.target.id === "memSearch") { memQuery = e.target.value; renderMemberList(); } });
document.addEventListener("keydown", e => {
  if (e.key !== "Enter" || !e.target.id) return;
  if (e.target.id === "memSearch") e.preventDefault();
  if (/^madd-/.test(e.target.id)) { e.preventDefault(); addMember(); }
});
document.addEventListener("submit", e => {
  if (e.target.id === "vform") { e.preventDefault(); saveVehicle(e.target); }
  if (e.target.id === "sform") { e.preventDefault(); saveSettings(e.target); }
});
// 予約フォームの入力を覚えておく
$("ph-screen").addEventListener("input", e => {
  if (e.target.id === "meSearch") { meQuery = e.target.value; $("meList").innerHTML = nameChips(meQuery, ME, "me"); return; }
  if (e.target.id === "whoSearch") { form.whoQ = e.target.value; $("whoList").innerHTML = nameChips(form.whoQ, form.who, "pickWho"); return; }
  const n = e.target.name;
  if (ui.screen.name === "repair" && n === "memo") rform.memo = e.target.value;
  if (ui.screen.name === "reserve" && ["from", "to", "who", "site", "siteOther"].includes(n)) form[n] = e.target.value;
});
$("ph-screen").addEventListener("change", e => {
  if (ui.screen.name !== "reserve") return;
  const n = e.target.name;
  if (form.err) { form.err = ""; if (n !== "from" && n !== "site") render(); } // 直したら古いエラーは消す
  if (n === "from") {
    form.from = e.target.value;
    if (form.from && (!form.to || form.to < form.from)) form.to = form.from; // 「いつまで」を自動でそろえる
    render();
  }
  if (n === "site") { form.site = e.target.value; render(); } // 「その他」なら入力欄を出す
});
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.matches && e.target.matches(".li.tap")) e.target.click();
});
document.addEventListener("keydown", e => { if (e.key === "Escape" && !$("modal").hidden) closeModal(); });
document.addEventListener("toggle", e => { if (e.target.matches && e.target.matches("details.retired")) ui.retiredOpen = e.target.open; }, true);
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
    S.reservations = snapList(snap); done("r");
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
}

/* ---------- iPhone のホーム画面から開いたときの高さの補正 ----------
   上端をステータスバーの下まで広げる設定（black-translucent）のとき、iOS がアプリに伝える画面の高さが
   上の余白の分だけ短くなることがあり、アプリの枠が画面の下まで届かない。短い分だけ枠を下へ延ばす。
   iPhone のホーム画面アプリ以外（Safari・Android・PC）では何もしない。 */
function fixIosStandaloneHeight() {
  let gap = 0;
  if (navigator.standalone === true) {
    const portrait = matchMedia("(orientation: portrait)").matches;
    const full = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const d = Math.round(full - window.innerHeight);
    if (d > 0 && d <= 100) gap = d;
  }
  document.documentElement.style.setProperty("--ios-gap", gap + "px");
}
addEventListener("resize", fixIosStandaloneHeight);
addEventListener("orientationchange", () => setTimeout(fixIosStandaloneHeight, 300));
fixIosStandaloneHeight();

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
