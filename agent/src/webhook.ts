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
  if (!repoConfig) return { allowed: true };
  if (!repoConfig.enabled) return { allowed: false, reason: "Repo is disabled" };

  if (repoConfig.allowedUsers.length > 0 && !repoConfig.allowedUsers.includes(senderLogin)) {
    return { allowed: false, reason: `User ${senderLogin} not in allowedUsers` };
  }

  const labelNames = labels.map((l) => l.name.toLowerCase());

  if (repoConfig.excludeLabels.length > 0) {
    const excluded = repoConfig.excludeLabels.find((el) =>
      labelNames.includes(el.toLowerCase())
    );
    if (excluded) return { allowed: false, reason: `Excluded label: ${excluded}` };
  }

  if (repoConfig.includeLabels.length > 0) {
    const hasInclude = repoConfig.includeLabels.some((il) =>
      labelNames.includes(il.toLowerCase())
    );
    if (!hasInclude) return { allowed: false, reason: "No matching includeLabels" };
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
  if (payload.action !== "created") {
    res.status(200).json({ ignored: true, reason: `Action: ${payload.action}` });
    return;
  }

  const commentBody = payload.comment.body ?? "";
  // Escape regex special chars in bot username (e.g. "grog-agent[bot]" → "grog-agent\\[bot\\]")
  const escapedName = config.botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`@${escapedName}`, "i");
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

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
  const isMentioned = mentionPattern.test(commentBody);
  const isTracked = existingJob && existingJob.status === "waiting_for_reply";

  if (!isMentioned && !isTracked) {
    res.status(200).json({ ignored: true, reason: "Bot not mentioned and issue not tracked" });
    return;
  }

  // Ignore bot's own comments — GitHub App bots post as "app-name[bot]"
  const botLogin = config.botUsername.replace(/\[bot\]$/, "[bot]");
  if (payload.comment.user.login === botLogin || payload.comment.user.login === config.botUsername) {
    res.status(200).json({ ignored: true, reason: "Ignoring own comment" });
    return;
  }

  const repoConfig = await state.getRepoConfig(owner, repo);
  const check = shouldProcess(repoConfig, payload.issue.labels, payload.comment.user.login);
  if (!check.allowed) {
    log.info(`Skipping ${owner}/${repo}#${issueNumber}: ${check.reason}`);
    res.status(200).json({ ignored: true, reason: check.reason });
    return;
  }

  const reg = await state.getWebhookByRepoId(`${owner}/${repo}`);

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
    userId: reg?.userId,
    startedAt: now,
    updatedAt: now,
  };
  await state.upsertJob(jobState);

  log.info(`Queued job ${jobId}`);
  res.status(202).json({ queued: true, issue: jobId });
}

async function handlePullRequestEvent(
  payload: PullRequestPayload,
  state: StateManager,
  res: Response
): Promise<void> {
  if (payload.action !== "closed" || !payload.pull_request.merged) {
    res.status(200).json({ ignored: true, reason: "PR not merged" });
    return;
  }

  const pr = payload.pull_request;
  const prUrl = pr.html_url;
  const branch = pr.head.ref;
  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

  let job = await state.getJobByPrUrl(prUrl);
  if (!job) {
    job = await state.getJobByBranch(owner, repo, branch);
  }

  if (!job) {
    res.status(200).json({ ignored: true, reason: "No matching job for merged PR" });
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
  if (payload.action !== "opened") {
    res.status(200).json({ ignored: true, reason: `Issues action: ${payload.action}` });
    return;
  }

  if (payload.issue.pull_request) {
    res.status(200).json({ ignored: true, reason: "Pull request, not issue" });
    return;
  }

  const owner = payload.repository.owner.login;
  const repo = payload.repository.name;

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

  const reg = await state.getWebhookByRepoId(`${owner}/${repo}`);

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
    userId: reg?.userId,
    startedAt: now,
    updatedAt: now,
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
    const signature = req.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = (req as Request & { rawBody?: string }).rawBody;

    if (!rawBody || !signature) {
      log.warn("Missing body or signature — rejecting request");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

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
      // Fall through to global secret
    }

    if (!verified && !verifySignature(rawBody, signature, config.webhookSecret)) {
      log.warn("Invalid signature — rejecting request");
      res.status(401).json({ error: "Invalid signature" });
      return;
    }

    const event = req.headers["x-github-event"] as string;

    if (event === "issue_comment") {
      await handleIssueComment(req.body as WebhookPayload, config, state, res);
    } else if (event === "issues") {
      await handleIssuesEvent(req.body as IssuesPayload, config, state, res);
    } else if (event === "pull_request") {
      await handlePullRequestEvent(req.body as PullRequestPayload, state, res);
    } else {
      res.status(200).json({ ignored: true, reason: `Event type: ${event}` });
    }
  };
}
