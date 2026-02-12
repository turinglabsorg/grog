import type { Config, Issue, Comment } from "./types.js";
import { createLogger } from "./logger.js";

const log = createLogger("github");

const API = "https://api.github.com";

function headers(config: Config) {
  return {
    Authorization: `token ${config.ghToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

// --- Retry logic with exponential backoff ---

interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
};

function isRetryable(status: number): boolean {
  // Rate limit (403 with rate limit message), server errors, and 429
  return status === 403 || status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelay(
  attempt: number,
  res: Response | null,
  opts: RetryOptions
): number {
  // Check Retry-After header first
  const retryAfter = res?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) return seconds * 1000;
  }

  // Check x-ratelimit-reset header
  const resetHeader = res?.headers.get("x-ratelimit-reset");
  const remaining = res?.headers.get("x-ratelimit-remaining");
  if (remaining === "0" && resetHeader) {
    const resetTime = parseInt(resetHeader, 10) * 1000;
    const waitMs = resetTime - Date.now() + 1000; // +1s buffer
    if (waitMs > 0 && waitMs < (opts.maxDelayMs ?? 30000)) {
      return waitMs;
    }
  }

  // Exponential backoff with jitter
  const delay = Math.min(
    (opts.baseDelayMs ?? 1000) * Math.pow(2, attempt) + Math.random() * 500,
    opts.maxDelayMs ?? 30000
  );
  return delay;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: RetryOptions = DEFAULT_RETRY
): Promise<Response> {
  const maxRetries = opts.maxRetries ?? 3;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);

    if (res.ok || !isRetryable(res.status) || attempt === maxRetries) {
      return res;
    }

    const delay = getRetryDelay(attempt, res, opts);
    log.warn(`${init.method ?? "GET"} ${url} → ${res.status}, retrying in ${Math.round(delay / 1000)}s (attempt ${attempt + 1}/${maxRetries})`);
    await sleep(delay);
  }

  // Unreachable, but TypeScript needs it
  return fetch(url, init);
}

// --- API functions ---

export async function fetchIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  config: Config
): Promise<Issue> {
  const res = await fetchWithRetry(
    `${API}/repos/${owner}/${repo}/issues/${issueNumber}`,
    { headers: headers(config) }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch issue #${issueNumber}: ${res.status} ${res.statusText}`
    );
  }
  return (await res.json()) as Issue;
}

export async function fetchIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  config: Config
): Promise<Comment[]> {
  const comments: Comment[] = [];
  let page = 1;

  while (true) {
    const res = await fetchWithRetry(
      `${API}/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
      { headers: headers(config) }
    );
    if (!res.ok) {
      throw new Error(
        `Failed to fetch comments for issue #${issueNumber}: ${res.status}`
      );
    }
    const batch = (await res.json()) as Comment[];
    if (batch.length === 0) break;
    comments.push(...batch);
    page++;
  }

  return comments;
}

export async function postComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  config: Config
): Promise<void> {
  const res = await fetchWithRetry(
    `${API}/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    {
      method: "POST",
      headers: { ...headers(config), "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to post comment on issue #${issueNumber}: ${res.status}`
    );
  }
}

export async function addReaction(
  owner: string,
  repo: string,
  commentId: number,
  reaction: string,
  config: Config
): Promise<void> {
  const res = await fetchWithRetry(
    `${API}/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
    {
      method: "POST",
      headers: { ...headers(config), "Content-Type": "application/json" },
      body: JSON.stringify({ content: reaction }),
    }
  );
  if (!res.ok) {
    log.error(`Failed to add reaction to comment ${commentId}: ${res.status}`);
  }
}

export async function closeIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  config: Config
): Promise<void> {
  const res = await fetchWithRetry(
    `${API}/repos/${owner}/${repo}/issues/${issueNumber}`,
    {
      method: "PATCH",
      headers: { ...headers(config), "Content-Type": "application/json" },
      body: JSON.stringify({ state: "closed" }),
    }
  );
  if (!res.ok) {
    throw new Error(
      `Failed to close issue #${issueNumber}: ${res.status} ${res.statusText}`
    );
  }
}

export async function createPullRequest(
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string,
  config: Config
): Promise<string> {
  const res = await fetchWithRetry(
    `${API}/repos/${owner}/${repo}/pulls`,
    {
      method: "POST",
      headers: { ...headers(config), "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, head, base }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Failed to create PR: ${res.status} ${res.statusText} — ${err}`
    );
  }
  const pr = (await res.json()) as { html_url: string };
  return pr.html_url;
}

export async function acceptRepoInvitations(config: Config): Promise<void> {
  const res = await fetchWithRetry(`${API}/user/repository_invitations`, {
    headers: headers(config),
  });
  if (!res.ok) {
    log.error(`Failed to fetch repo invitations: ${res.status}`);
    return;
  }
  const invitations = (await res.json()) as { id: number; repository: { full_name: string } }[];
  for (const inv of invitations) {
    const acceptRes = await fetchWithRetry(
      `${API}/user/repository_invitations/${inv.id}`,
      { method: "PATCH", headers: headers(config) }
    );
    if (acceptRes.ok) {
      log.info(`Accepted invitation for ${inv.repository.full_name}`);
    } else {
      log.error(`Failed to accept invitation ${inv.id}: ${acceptRes.status}`);
    }
  }
}
