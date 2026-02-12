import type { Config, Issue, Comment } from "./types.js";

const API = "https://api.github.com";

function headers(config: Config) {
  return {
    Authorization: `token ${config.ghToken}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function fetchIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  config: Config
): Promise<Issue> {
  const res = await fetch(
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
    const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(
    `${API}/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
    {
      method: "POST",
      headers: { ...headers(config), "Content-Type": "application/json" },
      body: JSON.stringify({ content: reaction }),
    }
  );
  if (!res.ok) {
    console.error(
      `Failed to add reaction to comment ${commentId}: ${res.status}`
    );
  }
}

export async function closeIssue(
  owner: string,
  repo: string,
  issueNumber: number,
  config: Config
): Promise<void> {
  const res = await fetch(
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
  const res = await fetch(
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
  const res = await fetch(`${API}/user/repository_invitations`, {
    headers: headers(config),
  });
  if (!res.ok) {
    console.error(`Failed to fetch repo invitations: ${res.status}`);
    return;
  }
  const invitations = (await res.json()) as { id: number; repository: { full_name: string } }[];
  for (const inv of invitations) {
    const acceptRes = await fetch(
      `${API}/user/repository_invitations/${inv.id}`,
      { method: "PATCH", headers: headers(config) }
    );
    if (acceptRes.ok) {
      console.log(`[github] Accepted invitation for ${inv.repository.full_name}`);
    } else {
      console.error(`[github] Failed to accept invitation ${inv.id}: ${acceptRes.status}`);
    }
  }
}
