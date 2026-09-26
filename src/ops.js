// 操作块：建缸、登记冲洗、复检、改检测、改用途。
// 规则取自 rules.js，存取交给 store.js，这里只编排业务流程。
import {
  STAGES,
  SLOTS,
  RECHECK_PASSES_NEEDED,
  TANK_OPEN,
  TANK_PENDING,
  RINSE_VALID,
  RINSE_RECALLED,
  evaluateTank,
  recheckPasses,
  slotKey,
  isValidStage,
  isValidSlot,
  isValidDate,
} from "./rules.js";

export class OpsError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function need(value, label) {
  const text = value === undefined || value === null ? "" : String(value).trim();
  if (!text) throw new OpsError("invalid", `请填写${label}`);
  return text;
}

function num(value, label, min = 0) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min) throw new OpsError("invalid", `${label}须为不小于 ${min} 的数字`);
  return n;
}

function parseTime(value, label, fallback) {
  if (!value) return fallback.toISOString();
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new OpsError("invalid", `${label}格式不正确`);
  return d.toISOString();
}

function findTank(db, tankId) {
  const tank = db.tanks.find((t) => t.id === tankId);
  if (!tank) throw new OpsError("tank_not_found", "找不到该水缸");
  return tank;
}

// 把满足条件的有效冲洗记录退回重算，返回退回条数
function recallRinses(db, predicate, now) {
  let count = 0;
  for (const r of db.rinses) {
    if (r.status === RINSE_VALID && predicate(r)) {
      r.status = RINSE_RECALLED;
      r.recalledAt = now.toISOString();
      count += 1;
    }
  }
  return count;
}

// 原许可退回：缸进入待复检，连续合格清零
function revokePermit(tank) {
  tank.permit = "revoked";
  tank.streak = 0;
  tank.streakBy = null;
}

// —— 建缸：登记来源、容量、银盐浓度、浊度、检测时间 ——
export function createTank(db, input, now) {
  const tank = {
    id: `G-${String(db.nextTank++).padStart(3, "0")}`,
    name: need(input.name, "水缸名称"),
    source: need(input.source, "水源"),
    capacity: num(input.capacity, "容量", 0.1),
    silver: num(input.silver, "银盐浓度"),
    turbidity: num(input.turbidity, "浊度"),
    testedAt: parseTime(input.testedAt, "检测时间", now),
    testedBy: need(input.testedBy, "检测人"),
    permit: "open",
    permitSince: now.toISOString(),
    streak: 0,
    streakBy: null,
    rechecks: [],
    createdAt: now.toISOString(),
  };
  db.tanks.unshift(tank);
  return tank;
}

// —— 登记冲洗：按用途选缸，同一缸同一时段只接受一张底片 ——
export function registerRinse(db, input, now) {
  const tank = findTank(db, input.tankId);
  const film = need(input.film, "底片编号");
  const operator = need(input.operator, "操作人");
  const stage = need(input.stage, "用途");
  if (!isValidStage(stage)) throw new OpsError("invalid", `用途须为：${STAGES.join("、")}`);
  const date = need(input.date, "冲洗日期");
  if (!isValidDate(date)) throw new OpsError("invalid", "冲洗日期格式不正确");
  const slot = need(input.slot, "时段");
  if (!isValidSlot(slot)) throw new OpsError("invalid", `时段须为：${SLOTS.join("、")}`);
  const liters = num(input.liters, "用水量", 0.1);
  if (liters > tank.capacity) {
    throw new OpsError("invalid", `用水量 ${liters} 升超过水缸容量 ${tank.capacity} 升`);
  }

  const evaluation = evaluateTank(tank, now);
  if (evaluation.status !== TANK_OPEN) {
    throw new OpsError(
      "tank_pending",
      `${tank.name}当前为${TANK_PENDING}，不能冲洗：${evaluation.reasons.join("；")}`,
      evaluation.reasons,
    );
  }

  const key = slotKey(date, slot);
  const occupant = db.rinses.find(
    (r) => r.tankId === tank.id && r.slot === key && r.status === RINSE_VALID,
  );
  if (occupant) {
    throw new OpsError(
      "slot_occupied",
      `${tank.name}「${key}」已被底片 ${occupant.film} 占用，本次不写入用量`,
      { film: occupant.film, rinseId: occupant.id },
    );
  }

  const rinse = {
    id: `R-${String(db.nextRinse++).padStart(3, "0")}`,
    tankId: tank.id,
    tankName: tank.name,
    film,
    stage,
    slot: key,
    liters,
    operator,
    at: now.toISOString(),
    status: RINSE_VALID,
  };
  db.rinses.unshift(rinse);
  return rinse;
}

// —— 复检：由检测人之外的另一人进行，连续两次合格才重新开放 ——
export function recheckTank(db, tankId, input, now) {
  const tank = findTank(db, tankId);
  const evaluation = evaluateTank(tank, now);
  if (evaluation.status !== TANK_PENDING) {
    throw new OpsError("not_pending", `${tank.name}当前${TANK_OPEN}，无需复检`);
  }
  const by = need(input.by, "复检人");
  if (by === tank.testedBy) {
    throw new OpsError("same_tester", `复检人须为另一人，不能是检测人 ${tank.testedBy}`);
  }
  const sample = { silver: num(input.silver, "银盐浓度"), turbidity: num(input.turbidity, "浊度") };
  const pass = recheckPasses(sample);
  tank.rechecks.push({ at: now.toISOString(), by, ...sample, pass });

  if (pass) {
    tank.streak = tank.streakBy === by ? tank.streak + 1 : 1;
    tank.streakBy = by;
  } else {
    tank.streak = 0;
    tank.streakBy = null;
  }

  let reopened = false;
  if (tank.streak >= RECHECK_PASSES_NEEDED) {
    // 重新开放：以最近一次合格复检作为新检测
    tank.silver = sample.silver;
    tank.turbidity = sample.turbidity;
    tank.testedAt = now.toISOString();
    tank.testedBy = by;
    tank.permit = "open";
    tank.permitSince = now.toISOString();
    tank.streak = 0;
    tank.streakBy = null;
    reopened = true;
  }
  return { tank, pass, reopened, streak: tank.streak, needed: RECHECK_PASSES_NEEDED };
}

// —— 改检测：改写检测值，原许可与后续冲洗记录退回重算 ——
export function updateTest(db, tankId, input, now) {
  const tank = findTank(db, tankId);
  const oldPermitSince = tank.permitSince;
  tank.silver = num(input.silver, "银盐浓度");
  tank.turbidity = num(input.turbidity, "浊度");
  tank.testedAt = parseTime(input.testedAt, "检测时间", now);
  tank.testedBy = need(input.testedBy, "检测人");
  revokePermit(tank);
  const recalled = recallRinses(db, (r) => r.tankId === tank.id && r.at >= oldPermitSince, now);
  return { tank, recalled };
}

// —— 改用途：改动冲洗记录的用途，原许可与同缸后续记录退回重算 ——
export function changeRinseStage(db, rinseId, input, now) {
  const rinse = db.rinses.find((r) => r.id === rinseId);
  if (!rinse) throw new OpsError("rinse_not_found", "找不到该冲洗记录");
  if (rinse.status !== RINSE_VALID) {
    throw new OpsError("already_recalled", "该记录已退回重算，不能再改");
  }
  const stage = need(input.stage, "新用途");
  if (!isValidStage(stage)) throw new OpsError("invalid", `用途须为：${STAGES.join("、")}`);
  if (stage === rinse.stage) throw new OpsError("invalid", "新用途与原来相同");

  const tank = findTank(db, rinse.tankId);
  rinse.stage = stage;
  rinse.status = RINSE_RECALLED;
  rinse.recalledAt = now.toISOString();
  revokePermit(tank);
  const recalled =
    1 + recallRinses(db, (r) => r.tankId === tank.id && r.id !== rinse.id && r.at >= rinse.at, now);
  return { rinse, tank, recalled };
}

// —— 查询：总览、待复检、底片用水履历 ——
export function board(db, now) {
  const tanks = db.tanks.map((tank) => ({
    ...tank,
    evaluation: evaluateTank(tank, now),
    activeRinses: db.rinses.filter((r) => r.tankId === tank.id && r.status === RINSE_VALID).length,
  }));
  const stats = {
    tanks: tanks.length,
    open: tanks.filter((t) => t.evaluation.status === TANK_OPEN).length,
    pending: tanks.filter((t) => t.evaluation.status === TANK_PENDING).length,
    rinses: db.rinses.filter((r) => r.status === RINSE_VALID).length,
  };
  return { tanks, stats };
}

export function filmHistory(db, film) {
  return db.rinses
    .filter((r) => r.film === film)
    .sort((a, b) => b.at.localeCompare(a.at));
}

export function listFilms(db) {
  return [...new Set(db.rinses.map((r) => r.film))];
}
