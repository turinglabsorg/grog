import type { JobState, BudgetStatus } from "@grog/shared";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  return String(n);
}

function statusColor(s: string): string {
  switch (s) {
    case "queued": return "#f59e0b";
    case "working": return "#22c55e";
    case "waiting_for_reply": return "#3b82f6";
    case "pr_opened": return "#8b5cf6";
    case "completed": return "#10b981";
    case "failed": return "#ef4444";
    case "closed": return "#6b7280";
    case "stopped": return "#f97316";
    default: return "#94a3b8";
  }
}

export function renderDashboard(jobs: JobState[], configured = true): string {
  const jobRows = jobs
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map((j) => {
      const color = statusColor(j.status);
      const tokens = j.tokenUsage
        ? `<span class="dim">${formatTokens(j.tokenUsage.inputTokens + j.tokenUsage.outputTokens)} tok</span>`
        : "";
      const pr = j.prUrl ? `<a href="${esc(j.prUrl)}" target="_blank" class="link">PR</a>` : "";
      const age = Math.round((Date.now() - new Date(j.updatedAt).getTime()) / 60000);
      const ageStr = age < 1 ? "<1m" : age < 60 ? `${age}m` : `${Math.round(age / 60)}h`;
      const live = j.status === "working" ? '<span class="blink">●</span> ' : "";
      return `<div class="row clickable" data-job-id="${esc(j.id)}" data-status="${j.status}">` +
        `<span class="col-status" style="color:${color}">${live}${j.status}</span>` +
        `<span class="col-repo">${esc(j.owner)}/${esc(j.repo)}</span>` +
        `<span class="col-issue">#${j.issueNumber}</span>` +
        `<span class="col-title">${esc(j.issueTitle ?? "")}</span>` +
        `<span class="col-age">${ageStr}</span>` +
        `${tokens}` +
        `${pr}` +
        `</div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>grog</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #c9d1d9; font-family: "SF Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace; font-size: 13px; line-height: 1.6; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  .header { padding: 16px 20px; border-bottom: 1px solid #21262d; display: flex; align-items: center; gap: 16px; }
  .logo { color: #58a6ff; font-size: 18px; font-weight: 700; letter-spacing: 2px; }
  .header-info { color: #8b949e; font-size: 11px; display: flex; gap: 16px; }
  .header-info span { display: flex; align-items: center; gap: 4px; }
  .budget-badge { background: #161b22; border: 1px solid #30363d; border-radius: 4px; padding: 2px 8px; font-size: 11px; }
  .budget-paused { color: #f59e0b; font-weight: 700; }

  .container { padding: 12px 20px; }

  .section-label { color: #8b949e; font-size: 11px; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 8px; padding-bottom: 4px; border-bottom: 1px solid #21262d; }

  /* Setup screen */
  .setup { max-width: 480px; margin: 60px auto; }
  .setup h2 { color: #58a6ff; font-size: 16px; font-weight: 700; margin-bottom: 8px; }
  .setup p { color: #8b949e; font-size: 12px; margin-bottom: 20px; line-height: 1.7; }
  .setup label { display: block; color: #c9d1d9; font-size: 12px; margin-bottom: 4px; font-weight: 600; }
  .setup input, .setup textarea { width: 100%; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; font-family: inherit; font-size: 13px; padding: 8px 10px; border-radius: 4px; margin-bottom: 14px; outline: none; }
  .setup input:focus, .setup textarea:focus { border-color: #58a6ff; }
  .setup textarea { min-height: 120px; resize: vertical; }
  .setup-btn { width: 100%; padding: 10px 0; background: #238636; color: #fff; border: none; border-radius: 6px; font-family: inherit; font-size: 14px; font-weight: 700; cursor: pointer; letter-spacing: .5px; transition: background .15s; }
  .setup-btn:hover { background: #2ea043; }
  .setup-btn:disabled { opacity: .5; cursor: not-allowed; }
  .setup-error { color: #f85149; font-size: 12px; margin-bottom: 12px; display: none; }
  .setup-success { color: #22c55e; font-size: 12px; margin-bottom: 12px; display: none; }
  .connected-badge { display: inline-flex; align-items: center; gap: 6px; background: #0d1117; border: 1px solid #238636; color: #22c55e; padding: 3px 10px; border-radius: 4px; font-size: 11px; font-weight: 600; }
  .disconnect-link { color: #f85149; font-size: 11px; cursor: pointer; margin-left: 8px; }

  .row { display: flex; gap: 12px; align-items: center; padding: 6px 8px; border-radius: 4px; cursor: pointer; transition: background .1s; }
  .row:hover { background: #161b22; }
  .col-status { width: 120px; font-weight: 600; font-size: 12px; white-space: nowrap; }
  .col-repo { width: 200px; color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-issue { width: 50px; color: #c9d1d9; }
  .col-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .col-age { width: 40px; color: #8b949e; text-align: right; }
  .dim { color: #484f58; margin-left: 8px; }
  .link { margin-left: 8px; font-size: 11px; }

  .blink { animation: blink 1.2s ease-in-out infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .2; } }

  .empty { color: #484f58; text-align: center; padding: 40px 0; }
  .prompt { color: #484f58; }
  .prompt::before { content: "$ "; color: #22c55e; }

  /* Terminal panel */
  .panel-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.5); z-index: 99; opacity: 0; pointer-events: none; transition: opacity .15s; }
  .panel-overlay.open { opacity: 1; pointer-events: auto; }
  .panel { position: fixed; top: 0; right: 0; width: 600px; min-width: 320px; max-width: 100vw; height: 100vh; background: #0d1117; border-left: 1px solid #21262d; z-index: 100; transform: translateX(100%); transition: transform .2s ease; display: flex; flex-direction: column; }
  .panel.resizing { transition: none; user-select: none; }
  .panel-resize { position: absolute; top: 0; left: -4px; width: 8px; height: 100%; cursor: col-resize; z-index: 101; }
  .panel-resize:hover, .panel-resize.active { background: #58a6ff; opacity: .4; }
  .panel.open { transform: translateX(0); }
  .panel-header { padding: 12px 16px; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; align-items: center; }
  .panel-header .panel-title { font-weight: 600; font-size: 13px; color: #c9d1d9; }
  .panel-header .panel-meta { font-size: 11px; color: #484f58; }
  .panel-close { background: none; border: 1px solid #30363d; color: #8b949e; border-radius: 4px; padding: 2px 8px; cursor: pointer; font-family: inherit; font-size: 12px; }
  .panel-close:hover { background: #21262d; color: #c9d1d9; }
  .terminal { flex: 1; overflow-y: auto; padding: 12px 16px; }
  .terminal.streaming { border-top: 2px solid #22c55e; }
  .term-line { padding: 1px 0 1px 10px; border-left: 2px solid transparent; word-break: break-word; }
  .term-line.tool { border-left-color: #58a6ff; color: #58a6ff; }
  .term-line.text { color: #c9d1d9; }
  .term-line.status { border-left-color: #22c55e; color: #22c55e; font-weight: 600; }
  .term-line.error { border-left-color: #f85149; color: #f85149; }
  .term-line.user { border-left-color: #f59e0b; color: #f59e0b; }
  .term-time { color: #484f58; font-size: 10px; margin-right: 6px; }
  .term-id { color: #30363d; font-size: 10px; margin-right: 4px; font-family: inherit; }

  /* Panel footer with stop/start button */
  .panel-footer { padding: 12px 16px; border-top: 1px solid #21262d; text-align: center; }
  .stop-btn { width: 100%; padding: 12px 0; font-family: inherit; font-size: 14px; font-weight: 700; letter-spacing: 1px; border: none; border-radius: 6px; cursor: pointer; transition: background .15s, transform .1s; }
  .stop-btn:active { transform: scale(.98); }
  .stop-btn.stop { background: #da3633; color: #fff; }
  .stop-btn.stop:hover { background: #f85149; }
  .stop-btn.start { background: #238636; color: #fff; }
  .stop-btn.start:hover { background: #2ea043; }
  .stop-btn:disabled { opacity: .5; cursor: not-allowed; }

  /* Chat input */
  .chat-row { display: flex; gap: 8px; margin-bottom: 10px; }
  .chat-row input { flex: 1; background: #161b22; border: 1px solid #30363d; color: #c9d1d9; font-family: inherit; font-size: 13px; padding: 8px 10px; border-radius: 4px; outline: none; }
  .chat-row input:focus { border-color: #f59e0b; }
  .chat-row input::placeholder { color: #484f58; }
  .chat-row button { background: #f59e0b; color: #0d1117; border: none; border-radius: 4px; padding: 8px 14px; font-family: inherit; font-size: 13px; font-weight: 700; cursor: pointer; white-space: nowrap; }
  .chat-row button:hover { background: #fbbf24; }

  /* Toast */
  .toast-box { position: fixed; bottom: 16px; right: 16px; z-index: 200; }
  .toast { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 14px; border-radius: 4px; font-size: 12px; margin-top: 6px; animation: fadein .2s ease, fadeout .3s ease 3s forwards; }
  .toast-err { border-color: #f85149; color: #f85149; }
  @keyframes fadein { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:translateY(0); } }
  @keyframes fadeout { from { opacity:1; } to { opacity:0; } }

  /* New job button + modal */
  .add-btn { background: #238636; color: #fff; border: none; border-radius: 6px; width: 28px; height: 28px; font-size: 18px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; margin-left: auto; transition: background .15s; }
  .add-btn:hover { background: #2ea043; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,.6); z-index: 300; display: none; align-items: center; justify-content: center; }
  .modal-overlay.open { display: flex; }
  .modal { background: #161b22; border: 1px solid #30363d; border-radius: 8px; width: 440px; max-width: 90vw; padding: 20px; }
  .modal h3 { color: #c9d1d9; font-size: 14px; margin-bottom: 14px; }
  .modal label { display: block; color: #8b949e; font-size: 11px; margin-bottom: 4px; text-transform: uppercase; letter-spacing: .5px; }
  .modal input, .modal textarea { width: 100%; background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; font-family: inherit; font-size: 13px; padding: 8px 10px; border-radius: 4px; margin-bottom: 12px; outline: none; }
  .modal input:focus, .modal textarea:focus { border-color: #58a6ff; }
  .modal textarea { min-height: 60px; resize: vertical; }
  .modal-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .modal-actions button { padding: 8px 16px; border-radius: 6px; font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer; border: none; }
  .modal-cancel { background: #21262d; color: #c9d1d9; }
  .modal-cancel:hover { background: #30363d; }
  .modal-submit { background: #238636; color: #fff; }
  .modal-submit:hover { background: #2ea043; }
  .modal-submit:disabled { opacity: .5; cursor: not-allowed; }
  .modal-error { color: #f85149; font-size: 12px; margin-bottom: 8px; display: none; }
</style>
</head>
<body>
<div class="header">
  <div class="logo">GROG</div>
  <div class="header-info">
    <span id="appStatus"></span>
    <span id="budgetInfo"></span>
    <span id="jobCount"></span>
  </div>
  <button class="add-btn" id="addJobBtn" title="New job">+</button>
</div>

<div class="modal-overlay" id="newJobOverlay">
  <div class="modal">
    <h3>New Job</h3>
    <label for="newJobUrl">GitHub URL</label>
    <input id="newJobUrl" type="text" placeholder="https://github.com/owner/repo or /issues/123" autocomplete="off" />
    <label for="newJobInstructions">Instructions <span style="color:#484f58">(optional)</span></label>
    <textarea id="newJobInstructions" placeholder="Tell the agent what to do..."></textarea>
    <div class="modal-error" id="newJobError"></div>
    <div class="modal-actions">
      <button class="modal-cancel" id="newJobCancel">Cancel</button>
      <button class="modal-submit" id="newJobSubmit">Queue</button>
    </div>
  </div>
</div>

<div id="setupScreen" class="container" style="display:${configured ? "none" : "block"};">
  <div class="setup">
    <h2>Connect GitHub App</h2>
    <p>Create a GitHub App and install it on your org to get started. The app needs permissions: Issues (R/W), Pull Requests (R/W), Contents (R/W), Metadata (Read). Subscribe to events: Issue comment, Issues, Pull request.</p>
    <p>After creating the app, go to <a href="https://github.com/settings/apps" target="_blank">github.com/settings/apps</a>/<strong>&lt;your-app-name&gt;</strong>/installations and install it on your org/account.</p>
    <div class="setup-error" id="setupError"></div>
    <div class="setup-success" id="setupSuccess"></div>
    <label for="appId">App ID</label>
    <input id="appId" type="text" placeholder="123456" autocomplete="off" />
    <label for="privateKey">Private Key (PEM)</label>
    <textarea id="privateKey" placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;...&#10;-----END RSA PRIVATE KEY-----"></textarea>
    <label for="webhookSecret">Webhook Secret <span style="color:#484f58">(optional)</span></label>
    <input id="webhookSecret" type="text" placeholder="your-webhook-secret" autocomplete="off" />
    <button class="setup-btn" id="setupBtn">Connect</button>
  </div>
</div>

<div id="dashboardScreen" class="container" style="display:${configured ? "block" : "none"};">
  <div class="section-label">Jobs</div>
  <div id="jobList">
    ${jobRows || '<div class="empty">No jobs yet. Waiting for webhooks...</div>'}
  </div>
</div>

<div class="panel-overlay" id="overlay"></div>
<div class="panel" id="panel">
  <div class="panel-resize" id="panelResize"></div>
  <div class="panel-header">
    <div>
      <div class="panel-title" id="panelTitle"></div>
      <div class="panel-meta" id="panelMeta"></div>
    </div>
    <button class="panel-close" id="panelClose">esc</button>
  </div>
  <div class="terminal" id="terminal"></div>
  <div class="panel-footer" id="panelFooter" style="display:none;">
    <div class="chat-row" id="chatRow">
      <input type="text" id="chatInput" placeholder="Send a message to the agent..." />
      <button id="chatSend">Send</button>
    </div>
    <button class="stop-btn" id="stopBtn">STOP AGENT</button>
  </div>
</div>

<div class="toast-box" id="toasts"></div>

<script>
function esc(s) { var d=document.createElement("div"); d.textContent=s; return d.innerHTML; }
function fmtTok(n) { return n>=1e6?(n/1e6).toFixed(1).replace(/\\.0$/,"")+"M":n>=1e3?(n/1e3).toFixed(1).replace(/\\.0$/,"")+"k":String(n); }
function statusColor(s) {
  var m={"queued":"#f59e0b","working":"#22c55e","waiting_for_reply":"#3b82f6","pr_opened":"#8b5cf6","completed":"#10b981","failed":"#ef4444","closed":"#6b7280","stopped":"#f97316"};
  return m[s]||"#8b949e";
}

var activeES=null, activeJobId=null, activeJobStatus=null;

function renderRow(j) {
  var c=statusColor(j.status);
  var tok=j.tokenUsage?'<span class="dim">'+fmtTok(j.tokenUsage.inputTokens+j.tokenUsage.outputTokens)+' tok</span>':"";
  var pr=j.prUrl?'<a href="'+esc(j.prUrl)+'" target="_blank" class="link">PR</a>':"";
  var age=Math.round((Date.now()-new Date(j.updatedAt).getTime())/60000);
  var ageStr=age<1?"<1m":age<60?age+"m":Math.round(age/60)+"h";
  var live=j.status==="working"?'<span class="blink">●</span> ':"";
  return '<div class="row clickable" data-job-id="'+esc(j.id)+'" data-status="'+j.status+'">'
    +'<span class="col-status" style="color:'+c+'">'+live+j.status+'</span>'
    +'<span class="col-repo">'+esc(j.owner)+'/'+esc(j.repo)+'</span>'
    +'<span class="col-issue">#'+j.issueNumber+'</span>'
    +'<span class="col-title">'+esc(j.issueTitle||"")+'</span>'
    +'<span class="col-age">'+ageStr+'</span>'+tok+pr+'</div>';
}

async function refresh() {
  try {
    var res=await fetch("/jobs");
    var jobs=await res.json();
    var el=document.getElementById("jobList");
    if(jobs.length===0){el.innerHTML='<div class="empty">No jobs yet. Waiting for webhooks...</div>';return;}
    jobs.sort(function(a,b){return new Date(b.updatedAt).getTime()-new Date(a.updatedAt).getTime();});
    el.innerHTML=jobs.map(renderRow).join("");
    document.getElementById("jobCount").textContent=jobs.length+" job(s)";
    if(activeJobId){
      var pj=jobs.find(function(j){return j.id===activeJobId;});
      if(pj){
        if(pj.tokenUsage)document.getElementById("panelMeta").textContent=fmtTok(pj.tokenUsage.inputTokens)+" in / "+fmtTok(pj.tokenUsage.outputTokens)+" out";
        if(pj.status!==activeJobStatus){
          var prev=activeJobStatus;
          activeJobStatus=pj.status;
          updateStopBtn(pj.status);
          // Status changed while panel is open — reconnect
          if(pj.status==="working"&&prev!=="working"){connectStream(activeJobId);}
          if(prev==="working"&&pj.status!=="working"){fetchLogs(activeJobId);}
        }
      }
    }
  } catch(e){console.error("refresh",e);}
}

async function refreshBudget() {
  try {
    var res=await fetch("/budget");
    var b=await res.json();
    var el=document.getElementById("budgetInfo");
    if(b.hourlyLimit===0&&b.dailyLimit===0){el.textContent="budget: unlimited";return;}
    var parts=[];
    if(b.hourlyLimit>0)parts.push("1h: "+fmtTok(b.hourlyUsed)+"/"+fmtTok(b.hourlyLimit));
    if(b.dailyLimit>0)parts.push("24h: "+fmtTok(b.dailyUsed)+"/"+fmtTok(b.dailyLimit));
    if(b.paused)parts.push("PAUSED");
    el.innerHTML=parts.map(function(p){return '<span class="budget-badge'+(p==="PAUSED"?" budget-paused":"")+'">'+p+'</span>';}).join(" ");
  } catch(e){}
}

// Panel
function updateStopBtn(status){
  var footer=document.getElementById("panelFooter");
  var btn=document.getElementById("stopBtn");
  // Show button for stoppable statuses
  var stoppable=["queued","working","waiting_for_reply","stopped"];
  if(stoppable.indexOf(status)===-1){footer.style.display="none";return;}
  footer.style.display="";
  if(status==="stopped"){
    btn.textContent="START AGENT";
    btn.className="stop-btn start";
  } else {
    btn.textContent="STOP AGENT";
    btn.className="stop-btn stop";
  }
  btn.disabled=false;
}

function connectStream(jobId){
  if(activeES){activeES.close();activeES=null;}
  var term=document.getElementById("terminal");
  var enc=encodeURIComponent(jobId);
  term.classList.add("streaming");
  var es=new EventSource("/jobs/"+enc+"/stream");
  activeES=es;
  es.onmessage=function(e){
    try{var line=JSON.parse(e.data);if(line.type==="done"){term.classList.remove("streaming");es.close();activeES=null;return;}appendLine(line);}catch(x){}
  };
  es.onerror=function(){term.classList.remove("streaming");es.close();activeES=null;};
}

function fetchLogs(jobId){
  if(activeES){activeES.close();activeES=null;}
  var term=document.getElementById("terminal");
  var enc=encodeURIComponent(jobId);
  term.classList.remove("streaming");
  fetch("/jobs/"+enc+"/logs").then(function(r){return r.json();}).then(function(lines){
    if(lines.length===0){appendLine({type:"status",content:"No logs available."});return;}
    for(var i=0;i<lines.length;i++)appendLine(lines[i]);
  }).catch(function(){appendLine({type:"error",content:"Failed to load logs."});});
}

function openPanel(jobId,title,status){
  if(activeES){activeES.close();activeES=null;}
  seenIds={};
  activeJobId=jobId;
  activeJobStatus=status;
  document.getElementById("panelTitle").textContent=title;
  document.getElementById("panelMeta").textContent="";
  document.getElementById("terminal").innerHTML="";
  document.getElementById("panel").classList.add("open");
  document.getElementById("overlay").classList.add("open");
  updateStopBtn(status);
  if(status==="working"||status==="queued"){connectStream(jobId);}
  else{fetchLogs(jobId);}
}

var seenIds={};
async function lineId(ts,content){
  var raw=String(ts||"")+(content||"");
  var buf=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(raw));
  var a=new Uint8Array(buf),hex="";
  for(var i=0;i<a.length;i++)hex+=a[i].toString(16).padStart(2,"0");
  return hex.slice(0,6);
}
async function appendLine(line){
  var id=await lineId(line.ts,line.content);
  if(seenIds[id])return;
  seenIds[id]=true;
  var d=document.createElement("div");
  d.className="term-line "+(line.type||"text");
  var ts=line.ts?'<span class="term-time">'+new Date(line.ts).toLocaleTimeString()+'</span> ':"";
  var prefix=line.type==="user"?"You: ":"";
  d.innerHTML='<span class="term-id">'+id+'</span> '+ts+esc(prefix+line.content||"");
  document.getElementById("terminal").appendChild(d);
  d.scrollIntoView({block:"end"});
}

function closePanel(){
  document.getElementById("panel").classList.remove("open");
  document.getElementById("overlay").classList.remove("open");
  if(activeES){activeES.close();activeES=null;}
  activeJobId=null;
  activeJobStatus=null;
}

document.getElementById("panelClose").addEventListener("click",closePanel);
document.getElementById("overlay").addEventListener("click",closePanel);
document.addEventListener("keydown",function(e){if(e.key==="Escape")closePanel();});

// Panel horizontal resize
(function(){
  var handle=document.getElementById("panelResize");
  var panel=document.getElementById("panel");
  var dragging=false;
  handle.addEventListener("mousedown",function(e){
    e.preventDefault();
    dragging=true;
    handle.classList.add("active");
    panel.classList.add("resizing");
  });
  document.addEventListener("mousemove",function(e){
    if(!dragging)return;
    var w=window.innerWidth-e.clientX;
    if(w<320)w=320;
    if(w>window.innerWidth)w=window.innerWidth;
    panel.style.width=w+"px";
  });
  document.addEventListener("mouseup",function(){
    if(!dragging)return;
    dragging=false;
    handle.classList.remove("active");
    panel.classList.remove("resizing");
  });
})();

document.getElementById("jobList").addEventListener("click",function(e){
  if(e.target.closest("a"))return;
  var row=e.target.closest(".row");
  if(!row)return;
  var id=row.dataset.jobId;
  var status=row.dataset.status;
  var title=row.querySelector(".col-repo").textContent+" #"+row.querySelector(".col-issue").textContent+" "+row.querySelector(".col-title").textContent;
  openPanel(id,title.trim(),status);
});

// Setup form handler
document.getElementById("setupBtn").addEventListener("click",async function(){
  var btn=document.getElementById("setupBtn");
  var errEl=document.getElementById("setupError");
  var sucEl=document.getElementById("setupSuccess");
  errEl.style.display="none";
  sucEl.style.display="none";
  btn.disabled=true;
  btn.textContent="Connecting...";
  try{
    var body={
      appId:document.getElementById("appId").value.trim(),
      privateKey:document.getElementById("privateKey").value.trim(),
      webhookSecret:document.getElementById("webhookSecret").value.trim()
    };
    if(!body.appId||!body.privateKey){throw new Error("App ID and Private Key are required");}
    var r=await fetch("/config/app",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    var data=await r.json();
    if(!r.ok)throw new Error(data.error||"Connection failed");
    sucEl.textContent="Connected as "+data.botUsername+" on "+data.installationAccount+" (rate limit: "+data.rateLimit.limit+"/hr)";
    sucEl.style.display="block";
    setTimeout(function(){
      document.getElementById("setupScreen").style.display="none";
      document.getElementById("dashboardScreen").style.display="block";
      refreshAppStatus();
    },1500);
  }catch(e){
    errEl.textContent=e.message;
    errEl.style.display="block";
    btn.disabled=false;
    btn.textContent="Connect";
  }
});

async function refreshAppStatus(){
  try{
    var r=await fetch("/config/app");
    var d=await r.json();
    var el=document.getElementById("appStatus");
    if(d.configured){
      el.innerHTML='<span class="connected-badge">'+esc(d.botUsername)+'</span><span class="disconnect-link" id="disconnectBtn">disconnect</span>';
      var disc=document.getElementById("disconnectBtn");
      if(disc)disc.onclick=async function(){
        if(!confirm("Disconnect GitHub App?"))return;
        await fetch("/config/app",{method:"DELETE"});
        location.reload();
      };
    } else {
      el.innerHTML='<span style="color:#f59e0b">not connected</span>';
    }
  }catch(e){}
}
refreshAppStatus();

// Stop / Start button handler
document.getElementById("stopBtn").addEventListener("click",async function(){
  if(!activeJobId)return;
  var btn=document.getElementById("stopBtn");
  btn.disabled=true;
  var isStopped=activeJobStatus==="stopped";
  var endpoint="/jobs/"+encodeURIComponent(activeJobId)+(isStopped?"/start":"/stop");
  try{
    var r=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"}});
    if(!r.ok){var e=await r.json();throw new Error(e.error||"Request failed");}
    var job=await r.json();
    activeJobStatus=job.status;
    updateStopBtn(job.status);
    showToast(isStopped?"Agent restarted":"Agent stopped");
    refresh();
  }catch(e){
    showToast("Error: "+e.message,true);
    btn.disabled=false;
  }
});

// Chat send handler
async function sendChatMessage(){
  if(!activeJobId)return;
  var input=document.getElementById("chatInput");
  var content=input.value.trim();
  if(!content)return;
  input.value="";
  // Only append locally if no SSE stream — otherwise the stream delivers it back
  if(!activeES)appendLine({ts:Date.now(),type:"user",content:content});
  try{
    var r=await fetch("/jobs/"+encodeURIComponent(activeJobId)+"/message",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({content:content})});
    if(!r.ok){var e=await r.json();throw new Error(e.error||"Send failed");}
    var data=await r.json();
    if(data.status==="queued"&&activeJobStatus!=="queued"){activeJobStatus="queued";updateStopBtn("queued");}
    showToast(data.delivered?"Message delivered to agent":"Message sent — agent will restart");
    refresh();
  }catch(e){showToast("Error: "+e.message,true);}
}
document.getElementById("chatSend").addEventListener("click",sendChatMessage);
document.getElementById("chatInput").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();sendChatMessage();}});

function showToast(msg,isErr){
  var box=document.getElementById("toasts");
  var t=document.createElement("div");
  t.className="toast"+(isErr?" toast-err":"");
  t.textContent=msg;
  box.appendChild(t);
  setTimeout(function(){t.remove();},3500);
}

setInterval(refresh,2000);
setInterval(refreshBudget,10000);
refreshBudget();

// New job modal
(function(){
  var overlay=document.getElementById("newJobOverlay");
  var urlInput=document.getElementById("newJobUrl");
  var instrInput=document.getElementById("newJobInstructions");
  var errEl=document.getElementById("newJobError");
  var submitBtn=document.getElementById("newJobSubmit");

  function openModal(){overlay.classList.add("open");urlInput.value="";instrInput.value="";errEl.style.display="none";submitBtn.disabled=false;submitBtn.textContent="Queue";urlInput.focus();}
  function closeModal(){overlay.classList.remove("open");}

  document.getElementById("addJobBtn").addEventListener("click",openModal);
  document.getElementById("newJobCancel").addEventListener("click",closeModal);
  overlay.addEventListener("click",function(e){if(e.target===overlay)closeModal();});
  document.addEventListener("keydown",function(e){if(e.key==="Escape"&&overlay.classList.contains("open"))closeModal();});

  submitBtn.addEventListener("click",async function(){
    errEl.style.display="none";
    var url=urlInput.value.trim();
    var instructions=instrInput.value.trim();
    if(!url){errEl.textContent="Paste a GitHub URL";errEl.style.display="block";return;}

    // If repo URL without issue number and instructions given, create an issue first
    var isIssueUrl=/github\\.com\\/[^/]+\\/[^/]+\\/issues\\/\\d+/.test(url);
    var repoMatch=url.match(/github\\.com\\/([^/]+)\\/([^/]+)/);
    if(!repoMatch){errEl.textContent="Invalid GitHub URL";errEl.style.display="block";return;}
    if(!isIssueUrl&&!instructions){errEl.textContent="For a repo URL, instructions are required (they become the issue body)";errEl.style.display="block";return;}

    submitBtn.disabled=true;submitBtn.textContent="Creating...";
    try{
      var targetUrl=url;
      // If repo-only URL, create an issue on GitHub first
      if(!isIssueUrl){
        var owner=repoMatch[1],repo=repoMatch[2];
        var title=instructions.split("\\n")[0].slice(0,80);
        var ir=await fetch("/jobs/create-issue",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({owner:owner,repo:repo,title:title,body:instructions})});
        if(!ir.ok){var ie=await ir.json();throw new Error(ie.error||"Failed to create issue");}
        var id=await ir.json();
        targetUrl="https://github.com/"+owner+"/"+repo+"/issues/"+id.issueNumber;
        instructions="";// already in the issue body
      }
      var r=await fetch("/jobs",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:targetUrl,instructions:instructions})});
      var data=await r.json();
      if(!r.ok)throw new Error(data.error||"Failed to create job");
      showToast("Job queued: "+data.jobId);
      closeModal();
      refresh();
    }catch(e){
      errEl.textContent=e.message;errEl.style.display="block";
      submitBtn.disabled=false;submitBtn.textContent="Queue";
    }
  });
})();
</script>
</body>
</html>`;
}
