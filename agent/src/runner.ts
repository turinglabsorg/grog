import { spawn, execSync } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import type { Config, QueuedJob, AgentResult, JobState, OutputLine } from "@grog/shared";
import {
  StateManager,
  fetchIssue,
  fetchIssueComments,
  postComment,
  addReaction,
  createPullRequest,
  pushLine,
  cleanup,
  createLogger,
  TOKENS_PER_CREDIT,
} from "@grog/shared";
import { buildSolvePrompt, buildChatPrompt } from "./prompt.js";

const log = createLogger("runner");

// Track active Claude processes so we can kill them on stop or send messages
interface ProcessHandle {
  kill: () => void;
  write: (msg: string) => void;
  interrupt: () => void;
}
const activeProcesses = new Map<string, ProcessHandle>();
// Track jobs that were deliberately interrupted by a chat message (not a failure)
const interruptedJobs = new Set<string>();

/** Stop a running job by killing its Claude process. Returns true if a process was found. */
export function stopJob(jobId: string): boolean {
  const entry = activeProcesses.get(jobId);
  if (entry) {
    entry.kill();
    activeProcesses.delete(jobId);
    return true;
  }
  return false;
}

/** Send a message to a running agent — interrupts current turn so the message is processed immediately. */
export function sendMessage(jobId: string, message: string): boolean {
  const entry = activeProcesses.get(jobId);
  if (entry) {
    interruptedJobs.add(jobId);
    entry.interrupt();
    entry.write(message);
    return true;
  }
  return false;
}

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
  onEvent?: (event: any) => void,
  onSpawn?: (handle: ProcessHandle) => void
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p",
        "--verbose",
        "--input-format",
        "stream-json",
        "--allowedTools",
        "Bash(git:*),Bash(npm:*),Bash(yarn:*),Bash(node:*),Bash(npx:*),Read,Edit,Write,Glob,Grep",
        "--output-format",
        "stream-json",
      ],
      {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        // Whitelist safe env vars — never expose full process.env (1.6)
        env: {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          USER: process.env.USER ?? "",
          SHELL: process.env.SHELL ?? "",
          TERM: process.env.TERM ?? "",
          LANG: process.env.LANG ?? "",
          TMPDIR: process.env.TMPDIR ?? "",
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "",
        },
      }
    );

    log.info(`Claude process spawned, pid=${proc.pid}`);

    let sessionId = "";
    let stdinCloseTimer: ReturnType<typeof setTimeout> | null = null;

    // Send the initial prompt immediately — stream-json mode waits for stdin before emitting events
    if (proc.stdin && !proc.stdin.destroyed) {
      const initMsg = JSON.stringify({
        type: "user",
        message: { role: "user", content: prompt },
        session_id: "",
        parent_tool_use_id: null,
      });
      proc.stdin.write(initMsg + "\n");
      log.info("Initial prompt sent via stdin");
    }

    // Schedule stdin close after a result — gives time for follow-up messages
    function scheduleStdinClose() {
      if (stdinCloseTimer) clearTimeout(stdinCloseTimer);
      stdinCloseTimer = setTimeout(() => {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.end();
        }
      }, 3000);
    }

    // Expose the process handle so callers can kill it, interrupt it, or send messages
    if (onSpawn) onSpawn({
      kill: () => { proc.kill("SIGTERM"); },
      interrupt: () => { if (!proc.killed) proc.kill("SIGINT"); },
      write: (msg: string) => {
        if (proc.killed || !proc.stdin || proc.stdin.destroyed) return;
        // Cancel pending stdin close — more interaction coming
        if (stdinCloseTimer) { clearTimeout(stdinCloseTimer); stdinCloseTimer = null; }
        const jsonMsg = JSON.stringify({
          type: "user",
          message: { role: "user", content: msg },
          session_id: sessionId,
          parent_tool_use_id: null,
        });
        proc.stdin.write(jsonMsg + "\n");
      },
    });

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
      log.info(`claude stdout: ${line.slice(0, 200)}`);
      try {
        const event = JSON.parse(line);
        if (onEvent) onEvent(event);

        // Capture session ID from init event (needed for follow-up chat messages)
        if (event.type === "system" && event.subtype === "init") {
          sessionId = event.session_id ?? "";
          log.info(`Claude init event received, session_id=${sessionId ? sessionId.slice(0, 8) + "..." : "(empty)"}`);
        }

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
          // Only close stdin if this is a final solve result — chat responses keep the session alive
          const resultText = typeof event.result === "string" ? event.result : text;
          if (/PR_READY|NEEDS_CLARIFICATION/.test(resultText)) {
            scheduleStdinClose();
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
      const chunk = data.toString();
      stderr += chunk;
      log.info(`claude stderr: ${chunk.trimEnd()}`);
    });

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (stdinCloseTimer) clearTimeout(stdinCloseTimer);
      if (timedOut) {
        resolve({ text, timedOut: true, usage: usage.inputTokens > 0 ? usage : undefined });
        return;
      }
      log.info(`Claude process closed with code ${code}`);
      if (code !== 0) {
        log.error(`Claude exited with code ${code}, stderr: ${stderr.slice(-500)}`);
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
  // Try JSON block first
  const jsonMatch = output.match(/```json\s*\n(\{[\s\S]*?\})\s*\n```/);
  if (jsonMatch) {
    try {
      const data = JSON.parse(jsonMatch[1]);
      if (data.result === "PR_READY") {
        return { type: "pr_ready", message: "Agent completed.", summary: data.summary };
      }
      if (data.result === "NEEDS_CLARIFICATION") {
        const questions = Array.isArray(data.questions) ? data.questions.join("\n") : data.questions ?? "";
        return { type: "needs_clarification", message: questions };
      }
    } catch {
      // JSON parse failed, fall through to regex
    }
  }

  // Legacy regex fallbacks
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

  // Read existing job to preserve userId set by webhook
  const existingJob = await state.getJobById(jobId);

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
    userId: existingJob?.userId,
  };
  await state.upsertJob(jobState);

  try {
    // Add eyes reaction to the triggering comment (skip for auto-solve)
    if (job.commentId > 0) {
      await addReaction(
        job.owner,
        job.repo,
        job.commentId,
        "eyes",
        config
      );
    }

    // Clone repo
    logLine({ ts: Date.now(), type: "status", content: "Cloning repository" });
    jlog.info(`Cloning ${job.owner}/${job.repo} into ${jobDir}`);
    fs.mkdirSync(jobDir, { recursive: true });

    if (fs.existsSync(repoPath)) {
      fs.rmSync(repoPath, { recursive: true, force: true });
    }

    // Use env-based auth to avoid leaking token in URLs / shell history (1.5)
    const gitAuthHeader = `Authorization: basic ${Buffer.from(`x-access-token:${config.ghToken}`).toString("base64")}`;
    const gitAuthEnv = {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: gitAuthHeader,
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
    };

    execSync(
      `git clone --depth=50 https://github.com/${job.owner}/${job.repo}.git`,
      { cwd: jobDir, stdio: "pipe", env: gitAuthEnv }
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

    // Check for dashboard chat messages
    const allLogs = await state.getJobLogs(jobId);
    const chatMessages = allLogs.filter((l) => l.type === "user");

    // Build prompt — use chat prompt if operator has sent messages
    const prompt = chatMessages.length > 0
      ? buildChatPrompt(issue, comments, repoPath, config, chatMessages, job.commentId)
      : buildSolvePrompt(issue, comments, repoPath, config, job.commentId);

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
    }, (handle) => {
      activeProcesses.set(jobId, handle);
    });

    // Process finished — remove from active map
    activeProcesses.delete(jobId);

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

      // Cleanup work directory on timeout (1.7)
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}

      return;
    }

    // If the job was stopped externally (via dashboard stop button), don't overwrite status
    const freshJob = await state.getJobById(jobId);
    if (freshJob?.status === "stopped") {
      jlog.info("Job was stopped by user — skipping result processing");
      return;
    }

    // If the job was interrupted by a chat message, requeue so it restarts with chat context
    if (interruptedJobs.has(jobId)) {
      interruptedJobs.delete(jobId);
      jlog.info("Job was interrupted by chat message — requeueing");
      jobState.status = "queued";
      jobState.updatedAt = new Date().toISOString();
      await state.upsertJob(jobState);
      return;
    }

    // Parse result
    const result = parseAgentOutput(output, repoPath, job.defaultBranch);
    jlog.info(`Agent result: ${result.type}`);
    jobState.summary = result.summary;

    if (result.type === "pr_ready") {
      // Push branch using env-based auth (1.5)
      logLine({ ts: Date.now(), type: "status", content: "Pushing branch" });
      jlog.info(`Pushing branch ${branchName}`);
      const pushAuthHeader = `Authorization: basic ${Buffer.from(`x-access-token:${config.ghToken}`).toString("base64")}`;
      execSync(`git push origin ${branchName}`, {
        cwd: repoPath,
        stdio: "pipe",
        env: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
          GIT_CONFIG_VALUE_0: pushAuthHeader,
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
        },
      });

      // Create PR via REST API
      logLine({ ts: Date.now(), type: "status", content: "Creating pull request" });
      const prTitle = `Fix #${job.issueNumber}: ${issue.title}`;
      const prTokens = jobState.tokenUsage;
      const prTokenLine = prTokens
        ? `\n\n> Token usage: **${prTokens.inputTokens.toLocaleString()}** input / **${prTokens.outputTokens.toLocaleString()}** output`
        : "";
      const prBody = result.summary
        ? `Fixes #${job.issueNumber}\n\n${result.summary}${prTokenLine}\n\n---\n_Generated by [Grog](https://github.com/turinglabsorg/grog)_`
        : `Automated fix for #${job.issueNumber}.\n\nGenerated by Grog.${prTokenLine}`;
      const prUrl = await createPullRequest(
        job.owner,
        job.repo,
        prTitle,
        prBody,
        branchName,
        job.defaultBranch,
        config
      );

      // Post comment on issue with PR link + summary + token usage
      const tokens = jobState.tokenUsage;
      const tokenLine = tokens
        ? `\n\n> Token usage: **${tokens.inputTokens.toLocaleString()}** input / **${tokens.outputTokens.toLocaleString()}** output`
        : "";
      const summaryExcerpt = result.summary
        ? `\n\n${result.summary}`
        : "";
      await postComment(
        job.owner,
        job.repo,
        job.issueNumber,
        `Arr! I've opened a PR to fix this: ${prUrl}${summaryExcerpt}${tokenLine}`,
        config
      );

      // Add rocket reaction (skip for auto-solve)
      if (job.commentId > 0) {
        await addReaction(
          job.owner,
          job.repo,
          job.commentId,
          "rocket",
          config
        );
      }

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
    // If job was stopped by user, don't treat the kill as an error
    const stoppedJob = await state.getJobById(jobId);
    if (stoppedJob?.status === "stopped") {
      jlog.info("Job was stopped by user — ignoring process error");
      return;
    }

    // If interrupted by chat message, requeue instead of failing
    if (interruptedJobs.has(jobId)) {
      interruptedJobs.delete(jobId);
      jlog.info("Job was interrupted by chat message — requeueing");
      jobState.status = "queued";
      jobState.updatedAt = new Date().toISOString();
      await state.upsertJob(jobState);
      return;
    }

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

      // Cleanup work directory on non-retryable failure (1.7)
      try { fs.rmSync(jobDir, { recursive: true, force: true }); } catch {}

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
    activeProcesses.delete(jobId);
    interruptedJobs.delete(jobId);
    cleanup(jobId);

    // Post-completion credit deduction (4.2)
    try {
      if (config.billingEnabled && jobState.userId && jobState.tokenUsage) {
        const totalTokens = jobState.tokenUsage.inputTokens + jobState.tokenUsage.outputTokens;
        const creditsUsed = Math.ceil(totalTokens / TOKENS_PER_CREDIT);
        if (creditsUsed > 0) {
          const deducted = await state.deductCredits(jobState.userId, creditsUsed);
          if (deducted) {
            const balance = await state.getCreditBalance(jobState.userId);
            await state.recordCreditTransaction({
              id: `deduct-${jobId}-${Date.now()}`,
              userId: jobState.userId,
              type: "deduction",
              amount: -creditsUsed,
              balanceAfter: balance?.credits ?? 0,
              jobId,
              tokensConsumed: totalTokens,
              description: `Job ${jobId}: ${totalTokens.toLocaleString()} tokens`,
              createdAt: new Date().toISOString(),
            });
            jlog.info(`Deducted ${creditsUsed} credits for ${totalTokens} tokens`);
          }
        }
      }
    } catch (err) {
      jlog.error(`Credit deduction failed: ${(err as Error).message}`);
    }
  }
}
