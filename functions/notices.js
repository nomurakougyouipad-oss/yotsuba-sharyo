// 車の記録（vehicles）が書きかわったときに送る通知を決める（index.js の vehicleUpdated から使う）
// Firebase を使わない形にしてあるので、本物のデータにさわらずに試せる（node functions/notices.test.js）
//   wish ：トラストワンが車検の希望日（取りに行きたい日）を入れた・変えた → 会社（PCでオンの人）へ
//   avail：会社が預けられる日を入れた・変えた（「この日でOK」でも、箱に入れても）→ トラストワン（PCでオンの人）へ
const WD = "日月火水木金土";
// "2026-10-15" → "10/15（木）"
const dayText = s => { const [y, m, d] = String(s).split("-").map(Number); return `${m}/${d}（${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`; };
// 「愛媛400と260 ダンプ（デュトロ）」の形（番号の前の「・」は外す）
const shortCar = v => `${[v.plateArea, v.plateClass, v.plateKana, String(v.plateNum || "").replace(/^[・･·\s]+/, "")].filter(Boolean).join("")} ${v.kind || ""}`.trim();
// 今の満了日のための希望日だけを使う（車検が終わって満了日が変わったら、古い希望は使わない）
const wishOf = v => (v && v.shopWish && v.shopWish.date && (!v.shopWish.shaken || v.shopWish.shaken === v.shakenDate) ? v.shopWish : null);

function vehicleNotices(before, after) {
  const b = before || {}, a = after || {};
  // 廃車・隠した車・サンプルには送らない。車検に出す・戻す・取り消すときの書きかえでも送らない（取り消しで前の日に戻ったときなど）
  if (a.retired || a.hidden || a.sample || a.inspection || b.inspection) return [];
  const out = [], w = wishOf(a), bw = wishOf(b);
  if (w && (!bw || bw.date !== w.date)) {
    out.push({ type: "wish", title: "📅 車検の希望日が届きました", body: `${shortCar(a)}：トラストワンが ${dayText(w.date)}に取りに行きたいそうです` });
  }
  if (a.availDate && a.availDate !== b.availDate) {
    out.push({ type: "avail", title: "📅 預けられる日が決まりました", body: `${shortCar(a)}：${dayText(a.availDate)}に預けられます` });
  }
  return out;
}

module.exports = { vehicleNotices, shortCar, dayText };
