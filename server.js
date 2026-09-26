// HTTP 外壳：静态页面 + API 路由，业务判断全部交给 src/ 下三块代码。
import http from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDb, saveDb } from "./src/store.js";
import { LIMITS, STAGES, SLOTS, RECHECK_PASSES_NEEDED } from "./src/rules.js";
import * as ops from "./src/ops.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3040);

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function sendFile(res, file, type) {
  try {
    const content = await readFile(join(__dirname, file));
    res.writeHead(200, { "Content-Type": type });
    res.end(content);
  } catch {
    send(res, 404, { error: "not_found", message: "页面不存在" });
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") return sendFile(res, "public/index.html", "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/app.js") return sendFile(res, "public/app.js", "text/javascript; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/style.css") return sendFile(res, "public/style.css", "text/css; charset=utf-8");

    const db = await loadDb();
    const now = new Date();

    if (req.method === "GET" && url.pathname === "/api/state") {
      const { tanks, stats } = ops.board(db, now);
      return send(res, 200, {
        now: now.toISOString(),
        limits: LIMITS,
        stages: STAGES,
        slots: SLOTS,
        recheckNeeded: RECHECK_PASSES_NEEDED,
        stats,
        tanks,
        rinses: db.rinses,
        films: ops.listFilms(db),
      });
    }
    if (req.method === "POST" && url.pathname === "/api/tanks") {
      const tank = ops.createTank(db, await body(req), now);
      await saveDb(db);
      return send(res, 201, tank);
    }
    const test = url.pathname.match(/^\/api\/tanks\/([^/]+)\/test$/);
    if (test && req.method === "POST") {
      const result = ops.updateTest(db, test[1], await body(req), now);
      await saveDb(db);
      return send(res, 200, result);
    }
    const recheck = url.pathname.match(/^\/api\/tanks\/([^/]+)\/recheck$/);
    if (recheck && req.method === "POST") {
      const result = ops.recheckTank(db, recheck[1], await body(req), now);
      await saveDb(db);
      return send(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/rinses") {
      const rinse = ops.registerRinse(db, await body(req), now);
      await saveDb(db);
      return send(res, 201, rinse);
    }
    const stage = url.pathname.match(/^\/api\/rinses\/([^/]+)\/stage$/);
    if (stage && req.method === "POST") {
      const result = ops.changeRinseStage(db, stage[1], await body(req), now);
      await saveDb(db);
      return send(res, 200, result);
    }
    const history = url.pathname.match(/^\/api\/films\/([^/]+)\/history$/);
    if (history && req.method === "GET") {
      return send(res, 200, ops.filmHistory(db, decodeURIComponent(history[1])));
    }
    send(res, 404, { error: "not_found", message: "接口不存在" });
  } catch (error) {
    if (error instanceof ops.OpsError) {
      const status = error.code === "invalid" ? 400 : error.code.endsWith("not_found") ? 404 : 409;
      return send(res, status, { error: error.code, message: error.message, details: error.details });
    }
    send(res, 500, { error: "server_error", message: error.message });
  }
});

server.listen(port, () => console.log("蓝晒冲洗水回用台 listening on http://localhost:" + port));
