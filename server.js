import http from "node:http";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Archive, ValidationError } from "./src/archive.js";
import { Operations, ConflictError } from "./src/operations.js";
import { renderPage } from "./src/page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_FILE || join(__dirname, "data", "wash-reuse.json");
const port = Number(process.env.PORT || 3040);

const archive = new Archive(dbPath);
const ops = new Operations(archive);

await mkdir(dirname(dbPath), { recursive: true });
await archive.load();

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(renderPage());
    }

    // ---- 水缸 ----
    if (req.method === "GET" && p === "/api/tanks") return send(res, 200, ops.listTanks());
    if (req.method === "POST" && p === "/api/tanks") {
      const tank = ops.createTank(await body(req));
      await archive.save();
      return send(res, 201, tank);
    }
    const tankDetail = p.match(/^\/api\/tanks\/([^/]+)$/);
    if (tankDetail && req.method === "GET") {
      return send(res, 200, ops.tankDetail(decodeURIComponent(tankDetail[1])));
    }
    const purposePatch = p.match(/^\/api\/tanks\/([^/]+)\/purpose$/);
    if (purposePatch && req.method === "PATCH") {
      const input = await body(req);
      const tank = ops.changeTankPurpose(decodeURIComponent(purposePatch[1]), input.purpose, input.editor);
      await archive.save();
      return send(res, 200, tank);
    }

    // ---- 检测 ----
    if (req.method === "POST" && p === "/api/inspections") {
      const out = ops.registerInspection(await body(req));
      await archive.save();
      return send(res, 201, out);
    }
    const inspEdit = p.match(/^\/api\/inspections\/([^/]+)$/);
    if (inspEdit && req.method === "PATCH") {
      const inspection = ops.editInspection(decodeURIComponent(inspEdit[1]), await body(req), req.headers["x-editor"]);
      await archive.save();
      return send(res, 200, inspection);
    }

    // ---- 冲洗登记 ----
    if (req.method === "POST" && p === "/api/washes") {
      const record = ops.registerWash(await body(req));
      await archive.save();
      return send(res, 201, record);
    }

    // ---- 查询 ----
    if (req.method === "GET" && p === "/api/pending") return send(res, 200, ops.pendingTanks());
    if (req.method === "GET" && p === "/api/events") return send(res, 200, ops.events(url.searchParams.get("limit") || 100));
    const neg = p.match(/^\/api\/negatives\/([^/]+)\/history$/);
    if (neg && req.method === "GET") {
      return send(res, 200, ops.negativeHistory(decodeURIComponent(neg[1])));
    }

    return send(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof ValidationError) return send(res, 400, { error: error.message, field: error.field });
    if (error instanceof ConflictError) return send(res, 409, { error: error.message, ...error.payload });
    if (error instanceof SyntaxError) return send(res, 400, { error: "请求体不是合法 JSON" });
    console.error(error);
    return send(res, 500, { error: error.message });
  }
});

server.listen(port, () => console.log("冲洗水回用台 listening on http://localhost:" + port));
