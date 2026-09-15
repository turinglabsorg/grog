const GITHUB_API_VERSION = "2022-11-28";

export function parseGitHubRepository(value) {
  const input = String(value || "").trim();
  if (!input) return null;

  const patterns = [
    /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?$/,
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i,
    /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/i,
  ];

  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (!match) continue;

    const owner = match[1];
    const repo = match[2];
    if (!owner || !repo || repo.includes("/")) return null;
    return { owner, repo, fullName: `${owner}/${repo}` };
  }

  return null;
}

async function readResponsePayload(response) {
  const raw = await response.text();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw };
  }
}

export async function createGitHubIssue({
  token,
  repository,
  title,
  body = "",
  labels = [],
  assignees = [],
  fetchImpl = globalThis.fetch,
  apiBaseUrl = "https://api.github.com",
}) {
  const parsedRepository = parseGitHubRepository(repository);
  if (!parsedRepository) {
    throw new Error(`Invalid GitHub repository "${repository || ""}". Use OWNER/REPO.`);
  }

  const normalizedTitle = String(title || "").trim();
  if (!normalizedTitle) throw new Error("Missing GitHub issue title.");
  if (!String(token || "").trim()) throw new Error("GH_TOKEN not found.");
  if (typeof fetchImpl !== "function") throw new Error("Fetch implementation is unavailable.");

  const payload = {
    title: normalizedTitle,
    body: String(body || ""),
  };
  if (labels.length > 0) payload.labels = labels;
  if (assignees.length > 0) payload.assignees = assignees;

  const { owner, repo } = parsedRepository;
  const response = await fetchImpl(
    `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "User-Agent": "grog-cli",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
      body: JSON.stringify(payload),
    },
  );
  const result = await readResponsePayload(response);

  if (!response.ok) {
    const detail = result.message || response.statusText || "Unknown error";
    throw new Error(`GitHub API error: ${response.status} ${detail}`);
  }

  if (!result.number || !result.html_url) {
    throw new Error("GitHub API returned an invalid issue response.");
  }

  return result;
}
