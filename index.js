#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env from the package directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, ".env") });

const GH_TOKEN = process.env.GH_TOKEN;

if (!GH_TOKEN) {
  console.error("Error: GH_TOKEN not found in .env file");
  process.exit(1);
}

/**
 * Parse GitHub issue URL
 * @param {string} url - GitHub issue URL like https://github.com/owner/repo/issues/123
 * @returns {{ owner: string, repo: string, issueNumber: string } | null}
 */
function parseGitHubUrl(url) {
  const match = url.match(
    /github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/
  );
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: match[3],
  };
}

/**
 * Fetch issue from GitHub API
 * @param {string} owner
 * @param {string} repo
 * @param {string} issueNumber
 */
async function fetchIssue(owner, repo, issueNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

/**
 * Main function
 */
async function main() {
  const issueUrl = process.argv[2];

  if (!issueUrl) {
    console.log("Usage: grog <github-issue-url>");
    console.log("Example: grog https://github.com/mtropro/admin-panel/issues/166");
    process.exit(1);
  }

  const parsed = parseGitHubUrl(issueUrl);
  if (!parsed) {
    console.error("Error: Invalid GitHub issue URL");
    console.error("Expected format: https://github.com/owner/repo/issues/123");
    process.exit(1);
  }

  try {
    console.log(`Fetching issue #${parsed.issueNumber} from ${parsed.owner}/${parsed.repo}...\n`);

    const issue = await fetchIssue(parsed.owner, parsed.repo, parsed.issueNumber);

    console.log("=".repeat(60));
    console.log(`Issue #${issue.number}: ${issue.title}`);
    console.log("=".repeat(60));
    console.log(`State: ${issue.state}`);
    console.log(`Author: ${issue.user?.login}`);
    console.log(`Created: ${new Date(issue.created_at).toLocaleString()}`);
    if (issue.labels?.length > 0) {
      console.log(`Labels: ${issue.labels.map((l) => l.name).join(", ")}`);
    }
    console.log("-".repeat(60));
    console.log("\nDescription:\n");
    console.log(issue.body || "(No description provided)");
    console.log("\n" + "=".repeat(60));

  } catch (error) {
    console.error("Error fetching issue:", error.message);
    process.exit(1);
  }
}

main();
