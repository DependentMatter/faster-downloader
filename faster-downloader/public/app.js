const jobsEl = document.getElementById("jobs");
const form = document.getElementById("addForm");
const formError = document.getElementById("formError");
const savePath = document.getElementById("savePath");
const jobs = new Map();

function fmtBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtEta(sec) {
  if (sec == null) return "—";
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}m ${s}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function renderJob(job) {
  const empty = jobsEl.querySelector(".empty");
  if (empty) empty.remove();
  jobs.set(job.id, job);
  let el = document.getElementById(`job-${job.id}`);
  if (!el) {
    el = document.createElement("article");
    el.className = "job";
    el.id = `job-${job.id}`;
    jobsEl.prepend(el);
  }
  const showPause = job.status === "downloading";
  const showResume = job.status === "paused";
  const showCancel = ["downloading", "paused", "connecting", "queued"].includes(job.status);
  el.innerHTML = `
    <div class="job-top">
      <div>
        <div class="filename">${job.filename || job.url}</div>
        <div class="muted">${job.url}</div>
      </div>
      <div class="actions">
        ${showPause ? `<button class="ghost" data-act="pause">Pause</button>` : ""}
        ${showResume ? `<button data-act="resume">Resume</button>` : ""}
        ${showCancel ? `<button class="ghost" data-act="cancel">Cancel</button>` : ""}
      </div>
    </div>
    <div class="bar"><div class="fill" style="width:${job.percent || 0}%"></div></div>
    <div class="meta">
      <span class="status ${job.status}">${job.status}</span>
      <span>${fmtBytes(job.downloadedBytes)} / ${job.totalBytes ? fmtBytes(job.totalBytes) : "?"}</span>
      <span>${fmtBytes(job.speed)}/s</span>
      <span>ETA ${fmtEta(job.eta)}</span>
      <span>${job.connections} connections</span>
    </div>
    ${job.error ? `<p class="error">${job.error}</p>` : ""}
  `;
  el.querySelectorAll("button[data-act]").forEach((btn) => {
    btn.onclick = async () => {
      await fetch(`/api/jobs/${job.id}/${btn.dataset.act}`, { method: "POST" });
    };
  });
}

function renderEmpty() {
  if (![...jobs.values()].length) {
    jobsEl.innerHTML = `<p class="empty">Paste a download URL above. The app will split the file across several connections when the server allows it.</p>`;
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;
  const url = document.getElementById("url").value.trim();
  const connections = Number(document.getElementById("connections").value);
  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, connections }),
  });
  const data = await res.json();
  if (!res.ok) {
    formError.hidden = false;
    formError.textContent = data.error || "Could not start download";
    return;
  }
  document.getElementById("url").value = "";
  renderJob(data);
});

async function boot() {
  const res = await fetch("/api/jobs");
  const data = await res.json();
  savePath.textContent = data.destDir;
  jobsEl.innerHTML = "";
  data.jobs.forEach(renderJob);
  renderEmpty();
  const es = new EventSource("/api/events");
  es.addEventListener("job", (ev) => renderJob(JSON.parse(ev.data)));
}

boot();
