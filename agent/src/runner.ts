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
import { createLogger } from "./logger.js";

const log = createLogger("runner");

function makeJobId(owner: string, repo: string, issueNumber: number): string {
  return `${owner}/${repo}#${issueNumber}`;
}

function isRetryableError(msg: string): boolean {
  const retryablePatterns = [
    /clone.*failed/i,
    /git.*error/i,
    /ECONNRESET/i,
    /ECONNREFUSED/i,
    /ETIMEDOUT/i,
    /ENOTFOUND/i,
    /rate limit/i,
    /503/,
    /502/,
    /500/,
    /Failed to spawn claude/i,
  ];
  return retryablePatterns.some((p) => p.test(msg));
}

interface SpawnResult {
  text: string;
  timedOut?: boolean;
  usage?: { inputTokens: number; outputTokens: number };
}

function spawnClaude(
  prompt: string,
  cwd: string,
  timeoutMs: number,
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
    let timedOut = false;

    // Timeout handler
    const timer = setTimeout(() => {
      timedOut = true;
      log.warn(`Agent timed out after ${Math.round(timeoutMs / 60000)} minutes — killing process`);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 10000);
    }, timeoutMs);

    const rl = createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line);
        if (onEvent) onEvent(event);

        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text") {
              text += block.text;
            }
          }
        }

        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          text += event.delta.text;
        }

        if (event.type === "result" && event.result) {
          if (typeof event.result === "string") {
            text = event.result;
          }
        }

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
      clearTimeout(timer);
      if (timedOut) {
        resolve({ text, timedOut: true, usage: usage.inputTokens > 0 ? usage : undefined });
        return;
      }
      if (code !== 0) {
        log.error(`Claude exited with code ${code}`);
        log.debug(`stderr: ${stderr.slice(-500)}`);
      }
      resolve({ text, usage: usage.inputTokens > 0 ? usage : undefined });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });
  });
}

function eventToOutputLine(event: any): OutputLine | null {
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

  if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
    return toolUseToLine(event.content_block);
  }

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
  const clarifyMatch = output.match(
    /RESULT:\s*NEEDS_CLARIFICATION\s*\n([\s\S]*?)(?:```|$)/
  );
  if (clarifyMatch) {
    return {
      type: "needs_clarification",
      message: clarifyMatch[1].trim(),
    };
  }

  if (/RESULT:\s*PR_READY/.test(output)) {
    return { type: "pr_ready", message: "Agent marked as ready for PR." };
  }

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
      const gitLog = execSync(`git log --oneline ${base}..HEAD`, {
        cwd: repoPath,
        encoding: "utf-8",
      }).trim();

      if (gitLog.length > 0) {
        return {
          type: "pr_ready",
          message: `Agent made commits (detected via git log):\n${gitLog}`,
        };
      }
      break;
    } catch {
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
  const jlog = log.child(jobId);
  const branchName = `grog/issue-${job.issueNumber}`;
  const jobDir = path.join(
    config.workDir,
    `${job.owner}-${job.repo}-${job.issueNumber}`
  );
  const repoPath = path.join(jobDir, job.repo);

  // Helper: push to in-memory store + persist to MongoDB
  function logLine(line: OutputLine) {
    pushLine(jobId, line);
    state.appendJobLog(jobId, line).catch((err) =>
      jlog.error(`Failed to persist log: ${err}`)
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
    logLine({ ts: Date.now(), type: "status", content: "Cloning repository" });
    jlog.info(`Cloning ${job.owner}/${job.repo} into ${jobDir}`);
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
    logLine({ ts: Date.now(), type: "status", content: "Fetching issue & comments" });
    jlog.info(`Fetching issue #${job.issueNumber} and comments`);
    const [issue, comments] = await Promise.all([
      fetchIssue(job.owner, job.repo, job.issueNumber, config),
      fetchIssueComments(job.owner, job.repo, job.issueNumber, config),
    ]);

    jobState.issueTitle = issue.title;

    // Build prompt
    const prompt = buildSolvePrompt(issue, comments, repoPath, config);

    // Spawn Claude with event streaming
    logLine({ ts: Date.now(), type: "status", content: "Running Claude agent" });
    jlog.info("Spawning Claude agent");

    const timeoutMs = config.agentTimeoutMinutes * 60 * 1000;
    let lastUsagePersist = 0;
    const { text: output, timedOut, usage } = await spawnClaude(prompt, repoPath, timeoutMs, (event) => {
      const line = eventToOutputLine(event);
      if (line) logLine(line);

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
      if (usageChanged) {
        const now = Date.now();
        if (now - lastUsagePersist > 3000) {
          lastUsagePersist = now;
          jobState.updatedAt = new Date().toISOString();
          state.upsertJob(jobState).catch(() => {});
        }
      }
    });

    jlog.info("Claude agent finished");

    // Save token usage
    if (usage) {
      jobState.tokenUsage = usage;
      jlog.info(`Token usage: input=${usage.inputTokens}, output=${usage.outputTokens}`, {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      });
    }

    // Handle timeout
    if (timedOut) {
      logLine({ ts: Date.now(), type: "error", content: `Agent timed out after ${config.agentTimeoutMinutes} minutes` });
      jlog.error(`Agent timed out after ${config.agentTimeoutMinutes} minutes`);

      jobState.status = "failed";
      jobState.failureReason = "timeout";
      jobState.updatedAt = new Date().toISOString();
      await state.upsertJob(jobState);

      try {
        await postComment(
          job.owner,
          job.repo,
          job.issueNumber,
          `I ran out of time working on this (${config.agentTimeoutMinutes} minute limit). The task may be too complex for a single run.`,
          config
        );
      } catch {
        jlog.error("Failed to post timeout comment");
      }

      return;
    }

    // Parse result
    const result = parseAgentOutput(output, repoPath, job.defaultBranch);
    jlog.info(`Agent result: ${result.type}`);

    if (result.type === "pr_ready") {
      // Push branch
      logLine({ ts: Date.now(), type: "status", content: "Pushing branch" });
      jlog.info(`Pushing branch ${branchName}`);
      execSync(`git push origin ${branchName}`, {
        cwd: repoPath,
        stdio: "pipe",
      });

      // Create PR via REST API
      logLine({ ts: Date.now(), type: "status", content: "Creating pull request" });
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
    } else {
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
    const errorMsg = (err as Error).message ?? String(err);
    jlog.error(`Error: ${errorMsg}`);
    logLine({ ts: Date.now(), type: "error", content: errorMsg.slice(0, 300) });

    // Determine if this is a retryable failure
    const retryable = isRetryableError(errorMsg);
    const retryCount = jobState.retryCount ?? 0;
    const canRetry = retryable && retryCount < config.maxRetries;

    if (canRetry) {
      jobState.status = "queued";
      jobState.retryCount = retryCount + 1;
      jobState.failureReason = errorMsg.slice(0, 200);
      jobState.updatedAt = new Date().toISOString();
      await state.upsertJob(jobState);

      jlog.info(`Retryable failure — will retry (attempt ${jobState.retryCount}/${config.maxRetries})`);
      logLine({ ts: Date.now(), type: "status", content: `Retrying (attempt ${jobState.retryCount}/${config.maxRetries})...` });
    } else {
      jobState.status = "failed";
      jobState.failureReason = errorMsg.slice(0, 200);
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
        jlog.error("Failed to post error comment");
      }
    }
  } finally {
    cleanup(jobId);
  }
}
