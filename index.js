#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  renameSync,
  appendFileSync,
  readFileSync,
  readdirSync,
  statSync,
} from "fs";

// Load .env from the package directory
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, ".env") });

const GH_TOKEN = process.env.GH_TOKEN;

if (!GH_TOKEN) {
  console.error("Error: GH_TOKEN not found in .env file");
  process.exit(1);
}

// Logging directory for worker activity
const LOGS_DIR = "/tmp/grog-logs";

/**
 * Get log file path for an issue
 * @param {string} owner
 * @param {string} repo
 * @param {string|number} issueNumber
 * @returns {string}
 */
function getLogPath(owner, repo, issueNumber) {
  return join(LOGS_DIR, `${owner}-${repo}-issue-${issueNumber}.log`);
}

/**
 * Write a log entry for an issue worker
 * @param {string} owner
 * @param {string} repo
 * @param {string|number} issueNumber
 * @param {string} message
 */
function writeLog(owner, repo, issueNumber, message) {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
  const logPath = getLogPath(owner, repo, issueNumber);
  const timestamp = new Date().toISOString();
  appendFileSync(logPath, `[${timestamp}] ${message}\n`);
}

/**
 * Parse GitHub issue URL
 * @param {string} url - GitHub issue URL like https://github.com/owner/repo/issues/123
 * @returns {{ owner: string, repo: string, issueNumber: string } | null}
 */
function parseGitHubIssueUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    issueNumber: match[3],
  };
}

/**
 * Parse GitHub project/repo URL
 * @param {string} url - GitHub URL like https://github.com/owner/repo or https://github.com/orgs/org/projects/123
 * @returns {{ type: 'repo', owner: string, repo: string } | { type: 'project', owner: string, projectNumber: number, isOrg: boolean } | null}
 */
function parseGitHubUrl(url) {
  // Match org project: https://github.com/orgs/orgname/projects/123
  const orgProjectMatch = url.match(
    /github\.com\/orgs\/([^/]+)\/projects\/(\d+)/,
  );
  if (orgProjectMatch) {
    return {
      type: "project",
      owner: orgProjectMatch[1],
      projectNumber: parseInt(orgProjectMatch[2], 10),
      isOrg: true,
    };
  }

  // Match user project: https://github.com/users/username/projects/123
  const userProjectMatch = url.match(
    /github\.com\/users\/([^/]+)\/projects\/(\d+)/,
  );
  if (userProjectMatch) {
    return {
      type: "project",
      owner: userProjectMatch[1],
      projectNumber: parseInt(userProjectMatch[2], 10),
      isOrg: false,
    };
  }

  // Match repository: https://github.com/owner/repo
  const repoMatch = url.match(/github\.com\/([^/]+)\/([^/]+)\/?$/);
  if (repoMatch) {
    return {
      type: "repo",
      owner: repoMatch[1],
      repo: repoMatch[2],
    };
  }

  return null;
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
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    );
  }

  return response.json();
}

/**
 * Fetch all issues from GitHub API with optional state filter
 * @param {string} owner
 * @param {string} repo
 * @param {string} state - 'open', 'closed', or 'all'
 */
async function fetchIssues(owner, repo, state = "open") {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=100`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    );
  }

  const issues = await response.json();
  // Filter out pull requests (they come in the issues endpoint too)
  return issues.filter((issue) => !issue.pull_request);
}

/**
 * Fetch project items using GitHub GraphQL API with pagination
 * @param {string} owner - Organization or user name
 * @param {number} projectNumber - Project number
 * @param {boolean} isOrg - Whether it's an organization project
 */
async function fetchProjectItems(owner, projectNumber, isOrg) {
  const ownerType = isOrg ? "organization" : "user";

  const query = `
    query($owner: String!, $projectNumber: Int!, $cursor: String) {
      ${ownerType}(login: $owner) {
        projectV2(number: $projectNumber) {
          title
          url
          items(first: 100, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              fieldValues(first: 20) {
                nodes {
                  ... on ProjectV2ItemFieldSingleSelectValue {
                    name
                    field {
                      ... on ProjectV2SingleSelectField {
                        name
                      }
                    }
                  }
                  ... on ProjectV2ItemFieldTextValue {
                    text
                    field {
                      ... on ProjectV2Field {
                        name
                      }
                    }
                  }
                }
              }
              content {
                ... on Issue {
                  number
                  title
                  state
                  url
                  body
                  createdAt
                  repository {
                    name
                    owner {
                      login
                    }
                  }
                  labels(first: 10) {
                    nodes {
                      name
                    }
                  }
                  author {
                    login
                  }
                }
                ... on DraftIssue {
                  title
                  body
                }
              }
            }
          }
          fields(first: 20) {
            nodes {
              ... on ProjectV2SingleSelectField {
                name
                options {
                  name
                }
              }
            }
          }
        }
      }
    }
  `;

  let allItems = [];
  let cursor = null;
  let projectData = null;

  // Paginate through all items
  while (true) {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        variables: { owner, projectNumber, cursor },
      }),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub GraphQL API error: ${response.status} ${response.statusText}`,
      );
    }

    const result = await response.json();

    if (result.errors) {
      throw new Error(
        `GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`,
      );
    }

    const data = result.data?.[ownerType]?.projectV2;
    if (!data) {
      throw new Error(`Project not found: ${owner}/projects/${projectNumber}`);
    }

    // Store project metadata on first request
    if (!projectData) {
      projectData = {
        title: data.title,
        url: data.url,
        fields: data.fields,
        items: { nodes: [] },
      };
    }

    // Accumulate items
    allItems = allItems.concat(data.items.nodes);

    // Check if there are more pages
    if (data.items.pageInfo.hasNextPage) {
      cursor = data.items.pageInfo.endCursor;
    } else {
      break;
    }
  }

  // Return combined result
  projectData.items.nodes = allItems;
  return projectData;
}

/**
 * Extract image URLs from issue body
 * @param {string} body - Issue body content
 * @returns {string[]} Array of image URLs
 */
function extractImageUrls(body) {
  if (!body) return [];

  const urls = new Set();

  // Match HTML img tags: <img ... src="URL" ... />
  const imgTagRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = imgTagRegex.exec(body)) !== null) {
    urls.add(match[1]);
  }

  // Match Markdown images: ![alt](URL)
  const mdImageRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  while ((match = mdImageRegex.exec(body)) !== null) {
    urls.add(match[1]);
  }

  // Match raw GitHub user-attachments URLs
  const rawUrlRegex =
    /https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/gi;
  while ((match = rawUrlRegex.exec(body)) !== null) {
    urls.add(match[0]);
  }

  // Match private user images
  const privateImageRegex =
    /https:\/\/private-user-images\.githubusercontent\.com\/[^\s"'<>]+/gi;
  while ((match = privateImageRegex.exec(body)) !== null) {
    urls.add(match[0]);
  }

  return Array.from(urls);
}

/**
 * Get file extension from content-type
 * @param {string} contentType
 * @returns {string}
 */
function getExtension(contentType) {
  const typeMap = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
  };
  return typeMap[contentType] || "png";
}

/**
 * Download an image from URL
 * @param {string} url - Image URL
 * @param {string} outputPath - Where to save the image
 */
async function downloadImage(url, outputPath) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      "User-Agent": "grog-cli/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download: ${response.status} ${response.statusText}`,
    );
  }

  const contentType = response.headers.get("content-type") || "";
  const buffer = await response.arrayBuffer();
  writeFileSync(outputPath, Buffer.from(buffer));

  return { contentType, size: buffer.byteLength };
}

/**
 * Print issue details with image download
 */
async function printIssueDetails(issue, owner, repo) {
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

  // Extract and download images
  const imageUrls = extractImageUrls(issue.body);

  if (imageUrls.length > 0) {
    console.log(
      `\nFound ${imageUrls.length} image attachment(s). Downloading...\n`,
    );

    const outputDir = "/tmp/grog-attachments";
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const downloadedFiles = [];

    for (let i = 0; i < imageUrls.length; i++) {
      const url = imageUrls[i];
      try {
        const tempPath = join(outputDir, `temp-${Date.now()}-${i}`);
        const { contentType, size } = await downloadImage(url, tempPath);
        const ext = getExtension(contentType);
        const filename = `${repo}-issue-${issue.number}-img-${i + 1}.${ext}`;
        const finalPath = join(outputDir, filename);
        renameSync(tempPath, finalPath);
        console.log(
          `  Downloaded: ${finalPath} (${(size / 1024).toFixed(1)} KB)`,
        );
        downloadedFiles.push(finalPath);
      } catch (err) {
        console.error(`  Failed to download image ${i + 1}: ${err.message}`);
      }
    }

    if (downloadedFiles.length > 0) {
      console.log("\n" + "=".repeat(60));
      console.log("IMAGE ATTACHMENTS (use Read tool to analyze these):");
      console.log("=".repeat(60));
      downloadedFiles.forEach((f) => console.log(f));
    }
  }
}

/**
 * Handle 'solve' command - fetch and display a single issue
 */
async function handleSolve(issueUrl) {
  const parsed = parseGitHubIssueUrl(issueUrl);
  if (!parsed) {
    console.error("Error: Invalid GitHub issue URL");
    console.error("Expected format: https://github.com/owner/repo/issues/123");
    process.exit(1);
  }

  try {
    writeLog(
      parsed.owner,
      parsed.repo,
      parsed.issueNumber,
      "Worker started - fetching issue details",
    );
    console.log(
      `Fetching issue #${parsed.issueNumber} from ${parsed.owner}/${parsed.repo}...\n`,
    );
    const issue = await fetchIssue(
      parsed.owner,
      parsed.repo,
      parsed.issueNumber,
    );
    writeLog(
      parsed.owner,
      parsed.repo,
      parsed.issueNumber,
      `Fetched issue: "${issue.title}" (state: ${issue.state})`,
    );
    await printIssueDetails(issue, parsed.owner, parsed.repo);

    const imageUrls = extractImageUrls(issue.body);
    if (imageUrls.length > 0) {
      writeLog(
        parsed.owner,
        parsed.repo,
        parsed.issueNumber,
        `Downloaded ${imageUrls.length} image attachment(s)`,
      );
    }
    writeLog(
      parsed.owner,
      parsed.repo,
      parsed.issueNumber,
      "Worker completed - issue details displayed",
    );
  } catch (error) {
    if (parsed) {
      writeLog(
        parsed.owner,
        parsed.repo,
        parsed.issueNumber,
        `Error: ${error.message}`,
      );
    }
    console.error("Error fetching issue:", error.message);
    process.exit(1);
  }
}

/**
 * Handle 'explore' command for a repository
 */
async function handleExploreRepo(owner, repo) {
  writeLog(owner, repo, "explore", "Exploring repository issues");
  console.log(`Fetching issues from ${owner}/${repo}...\n`);

  const openIssues = await fetchIssues(owner, repo, "open");
  writeLog(
    owner,
    repo,
    "explore",
    `Found ${openIssues.length} open issue(s)`,
  );

  if (openIssues.length === 0) {
    console.log("No open issues found in this repository.");
    process.exit(0);
  }

  console.log("=".repeat(60));
  console.log(`ISSUES IN ${owner}/${repo}`);
  console.log("=".repeat(60));
  console.log(`\nFound ${openIssues.length} open issue(s):\n`);

  // Group issues by labels for better organization
  const labelGroups = new Map();
  const unlabeled = [];

  openIssues.forEach((issue) => {
    if (issue.labels?.length > 0) {
      issue.labels.forEach((label) => {
        if (!labelGroups.has(label.name)) {
          labelGroups.set(label.name, []);
        }
        labelGroups.get(label.name).push(issue);
      });
    } else {
      unlabeled.push(issue);
    }
  });

  // Print issues grouped by label
  console.log("ISSUES BY LABEL:");
  console.log("-".repeat(40));

  for (const [label, issues] of labelGroups) {
    console.log(`\n[${label}] (${issues.length} issues)`);
    issues.forEach((issue) => {
      console.log(`  #${issue.number}: ${issue.title}`);
    });
  }

  if (unlabeled.length > 0) {
    console.log(`\n[unlabeled] (${unlabeled.length} issues)`);
    unlabeled.forEach((issue) => {
      console.log(`  #${issue.number}: ${issue.title}`);
    });
  }

  console.log("\n" + "=".repeat(60));
  console.log("ALL ISSUES (numbered list for selection):");
  console.log("=".repeat(60));

  openIssues.forEach((issue, index) => {
    const labels =
      issue.labels?.length > 0
        ? ` [${issue.labels.map((l) => l.name).join(", ")}]`
        : "";
    console.log(`${index + 1}. #${issue.number}: ${issue.title}${labels}`);
  });

  console.log("\n" + "=".repeat(60));
  console.log("NEXT STEPS:");
  console.log("=".repeat(60));
  console.log(`
Ask the user which issues they want to work on. They can specify:
- A label name (e.g., "todo", "bug", "enhancement") to work on all issues with that label
- Specific issue numbers (e.g., "#123, #456")
- "all" to work on all open issues

Once the user selects, process each issue one by one:
1. Fetch the full issue details using: /grog-solve https://github.com/${owner}/${repo}/issues/<number>
2. Implement the solution
3. Commit the changes
4. Move to the next issue

Repository URL for issues: https://github.com/${owner}/${repo}/issues/
`);
}

/**
 * Handle 'explore' command for a GitHub Project
 */
async function handleExploreProject(owner, projectNumber, isOrg) {
  const projectType = isOrg ? "organization" : "user";
  writeLog(
    owner,
    `project-${projectNumber}`,
    "explore",
    `Exploring ${projectType} project #${projectNumber}`,
  );
  console.log(
    `Fetching project #${projectNumber} from ${projectType} ${owner}...\n`,
  );

  const project = await fetchProjectItems(owner, projectNumber, isOrg);

  console.log("=".repeat(60));
  console.log(`PROJECT: ${project.title}`);
  console.log("=".repeat(60));
  console.log(`URL: ${project.url}\n`);

  // Get status field options if available
  const statusField = project.fields?.nodes?.find(
    (f) => f.name?.toLowerCase() === "status",
  );
  const statusOptions = statusField?.options?.map((o) => o.name) || [];

  // Process items and group by status
  const itemsByStatus = new Map();
  const issues = [];

  for (const item of project.items.nodes) {
    const content = item.content;
    if (!content || !content.number) continue; // Skip draft issues without numbers

    // Get status from field values
    let status = "No Status";
    for (const fieldValue of item.fieldValues.nodes) {
      if (
        fieldValue.field?.name?.toLowerCase() === "status" &&
        fieldValue.name
      ) {
        status = fieldValue.name;
        break;
      }
    }

    const issueData = {
      number: content.number,
      title: content.title,
      state: content.state,
      url: content.url,
      body: content.body,
      repo: content.repository?.name,
      owner: content.repository?.owner?.login,
      labels: content.labels?.nodes?.map((l) => l.name) || [],
      author: content.author?.login,
      createdAt: content.createdAt,
      status,
    };

    issues.push(issueData);

    if (!itemsByStatus.has(status)) {
      itemsByStatus.set(status, []);
    }
    itemsByStatus.get(status).push(issueData);
  }

  if (issues.length === 0) {
    console.log("No issues found in this project.");
    process.exit(0);
  }

  // Filter out "Done" issues for display
  const activeIssues = issues.filter((i) => i.status.toLowerCase() !== "done");
  const doneCount = issues.length - activeIssues.length;

  console.log(
    `Found ${issues.length} issue(s) total (${doneCount} done, ${activeIssues.length} active):\n`,
  );

  // Print available statuses with counts
  if (statusOptions.length > 0) {
    console.log("STATUSES:");
    console.log("-".repeat(40));
    statusOptions.forEach((s) => {
      const count = itemsByStatus.get(s)?.length || 0;
      const marker = s.toLowerCase() === "done" ? " (hidden)" : "";
      console.log(`  [${s}] - ${count} issue(s)${marker}`);
    });
    console.log("");
  }

  console.log("=".repeat(60));
  console.log("NEXT STEPS:");
  console.log("=".repeat(60));
  console.log(`
Ask the user which issues they want to work on. They can specify:
- A status name (e.g., "Todo", "In Progress") to work on all issues with that status
- Specific issue references (e.g., "repo#123, repo#456")
- "all" to work on all active issues

Once the user selects, process each issue one by one:
1. Fetch the full issue details using: /grog-solve <issue-url>
2. Implement the solution
3. Commit the changes
4. Move to the next issue

Active issues:
${activeIssues.length > 0 ? activeIssues.map((i) => `  ${i.owner}/${i.repo}#${i.number} ${i.title}`).join("\n") : "  (none)"}
`);
}

/**
 * Handle 'explore' command - list issues from a project or repo for batch processing
 */
async function handleExplore(url) {
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    console.error("Error: Invalid GitHub URL");
    console.error("Expected formats:");
    console.error("  - Repository: https://github.com/owner/repo");
    console.error(
      "  - Org Project: https://github.com/orgs/orgname/projects/123",
    );
    console.error(
      "  - User Project: https://github.com/users/username/projects/123",
    );
    process.exit(1);
  }

  try {
    if (parsed.type === "repo") {
      await handleExploreRepo(parsed.owner, parsed.repo);
    } else if (parsed.type === "project") {
      await handleExploreProject(
        parsed.owner,
        parsed.projectNumber,
        parsed.isOrg,
      );
    }
  } catch (error) {
    console.error("Error:", error.message);
    process.exit(1);
  }
}

/**
 * Handle 'logs' command - view recent worker logs for an issue
 */
function handleLogs(identifier, lines) {
  if (!existsSync(LOGS_DIR)) {
    console.log("No logs found. Workers haven't run yet.");
    process.exit(0);
  }

  // If identifier is "--all" or not provided, list all log files
  if (!identifier || identifier === "--all") {
    const files = readdirSync(LOGS_DIR)
      .filter((f) => f.endsWith(".log"))
      .map((f) => {
        const filePath = join(LOGS_DIR, f);
        const stats = statSync(filePath);
        return { name: f, mtime: stats.mtime, size: stats.size };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      console.log("No logs found.");
      process.exit(0);
    }

    console.log("=".repeat(60));
    console.log("GROG WORKER LOGS");
    console.log("=".repeat(60));
    console.log(`\nFound ${files.length} log file(s) in ${LOGS_DIR}:\n`);

    files.forEach((f) => {
      const issueId = f.name.replace(".log", "");
      const age = getTimeAgo(f.mtime);
      console.log(`  ${issueId}`);
      console.log(
        `    Last updated: ${age} (${f.mtime.toLocaleString()})`,
      );
      console.log(`    Size: ${(f.size / 1024).toFixed(1)} KB`);
      console.log("");
    });

    console.log("-".repeat(60));
    console.log("To view logs for a specific issue:");
    console.log("  grog logs <owner/repo#number>");
    console.log("  grog logs <github-issue-url>");
    console.log("  grog logs <owner-repo-issue-number>");
    process.exit(0);
  }

  // Parse the identifier to find the log file
  const logPath = resolveLogPath(identifier);
  if (!logPath) {
    console.error(`No logs found for: ${identifier}`);
    console.error("");
    console.error("Try one of these formats:");
    console.error("  grog logs owner/repo#123");
    console.error(
      "  grog logs https://github.com/owner/repo/issues/123",
    );
    console.error("  grog logs owner-repo-issue-123");
    console.error("  grog logs --all    (list all log files)");
    process.exit(1);
  }

  if (!existsSync(logPath)) {
    console.error(`No logs found for: ${identifier}`);
    console.error(`Expected log file: ${logPath}`);
    process.exit(1);
  }

  const content = readFileSync(logPath, "utf-8");
  const allLines = content.trim().split("\n");
  const maxLines = lines || 50;
  const displayLines = allLines.slice(-maxLines);

  const logName = logPath
    .replace(LOGS_DIR + "/", "")
    .replace(".log", "");

  console.log("=".repeat(60));
  console.log(`WORKER LOGS: ${logName}`);
  console.log("=".repeat(60));
  console.log(`Log file: ${logPath}`);
  console.log(`Total entries: ${allLines.length}`);
  if (allLines.length > maxLines) {
    console.log(
      `Showing last ${maxLines} entries (use --lines=N for more)`,
    );
  }
  console.log("-".repeat(60));
  console.log("");
  displayLines.forEach((line) => console.log(line));
  console.log("");
  console.log("=".repeat(60));
}

/**
 * Resolve a log file path from various identifier formats
 * @param {string} identifier - Could be owner/repo#123, a URL, or owner-repo-issue-123
 * @returns {string|null}
 */
function resolveLogPath(identifier) {
  // Try as GitHub issue URL
  const urlParsed = parseGitHubIssueUrl(identifier);
  if (urlParsed) {
    return getLogPath(urlParsed.owner, urlParsed.repo, urlParsed.issueNumber);
  }

  // Try as owner/repo#number format
  const shortMatch = identifier.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (shortMatch) {
    return getLogPath(shortMatch[1], shortMatch[2], shortMatch[3]);
  }

  // Try as owner-repo-issue-number format (log file name)
  const logNameMatch = identifier.match(/^(.+)-(.+)-issue-(\d+)$/);
  if (logNameMatch) {
    return getLogPath(logNameMatch[1], logNameMatch[2], logNameMatch[3]);
  }

  // Try as a plain issue number - search for matching log files
  if (/^\d+$/.test(identifier) && existsSync(LOGS_DIR)) {
    const files = readdirSync(LOGS_DIR).filter(
      (f) => f.endsWith(`-issue-${identifier}.log`),
    );
    if (files.length === 1) {
      return join(LOGS_DIR, files[0]);
    }
    if (files.length > 1) {
      console.log(`Multiple logs found for issue #${identifier}:`);
      files.forEach((f) => console.log(`  ${f.replace(".log", "")}`));
      console.log("\nPlease use the full identifier (e.g., owner/repo#" + identifier + ")");
      process.exit(1);
    }
  }

  return null;
}

/**
 * Get a human-readable time ago string
 * @param {Date} date
 * @returns {string}
 */
function getTimeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Main function
 */
async function main() {
  const command = process.argv[2];
  const url = process.argv[3];

  if (!command) {
    console.log("Usage:");
    console.log(
      "  grog solve <github-issue-url>      - Fetch and solve a single issue",
    );
    console.log(
      "  grog explore <github-project-url>  - List all issues for batch processing",
    );
    console.log(
      "  grog logs [issue-id]               - View recent worker logs",
    );
    console.log("");
    console.log("Examples:");
    console.log("  grog solve https://github.com/owner/repo/issues/123");
    console.log("  grog explore https://github.com/owner/repo");
    console.log("  grog explore https://github.com/orgs/myorg/projects/1");
    console.log("  grog logs --all");
    console.log("  grog logs owner/repo#123");
    console.log(
      "  grog logs https://github.com/owner/repo/issues/123",
    );
    process.exit(1);
  }

  switch (command) {
    case "solve":
      if (!url) {
        console.error("Error: Missing issue URL");
        console.log("Usage: grog solve <github-issue-url>");
        process.exit(1);
      }
      await handleSolve(url);
      break;

    case "explore":
      if (!url) {
        console.error("Error: Missing URL");
        console.log("Usage: grog explore <github-repo-or-project-url>");
        process.exit(1);
      }
      await handleExplore(url);
      break;

    case "logs": {
      const linesArg = process.argv[4];
      let lines;
      if (linesArg && linesArg.startsWith("--lines=")) {
        lines = parseInt(linesArg.split("=")[1], 10);
      }
      handleLogs(url, lines);
      break;
    }

    default:
      // Backwards compatibility: if the argument looks like an issue URL, treat it as 'solve'
      if (command.includes("github.com") && command.includes("/issues/")) {
        await handleSolve(command);
      } else if (command.includes("github.com")) {
        await handleExplore(command);
      } else {
        console.error(`Unknown command: ${command}`);
        console.log("Available commands: solve, explore");
        process.exit(1);
      }
  }
}

main();
