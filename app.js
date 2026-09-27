// 社用車管理アプリ（段階1: 車両一覧・詳細・PC版の登録／修正／廃車・Firestore同期・サンプル投入）
import { firebaseConfig, FIREBASE_SDK_VERSION } from "./firebase-config.js";

const $ = id => document.getElementById(id);

/* ---------- Firebase ---------- */
const SDK = `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}`;
let fb;
try {
  const [app, auth, fs] = await Promise.all([
    import(`${SDK}/firebase-app.js`),
    import(`${SDK}/firebase-auth.js`),
    import(`${SDK}/firebase-firestore.js`),
  ]);
  fb = { ...app, ...auth, ...fs };
} catch (e) {
  console.error(e);
  $("ph-screen").innerHTML = `<div class="errbar">読み込めませんでした。電波のよい所でもう一度開いてください。</div>`;
  throw e;
}
const {
  initializeApp, getAuth, signInAnonymously, onAuthStateChanged,
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, query, where, onSnapshot, getDocs, addDoc, updateDoc, writeBatch,
  serverTimestamp, Timestamp,
} = fb;

const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
// 電波が悪い現場でも前回の内容が見えるよう、端末にも保存しておく
const db = initializeFirestore(fbApp, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

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
  ready: false, error: "",
};

/* ---------- 画面の状態 ---------- */
const wide = matchMedia("(min-width: 900px)");
const ui = { view: "phone", tab: "cars", screen: { name: "list" }, filter: "all", tfilter: "all", retiredOpen: false };

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
function thumbHtml(v) { return `<div class="thumb" aria-hidden="true">${v.photoUrl ? `<img src="${esc(v.photoUrl)}" alt="">` : carSvg(carColor(v))}</div>`; }
function plateHtml(v, small) {
  return `<span class="plate"${small ? ' style="font-size:15px"' : ""}><small>${esc(v.plateArea)} ${esc(v.plateClass)}</small>${esc(v.plateKana)} ${esc(v.plateNum)}</span>`;
}
function shakenClass(v) { const d = daysTo(v.shakenDate); return d < 0 ? "over" : (d <= alertDays() ? "soon" : ""); }
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
function go(s) { ui.screen = s; render(); $("ph-screen").scrollTop = 0; }
function setTab(t) { ui.tab = t; go({ name: "list" }); }

function render() { if (ui.view === "phone") renderPhone(); else renderPc(); }

/* ================= スマホ版 ================= */
function renderPhone() {
  const h = $("ph-header"), s = $("ph-screen"), t = $("ph-tabs");
  t.innerHTML = [["cars", "🚐", "車両"], ["shaken", "📋", "車検"], ["repair", "🔧", "修理"]].map(([k, ic, l]) =>
    `<button class="${ui.tab === k ? "on" : ""}" data-act="tab" data-val="${k}"><span class="ic">${ic}</span>${l}</button>`).join("");

  let title = "社用車", back = false, body = "";
  const d = today();
  if (ui.screen.name === "detail") {
    const v = byId(ui.screen.id);
    if (!v || v.retired) { ui.screen = { name: "list" }; return renderPhone(); }
    title = esc(v.kind); back = true; body = detail(v);
  } else if (ui.tab === "cars") {
    body = listCars();
  } else if (ui.tab === "shaken") {
    title = "車検"; body = `<div class="empty">車検の一覧は、次の段階で使えるようになります</div>`;
  } else {
    title = "修理依頼"; body = `<div class="empty">修理依頼の一覧は、次の段階で使えるようになります</div>`;
  }
  h.innerHTML = `${back ? `<button class="back" data-act="back" aria-label="戻る">‹</button>` : ""}<h1>${title}</h1><span class="today">${d.getMonth() + 1}/${d.getDate()}（${DOW[d.getDay()]}）</span>`;
  s.innerHTML = errBar() + body;
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
      <div class="meta"><div class="r1">${plateHtml(v, true)}</div><div class="kind">${esc(v.kind)}</div><div class="who">${useText(v, use, fix)}</div></div>
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
    ? `<button class="btn primary" data-act="soon">返却する</button>`
    : (st === "free" ? `<button class="btn primary" data-act="soon">この車を予約する</button>` : "");
  return `<div class="hero">${thumbHtml(v)}${plateHtml(v)}<button class="photo-btn" data-act="soon">📷 ${v.photoUrl ? "写真を変える" : "写真を登録"}</button></div>
  <div class="rows">${rows.map(([k, val]) => `<div class="row"><span class="k">${k}</span><span class="v">${val}</span></div>`).join("")}</div>
  <div class="actions">${actions}<button class="btn ghost" data-act="soon">修理を頼む</button></div>`;
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
    <div class="counts"><div class="count free">${n("free")}<span>空き</span></div><div class="count use">${n("use")}<span>使用中</span></div><div class="count fix">${n("fix")}<span>修理中</span></div></div></div>
  ${errBar()}
  <div class="grid2">
    <div class="panel wide"><h2>全車両 <button class="btn primary small" data-act="add">＋ 車両を追加</button></h2>${table}</div>
    ${retired.length ? `<details class="panel retired"${ui.retiredOpen ? " open" : ""}><summary>廃車済み（${retired.length}台）</summary>
      <table class="table"><tbody>${retired.map(v => `<tr>
        <td>${thumbHtml(v)}</td><td>${plateHtml(v, true)}</td><td class="kind">${esc(v.kind)}</td><td>${esc(v.type)}</td>
        <td style="text-align:right"><button class="btn ghost small" data-act="restore" data-id="${v.id}">戻す</button></td></tr>`).join("")}</tbody></table>
    </details>` : ""}
  </div>
  ${hasSample ? `<p class="sample-note">サンプルデータが入っています。本番の車を登録する前に <button class="linkbtn" data-act="unseed">サンプルデータを消す</button></p>` : ""}`;
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
function closeModal() { $("modal").hidden = true; $("modal").innerHTML = ""; modalId = null; }

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
  const p = modalId
    ? updateDoc(doc(db, "vehicles", modalId), { ...data, updatedAt: serverTimestamp() })
    : addDoc(collection(db, "vehicles"), {
        ...data, currentLot: data.homeLot, photoUrl: null, status: "free", retired: false,
        createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
      });
  toast(modalId ? "保存しました" : "登録しました");
  closeModal();
  p.catch(e => { console.error(e); toast("保存できませんでした。もう一度お試しください"); });
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
  if (!confirm("サンプルデータ（車・予約・修理の例）をすべて消します。\n自分で登録した車は消えません。\n\n消しますか？")) return;
  try {
    const b = writeBatch(db);
    for (const c of ["vehicles", "reservations", "repairs"]) {
      (await getDocs(query(collection(db, c), where("sample", "==", true)))).forEach(d => b.delete(d.ref));
    }
    await b.commit();
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
    case "back": go({ name: "list" }); break;
    case "soon": toast("この機能は次の段階で使えるようになります"); break;
    case "add": openModal(null); break;
    case "edit": openModal(id); break;
    case "close": closeModal(); break;
    case "retire": retireVehicle(modalId); break;
    case "restore": restoreVehicle(id); break;
    case "seed": seed(); break;
    case "unseed": unseed(); break;
  }
});
document.addEventListener("submit", e => { if (e.target.id === "vform") { e.preventDefault(); saveVehicle(e.target); } });
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
  const done = k => { loaded.add(k); S.ready = loaded.size >= 3; S.error = ""; render(); };
  onSnapshot(collection(db, "vehicles"), snap => {
    S.vehicles = snapList(snap).sort((a, b) => millis(a.createdAt) - millis(b.createdAt));
    done("v");
  }, onErr);
  onSnapshot(query(collection(db, "reservations"), where("returnedAt", "==", null)), snap => {
    S.reservations = snapList(snap); done("r");
  }, onErr);
  onSnapshot(collection(db, "repairs"), snap => { S.repairs = snapList(snap); done("p"); }, onErr);
  onSnapshot(doc(db, "settings", "app"), d => {
    S.settingsExists = d.exists();
    S.settings = { ...DEFAULT_SETTINGS, ...(d.data() || {}) };
    render();
  }, onErr);
}

applyView();
onAuthStateChanged(auth, user => { if (user) startSync(); });
signInAnonymously(auth).catch(e => {
  console.error(e);
  S.error = e.code === "auth/unauthorized-domain"
    ? "このアドレスが Firebase に登録されていません（承認済みドメインを追加してください）"
    : "接続できませんでした。電波のよい所でもう一度開いてください";
  render();
});
