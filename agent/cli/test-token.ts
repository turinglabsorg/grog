#!/usr/bin/env npx tsx

// Quick CLI to test your GitHub token setup
// Usage: npx tsx cli/test-token.ts

import "dotenv/config";

const token = process.env.GH_TOKEN;
if (!token) {
  console.error("GH_TOKEN not set in .env");
  process.exit(1);
}

const headers: Record<string, string> = {
  Authorization: `token ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

async function main() {
  console.log(`Token: ${token!.slice(0, 8)}...${token!.slice(-4)}`);
  console.log(`Prefix: ${token!.slice(0, 4)} (ghp_=classic, github_pat_=fine-grained)\n`);

  // 1. Check authentication
  console.log("-- Auth --");
  const userRes = await fetch("https://api.github.com/user", { headers });
  if (userRes.ok) {
    const user = (await userRes.json()) as { login: string; id: number };
    console.log(`  Authenticated as: ${user.login} (ID: ${user.id})`);
  } else {
    const body = await userRes.text();
    console.error(`  Auth FAILED: ${userRes.status} - ${body.slice(0, 200)}`);
    process.exit(1);
  }

  // 2. Check scopes
  const scopes = userRes.headers.get("x-oauth-scopes") || "(none)";
  console.log(`  Scopes: ${scopes}`);
  if (!scopes.includes("repo")) {
    console.warn("  WARNING: Missing 'repo' scope - the agent needs full repo access");
  }

  // 3. Rate limits
  console.log("\n-- Rate Limits --");
  const rateRes = await fetch("https://api.github.com/rate_limit", { headers });
  const rate = (await rateRes.json()) as { resources: { core: { remaining: number; limit: number; reset: number; used: number } } };
  const core = rate.resources.core;
  const resetDate = new Date(core.reset * 1000);
  console.log(`  Core: ${core.remaining}/${core.limit} remaining (used ${core.used}, resets ${resetDate.toLocaleTimeString()})`);
  if (core.limit <= 60) {
    console.error("  FAIL: Rate limit is 60/hr - token is treated as UNAUTHENTICATED");
    console.error("  This usually means the token was revoked or is invalid");
  } else {
    console.log(`  OK: Rate limit is ${core.limit}/hr - token is properly authenticated`);
  }

  // 4. Test repo invitations endpoint
  console.log("\n-- Invitations --");
  const invRes = await fetch("https://api.github.com/user/repository_invitations", { headers });
  if (invRes.ok) {
    const invitations = (await invRes.json()) as unknown[];
    console.log(`  OK: Invitations endpoint works (${invitations.length} pending)`);
  } else {
    console.warn(`  WARN: Invitations endpoint returned ${invRes.status} (needs classic PAT with repo scope)`);
  }

  // 5. Test repo access
  console.log("\n-- Repo Access --");
  const reposRes = await fetch("https://api.github.com/user/repos?per_page=3&sort=updated", { headers });
  if (reposRes.ok) {
    const repos = (await reposRes.json()) as { full_name: string; private: boolean }[];
    console.log(`  OK: Can list repos (${repos.length} most recent):`);
    for (const r of repos) {
      console.log(`    - ${r.full_name} (${r.private ? "private" : "public"})`);
    }
  } else {
    console.error(`  FAIL: Cannot list repos: ${reposRes.status}`);
  }

  console.log("\n-- Done --");
}

main().catch((err) => {
  console.error(`Fatal: ${(err as Error).message}`);
  process.exit(1);
});
