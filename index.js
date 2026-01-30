#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { writeFileSync, mkdirSync, existsSync, renameSync } from "fs";

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
  const rawUrlRegex = /https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]+/gi;
  while ((match = rawUrlRegex.exec(body)) !== null) {
    urls.add(match[0]);
  }

  // Match private user images
  const privateImageRegex = /https:\/\/private-user-images\.githubusercontent\.com\/[^\s"'<>]+/gi;
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
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const buffer = await response.arrayBuffer();
  writeFileSync(outputPath, Buffer.from(buffer));

  return { contentType, size: buffer.byteLength };
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

    // Extract and download images
    const imageUrls = extractImageUrls(issue.body);

    if (imageUrls.length > 0) {
      console.log(`\nFound ${imageUrls.length} image attachment(s). Downloading...\n`);

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
          const filename = `${parsed.repo}-issue-${parsed.issueNumber}-img-${i + 1}.${ext}`;
          const finalPath = join(outputDir, filename);
          renameSync(tempPath, finalPath);
          console.log(`  Downloaded: ${finalPath} (${(size / 1024).toFixed(1)} KB)`);
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

  } catch (error) {
    console.error("Error fetching issue:", error.message);
    process.exit(1);
  }
}

main();
