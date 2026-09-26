// 存档块：只负责 JSON 文件的读取、写入与初始种子，不含业务判断。
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "..", "data", "rinse-water-reuse.json");

const HOUR = 3.6e6;
const DAY = 24 * HOUR;

function seed() {
  const now = Date.now();
  const iso = (t) => new Date(t).toISOString();
  const yesterday = new Date(now - DAY).toISOString().slice(0, 10);
  return {
    nextTank: 4,
    nextRinse: 2,
    tanks: [
      {
        id: "G-001",
        name: "甲缸",
        source: "井水过滤",
        capacity: 20,
        silver: 0.3,
        turbidity: 2.4,
        testedAt: iso(now - 2 * HOUR),
        testedBy: "老周",
        permit: "open",
        permitSince: iso(now - 2 * HOUR),
        streak: 0,
        streakBy: null,
        rechecks: [],
        createdAt: iso(now - 30 * DAY),
      },
      {
        id: "G-002",
        name: "乙缸",
        source: "定影回收静置水",
        capacity: 15,
        silver: 0.9,
        turbidity: 3.1,
        testedAt: iso(now - 1 * HOUR),
        testedBy: "老周",
        permit: "open",
        permitSince: iso(now - 1 * HOUR),
        streak: 1,
        streakBy: "阿黎",
        rechecks: [
          { at: iso(now - 30 * 60 * 1000), by: "阿黎", silver: 0.4, turbidity: 2.0, pass: true },
        ],
        createdAt: iso(now - 20 * DAY),
      },
      {
        id: "G-003",
        name: "丙缸",
        source: "雨水收集",
        capacity: 30,
        silver: 0.2,
        turbidity: 1.8,
        testedAt: iso(now - 10 * HOUR),
        testedBy: "老周",
        permit: "open",
        permitSince: iso(now - 10 * HOUR),
        streak: 0,
        streakBy: null,
        rechecks: [],
        createdAt: iso(now - 15 * DAY),
      },
    ],
    rinses: [
      {
        id: "R-001",
        tankId: "G-001",
        tankName: "甲缸",
        film: "CN-001",
        stage: "预洗",
        slot: `${yesterday} 下午`,
        liters: 3,
        operator: "小杜",
        at: iso(now - DAY),
        status: "有效",
      },
    ],
  };
}

export async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    const db = seed();
    await saveDb(db);
    return db;
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

export async function saveDb(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
