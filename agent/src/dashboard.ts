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
  header { background: #0f172a; color: #f8fafc; padding: 0 24px; display: flex; align-items: center; gap: 16px; height: 56px; }
  header h1 { font-size: 20px; font-weight: 700; }

  /* Nav tabs */
  .nav-tabs { display: flex; gap: 2px; margin-left: 24px; height: 100%; align-items: stretch; }
  .nav-tab { background: none; border: none; color: #94a3b8; font-size: 13px; font-weight: 600; padding: 0 16px; cursor: pointer; border-bottom: 2px solid transparent; transition: all .15s; }
  .nav-tab:hover { color: #e2e8f0; }
  .nav-tab.active { color: #f8fafc; border-bottom-color: #3b82f6; }

  .budget-bar { margin-left: auto; display: flex; gap: 16px; align-items: center; font-size: 12px; color: #94a3b8; }
  .budget-bar .budget-item { display: flex; align-items: center; gap: 6px; }
  .budget-bar .budget-label { font-weight: 600; }
  .budget-bar .budget-val { font-family: monospace; }
  .budget-bar .budget-paused { color: #fbbf24; font-weight: 700; }

  /* Views */
  .view { display: none; }
  .view.active { display: block; }

  /* Board view */
  .board { display: flex; gap: 16px; padding: 20px; overflow-x: auto; min-height: calc(100vh - 56px); }
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
  .token-badge { font-size: 10px; font-weight: 600; background: #f0f9ff; color: #0369a1; border: 1px solid #bae6fd; border-radius: 4px; padding: 1px 6px; font-family: monospace; white-space: nowrap; }
  .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; display: inline-block; animation: pulse 1.5s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

  /* Repos view */
  .repos-view { padding: 24px; max-width: 900px; }
  .repos-view h2 { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
  .repo-list { display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }
  .repo-card { background: #fff; border-radius: 8px; padding: 16px 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); display: flex; align-items: center; gap: 16px; }
  .repo-card .repo-name { font-weight: 700; font-size: 14px; min-width: 200px; }
  .repo-card .repo-flags { display: flex; gap: 12px; align-items: center; flex: 1; flex-wrap: wrap; }
  .repo-card .repo-actions { display: flex; gap: 8px; }
  .flag { font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 600; }
  .flag-on { background: #dcfce7; color: #166534; }
  .flag-off { background: #fee2e2; color: #991b1b; }
  .flag-label { background: #f0f9ff; color: #0369a1; border: 1px solid #bae6fd; }
  .btn { border: none; border-radius: 4px; padding: 6px 14px; font-size: 12px; font-weight: 600; cursor: pointer; }
  .btn-sm { padding: 4px 10px; font-size: 11px; }
  .btn-primary { background: #3b82f6; color: #fff; }
  .btn-primary:hover { background: #2563eb; }
  .btn-danger { background: #dc2626; color: #fff; }
  .btn-danger:hover { background: #b91c1c; }
  .btn-ghost { background: #f1f5f9; color: #475569; }
  .btn-ghost:hover { background: #e2e8f0; }

  /* Add repo form */
  .add-repo-form { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .add-repo-form h3 { font-size: 14px; font-weight: 700; margin-bottom: 12px; }
  .form-row { display: flex; gap: 12px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .form-row label { font-size: 12px; font-weight: 600; min-width: 100px; }
  .form-row input[type="text"] { border: 1px solid #d1d5db; border-radius: 4px; padding: 6px 10px; font-size: 13px; width: 280px; }
  .form-row input[type="text"]:focus { outline: none; border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.2); }
  .toggle { position: relative; width: 40px; height: 22px; appearance: none; background: #d1d5db; border-radius: 11px; cursor: pointer; transition: background .2s; }
  .toggle:checked { background: #22c55e; }
  .toggle::after { content: ""; position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; background: #fff; border-radius: 50%; transition: transform .2s; }
  .toggle:checked::after { transform: translateX(18px); }
  .help-text { font-size: 11px; color: #94a3b8; margin-top: 2px; }

  /* Admin view */
  .admin-view { padding: 24px; max-width: 900px; }
  .admin-view h2 { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .stat-card { background: #fff; border-radius: 8px; padding: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .stat-card .stat-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; margin-bottom: 4px; }
  .stat-card .stat-value { font-size: 24px; font-weight: 700; font-family: monospace; }
  .stat-card .stat-sub { font-size: 11px; color: #94a3b8; margin-top: 2px; }
  .admin-section { background: #fff; border-radius: 8px; padding: 20px; box-shadow: 0 1px 3px rgba(0,0,0,.08); margin-bottom: 16px; }
  .admin-section h3 { font-size: 14px; font-weight: 700; margin-bottom: 12px; }
  .admin-section p { font-size: 12px; color: #64748b; margin-bottom: 12px; }
  .inline-form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .inline-form select { border: 1px solid #d1d5db; border-radius: 4px; padding: 6px 10px; font-size: 13px; }
  .inline-form input[type="number"] { border: 1px solid #d1d5db; border-radius: 4px; padding: 6px 10px; font-size: 13px; width: 80px; }
  .status-breakdown { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .status-chip { font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 12px; background: #f1f5f9; }
  .repo-breakdown { font-size: 12px; color: #475569; line-height: 1.8; margin-top: 8px; }

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
  <nav class="nav-tabs">
    <button class="nav-tab active" data-view="board">Board</button>
    <button class="nav-tab" data-view="repos">Repos</button>
    <button class="nav-tab" data-view="admin">Admin</button>
  </nav>
  <div class="budget-bar" id="budgetBar"></div>
</header>

<!-- Board View -->
<div class="view active" id="view-board">
  <div class="board" id="board">
  ${columnsHtml}
  </div>
</div>

<!-- Repos View -->
<div class="view" id="view-repos">
  <div class="repos-view">
    <h2>Repository Configuration</h2>
    <div class="repo-list" id="repoList"></div>
    <div class="add-repo-form" id="addRepoForm">
      <h3>Add Repository</h3>
      <div class="form-row">
        <label>owner/repo</label>
        <input type="text" id="newRepoId" placeholder="turinglabsorg/website">
      </div>
      <div class="form-row">
        <label>Enabled</label>
        <input type="checkbox" class="toggle" id="newRepoEnabled" checked>
      </div>
      <div class="form-row">
        <label>Auto-solve</label>
        <input type="checkbox" class="toggle" id="newRepoAutoSolve">
        <span class="help-text">Automatically solve new issues without @mention</span>
      </div>
      <div class="form-row">
        <label>Include labels</label>
        <input type="text" id="newRepoInclude" placeholder="bug, help wanted">
        <span class="help-text">Comma-separated (empty = all)</span>
      </div>
      <div class="form-row">
        <label>Exclude labels</label>
        <input type="text" id="newRepoExclude" placeholder="wontfix, question">
      </div>
      <div class="form-row">
        <label>Allowed users</label>
        <input type="text" id="newRepoUsers" placeholder="user1, user2">
        <span class="help-text">Comma-separated (empty = anyone)</span>
      </div>
      <div class="form-row">
        <label></label>
        <button class="btn btn-primary" id="addRepoBtn">Save</button>
      </div>
    </div>
  </div>
</div>

<!-- Admin View -->
<div class="view" id="view-admin">
  <div class="admin-view">
    <h2>Admin</h2>
    <div class="stats-grid" id="statsGrid"></div>
    <div class="admin-section">
      <h3>Bulk Update Jobs</h3>
      <p>Change the status of multiple jobs at once.</p>
      <div class="inline-form">
        <label style="font-size:12px;font-weight:600">Where status is</label>
        <select id="bulkFromStatus">
          <option value="">Any</option>
          <option value="queued">queued</option>
          <option value="working">working</option>
          <option value="pr_opened">pr_opened</option>
          <option value="waiting_for_reply">waiting_for_reply</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="closed">closed</option>
        </select>
        <label style="font-size:12px;font-weight:600">set to</label>
        <select id="bulkToStatus">
          <option value="queued">queued</option>
          <option value="completed">completed</option>
          <option value="failed">failed</option>
          <option value="closed">closed</option>
        </select>
        <button class="btn btn-primary" id="bulkUpdateBtn">Apply</button>
      </div>
    </div>
    <div class="admin-section">
      <h3>Purge Old Jobs</h3>
      <p>Delete completed, failed, and closed jobs older than N days (including their logs).</p>
      <div class="inline-form">
        <label style="font-size:12px;font-weight:600">Older than</label>
        <input type="number" id="purgeDays" value="30" min="1">
        <label style="font-size:12px;font-weight:600">days</label>
        <button class="btn btn-danger" id="purgeBtn">Purge</button>
      </div>
    </div>
  </div>
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

// --- Tab navigation ---
document.querySelectorAll(".nav-tab").forEach(function(tab) {
  tab.addEventListener("click", function() {
    document.querySelectorAll(".nav-tab").forEach(function(t) { t.classList.remove("active"); });
    document.querySelectorAll(".view").forEach(function(v) { v.classList.remove("active"); });
    tab.classList.add("active");
    document.getElementById("view-" + tab.dataset.view).classList.add("active");
    if (tab.dataset.view === "repos") refreshRepos();
    if (tab.dataset.view === "admin") refreshStats();
  });
});

// --- Board rendering ---
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
  const liveIndicator = job.status === "working" ? '<span class="live-dot"></span>' : "";
  const isDraggable = job.status !== "working";
  const dragClass = isDraggable ? " draggable-card" : "";
  const dragAttr = isDraggable ? ' draggable="true"' : "";
  return '<div class="card clickable' + dragClass + '"' + dragAttr + ' data-job-id="' + escapeHtml(job.id) + '" data-job-status="' + job.status + '" style="border-left:4px solid ' + borderColor + '">'
    + '<div class="card-header-row"><div class="card-repo">' + escapeHtml(job.owner) + '/' + escapeHtml(job.repo) + '</div>' + liveIndicator + '</div>'
    + '<div class="card-title">' + title + '</div>'
    + '<div class="card-meta"><span class="badge">' + job.status + '</span><span class="branch">' + escapeHtml(job.branch) + '</span>' + tokenBadge + '</div>'
    + '<div class="card-times"><div>Started: ' + started + '</div><div>Updated: ' + updated + '</div></div>'
    + prLink + '</div>';
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
  return new Date(ts).toLocaleTimeString();
}

function appendTerminalLine(line) {
  const div = document.createElement("div");
  div.className = "terminal-line " + (line.type || "text");
  const timeStr = line.ts ? '<span class="log-time">' + formatTime(line.ts) + '</span> ' : '';
  div.innerHTML = timeStr + escapeHtml(line.content || "");
  panelTerminal.insertBefore(div, panelTerminal.firstChild);
}

function openPanel(jobId, jobTitle, jobStatus) {
  if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
  activeJobId = jobId;
  panelTitle.textContent = jobTitle || jobId;
  panelTokens.textContent = "";
  panelTerminal.innerHTML = "";
  slidePanel.classList.add("open");
  panelOverlay.classList.add("open");
  if (jobStatus === "working") { panelStop.classList.add("visible"); } else { panelStop.classList.remove("visible"); }
  const encodedId = encodeURIComponent(jobId);
  if (jobStatus === "working") {
    panelTerminal.classList.add("streaming");
    const es = new EventSource("/jobs/" + encodedId + "/stream");
    activeEventSource = es;
    es.onmessage = function(e) {
      try {
        const line = JSON.parse(e.data);
        if (line.type === "done") { panelTerminal.classList.remove("streaming"); es.close(); activeEventSource = null; return; }
        appendTerminalLine(line);
      } catch {}
    };
    es.onerror = function() { panelTerminal.classList.remove("streaming"); es.close(); activeEventSource = null; };
  } else {
    panelTerminal.classList.remove("streaming");
    fetch("/jobs/" + encodedId + "/logs")
      .then(function(res) { return res.json(); })
      .then(function(lines) {
        if (lines.length === 0) { appendTerminalLine({ type: "status", content: "No logs available." }); return; }
        for (const line of lines) appendTerminalLine(line);
      })
      .catch(function() { appendTerminalLine({ type: "error", content: "Failed to load logs." }); });
  }
}

function closePanel() {
  slidePanel.classList.remove("open");
  panelOverlay.classList.remove("open");
  if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
  activeJobId = null;
}

panelClose.addEventListener("click", closePanel);
panelOverlay.addEventListener("click", closePanel);

panelStop.addEventListener("click", async function() {
  if (!activeJobId) return;
  if (!confirm("Stop this worker and close the issue?")) return;
  try {
    const res = await fetch("/jobs/" + encodeURIComponent(activeJobId) + "/status", {
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); showToast(err.error || "Failed to stop worker", true); return; }
    showToast("Worker stopped, issue closed");
    panelStop.classList.remove("visible");
    if (activeEventSource) { activeEventSource.close(); activeEventSource = null; }
    panelTerminal.classList.remove("streaming");
    await refresh();
  } catch (err) { showToast("Network error: " + err.message, true); }
});

// Delegate click on cards
document.getElementById("board").addEventListener("click", function(e) {
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
    if (activeJobId) {
      const panelJob = jobs.find(j => j.id === activeJobId);
      if (panelJob && panelJob.tokenUsage) {
        panelTokens.textContent = "\\u2191" + formatTokens(panelJob.tokenUsage.inputTokens) + " tokens  \\u2193" + formatTokens(panelJob.tokenUsage.outputTokens) + " tokens";
      }
      if (panelJob && ["pr_opened", "completed", "failed", "closed"].includes(panelJob.status)) {
        panelTerminal.classList.remove("streaming");
      }
    }
  } catch (e) { console.error("refresh failed", e); }
}

// --- Toast ---
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
      method: "PATCH", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: targetStatus }),
    });
    if (!res.ok) { const err = await res.json().catch(() => ({})); showToast(err.error || "Failed to update status", true); return; }
    await refresh();
  } catch (err) { showToast("Network error: " + err.message, true); }
});

// --- Budget ---
async function refreshBudget() {
  try {
    const res = await fetch("/budget");
    const b = await res.json();
    const bar = document.getElementById("budgetBar");
    if (b.hourlyLimit === 0 && b.dailyLimit === 0) { bar.innerHTML = ""; return; }
    let html = "";
    if (b.hourlyLimit > 0) html += '<div class="budget-item"><span class="budget-label">1h:</span><span class="budget-val">' + formatTokens(b.hourlyUsed) + '/' + formatTokens(b.hourlyLimit) + '</span></div>';
    if (b.dailyLimit > 0) html += '<div class="budget-item"><span class="budget-label">24h:</span><span class="budget-val">' + formatTokens(b.dailyUsed) + '/' + formatTokens(b.dailyLimit) + '</span></div>';
    if (b.paused) html += '<span class="budget-paused">PAUSED</span>';
    bar.innerHTML = html;
  } catch {}
}
refreshBudget();

// --- Repos view ---
function splitCsv(s) { return s.split(",").map(function(x) { return x.trim(); }).filter(Boolean); }

function renderRepoCard(rc) {
  let flags = '';
  flags += '<span class="flag ' + (rc.enabled ? 'flag-on' : 'flag-off') + '">' + (rc.enabled ? 'enabled' : 'disabled') + '</span>';
  if (rc.autoSolve) flags += '<span class="flag flag-on">auto-solve</span>';
  if (rc.includeLabels.length) flags += rc.includeLabels.map(function(l) { return '<span class="flag flag-label">+' + escapeHtml(l) + '</span>'; }).join('');
  if (rc.excludeLabels.length) flags += rc.excludeLabels.map(function(l) { return '<span class="flag flag-off">-' + escapeHtml(l) + '</span>'; }).join('');
  if (rc.allowedUsers.length) flags += '<span class="flag flag-label">' + rc.allowedUsers.length + ' user(s)</span>';

  return '<div class="repo-card">'
    + '<div class="repo-name">' + escapeHtml(rc.id) + '</div>'
    + '<div class="repo-flags">' + flags + '</div>'
    + '<div class="repo-actions">'
    + '<button class="btn btn-sm btn-ghost" onclick="editRepo(\'' + escapeHtml(rc.id) + '\')">Edit</button>'
    + '<button class="btn btn-sm btn-danger" onclick="deleteRepo(\'' + escapeHtml(rc.id) + '\')">Delete</button>'
    + '</div></div>';
}

async function refreshRepos() {
  try {
    const res = await fetch("/repos");
    const repos = await res.json();
    const list = document.getElementById("repoList");
    if (repos.length === 0) {
      list.innerHTML = '<p style="color:#94a3b8;font-size:13px">No repos configured. All repos are accepted by default.</p>';
    } else {
      list.innerHTML = repos.map(renderRepoCard).join("");
    }
  } catch (err) { showToast("Failed to load repos: " + err.message, true); }
}

async function deleteRepo(id) {
  if (!confirm("Remove config for " + id + "?")) return;
  const parts = id.split("/");
  try {
    const res = await fetch("/repos/" + parts[0] + "/" + parts[1], { method: "DELETE" });
    if (!res.ok) { showToast("Failed to delete", true); return; }
    showToast("Removed " + id);
    refreshRepos();
  } catch (err) { showToast(err.message, true); }
}

async function editRepo(id) {
  const parts = id.split("/");
  try {
    const res = await fetch("/repos/" + parts[0] + "/" + parts[1]);
    if (!res.ok) return;
    const rc = await res.json();
    document.getElementById("newRepoId").value = rc.id;
    document.getElementById("newRepoEnabled").checked = rc.enabled;
    document.getElementById("newRepoAutoSolve").checked = rc.autoSolve;
    document.getElementById("newRepoInclude").value = rc.includeLabels.join(", ");
    document.getElementById("newRepoExclude").value = rc.excludeLabels.join(", ");
    document.getElementById("newRepoUsers").value = rc.allowedUsers.join(", ");
    document.getElementById("addRepoForm").querySelector("h3").textContent = "Edit Repository";
  } catch {}
}

document.getElementById("addRepoBtn").addEventListener("click", async function() {
  const repoId = document.getElementById("newRepoId").value.trim();
  if (!repoId || !repoId.includes("/")) { showToast("Enter owner/repo format", true); return; }
  const parts = repoId.split("/");
  const body = {
    enabled: document.getElementById("newRepoEnabled").checked,
    autoSolve: document.getElementById("newRepoAutoSolve").checked,
    includeLabels: splitCsv(document.getElementById("newRepoInclude").value),
    excludeLabels: splitCsv(document.getElementById("newRepoExclude").value),
    allowedUsers: splitCsv(document.getElementById("newRepoUsers").value),
  };
  try {
    const res = await fetch("/repos/" + parts[0] + "/" + parts[1], {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) { showToast("Failed to save", true); return; }
    showToast("Saved " + repoId);
    document.getElementById("newRepoId").value = "";
    document.getElementById("newRepoEnabled").checked = true;
    document.getElementById("newRepoAutoSolve").checked = false;
    document.getElementById("newRepoInclude").value = "";
    document.getElementById("newRepoExclude").value = "";
    document.getElementById("newRepoUsers").value = "";
    document.getElementById("addRepoForm").querySelector("h3").textContent = "Add Repository";
    refreshRepos();
  } catch (err) { showToast(err.message, true); }
});

// --- Admin view ---
async function refreshStats() {
  try {
    const res = await fetch("/admin/stats");
    const stats = await res.json();
    const grid = document.getElementById("statsGrid");
    let html = '';
    html += '<div class="stat-card"><div class="stat-label">Total Jobs</div><div class="stat-value">' + stats.totalJobs + '</div></div>';
    html += '<div class="stat-card"><div class="stat-label">Input Tokens</div><div class="stat-value">' + formatTokens(stats.totalTokens.input) + '</div></div>';
    html += '<div class="stat-card"><div class="stat-label">Output Tokens</div><div class="stat-value">' + formatTokens(stats.totalTokens.output) + '</div></div>';

    // Status breakdown
    const statusKeys = Object.keys(stats.byStatus);
    if (statusKeys.length) {
      html += '<div class="stat-card" style="grid-column: 1 / -1"><div class="stat-label">By Status</div><div class="status-breakdown">';
      for (const k of statusKeys) html += '<span class="status-chip">' + k + ': ' + stats.byStatus[k] + '</span>';
      html += '</div></div>';
    }

    // Repo breakdown
    const repoKeys = Object.keys(stats.byRepo);
    if (repoKeys.length) {
      html += '<div class="stat-card" style="grid-column: 1 / -1"><div class="stat-label">By Repository</div><div class="repo-breakdown">';
      for (const k of repoKeys) html += escapeHtml(k) + ': <strong>' + stats.byRepo[k] + '</strong><br>';
      html += '</div></div>';
    }

    grid.innerHTML = html;
  } catch (err) { showToast("Failed to load stats", true); }
}

document.getElementById("bulkUpdateBtn").addEventListener("click", async function() {
  const from = document.getElementById("bulkFromStatus").value;
  const to = document.getElementById("bulkToStatus").value;
  if (!to) return;
  const filter = {};
  if (from) filter.status = from;
  if (!confirm("Set " + (from || "all") + " jobs to " + to + "?")) return;
  try {
    const res = await fetch("/admin/jobs/bulk-update", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filter: filter, status: to }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "Failed", true); return; }
    showToast("Updated " + data.updated + " jobs");
    refreshStats();
    refresh();
  } catch (err) { showToast(err.message, true); }
});

document.getElementById("purgeBtn").addEventListener("click", async function() {
  const days = parseInt(document.getElementById("purgeDays").value, 10);
  if (isNaN(days) || days < 1) { showToast("Enter a valid number of days", true); return; }
  if (!confirm("Permanently delete completed/failed/closed jobs older than " + days + " days?")) return;
  try {
    const res = await fetch("/admin/jobs?olderThanDays=" + days, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || "Failed", true); return; }
    showToast("Purged " + data.purged + " jobs");
    refreshStats();
    refresh();
  } catch (err) { showToast(err.message, true); }
});

setInterval(refresh, 1000);
setInterval(refreshBudget, 10000);
</script>
</body>
</html>`;
}
