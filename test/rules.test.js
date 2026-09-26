import test from "node:test";
import assert from "node:assert/strict";
import {
  PURPOSES,
  FRESHNESS_MS,
  isQualified,
  evaluateAt,
  slotsOverlap,
  recalcRecord,
} from "../src/rules.js";

const H = 3600 * 1000;
const iso = (d) => new Date(d).toISOString();

test("限值按用途：预洗最宽、定影后最严", () => {
  const t = { silverMgL: 30, turbidityNtu: 8 };
  assert.equal(isQualified(t, "prewash").ok, true);
  assert.equal(isQualified(t, "post_develop").ok, false); // 银30>20
  assert.equal(isQualified(t, "post_fix").ok, false);
  assert.deepEqual(isQualified({ silverMgL: 1, turbidityNtu: 15 }, "post_develop").reasons, ["turbidity_exceeded"]);
  assert.equal(PURPOSES.post_fix.silverMaxMgL, 10);
});

test("evaluateAt 取冲洗时刻之前最近的检测，超八小时判 stale", () => {
  const tank = { id: "t1", purpose: "prewash" };
  const now = Date.now();
  const inspections = [
    { id: "a", tankId: "t1", at: iso(now - 9 * H), silverMgL: 1, turbidityNtu: 1 },
    { id: "b", tankId: "t1", at: iso(now - 2 * H), silverMgL: 1, turbidityNtu: 1 },
    // 未来检测不能提前用作许可
    { id: "c", tankId: "t1", at: iso(now + H), silverMgL: 1, turbidityNtu: 1 },
  ];
  const v = evaluateAt(tank, inspections, now);
  assert.equal(v.test.id, "b");
  assert.equal(v.stale, false);
  assert.equal(v.qualified, true);

  const old = evaluateAt(tank, [inspections[0]], now);
  assert.equal(old.stale, true);
  assert.equal(old.qualified, false);
  assert.deepEqual(old.reasons, ["test_stale"]);

  assert.equal(evaluateAt(tank, [], now).qualified, false);
  assert.equal(FRESHNESS_MS, 8 * H);
});

test("slotsOverlap：相接不重叠，交叉才冲突", () => {
  assert.equal(slotsOverlap(iso(0), iso(H), iso(H), iso(2 * H)), false);
  assert.equal(slotsOverlap(iso(0), iso(2 * H), iso(H), iso(3 * H)), true);
  assert.equal(slotsOverlap(iso(2 * H), iso(3 * H), iso(0), iso(H)), false);
});

test("recalcRecord：缸待复检/用途不符/无检测/占用 全部拒绝，合格则带许可", () => {
  const now = Date.now();
  const test = { id: "i1", tankId: "t1", at: iso(now - 2 * H), silverMgL: 5, turbidityNtu: 2 };
  const tank = { id: "t1", purpose: "prewash", status: "open" };
  const record = {
    id: "w1", tankId: "t1", negativeId: "N1", purpose: "prewash",
    startAt: iso(now), endAt: iso(now + H), status: "confirmed",
  };
  const base = { record, tank, inspections: [test], activeRecords: [] };

  const okVerdict = recalcRecord(base);
  assert.equal(okVerdict.ok, true);
  assert.equal(okVerdict.permit.inspectionId, "i1");
  assert.equal(recalcRecord({ ...base, tank: { ...tank, status: "pending" } }).reason, "tank_pending");
  // 用途变更触发重算：按缸的现用途限值重评（银30 对预洗合格、对定影后超限）
  assert.equal(recalcRecord({
    ...base,
    tank: { ...tank, purpose: "post_fix" },
    inspections: [{ id: "i2", tankId: "t1", at: iso(now - 2 * H), silverMgL: 30, turbidityNtu: 8 }],
  }).reason, "silver_exceeded");
  assert.equal(recalcRecord({ ...base, inspections: [] }).reason, "no_test");

  const blocker = {
    id: "w2", tankId: "t1", negativeId: "N2", status: "confirmed",
    startAt: iso(now + 1800000), endAt: iso(now + 2 * H),
  };
  const conflict = recalcRecord({ ...base, activeRecords: [blocker] });
  assert.equal(conflict.reason, "slot_occupied");
  assert.equal(conflict.occupyingNegativeId, "N2");
});
