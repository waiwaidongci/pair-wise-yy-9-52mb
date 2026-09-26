// 存档层：只负责数据落盘、读取与基础字段校验，不做水质判定。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { PURPOSES, toTime } from "./rules.js";

export class ValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = "ValidationError";
    this.field = field;
  }
}

const requireStr = (value, field, label) => {
  if (typeof value !== "string" || !value.trim()) throw new ValidationError(`${label}不能为空`, field);
  return value.trim();
};

export class Archive {
  constructor(file) {
    this.file = file;
    this.db = null;
  }

  async load() {
    if (!existsSync(this.file)) {
      await mkdir(dirname(this.file), { recursive: true });
      this.db = { tanks: [], inspections: [], washes: [], events: [] };
      await this.save();
      return this.db;
    }
    this.db = JSON.parse(await readFile(this.file, "utf8"));
    this.db.tanks ||= [];
    this.db.inspections ||= [];
    this.db.washes ||= [];
    this.db.events ||= [];
    return this.db;
  }

  async save() {
    await writeFile(this.file, JSON.stringify(this.db, null, 2));
  }

  get data() {
    return this.db;
  }

  nextId(kind) {
    return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  addEvent(type, detail) {
    this.db.events.push({ id: this.nextId("evt"), at: new Date().toISOString(), type, detail });
  }

  findTank(id) {
    return this.db.tanks.find((t) => t.id === id || t.code === id) || null;
  }

  findInspection(id) {
    return this.db.inspections.find((x) => x.id === id) || null;
  }

  findWash(id) {
    return this.db.washes.find((x) => x.id === id) || null;
  }

  createTank(input) {
    const code = requireStr(input.code, "code", "缸号");
    if (this.db.tanks.some((t) => t.code === code)) {
      throw new ValidationError("缸号已存在", "code");
    }
    const purpose = requireStr(input.purpose, "purpose", "用途");
    if (!PURPOSES[purpose]) throw new ValidationError("用途不合法", "purpose");
    const capacityLiters = Number(input.capacityLiters);
    if (!Number.isFinite(capacityLiters) || capacityLiters <= 0) {
      throw new ValidationError("容量必须为正数（升）", "capacityLiters");
    }
    const tank = {
      id: this.nextId("tank"),
      code,
      source: requireStr(input.source, "source", "来源"),
      capacityLiters,
      purpose,
      status: "open", // open | pending
      pendingReason: null,
      pendingFrom: null,
      recheck: { streak: 0, passes: [] },
      createdAt: new Date().toISOString(),
    };
    this.db.tanks.push(tank);
    this.addEvent("tank_created", { tankId: tank.id, code: tank.code, purpose: tank.purpose });
    return tank;
  }

  addInspection(input) {
    const tank = this.findTank(requireStr(input.tankId, "tankId", "水缸"));
    if (!tank) throw new ValidationError("水缸不存在", "tankId");
    const silverMgL = Number(input.silverMgL);
    const turbidityNtu = Number(input.turbidityNtu);
    if (!Number.isFinite(silverMgL) || silverMgL < 0) {
      throw new ValidationError("银盐浓度必须是非负数字（mg/L）", "silverMgL");
    }
    if (!Number.isFinite(turbidityNtu) || turbidityNtu < 0) {
      throw new ValidationError("浊度必须是非负数字（NTU）", "turbidityNtu");
    }
    const at = new Date(requireStr(input.at, "at", "检测时间"));
    if (Number.isNaN(at.getTime())) throw new ValidationError("检测时间不合法", "at");
    const inspector = requireStr(input.inspector, "inspector", "检测人");
    const inspection = {
      id: this.nextId("insp"),
      tankId: tank.id,
      at: at.toISOString(),
      silverMgL,
      turbidityNtu,
      inspector,
      kind: tank.status === "pending" ? "recheck" : "routine",
      note: typeof input.note === "string" ? input.note.trim() : "",
    };
    this.db.inspections.push(inspection);
    return { tank, inspection };
  }

  addWash(record) {
    this.db.washes.push(record);
  }
}
