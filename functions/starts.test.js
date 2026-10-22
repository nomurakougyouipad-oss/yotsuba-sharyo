// starts.js の試し（Firebase にはつながない）：node functions/starts.test.js
const assert = require("node:assert/strict");
const { shouldRemind, shouldCancel, jst, carName, remindMsg, cancelMsg, CANCEL_MARK } = require("./starts");

// 日本時間の「2026-10-22 08:59」などをミリ秒に
const at = (day, hm) => Date.parse(`${day}T${hm}:00+09:00`);
const ts = ms => ({ toMillis: () => ms }); // Firestore の Timestamp のかわり
const res = (x = {}) => ({ vehicleId: "v1", who: "田中", site: "東レ", from: "2026-10-22", to: "2026-10-24", returnedAt: null, needStart: true, createdAt: ts(at("2026-10-20", "15:00")), ...x });
const T = "2026-10-22";

assert.deepEqual(jst(at("2026-10-22", "08:59")), { day: "2026-10-22", hour: 8 });
assert.deepEqual(jst(at("2026-10-22", "09:00")), { day: "2026-10-22", hour: 9 });
assert.deepEqual(jst(at("2026-10-22", "00:30")), { day: "2026-10-22", hour: 0 }); // 日本時間の0時台（世界時では前の日）

// 8:30：今日始まる・まだ押していない予約だけ
assert.equal(shouldRemind(res(), T), true);
assert.equal(shouldRemind(res({ startedAt: ts(at(T, "08:10")) }), T), false); // もう押した
assert.equal(shouldRemind(res({ from: "2026-10-23" }), T), false);            // 明日から
assert.equal(shouldRemind(res({ from: "2026-10-21" }), T), false);            // 昨日から（2日目は押さなくてよい）
assert.equal(shouldRemind(res({ needStart: undefined }), T), false);          // 版25までに入れた予約
for (const x of [{ canceled: true }, { returnedAt: ts(1) }, { sample: true }]) assert.equal(shouldRemind(res(x), T), false);

// 9:00：まだ押していない予約は取り消す
assert.equal(shouldCancel(res(), T), true);
assert.equal(shouldCancel(res({ createdAt: ts(at(T, "08:59")) }), T), true);  // 今日の 9:00 より前に入れた
assert.equal(shouldCancel(res({ createdAt: ts(at(T, "09:00")) }), T), false); // 今日の 9:00 より後に入れた → 取り消さない
assert.equal(shouldCancel(res({ createdAt: null }), T), true);               // 入れた時がわからない
assert.equal(shouldCancel(res({ startedAt: ts(at(T, "08:50")) }), T), false); // 押した
assert.equal(shouldCancel(res({ needStart: undefined }), T), false);         // 版25までに入れた予約
assert.equal(shouldCancel(res({ from: "2026-10-23" }), T), false);           // 明日から
assert.equal(shouldCancel(res({ from: "2026-10-21", createdAt: ts(at("2026-10-20", "10:00")) }), T), true); // 前の日に取り消せなかった分も
for (const x of [{ canceled: true }, { returnedAt: ts(1) }, { sample: true }]) assert.equal(shouldCancel(res(x), T), false);

// 文面
const car = { kind: "ハイエース", plateArea: "愛媛", plateClass: "300", plateKana: "あ", plateNum: "・12-34" };
assert.equal(carName(car), "ハイエース（愛媛 300 あ 12-34）");
assert.equal(remindMsg(car).body, "ハイエース（愛媛 300 あ 12-34）：9時までに「使い始める」を押してください");
assert.equal(cancelMsg(res(), car).body, "田中さんのハイエース（愛媛 300 あ 12-34）の予約を取り消しました");
assert.deepEqual(CANCEL_MARK, { canceled: true, canceledBy: "自動（使い始めなし）", noStart: true });

console.log("starts.js：すべて OK");
