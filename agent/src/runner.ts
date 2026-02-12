import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { Config, QueuedJob, AgentResult, JobState } from "./types.js";
import {
  fetchIssue,
  fetchIssueComments,
  postComment,
  addReaction,
  createPullRequest,
} from "./github.js";
import { StateManager } from "./state.js";
import { buildSolvePrompt } from "./prompt.js";
import { pushLine, cleanup } from "./outputStore.js";
import type { OutputLine } from "./outputStore.js";

function makeJobId(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

interface SpawnResult {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
}

function spawnClaude(
  prompt: string,
  cwd: string,
  onEvent?: (event: any) => void
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--verbose",
        "--allowedTools",
        "Bash(git:*),Bash(npm:*),Bash(yarn:*),Bash(node:*),Bash(npx:*),Read,Edit,Write,Glob,Grep",
        "--output-format",
        "stream-json",
      ],
      {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env },
      }
    );

    let text = "";
    let usage = { inputTokens: 0, outputTokens: 0 };
    let stderr = "";

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (onEvent) onEvent(event);

        // Accumulate assistant text
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text") {
              text += block.text;
            }
          }
        }

        // Content block delta — streaming text chunks
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          text += event.delta.text;
        }

        // Result message with final text
        if (event.type === "result" && event.result) {
          // If result contains full text, prefer that
          if (typeof event.result === "string") {
            text = event.result;
          }
        }

        // Track usage from any event that carries it
        if (event.usage) {
          usage.inputTokens += event.usage.input_tokens ?? 0;
          usage.outputTokens += event.usage.output_tokens ?? 0;
        }
        if (event.message?.usage) {
          usage.inputTokens += event.message.usage.input_tokens ?? 0;
          usage.outputTokens += event.message.usage.output_tokens ?? 0;
        }
      } catch {
        // Non-JSON line, ignore
      }
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      if (code !== 0) {
        console.error(`[runner] Claude exited with code ${code}`);
        console.error(`[runner] stderr: ${stderr.slice(-500)}`);
      }
      resolve({ text, usage: usage.inputTokens > 0 ? usage : undefined });
    });

    proc.on("error", (err) => {
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

function eventToOutputLine(event: any): OutputLine | null {
  // Assistant text content
  if (event.type === "assistant" && event.message?.content) {
    for (const block of event.message.content) {
      if (block.type === "text" && block.text?.trim()) {
        return { ts: Date.now(), type: "text", content: block.text.trim() };
      }
      if (block.type === "tool_use") {
        return toolUseToLine(block);
      }
    }
  }

  // Content block start — tool_use
  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    return toolUseToLine(event.content_block);
  }

  // Streaming text delta
  if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
    const t = event.delta.text?.trim();
    if (t) return { ts: Date.now(), type: "text", content: t };
  }

  return null;
}

function toolUseToLine(block: any): OutputLine {
  const name: string = block.name ?? "Unknown";
  const input = block.input ?? {};

  let content: string;
  switch (name) {
    case "Read":
      content = `Read ${input.file_path ?? ""}`;
      break;
    case "Edit":
      content = `Edit ${input.file_path ?? ""}`;
      break;
    case "Write":
      content = `Write ${input.file_path ?? ""}`;
      break;
    case "Bash":
      content = `Bash: ${(input.command ?? "").slice(0, 120)}`;
      break;
    case "Glob":
      content = `Glob: ${input.pattern ?? ""}`;
      break;
    case "Grep":
      content = `Grep: ${input.pattern ?? ""} in ${input.glob ?? input.path ?? ""}`;
      break;
    default:
      content = `${name}`;
      break;
  }
  return { ts: Date.now(), type: "tool", content };
}

function parseAgentOutput(output: string, repoPath: string, defaultBranch: string): AgentResult {
  // Check for NEEDS_CLARIFICATION marker
  const clarifyMatch = output.match(
    /RESULT:\s*NEEDS_CLARIFICATION\s*\n([\s\S]*?)(?:```|$)/
  );
  if (clarifyMatch) {
    return {
      type: "needs_clarification",
      message: clarifyMatch[1].trim(),
    };
  }

  // Check for PR_READY marker
  if (/RESULT:\s*PR_READY/.test(output)) {
    return { type: "pr_ready", message: "Agent marked as ready for PR." };
  }

  // Fallback: check if there are actual commits on the branch
  // Try the actual default branch first, then origin/<branch>, then common names
  const candidates = [
    defaultBranch,
    `origin/${defaultBranch}`,
    "main",
    "origin/main",
    "master",
    "origin/master",
  ].filter(Boolean);
  for (const base of candidates) {
    try {
      const log = execSync(`git log --oneline ${base}..HEAD`, {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();

      if (log.length > 0) {
        return {
          type: "pr_ready",
          message: `Agent made commits (detected via git log):\n${log}`,
        };
      }
      // If git log succeeded but was empty, the agent made no commits
      break;
    } catch {
      // This base ref doesn't exist, try the next one
      continue;
    }
  }

  return {
    type: "failed",
    message: "Agent did not produce commits or a clear result marker.",
  };
}

export async function runAgent(
  job: QueuedJob,
  config: Config,
  state: StateManager
): Promise<void> {
  const jobId = makeJobId(job.owner, job.repo, job.issueNumber);
  const branchName = `grog/issue-${job.issueNumber}`;
  const jobDir = path.join(
    config.workDir,
    `${job.owner}-${job.repo}-${job.issueNumber}`
  );
  const repoPath = path.join(jobDir, job.repo);

  // Helper: push to in-memory store + persist to MongoDB
  function log(line: OutputLine) {
    pushLine(jobId, line);
    state.appendJobLog(jobId, line).catch((err) =>
      console.error(`[runner] Failed to persist log for ${jobId}:`, err)
    );
  }

  // Upsert job state as working
  const jobState: JobState = {
    id: jobId,
    owner: job.owner,
    repo: job.repo,
    issueNumber: job.issueNumber,
    status: "working",
    branch: branchName,
    triggerCommentId: job.commentId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await state.upsertJob(jobState);

  try {
    // Add eyes reaction to the triggering comment
    await addReaction(
      job.owner,
      job.repo,
      job.commentId,
      "eyes",
      config
    );

    // Clone repo
    log({ ts: Date.now(), type: "status", content: "Cloning repository" });
    console.log(`[runner] Cloning ${job.owner}/${job.repo} into ${jobDir}`);
    fs.mkdirSync(jobDir, { recursive: true });

    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }

    execSync(
      `git clone --depth=50 https://x-access-token:${config.ghToken}@github.com/${job.owner}/${job.repo}.git`,
      { cwd: jobDir, stdio: "pipe" }
    );

    // Create branch
    execSync(`git checkout -b ${branchName}`, {
      cwd: repoPath,
      stdio: "pipe",
    });

    // Fetch issue + comments
    log({ ts: Date.now(), type: "status", content: "Fetching issue & comments" });
    console.log(`[runner] Fetching issue #${job.issueNumber} and comments`);
    const [issue, comments] = await Promise.all([
      fetchIssue(job.owner, job.repo, job.issueNumber, config),
      fetchIssueComments(job.owner, job.repo, job.issueNumber, config),
    ]);

    jobState.issueTitle = issue.title;

    // Build prompt
    const prompt = buildSolvePrompt(issue, comments, repoPath, config);

    // Spawn Claude with event streaming
    log({ ts: Date.now(), type: "status", content: "Running Claude agent" });
    console.log(`[runner] Spawning Claude agent for ${jobId}`);

    let lastUsagePersist = 0;
    const { text: output, usage } = await spawnClaude(prompt, repoPath, (event) => {
      const line = eventToOutputLine(event);
      if (line) log(line);

      // Real-time token usage tracking
      let usageChanged = false;
      if (event.usage) {
        jobState.tokenUsage = jobState.tokenUsage ?? { inputTokens: 0, outputTokens: 0 };
        jobState.tokenUsage.inputTokens += event.usage.input_tokens ?? 0;
        jobState.tokenUsage.outputTokens += event.usage.output_tokens ?? 0;
        usageChanged = true;
      }
      if (event.message?.usage) {
        jobState.tokenUsage = jobState.tokenUsage ?? { inputTokens: 0, outputTokens: 0 };
        jobState.tokenUsage.inputTokens += event.message.usage.input_tokens ?? 0;
        jobState.tokenUsage.outputTokens += event.message.usage.output_tokens ?? 0;
        usageChanged = true;
      }
      // Throttled persist — save at most every 3 seconds
      if (usageChanged) {
        const now = Date.now();
        if (now - lastUsagePersist > 3000) {
          lastUsagePersist = now;
          jobState.updatedAt = new Date().toISOString();
          state.upsertJob(jobState).catch(() => {});
        }
      }
    });

    console.log(`[runner] Claude agent finished for ${jobId}`);

    // Save token usage
    if (usage) {
      jobState.tokenUsage = usage;
      console.log(`[runner] Token usage for ${jobId}: input=${usage.inputTokens}, output=${usage.outputTokens}`);
    }

    // Parse result
    const result = parseAgentOutput(output, repoPath, job.defaultBranch);
    console.log(`[runner] Agent result: ${result.type}`);

    if (result.type === "pr_ready") {
      // Push branch
      log({ ts: Date.now(), type: "status", content: "Pushing branch" });
      console.log(`[runner] Pushing branch ${branchName}`);
      execSync(`git push origin ${branchName}`, {
        cwd: repoPath,
        stdio: "pipe",
      });

      // Create PR via REST API
      log({ ts: Date.now(), type: "status", content: "Creating pull request" });
      const prTitle = `Fix #${job.issueNumber}: ${issue.title}`;
      const prBody = `Automated fix for #${job.issueNumber}.\n\nGenerated by Grog.`;
      const prUrl = await createPullRequest(
        job.owner,
        job.repo,
        prTitle,
        prBody,
        branchName,
        job.defaultBranch,
        config
      );

      // Post comment on issue with PR link + token usage
      const tokens = jobState.tokenUsage;
      const tokenLine = tokens
        ? `\n\n> Token usage: **${tokens.inputTokens.toLocaleString()}** input / **${tokens.outputTokens.toLocaleString()}** output`
        : "";
      await postComment(
        job.owner,
        job.repo,
        job.issueNumber,
        `Arr! I've opened a PR to fix this: ${prUrl}${tokenLine}`,
        config
      );

      // Add rocket reaction
      await addReaction(
        job.owner,
        job.repo,
        job.commentId,
        "rocket",
        config
      );

      // Update state
      jobState.status = "pr_opened";
      jobState.prUrl = prUrl;
      jobState.updatedAt = new Date().toISOString();
      await state.upsertJob(jobState);

      // Cleanup working directory on success
      fs.rmSync(jobDir, { recursive: true, force: true });
    } else if (result.type === "needs_clarification") {
      // Post clarification questions as a comment
      await postComment(
        job.owner,
        job.repo,
        job.issueNumber,
        `I need some clarification before I can solve this:\n\n${result.message}\n\nReply here and mention @${config.botUsername} when you're ready for me to try again.`,
        config
      );

      jobState.status = "waiting_for_reply";
      jobState.updatedAt = new Date().toISOString();
      await state.upsertJob(jobState);

      // Keep working directory for retry
    } else {
      // Failed
      await postComment(
        job.owner,
        job.repo,
        job.issueNumber,
        `I wasn't able to solve this automatically. Here's what happened:\n\n${result.message}\n\nYou may need to tackle this one manually.`,
        config
      );

      jobState.status = "failed";
      jobState.updatedAt = new Date().toISOString();
      await state.upsertJob(jobState);
    }
  } catch (err) {
    console.error(`[runner] Error running agent for ${jobId}:`, err);

    jobState.status = "failed";
    jobState.updatedAt = new Date().toISOString();
    await state.upsertJob(jobState);

    try {
      await postComment(
        job.owner,
        job.repo,
        job.issueNumber,
        `Something went wrong while I was working on this. The error has been logged.`,
        config
      );
    } catch {
      console.error(`[runner] Failed to post error comment for ${jobId}`);
    }
  } finally {
    // Clean up output store when job reaches terminal state
    cleanup(jobId);
  }
}
