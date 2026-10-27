const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { DownloadManager } = require("./engine");

const PORT = Number(process.env.PORT || 4780);
const destDir = path.join(os.homedir(), "Downloads", "FasterDownloader");
const manager = new DownloadManager(destDir);
const publicDir = path.join(__dirname, "public");

const clients = new Set();

manager.on("update", (job) => {
  const payload = `event: job\ndata: ${JSON.stringify(job)}\n\n`;
  for (const res of clients) res.write(payload);
});

function send(res, status, body, type = "application/json") {
  const data = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function serveStatic(req, res) {
  const urlPath = req.url === "/" ? "/index.html" : req.url.split("?")[0];
  const file = path.normalize(path.join(publicDir, urlPath));
  if (!file.startsWith(publicDir)) {
    send(res, 403, { error: "Forbidden" });
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      send(res, 404, { error: "Not found" });
      return;
    }
    const ext = path.extname(file);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
    };
    res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/jobs") {
      send(res, 200, { destDir, jobs: manager.list() });
      return;
    }
    if (req.method === "GET" && req.url === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.write("\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.method === "POST" && req.url === "/api/jobs") {
      const body = await readBody(req);
      const job = manager.add(String(body.url || "").trim(), Number(body.connections || 8));
      send(res, 201, job);
      return;
    }
    const action = req.url.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|cancel)$/);
    if (req.method === "POST" && action) {
      manager[action[2]](action[1]);
      send(res, 200, { ok: true });
      return;
    }
    serveStatic(req, res);
  } catch (err) {
    send(res, 400, { error: err.message || String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Faster Downloader is running at ${url}`);
  console.log(`Files save to ${destDir}`);
});
