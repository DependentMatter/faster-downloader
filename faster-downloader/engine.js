const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const { EventEmitter } = require("events");
const crypto = require("crypto");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

function request(urlString, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(
      url,
      {
        method: options.method || "GET",
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "*/*",
          Connection: "keep-alive",
          ...(options.headers || {}),
        },
      },
      (res) => resolve(res)
    );
    req.on("error", reject);
    req.setTimeout(options.timeoutMs || 30000, () => {
      req.destroy(new Error("Request timed out"));
    });
    req.end();
  });
}

async function follow(urlString, options = {}, hops = 0) {
  if (hops > 8) throw new Error("Too many redirects");
  const res = await request(urlString, options);
  const code = res.statusCode || 0;
  if ([301, 302, 303, 307, 308].includes(code) && res.headers.location) {
    res.resume();
    const next = new URL(res.headers.location, urlString).toString();
    const nextOptions = { ...options };
    if (code === 303) {
      nextOptions.method = "GET";
      if (nextOptions.headers) {
        const headers = { ...nextOptions.headers };
        delete headers.Range;
        nextOptions.headers = headers;
      }
    }
    return follow(next, nextOptions, hops + 1);
  }
  return { res, finalUrl: urlString };
}

function parseFilename(contentDisposition, urlString) {
  const cd = contentDisposition || "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^["']|["']$/g, ""));
    } catch {
      // ignore
    }
  }
  const plain = /filename=([^;]+)/i.exec(cd);
  if (plain) return plain[1].trim().replace(/^["']|["']$/g, "");
  try {
    const u = new URL(urlString);
    const base = path.basename(u.pathname);
    if (base && base !== "/" && base !== ".") return decodeURIComponent(base);
  } catch {
    // ignore
  }
  return `download-${Date.now()}`;
}

function sanitizeName(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 180) || "download";
}

class DownloadJob extends EventEmitter {
  constructor({ id, url, destDir, connections }) {
    super();
    this.id = id;
    this.url = url;
    this.destDir = destDir;
    this.connections = Math.max(1, Math.min(32, connections || 8));
    this.status = "queued";
    this.filename = "";
    this.filepath = "";
    this.totalBytes = 0;
    this.downloadedBytes = 0;
    this.speed = 0;
    this.error = "";
    this.createdAt = Date.now();
    this.abort = false;
    this.paused = false;
    this._pauseWaiters = [];
    this._bytesWindow = [];
    this._active = [];
  }

  snapshot() {
    const remaining = Math.max(0, this.totalBytes - this.downloadedBytes);
    const eta = this.speed > 0 ? Math.round(remaining / this.speed) : null;
    return {
      id: this.id,
      url: this.url,
      filename: this.filename,
      filepath: this.filepath,
      status: this.status,
      connections: this.connections,
      totalBytes: this.totalBytes,
      downloadedBytes: this.downloadedBytes,
      percent: this.totalBytes
        ? Math.min(100, (this.downloadedBytes / this.totalBytes) * 100)
        : 0,
      speed: this.speed,
      eta,
      error: this.error,
    };
  }

  pause() {
    if (this.status === "downloading") {
      this.paused = true;
      this.status = "paused";
      for (const worker of this._active) {
        try {
          worker.destroy();
        } catch {
          // ignore
        }
      }
      this.emit("update");
    }
  }

  resume() {
    if (this.status === "paused") {
      this.paused = false;
      this.status = "downloading";
      this._pauseWaiters.splice(0).forEach((fn) => fn());
      this.emit("update");
    }
  }

  cancel() {
    this.abort = true;
    this.paused = false;
    this._pauseWaiters.splice(0).forEach((fn) => fn());
    for (const worker of this._active) {
      try {
        worker.destroy();
      } catch {
        // ignore
      }
    }
    if (this.status !== "completed") {
      this.status = "cancelled";
      this.emit("update");
    }
  }

  waitIfPaused() {
    if (!this.paused) return Promise.resolve();
    return new Promise((resolve) => this._pauseWaiters.push(resolve));
  }

  noteBytes(n) {
    this.downloadedBytes += n;
    const now = Date.now();
    this._bytesWindow.push({ t: now, n });
    this._bytesWindow = this._bytesWindow.filter((x) => now - x.t < 2000);
    const sum = this._bytesWindow.reduce((a, b) => a + b.n, 0);
    const span = Math.max(1, now - this._bytesWindow[0].t);
    this.speed = (sum * 1000) / span;
    this.emit("update");
  }

  async start() {
    this.status = "connecting";
    this.emit("update");
    try {
      await fsp.mkdir(this.destDir, { recursive: true });
      const probe = await this.probe();
      this.filename = sanitizeName(probe.filename);
      this.filepath = await uniquePath(path.join(this.destDir, this.filename));
      this.filename = path.basename(this.filepath);
      this.totalBytes = probe.size;
      this.status = "downloading";
      this.emit("update");

      if (probe.size > 0 && probe.ranges) {
        await this.downloadSegmented(probe.finalUrl, probe.size);
      } else {
        await this.downloadSingle(probe.finalUrl);
      }

      if (this.abort) {
        this.status = "cancelled";
      } else {
        this.status = "completed";
        this.speed = 0;
        if (this.totalBytes) this.downloadedBytes = this.totalBytes;
      }
      this.emit("update");
    } catch (err) {
      if (this.abort) {
        this.status = "cancelled";
      } else {
        this.status = "error";
        this.error = err.message || String(err);
      }
      this.emit("update");
    }
  }

  async probe() {
    let size = 0;
    let ranges = false;
    let filename = parseFilename("", this.url);
    let finalUrl = this.url;

    try {
      const { res, finalUrl: u } = await follow(this.url, { method: "HEAD" });
      res.destroy();
      finalUrl = u;
      filename = parseFilename(res.headers["content-disposition"], finalUrl);
      size = Number(res.headers["content-length"] || 0);
      ranges = /bytes/i.test(res.headers["accept-ranges"] || "");
      if (res.statusCode >= 400) throw new Error(`HTTP ${res.statusCode}`);
    } catch {
      // Some hosts reject HEAD. Fall through to a range GET.
    }

    const { res, finalUrl: u2 } = await follow(finalUrl, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
    });
    res.destroy();
    finalUrl = u2;
    filename = parseFilename(res.headers["content-disposition"], finalUrl) || filename;
    if (res.statusCode === 206) {
      ranges = true;
      const cr = res.headers["content-range"] || "";
      const m = /\/(\d+)$/.exec(cr);
      if (m) size = Number(m[1]);
    } else if (res.statusCode === 200) {
      size = Number(res.headers["content-length"] || size || 0);
      ranges = false;
    } else if (res.statusCode >= 400) {
      throw new Error(`HTTP ${res.statusCode}`);
    }
    return { size, ranges, filename, finalUrl };
  }

  async downloadSegmented(url, size) {
    const partCount = Math.min(this.connections, Math.max(1, Math.ceil(size / (256 * 1024))));
    const chunk = Math.ceil(size / partCount);
    const segments = [];
    for (let i = 0; i < partCount; i++) {
      const start = i * chunk;
      const end = Math.min(size - 1, start + chunk - 1);
      if (start > end) break;
      segments.push({ start, end, done: 0 });
    }

    const handle = await fsp.open(this.filepath, "w");
    await handle.truncate(size);
    await handle.close();

    const workers = segments.map((seg) => this.downloadRange(url, seg));
    await Promise.all(workers);
  }

  async downloadRange(url, seg) {
    while (!this.abort) {
      await this.waitIfPaused();
      if (this.abort) return;
      const from = seg.start + seg.done;
      if (from > seg.end) return;

      const { res } = await follow(url, {
        method: "GET",
        headers: { Range: `bytes=${from}-${seg.end}` },
      });

      if (![200, 206].includes(res.statusCode)) {
        res.resume();
        throw new Error(`Segment failed (HTTP ${res.statusCode})`);
      }

      this._active.push(res);
      try {
        await new Promise((resolve, reject) => {
          const ws = fs.createWriteStream(this.filepath, {
            flags: "r+",
            start: from,
          });
          res.on("data", (buf) => {
            if (this.abort || this.paused) {
              res.destroy();
              return;
            }
            seg.done += buf.length;
            this.noteBytes(buf.length);
          });
          res.on("error", reject);
          ws.on("error", reject);
          ws.on("finish", resolve);
          res.pipe(ws);
        });
      } catch (err) {
        if (this.abort) return;
        if (this.paused) {
          await this.waitIfPaused();
          continue;
        }
        throw err;
      } finally {
        this._active = this._active.filter((x) => x !== res);
      }

      if (seg.start + seg.done > seg.end) return;
      if (this.abort) return;
    }
  }

  async downloadSingle(url) {
    const { res } = await follow(url, { method: "GET" });
    if (res.statusCode >= 400) {
      res.resume();
      throw new Error(`HTTP ${res.statusCode}`);
    }
    if (!this.totalBytes) {
      this.totalBytes = Number(res.headers["content-length"] || 0);
    }
    this._active.push(res);
    try {
      await new Promise((resolve, reject) => {
        const ws = fs.createWriteStream(this.filepath);
        res.on("data", (buf) => {
          if (this.abort) {
            res.destroy();
            return;
          }
          this.noteBytes(buf.length);
        });
        res.on("error", reject);
        ws.on("error", reject);
        ws.on("finish", resolve);
        res.pipe(ws);
      });
    } finally {
      this._active = this._active.filter((x) => x !== res);
    }
  }
}

async function uniquePath(filepath) {
  const ext = path.extname(filepath);
  const stem = filepath.slice(0, filepath.length - ext.length);
  let candidate = filepath;
  let i = 1;
  while (true) {
    try {
      await fsp.access(candidate);
      candidate = `${stem} (${i})${ext}`;
      i += 1;
    } catch {
      return candidate;
    }
  }
}

class DownloadManager extends EventEmitter {
  constructor(destDir) {
    super();
    this.destDir = destDir;
    this.jobs = new Map();
  }

  list() {
    return [...this.jobs.values()].map((j) => j.snapshot());
  }

  add(url, connections) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Enter a valid http:// or https:// URL");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Only HTTP and HTTPS downloads are supported");
    }
    const id = crypto.randomBytes(8).toString("hex");
    const job = new DownloadJob({
      id,
      url,
      destDir: this.destDir,
      connections,
    });
    job.on("update", () => this.emit("update", job.snapshot()));
    this.jobs.set(id, job);
    job.start();
    return job.snapshot();
  }

  pause(id) {
    this.jobs.get(id)?.pause();
  }

  resume(id) {
    this.jobs.get(id)?.resume();
  }

  cancel(id) {
    this.jobs.get(id)?.cancel();
  }
}

module.exports = { DownloadManager };
