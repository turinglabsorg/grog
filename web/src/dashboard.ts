export function renderLandingPage(loggedIn: boolean, user?: { login: string; avatarUrl: string }): string {
  const authHtml = loggedIn && user
    ? `<div class="auth-area">
        <img class="avatar" src="${esc(user.avatarUrl)}" alt="${esc(user.login)}">
        <span class="auth-login">${esc(user.login)}</span>
        <a href="/billing" class="nav-link">Billing</a>
        <button class="btn-logout" onclick="fetch('/auth/logout',{method:'POST'}).then(()=>location.reload())">Logout</button>
      </div>`
    : `<a class="btn-login" href="/auth/github">
        <svg viewBox="0 0 16 16"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>
        Login with GitHub
      </a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grog — Autonomous GitHub Agent</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0d1117; color: #c9d1d9; font-family: "SF Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, monospace; min-height: 100vh; display: flex; flex-direction: column; }

  header { padding: 16px 24px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #21262d; }
  .logo { color: #58a6ff; font-size: 22px; font-weight: 700; letter-spacing: 3px; }

  .auth-area { display: flex; align-items: center; gap: 12px; }
  .avatar { width: 28px; height: 28px; border-radius: 50%; border: 2px solid #30363d; }
  .auth-login { font-size: 13px; color: #8b949e; font-weight: 600; }
  .nav-link { color: #58a6ff; font-size: 12px; text-decoration: none; font-weight: 600; }
  .nav-link:hover { text-decoration: underline; }
  .btn-login { display: flex; align-items: center; gap: 8px; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; text-decoration: none; font-family: inherit; }
  .btn-login:hover { background: #30363d; }
  .btn-login svg { width: 18px; height: 18px; fill: currentColor; }
  .btn-logout { background: none; border: none; color: #484f58; cursor: pointer; font-size: 11px; font-family: inherit; }
  .btn-logout:hover { color: #c9d1d9; }

  .hero { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 60px 24px; }
  .hero-title { font-size: 48px; font-weight: 700; color: #58a6ff; letter-spacing: 6px; margin-bottom: 16px; }
  .hero-sub { font-size: 16px; color: #8b949e; max-width: 560px; line-height: 1.7; margin-bottom: 40px; }

  .features { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; max-width: 720px; width: 100%; }
  .feature { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 20px; }
  .feature-title { color: #c9d1d9; font-size: 13px; font-weight: 700; margin-bottom: 6px; }
  .feature-desc { color: #484f58; font-size: 12px; line-height: 1.6; }
  .feature .prompt { color: #22c55e; }

  footer { padding: 16px 24px; text-align: center; color: #30363d; font-size: 11px; border-top: 1px solid #21262d; }
</style>
</head>
<body>
<header>
  <div class="logo">GROG</div>
  ${authHtml}
</header>

<div class="hero">
  <div class="hero-title">GROG</div>
  <div class="hero-sub">
    Autonomous coding agent that solves GitHub issues.
    Mention <span style="color:#58a6ff">@grog</span> in any issue and it clones, fixes, and opens a PR.
  </div>

  <div class="features">
    <div class="feature">
      <div class="feature-title"><span class="prompt">$</span> Mention to trigger</div>
      <div class="feature-desc">Tag @grog in a GitHub issue comment. It picks up the task automatically.</div>
    </div>
    <div class="feature">
      <div class="feature-title"><span class="prompt">$</span> Autonomous solving</div>
      <div class="feature-desc">Clones the repo, reads the issue, writes code, commits, and opens a pull request.</div>
    </div>
    <div class="feature">
      <div class="feature-title"><span class="prompt">$</span> Self-host or SaaS</div>
      <div class="feature-desc">Run your own agent, or use the hosted version with a credits-based billing system.</div>
    </div>
  </div>
</div>

<footer>grog &mdash; powered by claude</footer>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
