// notices.js の試し（Firebase にはつながない）：node functions/notices.test.js
const assert = require("node:assert/strict");
const { vehicleNotices, shortCar, dayText } = require("./notices");

const car = (x = {}) => ({ plateArea: "愛媛", plateClass: "400", plateKana: "と", plateNum: "・260", kind: "ダンプ（デュトロ）", shakenDate: "2026-10-20", retired: false, ...x });
const wish = (date, shaken = "2026-10-20") => ({ date, by: "山岡（トラストワン）", shaken });
const types = (b, a) => vehicleNotices(b, a).map(n => n.type);

assert.equal(shortCar(car()), "愛媛400と260 ダンプ（デュトロ）");
assert.equal(dayText("2026-10-15"), "10/15（木）");

// トラストワンが希望日を入れた → 会社へ
assert.deepEqual(types(car(), car({ shopWish: wish("2026-10-15") })), ["wish"]);
assert.equal(vehicleNotices(car(), car({ shopWish: wish("2026-10-15") }))[0].body, "愛媛400と260 ダンプ（デュトロ）：トラストワンが 10/15（木）に取りに行きたいそうです");
// 希望日を変えた → また会社へ。同じ日のまま（ほかの所が変わっただけ）→ 送らない
assert.deepEqual(types(car({ shopWish: wish("2026-10-15") }), car({ shopWish: wish("2026-10-16") })), ["wish"]);
assert.deepEqual(types(car({ shopWish: wish("2026-10-15") }), car({ shopWish: wish("2026-10-15"), currentLot: "本社" })), []);
// 会社が預けられる日を入れた（この日でOK・箱）→ トラストワンへ。変えたらまた。消したら送らない
assert.deepEqual(types(car({ shopWish: wish("2026-10-15") }), car({ shopWish: wish("2026-10-15"), availDate: "2026-10-15" })), ["avail"]);
assert.equal(vehicleNotices(car(), car({ availDate: "2026-10-15" }))[0].body, "愛媛400と260 ダンプ（デュトロ）：10/15（木）に預けられます");
assert.deepEqual(types(car({ availDate: "2026-10-15" }), car({ availDate: "2026-10-17" })), ["avail"]);
assert.deepEqual(types(car({ availDate: "2026-10-15" }), car({ availDate: null })), []);
// 車検に出す・戻す・取り消す（前の日に戻す）ときは送らない
const insp = { id: "i1", from: "2026-10-09", until: null };
assert.deepEqual(types(car({ availDate: "2026-10-15", shopWish: wish("2026-10-15") }), car({ inspection: insp, availDate: null, shopWish: null })), []);
assert.deepEqual(types(car({ inspection: insp }), car({ availDate: "2026-10-15", shopWish: wish("2026-10-15") })), []);
// 前の車検のときの希望日（満了日がちがう）は使わない
assert.deepEqual(types(car({ shakenDate: "2028-10-20" }), car({ shakenDate: "2028-10-20", shopWish: wish("2026-10-15", "2026-10-20") })), []);
// 廃車・隠した車・サンプルには送らない
for (const x of [{ retired: true }, { hidden: true }, { sample: true }]) assert.deepEqual(types(car(x), car({ ...x, availDate: "2026-10-15", shopWish: wish("2026-10-15") })), []);
// 希望日と預けられる日を一度に（ふつうは起きない）→ 両方
assert.deepEqual(types(car(), car({ availDate: "2026-10-15", shopWish: wish("2026-10-15") })), ["wish", "avail"]);

console.log("notices.js：すべて OK");
