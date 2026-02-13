import crypto from "node:crypto";
import type { Request, Response } from "express";
import type {
  Config,
  WebhookPayload,
  PullRequestPayload,
  IssuesPayload,
  JobState,
  RepoConfig,
} from "@grog/shared";
import { StateManager, createLogger } from "@grog/shared";

const log = createLogger("webhook");

function shouldProcess(
  repoConfig: RepoConfig | undefined,
  labels: { name: string }[],
  senderLogin: string
): { allowed: boolean; reason?: string } {
  // No config = allow everything (backwards compatible)
  if (!repoConfig) return { allowed: true };

  if (!repoConfig.enabled) {
    return { allowed: false, reason: "Repo is disabled" };
  }

  // Check allowed users
  if (repoConfig.allowedUsers.length > 0 && !repoConfig.allowedUsers.includes(senderLogin)) {
    return { allowed: false, reason: `User ${senderLogin} not in allowedUsers` };
  }

  const labelNames = labels.map((l) => l.name.toLowerCase());

  // Check exclude labels
  if (repoConfig.excludeLabels.length > 0) {
    const excluded = repoConfig.excludeLabels.find((el) =>
      labelNames.includes(el.toLowerCase())
    );
    if (excluded) {
      return { allowed: false, reason: `Excluded label: ${excluded}` };
    }
  }

  // Check include labels (empty = allow all)
  if (repoConfig.includeLabels.length > 0) {
    const hasInclude = repoConfig.includeLabels.some((il) =>
      labelNames.includes(il.toLowerCase())
    );
    if (!hasInclude) {
      return { allowed: false, reason: "No matching includeLabels" };
    }
  }

  return { allowed: true };
}

export function verifySignature(
  payload: string,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expected)
  );
}

async function handleIssueComment(
  payload: WebhookPayload,
  config: Config,
  state: StateManager,
  res: Response
): Promise<void> {
  // Only react to new comments (not edits or deletions)
  if (payload.action !== "created") {
    res
      .status(200)
      .json({ ignored: true, reason: `Action: ${payload.action}` });
    return;
  }

  const commentBody = payload.comment.body ?? "";
  const mentionPattern = new RegExp(`@${config.botUsername}\\b`, "i");
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  // If the comment is on a PR, look up the original job by PR URL
  let issueNumber = payload.issue.number;
  if (payload.issue.pull_request) {
    const prUrl = payload.issue.pull_request.html_url;
    const originalJob = await state.getJobByPrUrl(prUrl);
    if (originalJob) {
      log.info(`PR comment detected — routing to original issue #${originalJob.issueNumber}`);
      issueNumber = originalJob.issueNumber;
    }
  }

  const existingJob = await state.getJob(owner, repo, issueNumber);

  // Trigger if bot is mentioned OR if there's an existing tracked job (continuation)
  const isMentioned = mentionPattern.test(commentBody);
  const isTracked = existingJob && existingJob.status === "waiting_for_reply";

  if (!isMentioned && !isTracked) {
    res
      .status(200)
      .json({ ignored: true, reason: "Bot not mentioned and issue not tracked" });
    return;
  }

  // Don't react to our own comments
  if (payload.comment.user.login === config.botUsername) {
    res
      .status(200)
      .json({ ignored: true, reason: "Ignoring own comment" });
    return;
  }

  // Check repo config
  const repoConfig = await state.getRepoConfig(owner, repo);
  const check = shouldProcess(repoConfig, payload.issue.labels, payload.comment.user.login);
  if (!check.allowed) {
    log.info(`Skipping ${owner}/${repo}#${issueNumber}: ${check.reason}`);
    res.status(200).json({ ignored: true, reason: check.reason });
    return;
  }

  // Credit check before queuing (4.1)
  let userId: number | undefined;
  const repoId = `${owner}/${repo}`;
  if (config.billingEnabled) {
    const reg = await state.getWebhookByRepoId(repoId);
    if (reg) {
      userId = reg.userId;
      const balance = await state.getCreditBalance(userId);
      if (!balance || balance.credits <= 0) {
        log.info(`Rejecting job for ${repoId}#${issueNumber}: user ${userId} has no credits`);
        res.status(402).json({ error: "Insufficient credits" });
        return;
      }
    }
  }

  // Write job directly to MongoDB with status "queued"
  const jobId = `${owner}/${repo}#${issueNumber}`;
  const now = new Date().toISOString();
  const jobState: JobState = {
    id: jobId,
    owner,
    repo,
    issueNumber,
    status: "queued",
    branch: `grog/issue-${issueNumber}`,
    issueTitle: payload.issue.title,
    triggerCommentId: payload.comment.id,
    startedAt: now,
    updatedAt: now,
    userId,
  };
  await state.upsertJob(jobState);

  log.info(`Queued job ${jobId}`);
  res.status(202).json({
    queued: true,
    issue: jobId,
  });
}

async function handlePullRequestEvent(
  payload: PullRequestPayload,
  state: StateManager,
  res: Response
): Promise<void> {
  if (payload.action !== "closed" || !payload.pull_request.merged) {
    res
      .status(200)
      .json({ ignored: true, reason: "PR not merged" });
    return;
  }

  const pr = payload.pull_request;
  const prUrl = pr.html_url;
  const branch = pr.head.ref;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  // Look up by prUrl first, then by branch
  let job = await state.getJobByPrUrl(prUrl);
  if (!job) {
    job = await state.getJobByBranch(owner, repo, branch);
  }

  if (!job) {
    res
      .status(200)
      .json({ ignored: true, reason: "No matching job for merged PR" });
    return;
  }

  job.status = "completed";
  job.updatedAt = new Date().toISOString();
  await state.upsertJob(job);

  log.info(`PR merged — marked job ${job.id} as completed`);
  res.status(200).json({ completed: true, job: job.id });
}

async function handleIssuesEvent(
  payload: IssuesPayload,
  config: Config,
  state: StateManager,
  res: Response
): Promise<void> {
  // Only handle newly opened issues
  if (payload.action !== "opened") {
    res.status(200).json({ ignored: true, reason: `Issues action: ${payload.action}` });
    return;
  }

  // Skip PRs
  if (payload.issue.pull_request) {
    res.status(200).json({ ignored: true, reason: "Pull request, not issue" });
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  // Check repo config — must have autoSolve enabled
  const repoConfig = await state.getRepoConfig(owner, repo);
  if (!repoConfig || !repoConfig.autoSolve) {
    res.status(200).json({ ignored: true, reason: "autoSolve not enabled for this repo" });
    return;
  }

  const check = shouldProcess(repoConfig, payload.issue.labels, payload.sender.login);
  if (!check.allowed) {
    log.info(`Skipping auto-solve ${owner}/${repo}#${payload.issue.number}: ${check.reason}`);
    res.status(200).json({ ignored: true, reason: check.reason });
    return;
  }

  log.info(`Auto-solving new issue ${owner}/${repo}#${payload.issue.number}`);

  // Credit check before queuing (4.1)
  let userId: number | undefined;
  const autoRepoId = `${owner}/${repo}`;
  if (config.billingEnabled) {
    const reg = await state.getWebhookByRepoId(autoRepoId);
    if (reg) {
      userId = reg.userId;
      const balance = await state.getCreditBalance(userId);
      if (!balance || balance.credits <= 0) {
        log.info(`Rejecting auto-solve for ${autoRepoId}#${payload.issue.number}: user ${userId} has no credits`);
        res.status(402).json({ error: "Insufficient credits" });
        return;
      }
    }
  }

  // Write job directly to MongoDB with status "queued"
  const jobId = `${owner}/${repo}#${payload.issue.number}`;
  const now = new Date().toISOString();
  const jobState: JobState = {
    id: jobId,
    owner,
    repo,
    issueNumber: payload.issue.number,
    status: "queued",
    branch: `grog/issue-${payload.issue.number}`,
    issueTitle: payload.issue.title,
    triggerCommentId: 0,
    startedAt: now,
    updatedAt: now,
    userId,
  };
  await state.upsertJob(jobState);

  log.info(`Queued auto-solve job ${jobId}`);
  res.status(202).json({ queued: true, autoSolve: true, issue: jobId });
}

export function createWebhookHandler(
  config: Config,
  state: StateManager
) {
  return async (req: Request, res: Response): Promise<void> => {
    // Verify HMAC signature — try per-repo secret first, then global secret
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = (req as Request & { rawBody?: string }).rawBody;

    if (!rawBody || !signature) {
      log.warn("Missing body or signature — rejecting request");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    // Extract repo info from payload to look up per-repo secret
    let verified = false;
    try {
      const body = req.body as { repository?: { full_name?: string } };
      if (body.repository?.full_name) {
        const reg = await state.getWebhookByRepoId(body.repository.full_name);
        if (reg && verifySignature(rawBody, signature, reg.webhookSecret)) {
          verified = true;
        }
      }
    } catch {
      // Ignore lookup errors, fall through to global secret
    }

    // Fall back to global webhook secret
    if (!verified && !verifySignature(rawBody, signature, config.webhookSecret)) {
      log.warn("Invalid signature — rejecting request");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const event = req.headers["x-github-event"] as string;

    if (event === "issue_comment") {
      await handleIssueComment(
        req.body as WebhookPayload,
        config,
        state,
        res
      );
    } else if (event === "issues") {
      await handleIssuesEvent(
        req.body as IssuesPayload,
        config,
        state,
        res
      );
    } else if (event === "pull_request") {
      await handlePullRequestEvent(
        req.body as PullRequestPayload,
        state,
        res
      );
    } else {
      res.status(200).json({ ignored: true, reason: `Event type: ${event}` });
    }
  };
}
