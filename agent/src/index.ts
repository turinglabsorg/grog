import express from "express";
import {
  loadConfig,
  StateManager,
  TokenBudget,
  createLogger,
  acceptRepoInvitations,
  fetchIssue,
  closeIssue,
  createIssue,
  getBuffer,
  subscribe,
  pushLine,
  postComment,
  getInstallationToken,
  clearTokenCache,
  getAppInfo,
  listInstallations,
  checkRateLimit,
} from "@grog/shared";
import type { Config, JobState, JobStatus, QueuedJob, RepoConfig, AppConfig } from "@grog/shared";
import { runAgent, stopJob, sendMessage } from "./runner.js";
import { createWebhookHandler } from "./webhook.js";
import { renderDashboard } from "./dashboard.js";

const log = createLogger("agent");

async function syncJobsWithGitHub(state: StateManager, config: Config) {
  const activeJobs = await state.listActiveJobs();
  if (activeJobs.length === 0) {
    log.info("No active jobs to reconcile");
    return;
  }

  log.info(`Reconciling ${activeJobs.length} active job(s) with GitHub...`);

  for (const job of activeJobs) {
    try {
      const issue = await fetchIssue(job.owner, job.repo, job.issueNumber, config);

      if (issue.state === "closed") {
        log.info(`${job.owner}/${job.repo}#${job.issueNumber} is closed on GitHub — marking as closed`);
        job.status = "closed";
        job.updatedAt = new Date().toISOString();
        await state.upsertJob(job);
      } else if (job.status === "working") {
        const ageMs = Date.now() - new Date(job.updatedAt).getTime();
        if (ageMs < 5 * 60 * 1000) {
          log.info(`${job.owner}/${job.repo}#${job.issueNumber} is working (updated ${Math.round(ageMs / 1000)}s ago) — skipping`);
        } else {
          log.info(`${job.owner}/${job.repo}#${job.issueNumber} was working but agent died — requeueing`);
          job.status = "queued";
          job.updatedAt = new Date().toISOString();
          await state.upsertJob(job);
        }
      }
    } catch (err) {
      log.error(`Failed to check ${job.owner}/${job.repo}#${job.issueNumber}: ${(err as Error).message}`);
    }
  }

  log.info("Reconciliation complete");
}

/** Refresh the ghToken from the GitHub App installation token. */
async function refreshAppToken(config: Config, appConfig: AppConfig): Promise<void> {
  const token = await getInstallationToken(
    appConfig.appId,
    appConfig.privateKey,
    appConfig.installationId
  );
  config.ghToken = token;
}

async function main() {
  const config = loadConfig();
  const state = await StateManager.connect(config.mongodbUri);

  // --- Check for GitHub App config in DB ---
  let appConfig = await state.getAppConfig();
  let configured = false;

  if (appConfig) {
    // App mode — generate installation token
    try {
      await refreshAppToken(config, appConfig);
      config.botUsername = appConfig.botUsername;
      config.webhookSecret = appConfig.webhookSecret || config.webhookSecret;
      configured = true;
      log.info(`GitHub App connected: ${appConfig.botUsername} (app ${appConfig.appId})`);
    } catch (err) {
      log.error(`Failed to get installation token: ${(err as Error).message}`);
      log.warn("Starting in setup mode — configure the app via the dashboard");
    }
  } else if (config.ghToken) {
    // Legacy PAT mode
    configured = true;
    log.info("Using legacy GH_TOKEN (PAT mode)");
  } else {
    log.warn("No GitHub App or GH_TOKEN configured — starting in setup mode");
  }

  // Reconcile local jobs with GitHub issue state before accepting new work
  if (configured) {
    await syncJobsWithGitHub(state, config);
  }

  const budget = new TokenBudget(config, state);

  let running = 0;
  let shuttingDown = false;

  // --- Express server ---
  const app = express();

  // Parse JSON body but also keep raw body for HMAC verification
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as express.Request & { rawBody?: string }).rawBody =
          buf.toString();
      },
    })
  );

  // Webhook endpoint
  app.post("/webhook", createWebhookHandler(config, state));

  // Health check
  app.get("/health", async (_req, res) => {
    const budgetStatus = await budget.getStatus();
    res.json({ status: "ok", running, budget: budgetStatus });
  });

  // Token budget status
  app.get("/budget", async (_req, res) => {
    res.json(await budget.getStatus());
  });

  // List jobs
  app.get("/jobs", async (_req, res) => {
    res.json(await state.listJobs());
  });

  // Create a GitHub issue from the dashboard (for repo-only URLs)
  app.post("/jobs/create-issue", async (req, res) => {
    const { owner, repo, title, body } = req.body as {
      owner?: string; repo?: string; title?: string; body?: string;
    };

    if (!owner || !repo || !title) {
      res.status(400).json({ error: "owner, repo, and title are required" });
      return;
    }

    try {
      const issue = await createIssue(owner, repo, title, body ?? "", config);
      log.info(`Created issue ${owner}/${repo}#${issue.number} from dashboard`);
      res.status(201).json({ issueNumber: issue.number, url: issue.html_url });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  // Create a job from the dashboard (internal webhook)
  app.post("/jobs", async (req, res) => {
    const { url, instructions } = req.body as { url?: string; instructions?: string };
    if (!url || typeof url !== "string") {
      res.status(400).json({ error: "url is required" });
      return;
    }

    // Parse GitHub issue URL: github.com/:owner/:repo/issues/:number
    const issueMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
    if (!issueMatch) {
      res.status(400).json({ error: "Invalid URL — paste a GitHub issue URL like https://github.com/owner/repo/issues/123" });
      return;
    }

    const [, owner, repo, numStr] = issueMatch;
    const issueNumber = parseInt(numStr, 10);
    const jobId = `${owner}/${repo}#${issueNumber}`;

    // Check if job already exists and is active
    const existing = await state.getJobById(jobId);
    if (existing && ["queued", "working"].includes(existing.status)) {
      res.status(409).json({ error: `Job already ${existing.status}`, jobId });
      return;
    }

    // Fetch issue title from GitHub
    let issueTitle = "";
    try {
      const issue = await fetchIssue(owner, repo, issueNumber, config);
      issueTitle = issue.title;
    } catch {
      // Non-fatal — we can still queue the job
    }

    const now = new Date().toISOString();
    const jobState: JobState = {
      id: jobId,
      owner,
      repo,
      issueNumber,
      status: "queued",
      branch: `grog/issue-${issueNumber}`,
      issueTitle,
      triggerCommentId: 0,
      startedAt: now,
      updatedAt: now,
    };
    await state.upsertJob(jobState);

    // If instructions provided, store them as a user chat message
    if (instructions && instructions.trim()) {
      const line = { ts: Date.now(), type: "user" as const, content: instructions.trim() };
      pushLine(jobId, line);
      await state.appendJobLog(jobId, line);
    }

    log.info(`Job ${jobId} created from dashboard${instructions ? " with instructions" : ""}`);
    res.status(201).json({ queued: true, jobId, issueTitle });
  });

  // SSE stream for live job output
  app.get("/jobs/:id/stream", async (req, res) => {
    const jobId = decodeURIComponent(req.params.id);

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send catch-up: prefer in-memory buffer, fall back to MongoDB logs
    const memBuffer = getBuffer(jobId);
    if (memBuffer.length > 0) {
      for (const line of memBuffer) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    } else {
      const dbLogs = await state.getJobLogs(jobId);
      for (const line of dbLogs) {
        res.write(`data: ${JSON.stringify(line)}\n\n`);
      }
    }

    // Check if job is in a terminal state
    const job = await state.getJobById(jobId);
    const terminalStatuses = ["pr_opened", "completed", "failed", "closed", "stopped"];
    if (!job || terminalStatuses.includes(job.status)) {
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      return;
    }

    // Subscribe to in-memory updates
    const unsub = subscribe(jobId, (line) => {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    });

    // Poll MongoDB for new logs (works across processes)
    let lastLogCount = memBuffer.length || (await state.getJobLogs(jobId)).length;
    const pollInterval = setInterval(async () => {
      try {
        const currentJob = await state.getJobById(jobId);
        if (!currentJob || terminalStatuses.includes(currentJob.status)) {
          res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
          clearInterval(pollInterval);
          unsub();
          res.end();
          return;
        }
        const allLogs = await state.getJobLogs(jobId);
        if (allLogs.length > lastLogCount) {
          const newLines = allLogs.slice(lastLogCount);
          for (const line of newLines) {
            res.write(`data: ${JSON.stringify(line)}\n\n`);
          }
          lastLogCount = allLogs.length;
        }
      } catch {
        // Ignore poll errors
      }
    }, 2000);

    req.on("close", () => {
      unsub();
      clearInterval(pollInterval);
    });
  });

  // Get persisted logs for a job
  app.get("/jobs/:id/logs", async (req, res) => {
    const jobId = decodeURIComponent(req.params.id);
    const logs = await state.getJobLogs(jobId);
    res.json(logs);
  });

  // Update job status
  const ALLOWED_TARGET_STATUSES: JobStatus[] = ["queued", "completed", "failed", "closed"];

  app.patch("/jobs/:id/status", async (req, res) => {
    const jobId = decodeURIComponent(req.params.id);
    const { status } = req.body as { status: string };

    if (!status || !ALLOWED_TARGET_STATUSES.includes(status as JobStatus)) {
      res.status(400).json({ error: `Invalid target status: ${status}` });
      return;
    }

    const job = await state.getJobById(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (status === "closed") {
      try {
        await closeIssue(job.owner, job.repo, job.issueNumber, config);
      } catch (err) {
        res.status(502).json({ error: `Failed to close issue: ${(err as Error).message}` });
        return;
      }
    }

    job.status = status as JobStatus;
    job.updatedAt = new Date().toISOString();
    await state.upsertJob(job);

    res.json(job);
  });

  // Stop a running job — kill Claude process, mark as stopped
  app.post("/jobs/:id/stop", async (req, res) => {
    const jobId = decodeURIComponent(req.params.id);
    const job = await state.getJobById(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Kill the Claude process if running
    stopJob(jobId);

    job.status = "stopped";
    job.updatedAt = new Date().toISOString();
    await state.upsertJob(job);

    log.info(`Job ${jobId} stopped by user`);
    res.json(job);
  });

  // Start a stopped job — requeue it so the poll loop picks it up
  app.post("/jobs/:id/start", async (req, res) => {
    const jobId = decodeURIComponent(req.params.id);
    const job = await state.getJobById(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status !== "stopped") {
      res.status(400).json({ error: `Job is not stopped (current: ${job.status})` });
      return;
    }

    job.status = "queued";
    job.updatedAt = new Date().toISOString();
    await state.upsertJob(job);

    log.info(`Job ${jobId} restarted by user`);
    res.json(job);
  });

  // Send a chat message to a job
  const IDLE_STATUSES: JobStatus[] = ["stopped", "waiting_for_reply", "failed", "pr_opened", "completed"];

  app.post("/jobs/:id/message", async (req, res) => {
    const jobId = decodeURIComponent(req.params.id);
    const { content } = req.body as { content?: string };

    if (!content || typeof content !== "string" || !content.trim()) {
      res.status(400).json({ error: "content is required" });
      return;
    }

    const job = await state.getJobById(jobId);
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    // Store the message as a user log line
    const line = { ts: Date.now(), type: "user" as const, content: content.trim() };
    pushLine(jobId, line);
    await state.appendJobLog(jobId, line);

    // If job is working, pipe the message directly to the running agent
    if (job.status === "working") {
      const sent = sendMessage(jobId, content.trim());
      if (sent) {
        log.info(`Message piped to running agent for ${jobId}`);
        res.json({ ok: true, status: job.status, delivered: true });
        return;
      }
      // Process not found — fall through to requeue
    }

    // If job is idle, requeue so the agent restarts with chat context
    if (IDLE_STATUSES.includes(job.status) || (job.status === "working")) {
      job.status = "queued";
      job.updatedAt = new Date().toISOString();
      await state.upsertJob(job);
      log.info(`Job ${jobId} requeued via chat message`);
    }
    // If queued, message is already stored — agent will see it when it starts

    res.json({ ok: true, status: job.status });
  });

  // Repo config API
  app.get("/repos", async (_req, res) => {
    res.json(await state.listRepoConfigs());
  });

  app.get("/repos/:owner/:repo", async (req, res) => {
    const config_ = await state.getRepoConfig(req.params.owner, req.params.repo);
    if (!config_) {
      res.status(404).json({ error: "No config for this repo" });
      return;
    }
    res.json(config_);
  });

  app.put("/repos/:owner/:repo", async (req, res) => {
    const owner = req.params.owner;
    const repo = req.params.repo;
    const id = `${owner}/${repo}`;
    const body = req.body as Partial<RepoConfig>;

    const existing = await state.getRepoConfig(owner, repo);
    const now = new Date().toISOString();

    const repoConfig: RepoConfig = {
      id,
      owner,
      repo,
      enabled: body.enabled ?? existing?.enabled ?? true,
      autoSolve: body.autoSolve ?? existing?.autoSolve ?? false,
      includeLabels: body.includeLabels ?? existing?.includeLabels ?? [],
      excludeLabels: body.excludeLabels ?? existing?.excludeLabels ?? [],
      allowedUsers: body.allowedUsers ?? existing?.allowedUsers ?? [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    await state.upsertRepoConfig(repoConfig);
    log.info(`Repo config updated: ${id}`);
    res.json(repoConfig);
  });

  app.delete("/repos/:owner/:repo", async (req, res) => {
    const id = `${req.params.owner}/${req.params.repo}`;
    const deleted = await state.deleteRepoConfig(id);
    if (!deleted) {
      res.status(404).json({ error: "No config for this repo" });
      return;
    }
    res.json({ deleted: true, id });
  });

  // --- GitHub App config API ---

  app.get("/config/app", async (_req, res) => {
    const ac = await state.getAppConfig();
    if (!ac) {
      res.json({ configured: false });
      return;
    }
    // Never expose the private key to the frontend
    res.json({
      configured: true,
      appId: ac.appId,
      installationId: ac.installationId,
      botUsername: ac.botUsername,
      webhookSecret: ac.webhookSecret ? "***" : "",
      createdAt: ac.createdAt,
      updatedAt: ac.updatedAt,
    });
  });

  app.post("/config/app", async (req, res) => {
    const { appId, privateKey, webhookSecret } = req.body as {
      appId?: string;
      privateKey?: string;
      webhookSecret?: string;
    };

    if (!appId || !privateKey) {
      res.status(400).json({ error: "appId and privateKey are required" });
      return;
    }

    // Validate: get app info
    let appInfo;
    try {
      appInfo = await getAppInfo(appId, privateKey);
    } catch (err) {
      res.status(400).json({ error: `Invalid App ID or private key: ${(err as Error).message}` });
      return;
    }

    // Find installation
    let installations;
    try {
      installations = await listInstallations(appId, privateKey);
    } catch (err) {
      res.status(400).json({ error: `Failed to list installations: ${(err as Error).message}` });
      return;
    }

    if (installations.length === 0) {
      res.status(400).json({ error: "No installations found. Install the app on your GitHub org/account first." });
      return;
    }

    // Use first installation (most common for self-hosted)
    const installation = installations[0];
    const botUsername = `${appInfo.slug}[bot]`;

    // Generate a test token to verify it works
    let token;
    try {
      clearTokenCache();
      token = await getInstallationToken(appId, privateKey, installation.id);
    } catch (err) {
      res.status(400).json({ error: `Failed to generate installation token: ${(err as Error).message}` });
      return;
    }

    // Check rate limit to verify token is healthy
    const rateLimit = await checkRateLimit(token);

    const now = new Date().toISOString();
    const newConfig: AppConfig = {
      id: "github-app",
      appId,
      privateKey,
      installationId: installation.id,
      webhookSecret: webhookSecret || config.webhookSecret,
      botUsername,
      createdAt: appConfig?.createdAt ?? now,
      updatedAt: now,
    };

    await state.saveAppConfig(newConfig);
    appConfig = newConfig;

    // Apply immediately
    config.ghToken = token;
    config.botUsername = botUsername;
    config.webhookSecret = newConfig.webhookSecret;
    configured = true;

    log.info(`GitHub App configured: ${botUsername} (app ${appId}, installation ${installation.id})`);

    res.json({
      configured: true,
      appId,
      botUsername,
      installationId: installation.id,
      installationAccount: installation.account.login,
      rateLimit: { limit: rateLimit.limit, remaining: rateLimit.remaining },
    });
  });

  app.delete("/config/app", async (_req, res) => {
    await state.deleteAppConfig();
    clearTokenCache();
    appConfig = undefined;

    // Revert to PAT if available
    const envToken = process.env.GH_TOKEN ?? "";
    config.ghToken = envToken;
    configured = !!envToken;

    log.info("GitHub App config removed");
    res.json({ configured, mode: configured ? "pat" : "setup" });
  });

  // Dashboard
  app.get("/", async (_req, res) => {
    const jobs = await state.listJobs();
    res.type("html").send(renderDashboard(jobs, configured));
  });

  app.get("/dashboard", async (_req, res) => {
    const jobs = await state.listJobs();
    res.type("html").send(renderDashboard(jobs, configured));
  });

  app.listen(config.port, () => {
    log.info(`Grog agent listening on port ${config.port}`);
    log.info(`Bot username: @${config.botUsername}`);
    log.info(`Max concurrent jobs: ${config.maxConcurrentJobs}`);
    log.info(`Work directory: ${config.workDir}`);
  });

  // --- Token refresh for App mode (every 45 minutes) ---
  const tokenRefreshInterval = setInterval(async () => {
    if (shuttingDown || !appConfig) return;
    try {
      await refreshAppToken(config, appConfig);
    } catch (err) {
      log.error(`Token refresh failed: ${(err as Error).message}`);
    }
  }, 45 * 60_000);

  // --- Auto-accept repository invitations (PAT mode only — Apps don't need this) ---
  const invitationTimeout = setTimeout(() => {
    if (!configured || appConfig) return;
    acceptRepoInvitations(config).catch((err) =>
      log.error(`Initial invitation accept failed: ${err}`)
    );
  }, 10_000);
  const invitationInterval = setInterval(() => {
    if (!configured || appConfig) return;
    acceptRepoInvitations(config).catch((err) =>
      log.error(`Periodic invitation accept failed: ${err}`)
    );
  }, 5 * 60_000);

  // --- Stale job recovery — every 5 minutes (1.9) ---
  const staleRecoveryInterval = setInterval(async () => {
    if (shuttingDown || !configured) return;
    try {
      await state.recoverStaleJobs(config.agentTimeoutMinutes + 5);
    } catch (err) {
      log.error(`Stale job recovery failed: ${(err as Error).message}`);
    }
  }, 5 * 60_000);

  // --- Poll loop ---
  const pollInterval = setInterval(async () => {
    if (shuttingDown || !configured) return;
    if (running >= config.maxConcurrentJobs) return;

    try {
      // Check token budget before claiming
      if (!(await budget.canRun())) {
        return;
      }

      const job = await state.claimNextJob();
      if (!job) return;

      running++;
      log.info(`Claimed job ${job.id} (running: ${running}/${config.maxConcurrentJobs})`);

      // Pre-job credit check
      if (config.billingEnabled && job.userId) {
        const balance = await state.getCreditBalance(job.userId);
        if (!balance || balance.credits <= 0) {
          const now = new Date().toISOString();
          await state.upsertJob({ ...job, status: "failed", failureReason: "Insufficient credits", updatedAt: now });
          await postComment(
            job.owner, job.repo, job.issueNumber,
            "This job cannot run because you have no credits remaining. Please purchase credits to continue.",
            config
          );
          running--;
          return;
        }
      }

      // Build the QueuedJob from the claimed JobState
      const queuedJob = await buildQueuedJob(job, config, state);
      if (!queuedJob) {
        running--;
        return;
      }

      // Run in background (don't await — allows concurrent jobs)
      runAgent(queuedJob, config, state)
        .then(async () => {
          const jobState = await state.getJobById(job.id);
          if (jobState && jobState.status === "queued" && (jobState.retryCount ?? 0) > 0) {
            log.info(`Job ${job.id} marked for retry (attempt ${jobState.retryCount})`);
          }
        })
        .catch((err) => {
          log.error(`Job ${job.id} failed: ${(err as Error).message}`);
        })
        .finally(() => {
          running--;
          log.info(`Job ${job.id} finished (running: ${running}/${config.maxConcurrentJobs})`);
        });
    } catch (err) {
      log.error(`Poll error: ${(err as Error).message}`);
    }
  }, 2000);

  // --- Graceful shutdown ---
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal} — shutting down gracefully`);

    clearInterval(pollInterval);
    clearTimeout(invitationTimeout);
    clearInterval(invitationInterval);
    clearInterval(staleRecoveryInterval);
    clearInterval(tokenRefreshInterval);

    // Wait for running jobs to finish (up to 60s)
    const deadline = Date.now() + 60_000;
    while (running > 0 && Date.now() < deadline) {
      log.info(`Waiting for ${running} running job(s) to finish...`);
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (running > 0) {
      log.warn(`${running} job(s) still running after timeout — exiting anyway`);
    }

    log.info("Agent stopped");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function buildQueuedJob(
  job: JobState,
  config: Config,
  state: StateManager
): Promise<QueuedJob | null> {
  try {
    const repoRes = await fetch(
      `https://api.github.com/repos/${job.owner}/${job.repo}`,
      {
        headers: {
          Authorization: `token ${config.ghToken}`,
          Accept: "application/vnd.github+json",
        },
      }
    );

    let defaultBranch = "main";
    if (repoRes.ok) {
      const repoData = (await repoRes.json()) as { default_branch: string };
      defaultBranch = repoData.default_branch;
    }

    return {
      owner: job.owner,
      repo: job.repo,
      issueNumber: job.issueNumber,
      commentId: job.triggerCommentId,
      commentBody: "",
      defaultBranch,
    };
  } catch (err) {
    log.error(`Failed to build queued job for ${job.id}: ${(err as Error).message}`);

    job.status = "failed";
    job.failureReason = `Failed to fetch issue: ${(err as Error).message}`.slice(0, 200);
    job.updatedAt = new Date().toISOString();
    await state.upsertJob(job);

    return null;
  }
}

main().catch((err) => {
  log.error(`Failed to start Grog agent: ${err}`);
  process.exit(1);
});
