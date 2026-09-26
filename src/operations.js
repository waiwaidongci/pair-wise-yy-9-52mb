// 操作层：编排规则与存档。页面只通过这里办事——
// 建缸、登记检测、登记冲洗、复检放行、改检测/用途触发退回重算、查询待复检与用水履历。
import {
  PURPOSES,
  FRESHNESS_MS,
  evaluateAt,
  isQualified,
  slotsOverlap,
  recalcRecord,
  recheckPolicy,
  toTime,
} from "./rules.js";
import { ValidationError } from "./archive.js";

export class ConflictError extends Error {
  constructor(detail) {
    super(detail.message);
    this.name = "ConflictError";
    this.code = detail.code;
    this.payload = detail;
  }
}

const str = (v) => (typeof v === "string" ? v.trim() : "");

export class Operations {
  constructor(archive) {
    this.archive = archive;
  }

  get db() {
    return this.archive.data;
  }

  // ---- 建缸 ----
  createTank(input) {
    const tank = this.archive.createTank(input);
    this.archive.addEvent("tank_ready", { tankId: tank.id });
    return tank;
  }

  listTanks() {
    return this.db.tanks.map((t) => this.decorateTank(t));
  }

  decorateTank(tank) {
    const latest = this.db.inspections
      .filter((x) => x.tankId === tank.id)
      .sort((a, b) => toTime(b.at) - toTime(a.at))[0] || null;
    const limit = PURPOSES[tank.purpose];
    const freshUntil = latest ? new Date(toTime(latest.at) + FRESHNESS_MS).toISOString() : null;
    const stale = !latest || Date.now() - toTime(latest.at) > FRESHNESS_MS;
    const overLimit = latest
      ? Number(latest.silverMgL) > limit.silverMaxMgL || Number(latest.turbidityNtu) > limit.turbidityMaxNtu
      : false;
    return {
      ...tank,
      purposeLabel: limit.label,
      limit,
      latest,
      freshUntil,
      stale,
      overLimit,
      usableNow: tank.status === "open" && latest && !stale && !overLimit,
      recheckPolicy: recheckPolicy(tank),
    };
  }

  // ---- 登记检测（自动判断常规检测 / 复检，并在合格时推进复检放行）----
  registerInspection(input) {
    const { tank, inspection } = this.archive.addInspection(input);
    const quality = isQualified(inspection, tank.purpose);
    const pass = quality.ok;
    const eventDetail = {
      tankId: tank.id,
      inspectionId: inspection.id,
      pass,
      reasons: quality.reasons,
    };

    if (tank.status === "pending") {
      if (pass) {
        const lastPass = tank.recheck.passes[tank.recheck.streak - 1];
        if (tank.recheck.streak > 0 && lastPass && lastPass.inspector === inspection.inspector) {
          this.archive.addEvent("recheck_rejected_same_inspector", eventDetail);
          throw new ConflictError({
            code: "recheck_same_inspector",
            message: "复检必须由另一名检测人完成",
            inspector: inspection.inspector,
          });
        }
        tank.recheck.streak += 1;
        tank.recheck.passes.push({ inspectionId: inspection.id, inspector: inspection.inspector });
        const { needPasses } = recheckPolicy(tank);
        if (tank.recheck.streak >= needPasses) {
          tank.status = "open";
          tank.pendingReason = null;
          tank.pendingFrom = null;
          this.archive.addEvent("tank_reopened", eventDetail);
          // 重新开放后，被退回的冲洗记录自动按序重算
          this.recalcTank(tank.id);
        } else {
          this.archive.addEvent("recheck_pass_partial", { ...eventDetail, needPasses });
        }
      } else {
        tank.recheck.streak = 0;
        tank.recheck.passes = [];
        this.archive.addEvent("recheck_fail_reset", eventDetail);
      }
    } else if (!pass) {
      // 开放缸常规检测不合格：立即打回待复检
      tank.status = "pending";
      tank.pendingReason = quality.reasons[0];
      tank.pendingFrom = inspection.at;
      tank.recheck = { streak: 0, passes: [] };
      this.archive.addEvent("tank_pending", eventDetail);
      this.voidWashesAfter(tank, inspection.at, quality.reasons[0], "常规检测不合格，缸待复检");
    } else {
      this.archive.addEvent("inspection_passed", eventDetail);
    }
    return { inspection, tank: this.decorateTank(tank) };
  }

  // ---- 登记底片冲洗 ----
  registerWash(input) {
    const tank = this.archive.findTank(str(input.tankId));
    if (!tank) throw new ValidationError("水缸不存在", "tankId");
    const negativeId = str(input.negativeId);
    if (!negativeId) throw new ValidationError("底片编号不能为空", "negativeId");
    const purpose = str(input.purpose);
    if (!PURPOSES[purpose]) throw new ValidationError("用途不合法", "purpose");
    const operator = str(input.operator);
    if (!operator) throw new ValidationError("操作人不能为空", "operator");
    const startAt = new Date(str(input.startAt));
    const endAt = new Date(str(input.endAt));
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime())) {
      throw new ValidationError("冲洗时段不合法", "startAt");
    }
    if (endAt.getTime() <= startAt.getTime()) {
      throw new ValidationError("结束时间必须晚于开始时间", "endAt");
    }

    // 1) 占用优先检查：重复请求只指出占用底片，绝不写入用量
    const occupant = this.findOccupant(tank.id, startAt, endAt, null);
    if (occupant) {
      const payload = {
        code: "slot_occupied",
        message: "该缸此时段已被占用",
        tankId: tank.id,
        tankCode: tank.code,
        occupyingNegativeId: occupant.negativeId,
        occupyingWashId: occupant.id,
      };
      this.archive.addEvent("wash_denied_slot", {
        at: startAt.toISOString(),
        code: "slot_occupied",
        tankId: tank.id,
        tankCode: tank.code,
        negativeId,
        occupyingNegativeId: occupant.negativeId,
        occupyingWashId: occupant.id,
      });
      throw new ConflictError(payload);
    }

    // 2) 水质判定（用途、缸状态、八小时时效、限值）
    const denial = this.checkUsable(tank, purpose, startAt);
    if (denial) {
      this.archive.addEvent("wash_denied_quality", {
        at: startAt.toISOString(),
        tankId: tank.id,
        negativeId,
        purpose,
        ...denial,
      });
      // 浓度超限 / 浊度过高 / 检测超八小时的缸只能待复检（用途选错不动缸）
      if (tank.status === "open" && !denial.keepTankState) {
        tank.status = "pending";
        tank.pendingReason = denial.code;
        tank.pendingFrom = startAt.toISOString();
        tank.recheck = { streak: 0, passes: [] };
        this.archive.addEvent("tank_pending", { tankId: tank.id, negativeId, ...denial });
        this.voidWashesAfter(tank, startAt, denial.code, denial.message);
      }      throw new ConflictError({ code: denial.code, message: denial.message, tankId: tank.id });
    }

    const verdict = evaluateAt(tank, this.db.inspections, startAt);
    const record = {
      id: this.archive.nextId("wash"),
      tankId: tank.id,
      negativeId,
      purpose,
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      operator,
      note: str(input.note),
      status: "confirmed", // confirmed | returned
      permit: {
        inspectionId: verdict.test.id,
        testAt: verdict.test.at,
        silverMgL: verdict.test.silverMgL,
        turbidityNtu: verdict.test.turbidityNtu,
        purposeAtPermit: purpose,
      },
      returnReason: null,
      history: [
        {
          at: new Date().toISOString(),
          kind: "confirmed",
          reason: "登记时检测合格且时段空闲",
          permitInspectionId: verdict.test.id,
        },
      ],
    };
    this.archive.addWash(record);
    this.archive.addEvent("wash_confirmed", {
      washId: record.id,
      tankId: tank.id,
      negativeId,
      purpose,
      inspectionId: verdict.test.id,
    });
    return record;
  }

  checkUsable(tank, purpose, when) {
    // 用途不符只是选错缸：指出不匹配，不改变缸的开放状态
    if (purpose !== tank.purpose) {
      return { code: "purpose_mismatch", message: `该缸登记用途为「${PURPOSES[tank.purpose].label}」，不能用于「${PURPOSES[purpose].label}」`, keepTankState: true };
    }
    if (tank.status === "pending") {
      return { code: "tank_pending", message: "该缸正在待复检，暂不开放" };
    }
    const verdict = evaluateAt(tank, this.db.inspections, when);
    if (!verdict.test) return { code: "no_test", message: "该缸尚未登记检测" };
    if (verdict.reasons.includes("test_stale")) return { code: "test_stale", message: "检测距冲洗已超过八小时，只能待复检" };
    if (verdict.reasons.includes("silver_exceeded")) return { code: "silver_exceeded", message: "银盐浓度超出该用途限值" };
    if (verdict.reasons.includes("turbidity_exceeded")) return { code: "turbidity_exceeded", message: "浊度超出该用途限值" };
    return null;
  }

  findOccupant(tankId, startAt, endAt, excludeWashId) {
    return this.db.washes.find(
      (w) =>
        w.tankId === tankId &&
        w.status === "confirmed" &&
        w.id !== excludeWashId &&
        slotsOverlap(startAt, endAt, w.startAt, w.endAt),
    );
  }

  voidWashesAfter(tank, sinceIso, reasonCode, detail) {
    // 缸被打回后，起点晚于打回时刻的有效冲洗许可全部退回
    const since = toTime(sinceIso);
    for (const w of this.db.washes) {
      if (w.tankId === tank.id && w.status === "confirmed" && toTime(w.startAt) >= since) {
        this.markReturned(w, reasonCode, detail);
      }
    }
  }

  // 改检测/用途后按最新检测重新评估缸是否仍可开放
  reevaluateTankStatus(tank) {
    const latest = this.db.inspections
      .filter((x) => x.tankId === tank.id)
      .sort((a, b) => toTime(b.at) - toTime(a.at))[0] || null;
    if (!latest) {
      if (tank.status === "open") this.setPending(tank, "no_test", latest?.at || new Date().toISOString());
      return;
    }
    const quality = isQualified(latest, tank.purpose);
    if (!quality.ok) {
      if (tank.status === "open") this.setPending(tank, quality.reasons[0], latest.at);
      else { tank.pendingReason = quality.reasons[0]; }
    }
  }

  setPending(tank, reason, fromIso) {
    tank.status = "pending";
    tank.pendingReason = reason;
    tank.pendingFrom = fromIso;
    tank.recheck = { streak: 0, passes: [] };
  }

  markReturned(w, reason, detail) {
    w.status = "returned";
    w.returnReason = reason;
    w.history.push({ at: new Date().toISOString(), kind: "returned", reason, detail: detail || "" });
    this.archive.addEvent("wash_returned", { washId: w.id, tankId: w.tankId, reason });
  }

  markReconfirmed(w, permit) {
    w.status = "confirmed";
    w.returnReason = null;
    w.permit = permit;
    w.history.push({
      at: new Date().toISOString(),
      kind: "reconfirmed",
      reason: "依据当前检测与占用情况重算合格",
      permitInspectionId: permit.inspectionId,
    });
    this.archive.addEvent("wash_reconfirmed", { washId: w.id, tankId: w.tankId, inspectionId: permit.inspectionId });
  }

  // ---- 修改检测：原许可及该检测之后的冲洗记录退回重算 ----
  editInspection(id, patch, editor) {
    const inspection = this.archive.findInspection(id);
    if (!inspection) throw new ValidationError("检测记录不存在", "id");
    const tank = this.archive.findTank(inspection.tankId);
    const before = { silverMgL: inspection.silverMgL, turbidityNtu: inspection.turbidityNtu, at: inspection.at, inspector: inspection.inspector };
    if (patch.silverMgL !== undefined) {
      const v = Number(patch.silverMgL);
      if (!Number.isFinite(v) || v < 0) throw new ValidationError("银盐浓度不合法", "silverMgL");
      inspection.silverMgL = v;
    }
    if (patch.turbidityNtu !== undefined) {
      const v = Number(patch.turbidityNtu);
      if (!Number.isFinite(v) || v < 0) throw new ValidationError("浊度不合法", "turbidityNtu");
      inspection.turbidityNtu = v;
    }
    if (patch.at !== undefined) {
      const t = new Date(str(patch.at));
      if (Number.isNaN(t.getTime())) throw new ValidationError("检测时间不合法", "at");
      inspection.at = t.toISOString();
    }
    if (patch.inspector !== undefined && str(patch.inspector)) inspection.inspector = str(patch.inspector);
    inspection.editedAt = new Date().toISOString();
    inspection.editedBy = str(editor) || inspection.editedBy || null;
    this.archive.addEvent("inspection_edited", {
      inspectionId: id,
      tankId: inspection.tankId,
      before,
      after: { silverMgL: inspection.silverMgL, turbidityNtu: inspection.turbidityNtu, at: inspection.at, inspector: inspection.inspector },
      editor: inspection.editedBy,
    });
    // 引用该检测的许可先作废；该检测时间点之后的同缸冲洗全部退回
    for (const w of this.db.washes) {
      if (w.tankId !== inspection.tankId || w.status !== "confirmed") continue;
      if (w.permit?.inspectionId === id || toTime(w.startAt) >= toTime(inspection.at)) {
        this.markReturned(w, "inspection_changed", "检测记录已修改，原许可退回重算");
      }
    }
    this.reevaluateTankStatus(tank);
    this.recalcTank(inspection.tankId);
    return inspection;
  }

  // ---- 改用途：原许可及后续冲洗记录退回重算 ----
  changeTankPurpose(tankId, purpose, editor) {
    const tank = this.archive.findTank(str(tankId));
    if (!tank) throw new ValidationError("水缸不存在", "tankId");
    if (!PURPOSES[purpose]) throw new ValidationError("用途不合法", "purpose");
    if (purpose === tank.purpose) return this.decorateTank(tank);
    const oldPurpose = tank.purpose;
    tank.purpose = purpose;
    this.archive.addEvent("tank_purpose_changed", { tankId: tank.id, oldPurpose, newPurpose: purpose, editor: str(editor) || null });
    for (const w of this.db.washes) {
      if (w.tankId === tank.id && w.status === "confirmed") {
        this.markReturned(w, "purpose_changed", "水缸用途已变更，原许可退回重算");
      }
    }
    // 已经退回的记录保留最初退回原因，只追加一次重算尝试
    this.reevaluateTankStatus(tank);
    this.recalcTank(tank.id);
    return this.decorateTank(tank);
  }

  // 按时间顺序对缸上退回的冲洗重算；冲突时以先到先得
  recalcTank(tankId) {
    const tank = this.archive.findTank(tankId);
    if (!tank) return [];
    const inspections = this.db.inspections;
    const results = [];
    const returned = this.db.washes
      .filter((w) => w.tankId === tank.id && w.status === "returned")
      .sort((a, b) => toTime(a.startAt) - toTime(b.startAt));
    for (const record of returned) {
      const active = this.db.washes.filter((w) => w.tankId === tank.id && w.status === "confirmed");
      const verdict = recalcRecord({ record, tank, inspections, activeRecords: active });
      if (verdict.ok) {
        this.markReconfirmed(record, verdict.permit);
      } else {
        // 保持退回：保留最初触发退回的原因（改检测/改用途），重算细节另入履历
        record.history.push({
          at: new Date().toISOString(),
          kind: "recalc_failed",
          reason: verdict.reason,
          detail: verdict.detail,
          occupyingNegativeId: verdict.occupyingNegativeId || null,
        });
        this.archive.addEvent("wash_recalc_failed", { washId: record.id, tankId: tank.id, reason: verdict.reason });
      }
      results.push({ washId: record.id, ok: verdict.ok, reason: verdict.ok ? null : verdict.reason });
    }
    return results;
  }

  // ---- 查询：待复检 ----
  pendingTanks() {
    return this.db.tanks.filter((t) => t.status === "pending").map((t) => {
      const d = this.decorateTank(t);
      const { needPasses, streak } = recheckPolicy(t);
      return { ...d, needPasses, streak, remaining: Math.max(0, needPasses - streak) };
    });
  }

  // ---- 查询：底片用水履历（含被退回的记录与被拒尝试）----
  negativeHistory(negativeId) {
    const key = str(negativeId);
    const washes = this.db.washes
      .filter((w) => w.negativeId === key)
      .sort((a, b) => toTime(a.startAt) - toTime(b.startAt))
      .map((w) => ({ ...w, tank: this.archive.findTank(w.tankId) }));
    const denials = this.db.events
      .filter((e) => (e.type === "wash_denied_slot" || e.type === "wash_denied_quality") && e.detail?.negativeId === key)
      .map((e) => e.detail);
    return { negativeId: key, washes, denials };
  }

  tankDetail(tankId) {
    const tank = this.archive.findTank(str(tankId));
    if (!tank) throw new ValidationError("水缸不存在", "tankId");
    const inspections = this.db.inspections
      .filter((x) => x.tankId === tank.id)
      .sort((a, b) => toTime(b.at) - toTime(a.at));
    const washes = this.db.washes
      .filter((w) => w.tankId === tank.id)
      .sort((a, b) => toTime(a.startAt) - toTime(b.startAt));
    return { tank: this.decorateTank(tank), inspections, washes };
  }

  events(limit = 100) {
    return this.db.events.slice(-Number(limit)).reverse();
  }
}
