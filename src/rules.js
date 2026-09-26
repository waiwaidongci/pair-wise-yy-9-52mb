// 规则层：冲洗水回用的全部业务判定，纯函数、不读写文件、不发请求。
// 阈值与时限集中在此处，便于工艺调整。

export const PURPOSES = {
  prewash: { key: "prewash", label: "预洗", silverMaxMgL: 50, turbidityMaxNtu: 20 },
  post_develop: { key: "post_develop", label: "显影后", silverMaxMgL: 20, turbidityMaxNtu: 10 },
  post_fix: { key: "post_fix", label: "定影后", silverMaxMgL: 10, turbidityMaxNtu: 5 },
};

export const FRESHNESS_MS = 8 * 60 * 60 * 1000; // 检测超过八小时只能待复检

export const RECALC_REASON = {
  NO_TEST: "no_test",
  TEST_STALE: "test_stale",
  SILVER_EXCEEDED: "silver_exceeded",
  TURBIDITY_EXCEEDED: "turbidity_exceeded",
  TANK_PENDING: "tank_pending",
  PURPOSE_MISMATCH: "purpose_mismatch",
  SLOT_OCCUPIED: "slot_occupied",
};

export function purposeKeys() {
  return Object.keys(PURPOSES);
}

export function toTime(value) {
  if (value === undefined || value === null || value === "") return NaN;
  if (value instanceof Date) return value.getTime();
  return new Date(value).getTime();
}

export function isQualified(test, purposeKey) {
  const limit = PURPOSES[purposeKey];
  if (!limit) return { ok: false, reasons: ["unknown_purpose"] };
  const reasons = [];
  if (Number(test.silverMgL) > limit.silverMaxMgL) reasons.push(RECALC_REASON.SILVER_EXCEEDED);
  if (Number(test.turbidityNtu) > limit.turbidityMaxNtu) reasons.push(RECALC_REASON.TURBIDITY_EXCEEDED);
  return { ok: reasons.length === 0, reasons };
}

// 缸在某时刻的水质判定：取该时刻之前最近一次检测
export function evaluateAt(tank, inspections, at) {
  const time = toTime(at);
  const past = inspections
    .filter((x) => x.tankId === tank.id && toTime(x.at) <= time)
    .sort((a, b) => toTime(b.at) - toTime(a.at));
  const test = past[0] || null;
  if (!test) return { test: null, stale: true, qualified: false, reasons: [RECALC_REASON.NO_TEST] };
  const ageMs = time - toTime(test.at);
  const stale = ageMs > FRESHNESS_MS;
  const quality = isQualified(test, tank.purpose);
  const reasons = [];
  if (stale) reasons.push(RECALC_REASON.TEST_STALE);
  reasons.push(...quality.reasons);
  return { test, ageMs, stale, qualified: reasons.length === 0, reasons };
}

// 时段重叠即冲突（同一缸同一时段只接受一张底片）
export function slotsOverlap(aStart, aEnd, bStart, bEnd) {
  const s1 = toTime(aStart), e1 = toTime(aEnd);
  const s2 = toTime(bStart), e2 = toTime(bEnd);
  return s1 < e2 && s2 < e1;
}

// 重算一张被退回的冲洗记录。against 为当前仍然有效的其它冲洗记录。
// 用途变更触发的重算按缸的“现用途”限值重评水质，不再以用途不符直接判死。
// 判定顺序：冲洗当时水质（现用途限值与八小时时效）→ 缸已开放 → 时段无占用。
export function recalcRecord({ record, tank, inspections, activeRecords }) {
  if (!tank) return { ok: false, reason: RECALC_REASON.NO_TEST, detail: "水缸不存在" };
  const verdict = evaluateAt(tank, inspections, record.startAt);
  if (!verdict.test) {
    return { ok: false, reason: RECALC_REASON.NO_TEST, detail: "冲洗前缺少检测记录", permit: null };
  }
  if (verdict.stale) {
    return { ok: false, reason: RECALC_REASON.TEST_STALE, detail: "最近检测距冲洗已超过八小时", permit: permitOf(verdict.test) };
  }
  if (!verdict.qualified) {
    return { ok: false, reason: verdict.reasons[0], detail: "检测指标超出该用途限值", permit: permitOf(verdict.test) };
  }
  if (tank.status === "pending") {
    return { ok: false, reason: RECALC_REASON.TANK_PENDING, detail: "水缸仍在待复检", permit: permitOf(verdict.test) };
  }
  const blocker = activeRecords.find(
    (other) =>
      other.id !== record.id &&
      other.tankId === tank.id &&
      slotsOverlap(record.startAt, record.endAt, other.startAt, other.endAt),
  );
  if (blocker) {
    return {
      ok: false,
      reason: RECALC_REASON.SLOT_OCCUPIED,
      detail: "时段与其它有效冲洗冲突",
      occupyingNegativeId: blocker.negativeId,
      occupyingWashId: blocker.id,
      permit: permitOf(verdict.test),
    };
  }
  return { ok: true, permit: permitOf(verdict.test) };
}

export function permitOf(test) {
  return {
    inspectionId: test.id,
    testAt: test.at,
    silverMgL: test.silverMgL,
    turbidityNtu: test.turbidityNtu,
  };
}

// 待复检缸重新开放所需条件：
// 无检测建档的缸一次合格即可启用；因指标/超时被打回的缸须由另一人连续两次合格。
export function recheckPolicy(tank) {
  const needPasses = tank.pendingReason === "no_test" ? 1 : 2;
  return { needPasses, streak: tank.recheck?.streak || 0 };
}
