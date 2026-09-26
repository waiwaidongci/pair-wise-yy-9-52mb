import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Archive, ValidationError } from "../src/archive.js";
import { Operations, ConflictError } from "../src/operations.js";
import { FRESHNESS_MS } from "../src/rules.js";

const iso = (d) => new Date(d).toISOString();
const H = 3600 * 1000;

async function makeOps() {
  const dir = await mkdtemp(join(tmpdir(), "wash-"));
  const archive = new Archive(join(dir, "db.json"));
  await archive.load();
  const ops = new Operations(archive);
  return {
    ops,
    save: () => archive.save(),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// 断言 fn 以指定 code 的 ConflictError 失败
async function expectDenied(fn, code) {
  let thrown = null;
  try {
    await fn();
  } catch (e) {
    thrown = e;
  }
  assert.ok(thrown instanceof ConflictError, "应抛出 ConflictError，实际：" + (thrown && thrown.message));
  if (code) assert.equal(thrown.code, code);
  return thrown;
}

test("建缸登记来源、容量、用途，无检测时不可洗（缸待复检）", async () => {
  const { ops, save, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-1", source: "高银盐水", capacityLiters: 120, purpose: "prewash" });
    await save();
    assert.equal(t.status, "open");
    const err = await expectDenied(
      () => ops.registerWash({ tankId: t.id, negativeId: "N-1", purpose: "prewash", operator: "甲", startAt: iso(Date.now()), endAt: iso(Date.now() + 1800000) }),
      "no_test",
    );
    assert.equal(err.message, "该缸尚未登记检测");
    assert.equal(ops.db.tanks[0].status, "pending");
    assert.equal(ops.db.tanks[0].pendingReason, "no_test");
    assert.equal(ops.db.washes.length, 0, "被拒请求不产生用量记录");
    assert.ok(ops.db.events.some((e) => e.type === "wash_denied_quality"));
  } finally {
    await cleanup();
  }
});

test("检测合格后可登记冲洗；限值按用途区分，超限即打回", async () => {
  const { ops, save, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-2", source: "井水", capacityLiters: 80, purpose: "post_fix" });
    const now = Date.now();
    // 定影后限值 银10 / 浊度5
    ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 8, turbidityNtu: 4, inspector: "甲" });
    const w = ops.registerWash({ tankId: t.id, negativeId: "N-2", purpose: "post_fix", operator: "乙", startAt: iso(now), endAt: iso(now + 1800000) });
    assert.equal(w.status, "confirmed");
    assert.equal(w.permit.inspectionId, ops.db.inspections[0].id);

    // 银盐超限（12 > 10）的常规登记一提交即把缸打回
    ops.registerInspection({ tankId: t.id, at: iso(now + 2 * H), silverMgL: 12, turbidityNtu: 4, inspector: "甲" });
    assert.equal(ops.db.tanks[0].status, "pending");
    assert.equal(ops.db.tanks[0].pendingReason, "silver_exceeded");
    await expectDenied(
      () => ops.registerWash({ tankId: t.id, negativeId: "N-3", purpose: "post_fix", operator: "乙", startAt: iso(now + 3 * H), endAt: iso(now + 4 * H) }),
      "tank_pending",
    );
    await save();
  } finally {
    await cleanup();
  }
});

test("冲洗当时检测指标超限：申请被拒并打回缸", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-2b", source: "井水", capacityLiters: 80, purpose: "post_fix" });
    const now = Date.now();
    // 登记时合格，随后银盐超限（仍在八小时内）
    ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 8, turbidityNtu: 4, inspector: "甲" });
    ops.registerInspection({ tankId: t.id, at: iso(now - 1800000), silverMgL: 30, turbidityNtu: 4, inspector: "甲" });
    assert.equal(t.status, "pending");
    await expectDenied(
      () => ops.registerWash({ tankId: t.id, negativeId: "N-2b", purpose: "post_fix", operator: "乙", startAt: iso(now + H), endAt: iso(now + 2 * H) }),
      "tank_pending",
    );

    // 只浊度超限的场景
    const t2 = ops.createTank({ code: "W-2c", source: "井水", capacityLiters: 80, purpose: "prewash" });
    ops.registerInspection({ tankId: t2.id, at: iso(now - H), silverMgL: 1, turbidityNtu: 30, inspector: "甲" });
    assert.equal(t2.status, "pending");
    assert.equal(t2.pendingReason, "turbidity_exceeded");
  } finally {
    await cleanup();
  }
});

test("检测超过八小时只能待复检", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-3", source: "回用", capacityLiters: 50, purpose: "prewash" });
    const now = Date.now();
    ops.registerInspection({ tankId: t.id, at: iso(now - 9 * H), silverMgL: 10, turbidityNtu: 5, inspector: "甲" });
    await expectDenied(
      () => ops.registerWash({ tankId: t.id, negativeId: "N-4", purpose: "prewash", operator: "乙", startAt: iso(now), endAt: iso(now + H) }),
      "test_stale",
    );
    assert.equal(ops.db.tanks[0].status, "pending");
  } finally {
    await cleanup();
  }
});

test("同一缸同一时段只接受一张底片；重复请求指出占用底片且不写入", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-4", source: "井水", capacityLiters: 60, purpose: "prewash" });
    const now = Date.now();
    ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 10, turbidityNtu: 5, inspector: "甲" });
    ops.registerWash({ tankId: t.id, negativeId: "N-A", purpose: "prewash", operator: "乙", startAt: iso(now), endAt: iso(now + 2 * H) });
    const before = ops.db.washes.length;
    const err = await expectDenied(
      () => ops.registerWash({ tankId: t.id, negativeId: "N-B", purpose: "prewash", operator: "丙", startAt: iso(now + H), endAt: iso(now + 3 * H) }),
      "slot_occupied",
    );
    assert.equal(err.payload.occupyingNegativeId, "N-A");
    assert.equal(err.payload.occupyingWashId, ops.db.washes[0].id);
    assert.equal(ops.db.washes.length, before, "冲突请求不写入用量");
    // 首尾相接不重叠，可以洗
    const ok = ops.registerWash({ tankId: t.id, negativeId: "N-C", purpose: "prewash", operator: "丙", startAt: iso(now + 2 * H), endAt: iso(now + 3 * H) });
    assert.equal(ok.status, "confirmed");
  } finally {
    await cleanup();
  }
});

test("用途不匹配被拒，不影响缸状态", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-5", source: "井水", capacityLiters: 60, purpose: "prewash" });
    const now = Date.now();
    ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 10, turbidityNtu: 5, inspector: "甲" });
    await expectDenied(
      () => ops.registerWash({ tankId: t.id, negativeId: "N-5", purpose: "post_fix", operator: "乙", startAt: iso(now), endAt: iso(now + H) }),
      "purpose_mismatch",
    );
    assert.equal(ops.db.tanks[0].status, "open");
  } finally {
    await cleanup();
  }
});

test("复检须由另一人连续两次合格才重新开放，同人第二次被拒；失败清零", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-6", source: "回用", capacityLiters: 90, purpose: "post_develop" });
    const now = Date.now();
    // 先合格开放、再因超限打回
    ops.registerInspection({ tankId: t.id, at: iso(now - 5 * H), silverMgL: 5, turbidityNtu: 2, inspector: "甲" });
    ops.registerInspection({ tankId: t.id, at: iso(now - 4 * H), silverMgL: 40, turbidityNtu: 2, inspector: "甲" });
    assert.equal(t.status, "pending");
    assert.equal(ops.pendingTanks()[0].needPasses, 2);

    // 第一次复检：甲，合格
    ops.registerInspection({ tankId: t.id, at: iso(now - 3 * H), silverMgL: 5, turbidityNtu: 2, inspector: "甲" });
    assert.equal(t.status, "pending");
    assert.equal(t.recheck.streak, 1);
    // 第二次还是甲 → 拒绝，不计数
    await expectDenied(
      () => ops.registerInspection({ tankId: t.id, at: iso(now - 2 * H), silverMgL: 5, turbidityNtu: 2, inspector: "甲" }),
      "recheck_same_inspector",
    );
    assert.equal(t.recheck.streak, 1);
    // 换乙合格 → 开放
    ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 5, turbidityNtu: 2, inspector: "乙" });
    assert.equal(t.status, "open");

    // 失败清零路径：乙一次合格后，下一次不合格 → 归零
    ops.registerInspection({ tankId: t.id, at: iso(now), silverMgL: 40, turbidityNtu: 2, inspector: "乙" });
    ops.registerInspection({ tankId: t.id, at: iso(now + H), silverMgL: 5, turbidityNtu: 2, inspector: "乙" });
    assert.equal(t.recheck.streak, 1);
    ops.registerInspection({ tankId: t.id, at: iso(now + 2 * H), silverMgL: 40, turbidityNtu: 2, inspector: "丙" });
    assert.equal(t.recheck.streak, 0);
    assert.equal(t.status, "pending");
  } finally {
    await cleanup();
  }
});

test("无检测建档的缸一次合格复检即可启用", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-7", source: "新水", capacityLiters: 30, purpose: "prewash" });
    const now = Date.now();
    await expectDenied(
      () => ops.registerWash({ tankId: t.id, negativeId: "N-7", purpose: "prewash", operator: "甲", startAt: iso(now), endAt: iso(now + H) }),
      "no_test",
    );
    assert.equal(ops.pendingTanks()[0].needPasses, 1);
    ops.registerInspection({ tankId: t.id, at: iso(now), silverMgL: 5, turbidityNtu: 2, inspector: "甲" });
    assert.equal(t.status, "open");
  } finally {
    await cleanup();
  }
});

test("改检测：原许可与后续冲洗退回；更正后按当时检测重算，合格者恢复", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-8", source: "井水", capacityLiters: 60, purpose: "prewash" });
    const now = Date.now();
    const insp = ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 5, turbidityNtu: 2, inspector: "甲" }).inspection;
    // w0 在错误检测“合格”期间冲洗；w1、w2 排在复检之后
    const w0 = ops.registerWash({ tankId: t.id, negativeId: "N-0", purpose: "prewash", operator: "乙", startAt: iso(now), endAt: iso(now + 30 * 60000) });
    const w1 = ops.registerWash({ tankId: t.id, negativeId: "N-1", purpose: "prewash", operator: "乙", startAt: iso(now + 2 * H), endAt: iso(now + 2 * H + 30 * 60000) });
    const w2 = ops.registerWash({ tankId: t.id, negativeId: "N-2", purpose: "prewash", operator: "丙", startAt: iso(now + 3 * H), endAt: iso(now + 3 * H + 30 * 60000) });

    // 事后发现当时检测录错，实为超限 → 全部退回，缸待复检
    ops.editInspection(insp.id, { silverMgL: 80 }, "管理员");
    assert.equal(w0.status, "returned");
    assert.equal(w1.status, "returned");
    assert.equal(w2.status, "returned");
    assert.equal(t.status, "pending");
    assert.equal(t.pendingReason, "silver_exceeded");

    // 双人复检合格，时间早于 w1/w2、晚于 w0
    ops.registerInspection({ tankId: t.id, at: iso(now + 60 * 60000), silverMgL: 5, turbidityNtu: 2, inspector: "甲" });
    assert.equal(w1.status, "returned", "第一次复检后仍待复检，不重算");
    ops.registerInspection({ tankId: t.id, at: iso(now + 90 * 60000), silverMgL: 5, turbidityNtu: 2, inspector: "乙" });
    assert.equal(t.status, "open");
    // w0 冲洗时刻之前没有任何合格检测 → 不能补发许可，仍退回
    assert.equal(w0.status, "returned");
    assert.equal(w0.returnReason, "inspection_changed");
    assert.equal(w0.history.at(-1).reason, "silver_exceeded");
    // w1/w2 在新检测 8 小时窗口内 → 重算恢复，许可指向复检
    assert.equal(w1.status, "confirmed");
    assert.equal(w2.status, "confirmed");
    assert.notEqual(w1.permit.inspectionId, insp.id);
    assert.ok(w1.history.some((h) => h.kind === "reconfirmed"));
  } finally {
    await cleanup();
  }
});

test("重算时段冲突：缸开放后自动重算，冲突者保持退回并记录占用底片", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-8b", source: "井水", capacityLiters: 60, purpose: "prewash" });
    const now = Date.now();
    const insp = ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 5, turbidityNtu: 2, inspector: "甲" }).inspection;
    ops.registerWash({ tankId: t.id, negativeId: "N-1", purpose: "prewash", operator: "乙", startAt: iso(now + 2 * H), endAt: iso(now + 2 * H + 30 * 60000) });
    const w2 = ops.registerWash({ tankId: t.id, negativeId: "N-2", purpose: "prewash", operator: "丙", startAt: iso(now + 3 * H), endAt: iso(now + 3 * H + 30 * 60000) });
    ops.editInspection(insp.id, { silverMgL: 80 }, "管理员");
    // 与 w2 同时段的外来有效冲洗（占用者）
    ops.archive.addWash({
      id: ops.archive.nextId("wash"), tankId: t.id, negativeId: "N-Z", purpose: "prewash",
      startAt: iso(now + 3 * H + 10 * 60000), endAt: iso(now + 3 * H + 25 * 60000),
      operator: "丁", status: "confirmed",
      permit: { inspectionId: "later", testAt: iso(now + 90 * 60000), silverMgL: 5, turbidityNtu: 2 },
      history: [],
    });
    ops.registerInspection({ tankId: t.id, at: iso(now + 60 * 60000), silverMgL: 5, turbidityNtu: 2, inspector: "甲" });
    ops.registerInspection({ tankId: t.id, at: iso(now + 90 * 60000), silverMgL: 5, turbidityNtu: 2, inspector: "乙" });
    assert.equal(t.status, "open");
    const n1 = ops.db.washes.find((w) => w.negativeId === "N-1");
    assert.equal(n1.status, "confirmed");
    assert.equal(w2.status, "returned");
    assert.equal(w2.returnReason, "inspection_changed");
    assert.equal(w2.history.at(-1).reason, "slot_occupied");
    assert.equal(w2.history.at(-1).occupyingNegativeId, "N-Z");
  } finally {
    await cleanup();
  }
});

test("改用途：全部原许可退回，与新用途限值不符的保持退回；复检放行后重算恢复", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-9", source: "高银盐水", capacityLiters: 100, purpose: "prewash" });
    const now = Date.now();
    ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 30, turbidityNtu: 8, inspector: "甲" });
    const w = ops.registerWash({ tankId: t.id, negativeId: "N-9", purpose: "prewash", operator: "乙", startAt: iso(now), endAt: iso(now + H) });
    assert.equal(w.status, "confirmed");

    // 改成定影后：银30 > 10，重算不合格，缸待复检
    ops.changeTankPurpose(t.id, "post_fix", "管理员");
    assert.equal(w.status, "returned");
    assert.equal(w.returnReason, "purpose_changed");
    assert.equal(t.status, "pending");
    const results = ops.recalcTank(t.id);
    assert.equal(results[0].ok, false);
    assert.equal(results[0].reason, "silver_exceeded");
    assert.equal(w.status, "returned");

    // 改回预洗并双人复检放行 → 自动重算恢复（w 时刻最近检测为银30，符合预洗）
    ops.changeTankPurpose(t.id, "prewash", "管理员");
    assert.equal(t.status, "pending", "用途改回本身不解除待复检");
    ops.registerInspection({ tankId: t.id, at: iso(now - 30 * 60000), silverMgL: 30, turbidityNtu: 8, inspector: "甲" });
    assert.equal(t.status, "pending");
    ops.registerInspection({ tankId: t.id, at: iso(now - 15 * 60000), silverMgL: 30, turbidityNtu: 8, inspector: "乙" });
    assert.equal(t.status, "open");
    assert.equal(w.status, "confirmed");
  } finally {
    await cleanup();
  }
});

test("底片用水履历包含有效、退回与被拒记录", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    const t = ops.createTank({ code: "W-10", source: "井水", capacityLiters: 60, purpose: "prewash" });
    const now = Date.now();
    ops.registerInspection({ tankId: t.id, at: iso(now - H), silverMgL: 5, turbidityNtu: 2, inspector: "甲" });
    ops.registerWash({ tankId: t.id, negativeId: "N-X", purpose: "prewash", operator: "乙", startAt: iso(now), endAt: iso(now + H) });
    await expectDenied(
      () => ops.registerWash({ tankId: t.id, negativeId: "N-Y", purpose: "prewash", operator: "丙", startAt: iso(now + 30 * 60000), endAt: iso(now + 2 * H) }),
      "slot_occupied",
    );
    const histX = ops.negativeHistory("N-X");
    assert.equal(histX.washes.length, 1);
    assert.equal(histX.washes[0].tank.code, "W-10");
    const histY = ops.negativeHistory("N-Y");
    assert.equal(histY.washes.length, 0);
    assert.equal(histY.denials.length, 1);
    assert.equal(histY.denials[0].code, "slot_occupied");
    assert.equal(histY.denials[0].occupyingNegativeId, "N-X");
    assert.ok(histY.denials[0].at);
  } finally {
    await cleanup();
  }
});

test("字段校验：缸号重复、容量非法、检测值非法", async () => {
  const { ops, cleanup } = await makeOps();
  try {
    ops.createTank({ code: "DUP", source: "水", capacityLiters: 10, purpose: "prewash" });
    assert.throws(() => ops.createTank({ code: "DUP", source: "水", capacityLiters: 10, purpose: "prewash" }), ValidationError);
    assert.throws(() => ops.createTank({ code: "X", source: "水", capacityLiters: -1, purpose: "prewash" }), ValidationError);
    const t = ops.db.tanks[0];
    assert.throws(() => ops.registerInspection({ tankId: t.id, at: new Date().toISOString(), silverMgL: -2, turbidityNtu: 1, inspector: "甲" }), ValidationError);
  } finally {
    await cleanup();
  }
});

test("FRESHNESS 常量为八小时", () => {
  assert.equal(FRESHNESS_MS, 8 * 60 * 60 * 1000);
});
