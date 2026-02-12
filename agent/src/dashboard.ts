import type { JobState } from "./types.js";

export function renderDashboard(jobs: JobState[]): string {
  const columns = [
    {
      title: "New",
      statuses: ["queued", "working"],
      color: "#3b82f6",
      bg: "#eff6ff",
      droppable: true,
      dropStatus: "queued",
    },
    {
      title: "Worked",
      statuses: ["pr_opened"],
      color: "#8b5cf6",
      bg: "#f5f3ff",
      droppable: false,
      dropStatus: null,
    },
    {
      title: "Waiting",
      statuses: ["waiting_for_reply"],
      color: "#f59e0b",
      bg: "#fffbeb",
      droppable: false,
      dropStatus: null,
    },
    {
      title: "Completed",
      statuses: ["completed"],
      color: "#10b981",
      bg: "#ecfdf5",
      droppable: true,
      dropStatus: "completed",
    },
    {
      title: "Failed",
      statuses: ["failed"],
      color: "#ef4444",
      bg: "#fef2f2",
      droppable: true,
      dropStatus: "failed",
    },
    {
      title: "Closed",
      statuses: ["closed"],
      color: "#6b7280",
      bg: "#f9fafb",
      droppable: true,
      dropStatus: "closed",
    },
  ];

  function formatTokens(n: number): string {
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    return String(n);
  }

  function cardHtml(job: JobState, borderColor: string): string {
    const title = job.issueTitle
      ? `#${job.issueNumber} — ${escapeHtml(job.issueTitle)}`
      : `#${job.issueNumber}`;
    const prLink = job.prUrl
      ? `<a href="${escapeHtml(job.prUrl)}" target="_blank" class="pr-link">View PR</a>`
      : "";
    const started = new Date(job.startedAt).toLocaleString();
    const updated = new Date(job.updatedAt).toLocaleString();

    const tokenBadge = job.tokenUsage
      ? `<span class="token-badge">&uarr;${formatTokens(job.tokenUsage.inputTokens)} &darr;${formatTokens(job.tokenUsage.outputTokens)}</span>`
      : "";

    const liveIndicator = job.status === "working"
      ? `<span class="live-dot"></span>`
      : "";

    const draggable = job.status !== "working";
    const dragAttr = draggable ? ` draggable="true"` : "";

    return `<div class="card clickable${draggable ? " draggable-card" : ""}" data-job-id="${escapeHtml(job.id)}" data-job-status="${job.status}"${dragAttr} style="border-left: 4px solid ${borderColor}">
      <div class="card-header-row">
        <div class="card-repo">${escapeHtml(job.owner)}/${escapeHtml(job.repo)}</div>
        ${liveIndicator}
      </div>
      <div class="card-title">${title}</div>
      <div class="card-meta">
        <span class="badge">${job.status}</span>
        <span class="branch">${escapeHtml(job.branch)}</span>
        ${tokenBadge}
      </div>
      <div class="card-times">
        <div>Started: ${started}</div>
        <div>Updated: ${updated}</div>
      </div>
      ${prLink}
    </div>`;
  }

  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const columnsHtml = columns
    .map((col) => {
      const colJobs = jobs.filter((j) => col.statuses.includes(j.status));
      const cards = colJobs.map((j) => cardHtml(j, col.color)).join("\n");
      return `<div class="column" style="background:${col.bg}">
        <div class="column-header" style="border-bottom: 3px solid ${col.color}">
          <span class="column-title">${col.title}</span>
          <span class="column-count">${colJobs.length}</span>
        </div>
        <div class="column-body" id="col-${col.title.toLowerCase()}" data-droppable="${col.droppable}" data-drop-status="${col.dropStatus || ""}">${cards}</div>
      </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grog Dashboard</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; color: #1e293b; }
  header { background: #0f172a; color: #f8fafc; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
  header h1 { font-size: 20px; font-weight: 700; }
  header .subtitle { font-size: 13px; color: #94a3b8; }
  .board { display: flex; gap: 16px; padding: 20px; overflow-x: auto; min-height: calc(100vh - 64px); }
  .column { flex: 1; min-width: 240px; border-radius: 8px; display: flex; flex-direction: column; }
  .column-header { padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; }
  .column-title { font-weight: 700; font-size: 14px; text-transform: uppercase; letter-spacing: .5px; }
  .column-count { background: #e2e8f0; border-radius: 12px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
  .column-body { padding: 8px 12px; display: flex; flex-direction: column; gap: 10px; flex: 1; }
  .card { background: #fff; border-radius: 6px; padding: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card.clickable { cursor: pointer; transition: box-shadow .15s; }
  .card.clickable:hover { box-shadow: 0 2px 8px rgba(59,130,246,.25); }
  .card-header-row { display: flex; justify-content: space-between; align-items: center; }
  .card-repo { font-size: 11px; color: #64748b; margin-bottom: 4px; }
  .card-title { font-weight: 600; font-size: 14px; margin-bottom: 8px; }
  .card-meta { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap; }
  .badge { background: #e2e8f0; border-radius: 4px; padding: 2px 6px; font-size: 11px; font-weight: 600; }
  .branch { font-size: 11px; color: #64748b; font-family: monospace; }
  .card-times { font-size: 11px; color: #94a3b8; line-height: 1.6; }
  .pr-link { display: inline-block; margin-top: 6px; font-size: 12px; color: #3b82f6; text-decoration: none; font-weight: 600; }
  .pr-link:hover { text-decoration: underline; }

  /* Token badge */
  .token-badge { font-size: 10px; font-weight: 600; background: #f0f9ff; color: #0369a1; border: 1px solid #bae6fd; border-radius: 4px; padding: 1px 6px; font-family: monospace; white-space: nowrap; }

  /* Live dot */
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

  /* Slide-out panel */
  .slide-panel-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.3); z-index: 99; opacity: 0; pointer-events: none; transition: opacity .2s; }
  .slide-panel-overlay.open { opacity: 1; pointer-events: auto; }
  .slide-panel { position: fixed; top: 0; right: 0; width: 520px; max-width: 100vw; height: 100vh; background: #fff; z-index: 100; transform: translateX(100%); transition: transform .25s ease; display: flex; flex-direction: column; box-shadow: -4px 0 24px rgba(0,0,0,.12); }
  .slide-panel.open { transform: translateX(0); }
  .slide-panel .panel-header { padding: 16px 20px; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; flex-shrink: 0; }
  .slide-panel .panel-header .panel-title { font-weight: 700; font-size: 14px; line-height: 1.4; }
  .slide-panel .panel-header .panel-tokens { font-size: 12px; color: #64748b; font-family: monospace; margin-top: 4px; }
  .slide-panel .panel-close { background: none; border: none; font-size: 20px; cursor: pointer; color: #64748b; padding: 0 4px; line-height: 1; }
  .slide-panel .panel-close:hover { color: #1e293b; }
  .slide-panel .panel-actions { display: flex; gap: 8px; align-items: center; }
  .btn-stop { background: #dc2626; color: #fff; border: none; border-radius: 4px; padding: 5px 12px; font-size: 12px; font-weight: 600; cursor: pointer; display: none; }
  .btn-stop:hover { background: #b91c1c; }
  .btn-stop.visible { display: inline-block; }
  .slide-panel .terminal { flex: 1; background: #1e1e2e; color: #cdd6f4; font-family: "SF Mono", "Cascadia Code", "Fira Code", Menlo, monospace; font-size: 12px; line-height: 1.7; padding: 16px; overflow-y: auto; overflow-x: hidden; }
  .slide-panel .terminal.streaming { border-top: 2px solid #22c55e; animation: term-pulse 2s ease-in-out infinite; }
  @keyframes term-pulse { 0%, 100% { border-top-color: #22c55e; } 50% { border-top-color: #1e1e2e; } }
  .terminal-line { padding: 2px 0 2px 12px; border-left: 3px solid transparent; word-break: break-word; }
  .terminal-line.tool { border-left-color: #89b4fa; color: #89b4fa; }
  .terminal-line.text { border-left-color: transparent; color: #cdd6f4; }
  .terminal-line.status { border-left-color: #a6e3a1; color: #a6e3a1; font-weight: 700; }
  .terminal-line.error { border-left-color: #f38ba8; color: #f38ba8; }
  .log-time { color: #585b70; font-size: 10px; margin-right: 6px; }

  /* Drag-and-drop */
  .card.draggable-card { cursor: grab; }
  .card.draggable-card:active { cursor: grabbing; }
  .card.dragging { opacity: .4; }
  .column-body.drag-over { background: rgba(59,130,246,.08); border: 2px dashed #3b82f6; border-radius: 6px; }
  .column-body[data-droppable="false"] { }

  /* Toast notifications */
  .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 200; display: flex; flex-direction: column; gap: 8px; }
  .toast { background: #1e293b; color: #f8fafc; padding: 10px 16px; border-radius: 6px; font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,.2); animation: toast-in .25s ease, toast-out .3s ease 3s forwards; max-width: 360px; }
  .toast.toast-error { background: #991b1b; }
  @keyframes toast-in { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes toast-out { from { opacity: 1; } to { opacity: 0; } }
</style>
</head>
<body>
<header>
  <h1>Grog</h1>
  <span class="subtitle">Job Dashboard</span>
</header>
<div class="board" id="board">
${columnsHtml}
</div>

<div class="toast-container" id="toastContainer"></div>

<!-- Slide-out panel -->
<div class="slide-panel-overlay" id="panelOverlay"></div>
<div class="slide-panel" id="slidePanel">
  <div class="panel-header">
    <div>
      <div class="panel-title" id="panelTitle"></div>
      <div class="panel-tokens" id="panelTokens"></div>
    </div>
    <div class="panel-actions">
      <button class="btn-stop" id="panelStop">Stop Worker</button>
      <button class="panel-close" id="panelClose">&times;</button>
    </div>
  </div>
  <div class="terminal" id="panelTerminal"></div>
</div>

<script>
const COLUMNS = ${JSON.stringify(columns.map((c) => ({ title: c.title, statuses: c.statuses, color: c.color, bg: c.bg, droppable: c.droppable, dropStatus: c.dropStatus })))};

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function formatTokens(n) {
  if (n >= 1000) return (n / 1000).toFixed(1).replace(/\\.0$/, "") + "k";
  return String(n);
}

function renderCard(job, borderColor) {
  const title = job.issueTitle
    ? "#" + job.issueNumber + " \\u2014 " + escapeHtml(job.issueTitle)
    : "#" + job.issueNumber;
  const prLink = job.prUrl
    ? '<a href="' + escapeHtml(job.prUrl) + '" target="_blank" class="pr-link">View PR</a>'
    : "";
  const started = new Date(job.startedAt).toLocaleString();
  const updated = new Date(job.updatedAt).toLocaleString();

  const tokenBadge = job.tokenUsage
    ? '<span class="token-badge">&uarr;' + formatTokens(job.tokenUsage.inputTokens) + ' &darr;' + formatTokens(job.tokenUsage.outputTokens) + '</span>'
    : "";

  const liveIndicator = job.status === "working"
    ? '<span class="live-dot"></span>'
    : "";

  const isDraggable = job.status !== "working";
  const dragClass = isDraggable ? " draggable-card" : "";
  const dragAttr = isDraggable ? ' draggable="true"' : "";

  return '<div class="card clickable' + dragClass + '"' + dragAttr + ' data-job-id="' + escapeHtml(job.id) + '" data-job-status="' + job.status + '" style="border-left:4px solid ' + borderColor + '">'
    + '<div class="card-header-row"><div class="card-repo">' + escapeHtml(job.owner) + '/' + escapeHtml(job.repo) + '</div>' + liveIndicator + '</div>'
    + '<div class="card-title">' + title + '</div>'
    + '<div class="card-meta"><span class="badge">' + job.status + '</span>'
    + '<span class="branch">' + escapeHtml(job.branch) + '</span>'
    + tokenBadge + '</div>'
    + '<div class="card-times"><div>Started: ' + started + '</div><div>Updated: ' + updated + '</div></div>'
    + prLink
    + '</div>';
}

// --- Slide-out panel ---
let activeEventSource = null;
let activeJobId = null;

const slidePanel = document.getElementById("slidePanel");
const panelOverlay = document.getElementById("panelOverlay");
const panelTitle = document.getElementById("panelTitle");
const panelTokens = document.getElementById("panelTokens");
const panelTerminal = document.getElementById("panelTerminal");
const panelClose = document.getElementById("panelClose");
const panelStop = document.getElementById("panelStop");

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  return d.toLocaleTimeString();
}

function appendTerminalLine(line) {
  const div = document.createElement("div");
  div.className = "terminal-line " + (line.type || "text");
  const timeStr = line.ts ? '<span class="log-time">' + formatTime(line.ts) + '</span> ' : '';
  div.innerHTML = timeStr + escapeHtml(line.content || "");
  panelTerminal.insertBefore(div, panelTerminal.firstChild);
}

function openPanel(jobId, jobTitle, jobStatus) {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  activeJobId = jobId;
  panelTitle.textContent = jobTitle || jobId;
  panelTokens.textContent = "";
  panelTerminal.innerHTML = "";

  slidePanel.classList.add("open");
  panelOverlay.classList.add("open");

  // Show stop button only for working jobs
  if (jobStatus === "working") {
    panelStop.classList.add("visible");
  } else {
    panelStop.classList.remove("visible");
  }

  const encodedId = encodeURIComponent(jobId);

  if (jobStatus === "working") {
    // Live streaming via SSE
    panelTerminal.classList.add("streaming");
    const es = new EventSource("/jobs/" + encodedId + "/stream");
    activeEventSource = es;

    es.onmessage = function(e) {
      try {
        const line = JSON.parse(e.data);
        if (line.type === "done") {
          panelTerminal.classList.remove("streaming");
          es.close();
          activeEventSource = null;
          return;
        }
        appendTerminalLine(line);
      } catch {}
    };

    es.onerror = function() {
      panelTerminal.classList.remove("streaming");
      es.close();
      activeEventSource = null;
    };
  } else {
    // Historical logs from DB
    panelTerminal.classList.remove("streaming");
    fetch("/jobs/" + encodedId + "/logs")
      .then(function(res) { return res.json(); })
      .then(function(lines) {
        if (lines.length === 0) {
          appendTerminalLine({ type: "status", content: "No logs available for this job." });
          return;
        }
        for (const line of lines) {
          appendTerminalLine(line);
        }
      })
      .catch(function() {
        appendTerminalLine({ type: "error", content: "Failed to load logs." });
      });
  }
}

function closePanel() {
  slidePanel.classList.remove("open");
  panelOverlay.classList.remove("open");
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  activeJobId = null;
}

panelClose.addEventListener("click", closePanel);
panelOverlay.addEventListener("click", closePanel);

panelStop.addEventListener("click", async function() {
  if (!activeJobId) return;
  if (!confirm("Stop this worker and close the issue?")) return;
  try {
    const res = await fetch("/jobs/" + encodeURIComponent(activeJobId) + "/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Failed to stop worker", true);
      return;
    }
    showToast("Worker stopped, issue closed");
    panelStop.classList.remove("visible");
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
    panelTerminal.classList.remove("streaming");
    await refresh();
  } catch (err) {
    showToast("Network error: " + err.message, true);
  }
});

// Delegate click on cards
document.getElementById("board").addEventListener("click", function(e) {
  // Ignore clicks on links (PR link, etc.)
  if (e.target.closest("a")) return;
  const card = e.target.closest(".card.clickable");
  if (!card) return;
  const jobId = card.getAttribute("data-job-id");
  const jobStatus = card.getAttribute("data-job-status");
  const title = card.querySelector(".card-repo").textContent + " " + card.querySelector(".card-title").textContent;
  openPanel(jobId, title, jobStatus);
});

async function refresh() {
  try {
    const res = await fetch("/jobs");
    const jobs = await res.json();
    for (const col of COLUMNS) {
      const el = document.getElementById("col-" + col.title.toLowerCase());
      const colJobs = jobs.filter(j => col.statuses.includes(j.status));
      el.innerHTML = colJobs.map(j => renderCard(j, col.color)).join("");
      el.parentElement.querySelector(".column-count").textContent = colJobs.length;
    }
    // Update panel tokens if panel is open
    if (activeJobId) {
      const panelJob = jobs.find(j => j.id === activeJobId);
      if (panelJob && panelJob.tokenUsage) {
        panelTokens.textContent = "\\u2191" + formatTokens(panelJob.tokenUsage.inputTokens) + " tokens  \\u2193" + formatTokens(panelJob.tokenUsage.outputTokens) + " tokens";
      }
      // If job finished, stop streaming indicator
      if (panelJob && ["pr_opened", "completed", "failed", "closed"].includes(panelJob.status)) {
        panelTerminal.classList.remove("streaming");
      }
    }
  } catch (e) {
    console.error("refresh failed", e);
  }
}

// --- Toast notifications ---
function showToast(msg, isError) {
  const container = document.getElementById("toastContainer");
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " toast-error" : "");
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// --- Drag-and-drop ---
const board = document.getElementById("board");

board.addEventListener("dragstart", function(e) {
  const card = e.target.closest(".card[draggable='true']");
  if (!card) return;
  card.classList.add("dragging");
  e.dataTransfer.setData("text/plain", card.getAttribute("data-job-id"));
  e.dataTransfer.effectAllowed = "move";
});

board.addEventListener("dragend", function(e) {
  const card = e.target.closest(".card");
  if (card) card.classList.remove("dragging");
  document.querySelectorAll(".column-body.drag-over").forEach(el => el.classList.remove("drag-over"));
});

board.addEventListener("dragover", function(e) {
  const colBody = e.target.closest('.column-body[data-droppable="true"]');
  if (!colBody) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  colBody.classList.add("drag-over");
});

board.addEventListener("dragleave", function(e) {
  const colBody = e.target.closest(".column-body");
  if (colBody) colBody.classList.remove("drag-over");
});

board.addEventListener("drop", async function(e) {
  e.preventDefault();
  document.querySelectorAll(".column-body.drag-over").forEach(el => el.classList.remove("drag-over"));

  const colBody = e.target.closest('.column-body[data-droppable="true"]');
  if (!colBody) return;

  const jobId = e.dataTransfer.getData("text/plain");
  const targetStatus = colBody.getAttribute("data-drop-status");
  if (!jobId || !targetStatus) return;

  try {
    const res = await fetch("/jobs/" + encodeURIComponent(jobId) + "/status", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: targetStatus }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(err.error || "Failed to update status", true);
      return;
    }
    await refresh();
  } catch (err) {
    showToast("Network error: " + err.message, true);
  }
});

setInterval(refresh, 1000);
</script>
</body>
</html>`;
}
