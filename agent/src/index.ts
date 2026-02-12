import express from "express";
import { loadConfig } from "./config.js";
import { createWebhookHandler } from "./webhook.js";
import { JobQueue } from "./queue.js";
import { StateManager } from "./state.js";
import { runAgent } from "./runner.js";
import { renderDashboard } from "./dashboard.js";
import { getBuffer, subscribe } from "./outputStore.js";
import { closeIssue, acceptRepoInvitations, fetchIssue } from "./github.js";
import { createLogger } from "./logger.js";
import { TokenBudget } from "./budget.js";
import type { Config, JobStatus } from "./types.js";

const log = createLogger("server");

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
        // Skip if recently updated — likely still running in a CLI worker
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

async function main() {
  const config = loadConfig();
  const state = await StateManager.connect(config.mongodbUri);

  // Reconcile local jobs with GitHub issue state before accepting new work
  await syncJobsWithGitHub(state, config);

  const budget = new TokenBudget(config, state);

  const queue = new JobQueue(config.maxConcurrentJobs, async (job) => {
    // Check token budget before running
    if (!(await budget.canRun())) {
      const jobId = `${job.owner}/${job.repo}#${job.issueNumber}`;
      log.warn(`Token budget exceeded — skipping ${jobId}`);
      const jobState = await state.getJobById(jobId);
      if (jobState) {
        jobState.status = "queued";
        jobState.updatedAt = new Date().toISOString();
        await state.upsertJob(jobState);
      }
      return;
    }

    await runAgent(job, config, state);

    // Check if the job was marked for retry
    const jobId = `${job.owner}/${job.repo}#${job.issueNumber}`;
    const jobState = await state.getJobById(jobId);
    if (jobState && jobState.status === "queued" && (jobState.retryCount ?? 0) > 0) {
      log.info(`Re-enqueueing ${jobId} for retry (attempt ${jobState.retryCount})`);
      // Delay retry by 10 seconds to avoid hammering
      await new Promise((r) => setTimeout(r, 10000));
      queue.enqueue(job);
    }
  });

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
  app.post("/webhook", createWebhookHandler(config, queue, state));

  // Health check
  app.get("/health", async (_req, res) => {
    const budgetStatus = await budget.getStatus();
    res.json({ status: "ok", queue: queue.stats, budget: budgetStatus });
  });

  // Token budget status
  app.get("/budget", async (_req, res) => {
    res.json(await budget.getStatus());
  });

  // List active jobs
  app.get("/jobs", async (_req, res) => {
    res.json(await state.listJobs());
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
    const terminalStatuses = ["pr_opened", "completed", "failed", "closed"];
    if (!job || terminalStatuses.includes(job.status)) {
      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
      return;
    }

    // Subscribe to in-memory updates (works when agent runs in same process)
    const unsub = subscribe(jobId, (line) => {
      res.write(`data: ${JSON.stringify(line)}\n\n`);
    });

    // Poll MongoDB for new logs (works when agent runs in separate process)
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

  // Update job status (drag-and-drop)
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

  // Dashboard
  app.get("/dashboard", async (_req, res) => {
    const jobs = await state.listJobs();
    res.type("html").send(renderDashboard(jobs));
  });

  app.listen(config.port, () => {
    log.info(`Grog agent server listening on port ${config.port}`);
    log.info(`Bot username: @${config.botUsername}`);
    log.info(`Max concurrent jobs: ${config.maxConcurrentJobs}`);
    log.info(`Work directory: ${config.workDir}`);

    // Auto-accept repository invitations
    acceptRepoInvitations(config).catch((err) =>
      log.error(`Initial invitation accept failed: ${err}`)
    );
    setInterval(() => {
      acceptRepoInvitations(config).catch((err) =>
        log.error(`Periodic invitation accept failed: ${err}`)
      );
    }, 60_000);
  });
}

main().catch((err) => {
  log.error(`Failed to start Grog: ${err}`);
  process.exit(1);
});
