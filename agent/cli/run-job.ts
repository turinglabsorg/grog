#!/usr/bin/env npx tsx
/**
 * Run a Grog worker on a GitHub issue directly, bypassing the webhook.
 *
 * Usage:
 *   npx tsx cli/run-job.ts <owner> <repo> <issue-number> [default-branch]
 *
 * Examples:
 *   npx tsx cli/run-job.ts turinglabsorg eth-shamir 1
 *   npx tsx cli/run-job.ts turinglabsorg eth-shamir 1 master
 */

import { loadConfig } from "../src/config.js";
import { StateManager } from "../src/state.js";
import { runAgent } from "../src/runner.js";
import { fetchIssue } from "../src/github.js";
import type { QueuedJob } from "../src/types.js";

async function main() {
  const [owner, repo, issueStr, branchArg] = process.argv.slice(2);

  if (!owner || !repo || !issueStr) {
    console.error("Usage: npx tsx cli/run-job.ts <owner> <repo> <issue-number> [default-branch]");
    console.error("Example: npx tsx cli/run-job.ts turinglabsorg eth-shamir 1");
    process.exit(1);
  }

  const issueNumber = parseInt(issueStr, 10);
  if (isNaN(issueNumber)) {
    console.error(`Invalid issue number: ${issueStr}`);
    process.exit(1);
  }

  const config = loadConfig();
  const state = await StateManager.connect(config.mongodbUri);

  // Auto-detect default branch if not provided
  let defaultBranch = branchArg;
  if (!defaultBranch) {
    console.log(`[cli] Detecting default branch for ${owner}/${repo}...`);
    try {
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
        headers: {
          Authorization: `token ${config.ghToken}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (res.ok) {
        const data = (await res.json()) as { default_branch: string };
        defaultBranch = data.default_branch;
      } else {
        console.error(`[cli] Failed to fetch repo info (${res.status}), defaulting to "main"`);
        defaultBranch = "main";
      }
    } catch {
      defaultBranch = "main";
    }
  }

  console.log(`[cli] Running agent on ${owner}/${repo}#${issueNumber}`);
  console.log(`[cli] Default branch: ${defaultBranch}`);

  // Fetch issue and check state
  try {
    const issue = await fetchIssue(owner, repo, issueNumber, config);
    console.log(`[cli] Issue: ${issue.title}`);
    console.log(`[cli] State: ${issue.state}`);
    if (issue.state === "closed") {
      console.log("[cli] Issue is closed — skipping.");
      process.exit(0);
    }
  } catch (err) {
    console.error(`[cli] Warning: could not fetch issue: ${(err as Error).message}`);
  }

  const job: QueuedJob = {
    owner,
    repo,
    issueNumber,
    commentId: 0,
    commentBody: "manual run via cli",
    defaultBranch,
  };

  console.log("[cli] Starting agent...\n");

  try {
    await runAgent(job, config, state);
    console.log("\n[cli] Agent finished.");
  } catch (err) {
    console.error("\n[cli] Agent failed:", (err as Error).message);
    process.exit(1);
  }

  // Show final job state
  const finalJob = await state.getJobById(`${owner}/${repo}#${issueNumber}`);
  if (finalJob) {
    console.log(`[cli] Final status: ${finalJob.status}`);
    if (finalJob.prUrl) console.log(`[cli] PR: ${finalJob.prUrl}`);
    if (finalJob.tokenUsage) {
      console.log(`[cli] Tokens: input=${finalJob.tokenUsage.inputTokens}, output=${finalJob.tokenUsage.outputTokens}`);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("[cli] Fatal:", err);
  process.exit(1);
});
