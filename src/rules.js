// 规则块：限值、缸状态判定、时段与复检规则。
// 只放纯规则与判定，不碰存储、不编排操作流程。

export const LIMITS = {
  silverMax: 0.5, // 银盐浓度上限（mg/L）
  turbidityMax: 5, // 浊度上限（NTU）
  testValidHours: 8, // 检测有效时长（小时）
};

export const STAGES = ["预洗", "显影后", "定影后"]; // 冲洗用途
export const SLOTS = ["上午", "下午", "晚间"]; // 每日冲洗时段
export const RECHECK_PASSES_NEEDED = 2; // 重新开放所需连续合格次数

export const TANK_OPEN = "可用";
export const TANK_PENDING = "待复检";
export const RINSE_VALID = "有效";
export const RINSE_RECALLED = "退回重算";

export function hoursSince(isoTime, now) {
  return (now.getTime() - new Date(isoTime).getTime()) / 3.6e6;
}

// 判定水缸当前状态：许可被退回、浓度超限、浊度过高、检测超八小时，都只能待复检
export function evaluateTank(tank, now) {
  const reasons = [];
  if (tank.permit !== "open") reasons.push("使用许可已退回，须复检两次合格");
  if (tank.silver > LIMITS.silverMax) {
    reasons.push(`银盐浓度 ${tank.silver} mg/L 超限（上限 ${LIMITS.silverMax}）`);
  }
  if (tank.turbidity > LIMITS.turbidityMax) {
    reasons.push(`浊度 ${tank.turbidity} NTU 过高（上限 ${LIMITS.turbidityMax}）`);
  }
  const testAgeHours = hoursSince(tank.testedAt, now);
  if (testAgeHours > LIMITS.testValidHours) {
    reasons.push(`检测已 ${testAgeHours.toFixed(1)} 小时，超过 ${LIMITS.testValidHours} 小时有效期`);
  }
  return { status: reasons.length ? TANK_PENDING : TANK_OPEN, reasons, testAgeHours };
}

// 单次复检样本是否合格
export function recheckPasses(sample) {
  return sample.silver <= LIMITS.silverMax && sample.turbidity <= LIMITS.turbidityMax;
}

// 同一缸同一时段的占用键
export function slotKey(date, slot) {
  return `${date} ${slot}`;
}

export function isValidStage(stage) {
  return STAGES.includes(stage);
}

export function isValidSlot(slot) {
  return SLOTS.includes(slot);
}

export function isValidDate(text) {
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(new Date(text).getTime());
}
