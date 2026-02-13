import express from "express";
import {
  loadConfig,
  StateManager,
  createLogger,
} from "@grog/shared";
import { createAuthRouter, getCurrentUser } from "./auth.js";
import { renderLandingPage } from "./dashboard.js";
import { requireAuth, requireAdmin, csrfProtection, rateLimit } from "./middleware.js";
import { createBillingRouter } from "./billing.js";
import { registerStripeWebhook } from "./stripeWebhook.js";

const log = createLogger("web");

async function main() {
  const config = loadConfig();
  const state = await StateManager.connect(config.mongodbUri);

  const app = express();

  // Register Stripe webhook BEFORE global JSON parser (needs raw body)
  registerStripeWebhook(app, config, state);

  // Parse JSON
  app.use(express.json());

  // Global rate limit
  app.use(rateLimit(60_000, 120));

  // CSRF protection
  app.use(csrfProtection());

  // Auth routes (OAuth + repo setup) — strict rate limit on auth endpoints
  const authLimiter = rateLimit(60_000, 10);
  app.use("/auth", authLimiter);
  app.use(createAuthRouter(config, state));

  // Billing routes
  app.use(createBillingRouter(config, state));

  // Billing page (simple HTML with billing UI)
  app.get("/billing", requireAuth(config, state), async (req, res) => {
    const user = (req as any).grogUser as { login: string; avatarUrl: string };
    res.type("html").send(renderBillingPage(user));
  });

  // Admin stats (keep for SaaS admin)
  app.get("/admin/stats", requireAuth(config, state), requireAdmin(config), async (_req, res) => {
    res.json(await state.getStats());
  });

  // Landing page
  app.get("/", async (req, res) => {
    const githubId = getCurrentUser(req, config);
    let user: { login: string; avatarUrl: string } | undefined;
    if (githubId) {
      const u = await state.getUserByGithubId(githubId);
      if (u) user = { login: u.login, avatarUrl: u.avatarUrl };
    }
    res.type("html").send(renderLandingPage(!!user, user));
  });

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.listen(config.port, () => {
    log.info(`Grog web server listening on port ${config.port}`);
  });
}

function renderBillingPage(user: { login: string; avatarUrl: string }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grog — Billing</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #c9d1d9; font-family: "SF Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace; font-size: 13px; line-height: 1.6; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }

  header { padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #21262d; }
  .logo { color: #58a6ff; font-size: 22px; font-weight: 700; letter-spacing: 3px; }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .avatar { width: 28px; height: 28px; border-radius: 50%; border: 2px solid #30363d; }
  .auth-login { font-size: 13px; color: #8b949e; font-weight: 600; }

  .container { max-width: 720px; margin: 0 auto; padding: 32px 24px; }
  h2 { font-size: 18px; margin-bottom: 20px; }

  .balance-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 24px; margin-bottom: 24px; }
  .balance-amount { font-size: 36px; font-weight: 700; color: #58a6ff; font-family: monospace; }
  .balance-label { font-size: 11px; color: #8b949e; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; }
  .balance-sub { font-size: 12px; color: #484f58; margin-top: 4px; }

  h3 { font-size: 14px; font-weight: 700; margin-bottom: 12px; color: #8b949e; }

  .packs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .pack-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 20px; text-align: center; cursor: pointer; transition: all .15s; }
  .pack-card:hover { border-color: #58a6ff; }
  .pack-credits { font-size: 28px; font-weight: 700; color: #c9d1d9; }
  .pack-price { font-size: 16px; color: #8b949e; font-weight: 600; margin-top: 4px; }
  .pack-per { font-size: 11px; color: #484f58; margin-top: 2px; }

  .tx-table { width: 100%; border-collapse: collapse; background: #161b22; border-radius: 8px; overflow: hidden; border: 1px solid #21262d; }
  .tx-table th { background: #0d1117; font-size: 11px; text-transform: uppercase; letter-spacing: .5px; font-weight: 600; color: #484f58; padding: 10px 12px; text-align: left; }
  .tx-table td { padding: 10px 12px; font-size: 12px; border-top: 1px solid #21262d; }
  .tx-positive { color: #22c55e; font-weight: 600; }
  .tx-negative { color: #ef4444; font-weight: 600; }

  .toast-box { position: fixed; bottom: 16px; right: 16px; z-index: 200; }
  .toast { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 8px 14px; border-radius: 4px; font-size: 12px; }
  .toast-ok { border-color: #22c55e; color: #22c55e; }
</style>
</head>
<body>
<header>
  <a href="/" class="logo">GROG</a>
  <div class="header-right">
    <img class="avatar" src="${esc(user.avatarUrl)}" alt="${esc(user.login)}">
    <span class="auth-login">${esc(user.login)}</span>
  </div>
</header>

<div class="container">
  <h2>Billing</h2>
  <div class="balance-card" id="balanceCard">Loading...</div>

  <h3>Buy Credits</h3>
  <div class="packs-grid" id="packsGrid"></div>

  <h3>Transaction History</h3>
  <div id="txHistory"></div>
</div>

<div class="toast-box" id="toasts"></div>

<script>
function esc(s){var d=document.createElement("div");d.textContent=s;return d.innerHTML;}
function showToast(msg,ok){var t=document.getElementById("toasts");var d=document.createElement("div");d.className="toast"+(ok?" toast-ok":"");d.textContent=msg;t.appendChild(d);setTimeout(function(){d.remove();},3500);}

async function loadBalance(){
  try{
    var res=await fetch("/billing/balance");
    var b=await res.json();
    var el=document.getElementById("balanceCard");
    if(b.billingEnabled===false){
      el.innerHTML='<div class="balance-label">Credits</div><div class="balance-amount">Unlimited</div><div class="balance-sub">Self-hosted mode</div>';
    }else{
      el.innerHTML='<div class="balance-label">Credit Balance</div><div class="balance-amount">'+b.credits+'</div>'
        +'<div class="balance-sub">~'+(b.credits*10000).toLocaleString()+' tokens | Purchased: '+b.lifetimePurchased+' | Used: '+b.lifetimeUsed+'</div>';
    }
  }catch(e){document.getElementById("balanceCard").textContent="Failed to load";}
}

async function loadPacks(){
  try{
    var res=await fetch("/billing/packs");
    var packs=await res.json();
    var el=document.getElementById("packsGrid");
    if(packs.length===0){el.innerHTML="";return;}
    el.innerHTML=packs.map(function(p){
      var per=(p.priceUsd/p.credits*100).toFixed(1);
      return '<div class="pack-card" onclick="buyPack(\\''+p.id+'\\')"><div class="pack-credits">'+p.credits+'</div><div class="pack-price">$'+p.priceUsd+'</div><div class="pack-per">'+per+'c per credit</div></div>';
    }).join("");
  }catch(e){}
}

async function loadTx(){
  try{
    var res=await fetch("/billing/transactions?limit=50");
    var txs=await res.json();
    var el=document.getElementById("txHistory");
    if(txs.length===0){el.innerHTML='<p style="color:#484f58">No transactions yet.</p>';return;}
    var html='<table class="tx-table"><thead><tr><th>Date</th><th>Type</th><th>Amount</th><th>Balance</th><th>Description</th></tr></thead><tbody>';
    for(var i=0;i<txs.length;i++){
      var tx=txs[i];
      var cls=tx.amount>=0?"tx-positive":"tx-negative";
      var sign=tx.amount>=0?"+":"";
      html+='<tr><td>'+new Date(tx.createdAt).toLocaleString()+'</td><td>'+tx.type+'</td><td class="'+cls+'">'+sign+tx.amount+'</td><td>'+tx.balanceAfter+'</td><td>'+esc(tx.description)+'</td></tr>';
    }
    html+='</tbody></table>';
    el.innerHTML=html;
  }catch(e){}
}

async function buyPack(packId){
  try{
    var res=await fetch("/billing/checkout",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({packId:packId})});
    if(!res.ok){showToast("Checkout failed");return;}
    var data=await res.json();
    if(data.checkoutUrl)window.location.href=data.checkoutUrl;
  }catch(e){showToast("Network error");}
}

if(new URLSearchParams(window.location.search).get("billing")==="success"){
  showToast("Payment successful! Credits added.",true);
  history.replaceState({},"","/billing");
}

loadBalance();
loadPacks();
loadTx();
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

main().catch((err) => {
  log.error(`Failed to start Grog web: ${err}`);
  process.exit(1);
});
