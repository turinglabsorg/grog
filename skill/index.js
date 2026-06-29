#!/usr/bin/env node

import { config } from "dotenv";
import { fileURLToPath } from "url";
import { basename, dirname, join } from "path";
import { writeFileSync, readFileSync, mkdirSync, existsSync, renameSync, statSync } from "fs";
import { homedir } from "os";
import { execFileSync, execSync } from "child_process";

// Load config from ~/.grog/config.json (primary) with .env fallback
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
config({ path: join(__dirname, ".env") });

const GROG_CONFIG_PATH = join(homedir(), ".grog", "config.json");

function loadGrogConfig() {
  try {
    return JSON.parse(readFileSync(GROG_CONFIG_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveGrogConfig(nextConfig) {
  mkdirSync(dirname(GROG_CONFIG_PATH), { recursive: true });
  const tmpPath = `${GROG_CONFIG_PATH}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(nextConfig, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmpPath, GROG_CONFIG_PATH);
}

const grogConfig = loadGrogConfig();

// Config precedence: ~/.grog/config.json > .env > process.env
const GH_TOKEN = grogConfig.ghToken || process.env.GH_TOKEN;
const TELEGRAM_BOT_TOKEN = grogConfig.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = grogConfig.telegramChatId || process.env.TELEGRAM_CHAT_ID;
const TELEGRAM_STATE_FILE = "/tmp/grog-telegram-state.json";
const TELEGRAM_DOWNLOAD_DIR = "/tmp/grog-telegram-files";

// Zernio (WhatsApp) bridge config — https://zernio.com/api
const ZERNIO_API_KEY = grogConfig.zernio?.apiKey || process.env.ZERNIO_API_KEY;
const ZERNIO_WA_ACCOUNT_ID =
  grogConfig.zernio?.whatsappAccountId || process.env.ZERNIO_WA_ACCOUNT_ID;
// Optional: pin the bridge to a specific recipient phone (international digits).
const ZERNIO_WA_PARTICIPANT =
  grogConfig.zernio?.whatsappParticipantId || process.env.ZERNIO_WA_PARTICIPANT;
// Optional: template used by `notify` to re-engage outside the 24h window.
const ZERNIO_WA_TEMPLATE = grogConfig.zernio?.whatsappTemplate || {
  name: "robin_message_it",
  language: "it",
};
const ZERNIO_BASE = "https://zernio.com/api/v1";
const WHATSAPP_STATE_FILE = "/tmp/grog-whatsapp-state.json";

// Which channel the generic talk/recv/send/notify commands use.
// Precedence: --whatsapp/--telegram flag (handled in main) > GROG_CHANNEL env >
// config.channel > "telegram" (backward compatible default).
const GROG_CHANNEL = (
  process.env.GROG_CHANNEL ||
  grogConfig.channel ||
  "telegram"
).toLowerCase();

function normalizeContactKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "-");
}

function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function getAddressBook(configValue = grogConfig) {
  const book = configValue.addressBook || configValue.contacts || {};
  return book && typeof book === "object" && !Array.isArray(book) ? book : {};
}

function findAddressBookContact(alias, configValue = grogConfig) {
  const key = normalizeContactKey(alias);
  if (!key) return null;
  const book = getAddressBook(configValue);
  if (book[key]) return { key, contact: book[key] };
  const match = Object.entries(book).find(([candidate]) => normalizeContactKey(candidate) === key);
  return match ? { key: match[0], contact: match[1] } : null;
}

function getContactChannel(contact, channel) {
  if (!contact || typeof contact !== "object") return null;
  if (channel === "whatsapp") return contact.whatsapp || contact.whatsappPhone || contact.phone || null;
  if (channel === "telegram") return contact.telegram || contact.telegramChatId || contact.chatId || null;
  return null;
}

function resolveAddressBookTarget(channel, recipient) {
  if (!recipient) return null;

  const match = findAddressBookContact(recipient);
  if (match) {
    const value = getContactChannel(match.contact, channel);
    if (!value) {
      console.error(`! error: contact "${match.key}" has no ${channel} destination`);
      process.exit(1);
    }
    return {
      label: match.key,
      value: channel === "whatsapp" ? normalizePhone(value) : String(value),
      fromAddressBook: true,
    };
  }

  if (channel === "whatsapp") {
    const digits = normalizePhone(recipient);
    if (digits.length >= 6) {
      return { label: recipient, value: digits, fromAddressBook: false };
    }
  }

  if (channel === "telegram" && /^-?\d+$/.test(String(recipient).trim())) {
    return { label: recipient, value: String(recipient).trim(), fromAddressBook: false };
  }

  console.error(`! error: unknown contact "${recipient}"`);
  console.error("  save it with: grog contacts save <alias> --whatsapp <phone> --telegram <chat-id>");
  process.exit(1);
}

function parseRecipientArgs(args) {
  const rest = [];
  let to = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--to" || arg === "--contact" || arg === "--recipient") {
      to = args[++i];
      if (!to) {
        console.error(`! error: ${arg} requires a contact alias or destination`);
        process.exit(1);
      }
    } else if (arg.startsWith("--to=")) {
      to = arg.slice("--to=".length);
    } else if (arg.startsWith("--contact=")) {
      to = arg.slice("--contact=".length);
    } else if (arg.startsWith("--recipient=")) {
      to = arg.slice("--recipient=".length);
    } else {
      rest.push(arg);
    }
  }

  return { to, rest };
}

function readMessageFromArgs(args) {
  if (args.length === 1 && existsSync(args[0])) {
    return readFileSync(args[0], "utf-8").trim();
  }
  return args.join(" ");
}

function sanitizeTelegramFileName(value) {
  const name = basename(String(value || "telegram-file")).replace(/[^a-zA-Z0-9._-]/g, "_");
  return name || "telegram-file";
}

function isTelegramTextDocument(document) {
  const name = String(document?.file_name || "").toLowerCase();
  const mime = String(document?.mime_type || "").toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/x-yaml"].includes(mime)) return true;
  return [
    ".md",
    ".markdown",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".csv",
    ".tsv",
    ".log",
  ].some((suffix) => name.endsWith(suffix));
}

function parseContactFields(args) {
  const rest = [];
  const fields = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const readValue = (flag) => {
      const value = args[++i];
      if (!value) {
        console.error(`! error: ${flag} requires a value`);
        process.exit(1);
      }
      return value;
    };

    if (arg === "--name") fields.name = readValue(arg);
    else if (arg.startsWith("--name=")) fields.name = arg.slice("--name=".length);
    else if (arg === "--whatsapp" || arg === "--wa" || arg === "--phone") {
      fields.whatsapp = normalizePhone(readValue(arg));
    } else if (arg.startsWith("--whatsapp=")) {
      fields.whatsapp = normalizePhone(arg.slice("--whatsapp=".length));
    } else if (arg.startsWith("--wa=")) {
      fields.whatsapp = normalizePhone(arg.slice("--wa=".length));
    } else if (arg.startsWith("--phone=")) {
      fields.whatsapp = normalizePhone(arg.slice("--phone=".length));
    } else if (arg === "--telegram" || arg === "--tg" || arg === "--chat-id") {
      fields.telegram = String(readValue(arg)).trim();
    } else if (arg.startsWith("--telegram=")) {
      fields.telegram = arg.slice("--telegram=".length).trim();
    } else if (arg.startsWith("--tg=")) {
      fields.telegram = arg.slice("--tg=".length).trim();
    } else if (arg.startsWith("--chat-id=")) {
      fields.telegram = arg.slice("--chat-id=".length).trim();
    } else {
      rest.push(arg);
    }
  }

  return { fields, rest };
}

function printContact(alias, contact) {
  const parts = [];
  const whatsapp = getContactChannel(contact, "whatsapp");
  const telegram = getContactChannel(contact, "telegram");
  if (whatsapp) parts.push(`whatsapp=${normalizePhone(whatsapp)}`);
  if (telegram) parts.push(`telegram=${telegram}`);
  const name = contact?.name ? ` (${contact.name})` : "";
  console.log(`- ${alias}${name}: ${parts.join(", ") || "(no channels)"}`);
}

async function handleContacts(args) {
  const action = args[0] || "list";

  if (action === "list" || action === "ls") {
    const book = getAddressBook();
    const entries = Object.entries(book).sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0) {
      console.log("> no contacts saved");
      return;
    }
    for (const [alias, contact] of entries) printContact(alias, contact);
    return;
  }

  if (action === "get" || action === "show") {
    const alias = args[1];
    if (!alias) {
      console.error("! error: missing contact alias");
      console.log("  usage: grog contacts get <alias>");
      process.exit(1);
    }
    const match = findAddressBookContact(alias);
    if (!match) {
      console.error(`! error: contact "${alias}" not found`);
      process.exit(1);
    }
    printContact(match.key, match.contact);
    return;
  }

  if (action === "save" || action === "set" || action === "add") {
    const alias = args[1];
    if (!alias) {
      console.error("! error: missing contact alias");
      console.log("  usage: grog contacts save <alias> [--name NAME] [--whatsapp PHONE] [--telegram CHAT_ID]");
      process.exit(1);
    }
    const { fields } = parseContactFields(args.slice(2));
    if (Object.keys(fields).length === 0) {
      console.error("! error: missing contact fields");
      console.log("  usage: grog contacts save <alias> [--name NAME] [--whatsapp PHONE] [--telegram CHAT_ID]");
      process.exit(1);
    }

    const key = normalizeContactKey(alias);
    const nextConfig = loadGrogConfig();
    const book = { ...getAddressBook(nextConfig) };
    book[key] = { ...(book[key] || {}), ...fields };
    nextConfig.addressBook = book;
    saveGrogConfig(nextConfig);
    console.log(`> saved contact ${key}`);
    return;
  }

  if (action === "remove" || action === "rm" || action === "delete") {
    const alias = args[1];
    if (!alias) {
      console.error("! error: missing contact alias");
      console.log("  usage: grog contacts remove <alias>");
      process.exit(1);
    }
    const key = normalizeContactKey(alias);
    const nextConfig = loadGrogConfig();
    const book = { ...getAddressBook(nextConfig) };
    if (!book[key]) {
      console.error(`! error: contact "${alias}" not found`);
      process.exit(1);
    }
    delete book[key];
    nextConfig.addressBook = book;
    saveGrogConfig(nextConfig);
    console.log(`> removed contact ${key}`);
    return;
  }

  console.error(`! error: unknown contacts action "${action}"`);
  console.log("  usage: grog contacts [list|get|save|remove] ...");
  process.exit(1);
}

/**
 * Locate the nearest `.grog` file walking upward from cwd.
 * Returns the file path or null.
 */
function findGrogFile(startDir) {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, ".grog");
    if (existsSync(candidate)) {
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {}
      // Skip directories named .grog (e.g. ~/.grog/ config dir)
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve which Linear workspace to use. Requires a `.grog` file in the
 * current project (searched upward from cwd) with a `workspace=NAME` line.
 * The name must match a key in config.linear. No fallback — if anything is
 * missing, exits with an actionable error.
 */
function resolveLinearApiKey() {
  const envOverride = process.env.GROG_WORKSPACE;
  let workspace = envOverride;
  let source = "GROG_WORKSPACE env";

  if (!workspace) {
    const grogFile = findGrogFile(process.cwd());
    if (!grogFile) {
      console.error("! error: no .grog file found in this project");
      console.error("  grog refuses to touch Linear without an explicit workspace declaration.");
      console.error("  create a .grog file in your project root with a line like:");
      console.error("    workspace=MTROPRO");
      console.error("  available workspaces:", Object.keys(grogConfig.linear || {}).join(", ") || "(none configured)");
      process.exit(1);
    }
    const content = readFileSync(grogFile, "utf-8");
    const match = content.match(/^\s*workspace\s*=\s*(\S+)\s*$/m);
    if (!match) {
      console.error(`! error: ${grogFile} has no 'workspace=NAME' line`);
      process.exit(1);
    }
    workspace = match[1];
    source = grogFile;
  }

  const keys = grogConfig.linear || {};
  const key = keys[workspace];
  if (!key) {
    console.error(`! error: workspace "${workspace}" (from ${source}) not configured in ~/.grog/config.json`);
    console.error("  expected shape: { \"linear\": { \"" + workspace + "\": \"lin_api_...\" } }");
    console.error("  configured workspaces:", Object.keys(keys).join(", ") || "(none)");
    process.exit(1);
  }
  return { key, workspace, source };
}

function detectPlatform(url) {
  if (!url) return null;
  if (url.includes("jam.dev/")) return "jam";
  if (url.includes("linear.app")) return "linear";
  if (url.includes("github.com")) return "github";
  return null;
}

function parseJamUrl(url) {
  if (!url) return null;
  const match = url.match(/^https?:\/\/(?:www\.)?jam\.dev\/c\/([A-Za-z0-9-]+)(?:[/?#].*)?$/);
  if (!match) return null;
  return {
    id: match[1],
    url: `https://jam.dev/c/${match[1]}`,
  };
}

function decodeHtmlEntities(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/");
}

function extractMetaContent(html, property) {
  const patterns = [
    new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+name=["']${property}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtmlEntities(match[1].trim());
  }
  return "";
}

function extractTitle(html) {
  const ogTitle = extractMetaContent(html, "og:title");
  if (ogTitle) return ogTitle;
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim();
  return title ? decodeHtmlEntities(title) : "";
}

function extractJamAssets(html) {
  const assets = new Set();
  const assetPattern = /https?:\/\/[^"'\\\s<>]+(?:\.png|\.jpe?g|\.webp|\.gif|\.mp4|\.webm)(?:\?[^"'\\\s<>]*)?/gi;
  for (const match of html.matchAll(assetPattern)) {
    assets.add(match[0]);
  }
  const ogImage = extractMetaContent(html, "og:image");
  if (ogImage) assets.add(ogImage);
  const ogVideo = extractMetaContent(html, "og:video");
  if (ogVideo) assets.add(ogVideo);
  return Array.from(assets);
}

function requireGhToken() {
  if (!GH_TOKEN) {
    console.error("! error: GH_TOKEN not found");
    console.error("  add it to ~/.grog/config.json or ~/.claude/tools/grog/.env");
    process.exit(1);
  }
}

/**
 * Lazily resolved on first Linear call. Cached module-wide.
 * Structure: { key, workspace, source } — see resolveLinearApiKey().
 */
let _linearAuth = null;
function requireLinearToken() {
  if (!_linearAuth) _linearAuth = resolveLinearApiKey();
  return _linearAuth;
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
 * Parse GitHub pull request URL
 * @param {string} url - GitHub PR URL like https://github.com/owner/repo/pull/123
 * @returns {{ owner: string, repo: string, prNumber: string } | null}
 */
function parseGitHubPrUrl(url) {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2],
    prNumber: match[3],
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

// ─────────────────────────────────────────────────────────
// Linear URL Parsers & API
// ─────────────────────────────────────────────────────────

/**
 * Parse Linear issue URL
 * @param {string} url - Linear issue URL like https://linear.app/workspace/issue/PROJ-123 or https://linear.app/workspace/issue/PROJ-123/title-slug
 * @returns {{ workspace: string, identifier: string } | null}
 */
function parseLinearIssueUrl(url) {
  const match = url.match(/linear\.app\/([^/]+)\/issue\/([A-Z0-9]+-\d+)/);
  if (!match) return null;
  return { workspace: match[1], identifier: match[2] };
}

function parseLinearIssueIdentifier(ref) {
  const parsed = parseLinearIssueUrl(ref);
  if (parsed) return parsed.identifier;
  if (/^[A-Z0-9]+-\d+$/.test(ref)) return ref;
  return null;
}

/**
 * Parse Linear team/project URL for exploration
 * @param {string} url - Linear URL like https://linear.app/workspace/team/PROJ/... or https://linear.app/workspace/project/...
 * @returns {{ type: string, workspace: string, teamKey?: string, projectId?: string } | null}
 */
function parseLinearUrl(url) {
  // Team view: https://linear.app/workspace/team/PROJ/active (or /backlog, /all, etc.)
  const teamMatch = url.match(/linear\.app\/([^/]+)\/team\/([^/]+)/);
  if (teamMatch) {
    return { type: "team", workspace: teamMatch[1], teamKey: teamMatch[2] };
  }

  // Project: https://linear.app/workspace/project/project-slug-id
  const projectMatch = url.match(/linear\.app\/([^/]+)\/project\/([^/]+)/);
  if (projectMatch) {
    return { type: "project", workspace: projectMatch[1], projectSlug: projectMatch[2] };
  }

  // Workspace root: https://linear.app/workspace
  const workspaceMatch = url.match(/linear\.app\/([^/]+)\/?$/);
  if (workspaceMatch) {
    return { type: "workspace", workspace: workspaceMatch[1] };
  }

  return null;
}

/**
 * Execute a Linear GraphQL query
 */
async function linearGraphQL(query, variables = {}) {
  const { key } = requireLinearToken();
  const response = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      Authorization: key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(`Linear GraphQL error: ${result.errors.map((e) => e.message).join(", ")}`);
  }
  return result.data;
}

/**
 * Fetch a single Linear issue by identifier (e.g. "PROJ-123")
 */
async function fetchLinearIssue(identifier) {
  const query = `
    query($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        description
        priority
        priorityLabel
        state { name type color }
        assignee { name displayName email }
        creator { name displayName }
        team { key name }
        project { name }
        labels { nodes { name color } }
        comments { nodes { body createdAt user { name displayName } } }
        createdAt
        updatedAt
        url
        estimate
        dueDate
        parent { identifier title }
        children { nodes { identifier title state { name } } }
        relations { nodes { type relatedIssue { identifier title state { name } } } }
        attachments { nodes { title url } }
      }
    }
  `;

  const data = await linearGraphQL(query, { id: identifier });
  if (!data.issue) {
    throw new Error(`Issue not found: ${identifier}`);
  }
  return data.issue;
}

async function fetchLinearIssueWithWorkflowStates(identifier) {
  const query = `
    query($id: String!) {
      issue(id: $id) {
        id
        identifier
        title
        url
        state { id name type }
        team {
          key
          name
          states {
            nodes { id name type }
          }
        }
      }
    }
  `;

  const data = await linearGraphQL(query, { id: identifier });
  if (!data.issue) {
    throw new Error(`Issue not found: ${identifier}`);
  }
  return data.issue;
}

async function markLinearIssueDone(identifier) {
  const issue = await fetchLinearIssueWithWorkflowStates(identifier);
  const states = issue.team?.states?.nodes || [];
  const doneState =
    states.find(
      (state) =>
        state.type === "completed" &&
        state.name?.toLowerCase() === "done",
    ) ||
    states.find((state) => state.type === "completed");

  if (!doneState) {
    throw new Error(
      `No completed workflow state found for team ${issue.team?.key || "unknown"}`,
    );
  }

  if (issue.state?.id === doneState.id) {
    return {
      issue,
      changed: false,
      previousState: issue.state,
      targetState: doneState,
    };
  }

  const mutation = `
    mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state { id name type }
        }
      }
    }
  `;

  const data = await linearGraphQL(mutation, {
    id: issue.id,
    input: { stateId: doneState.id },
  });

  if (!data.issueUpdate?.success) {
    throw new Error("Failed to update Linear issue");
  }

  return {
    issue: data.issueUpdate.issue,
    changed: true,
    previousState: issue.state,
    targetState: doneState,
  };
}

async function markLinearIssueStarted(identifier) {
  const issue = await fetchLinearIssueWithWorkflowStates(identifier);
  const states = issue.team?.states?.nodes || [];
  const startedState =
    states.find(
      (state) =>
        state.type === "started" &&
        state.name?.toLowerCase() === "in progress",
    ) ||
    states.find(
      (state) =>
        state.type === "started" &&
        state.name?.toLowerCase().includes("progress"),
    ) ||
    states.find((state) => state.type === "started");

  if (!startedState) {
    throw new Error(
      `No started workflow state found for team ${issue.team?.key || "unknown"}`,
    );
  }

  if (issue.state?.id === startedState.id) {
    return {
      issue,
      changed: false,
      previousState: issue.state,
      targetState: startedState,
    };
  }

  const mutation = `
    mutation($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state { id name type }
        }
      }
    }
  `;

  const data = await linearGraphQL(mutation, {
    id: issue.id,
    input: { stateId: startedState.id },
  });

  if (!data.issueUpdate?.success) {
    throw new Error("Failed to update Linear issue");
  }

  return {
    issue: data.issueUpdate.issue,
    changed: true,
    previousState: issue.state,
    targetState: startedState,
  };
}

/**
 * Fetch Linear issues by team key
 */
async function fetchLinearTeamIssues(teamKey) {
  const query = `
    query($teamKey: String!) {
      teams(filter: { key: { eq: $teamKey } }) {
        nodes {
          id
          name
          key
          issues(
            filter: { state: { type: { nin: ["canceled", "completed"] } } }
            orderBy: updatedAt
            first: 50
          ) {
            nodes {
              identifier
              title
              priority
              priorityLabel
              state { name }
              assignee { displayName }
              url
            }
          }
        }
      }
    }
  `;

  const data = await linearGraphQL(query, { teamKey });
  const team = data.teams?.nodes?.[0];
  if (!team) {
    throw new Error(`Team not found: ${teamKey}`);
  }
  return team;
}

/**
 * Fetch all teams for workspace exploration (lightweight — no issues)
 */
async function fetchLinearTeams() {
  const query = `
    query {
      teams {
        nodes {
          id
          key
          name
          issueCount
        }
      }
    }
  `;

  const data = await linearGraphQL(query);
  return data.teams?.nodes || [];
}

async function fetchLinearTeamByKey(teamKey) {
  const query = `
    query($teamKey: String!) {
      teams(filter: { key: { eq: $teamKey } }, first: 1) {
        nodes {
          id
          key
          name
        }
      }
    }
  `;

  const data = await linearGraphQL(query, { teamKey });
  const team = data.teams?.nodes?.[0];
  if (!team) {
    throw new Error(`Team not found: ${teamKey}`);
  }
  return team;
}

async function createLinearIssue({ teamKey, title, description, priority }) {
  const team = await fetchLinearTeamByKey(teamKey);
  const mutation = `
    mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success
        issue {
          id
          identifier
          title
          url
          state { name type }
          team { key name }
        }
      }
    }
  `;

  const input = {
    teamId: team.id,
    title,
    description: description || "",
  };
  if (priority != null) input.priority = priority;

  const data = await linearGraphQL(mutation, { input });
  if (!data.issueCreate?.success) {
    throw new Error("Failed to create Linear issue");
  }
  return data.issueCreate.issue;
}

/**
 * Fetch Linear project issues by slug
 */
async function fetchLinearProjectIssues(projectSlug) {
  const query = `
    query($slug: String!) {
      projects(filter: { slugId: { eq: $slug } }, first: 1) {
        nodes {
          name
          description
          state
          url
          issues(
            filter: { state: { type: { nin: ["canceled", "completed"] } } }
            orderBy: updatedAt
            first: 50
          ) {
            nodes {
              identifier
              title
              priority
              priorityLabel
              state { name }
              assignee { displayName }
              team { key }
              url
            }
          }
        }
      }
    }
  `;

  const data = await linearGraphQL(query, { slug: projectSlug });
  const project = data.projects?.nodes?.[0];
  if (!project) {
    throw new Error(`Project not found: ${projectSlug}`);
  }
  return project;
}

/**
 * Post a comment on a Linear issue
 */
async function postLinearComment(issueIdentifier, body) {
  const issueData = await linearGraphQL(
    `query($id: String!) { issue(id: $id) { id } }`,
    { id: issueIdentifier },
  );

  if (!issueData.issue) {
    throw new Error(`Issue not found: ${issueIdentifier}`);
  }

  const mutation = `
    mutation($issueId: String!, $body: String!) {
      commentCreate(input: { issueId: $issueId, body: $body }) {
        success
        comment { id url }
      }
    }
  `;

  const data = await linearGraphQL(mutation, {
    issueId: issueData.issue.id,
    body,
  });

  if (!data.commentCreate?.success) {
    throw new Error("Failed to create comment on Linear issue");
  }

  return data.commentCreate.comment;
}

function contentTypeForFile(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  throw new Error(`Unsupported image type: ${filePath}`);
}

function isSupportedImagePath(filePath) {
  if (!filePath || !existsSync(filePath)) return false;
  try {
    return contentTypeForFile(filePath).startsWith("image/");
  } catch {
    return false;
  }
}

async function uploadLinearFile(filePath, { makePublic = true } = {}) {
  const file = readFileSync(filePath);
  const contentType = contentTypeForFile(filePath);

  const data = await linearGraphQL(
    `
      mutation($filename: String!, $contentType: String!, $size: Int!, $makePublic: Boolean) {
        fileUpload(filename: $filename, contentType: $contentType, size: $size, makePublic: $makePublic) {
          success
          uploadFile {
            filename
            contentType
            size
            uploadUrl
            assetUrl
            headers { key value }
          }
        }
      }
    `,
    {
      filename: basename(filePath),
      contentType,
      size: file.length,
      makePublic,
    },
  );

  const uploadFile = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !uploadFile?.uploadUrl || !uploadFile?.assetUrl) {
    throw new Error(`Failed to create Linear upload for ${filePath}`);
  }

  const headers = {};
  for (const header of uploadFile.headers || []) {
    headers[header.key] = header.value;
  }
  if (!Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["Content-Type"] = contentType;
  }

  const response = await fetch(uploadFile.uploadUrl, {
    method: "PUT",
    headers,
    body: file,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to upload ${filePath}: ${response.status} ${response.statusText}${text ? ` - ${text}` : ""}`);
  }

  return uploadFile.assetUrl;
}

function parseImageArgs(args) {
  const imagePaths = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--image" || arg === "-i") {
      const value = args[++i];
      if (!value) throw new Error(`${arg} requires a file path`);
      imagePaths.push(value);
      continue;
    }
    if (arg.startsWith("--image=")) {
      imagePaths.push(arg.slice("--image=".length));
      continue;
    }
    throw new Error(`Unknown answer option: ${arg}`);
  }
  return imagePaths;
}

async function appendLinearImages(body, imagePaths) {
  if (imagePaths.length === 0) return body;

  const lines = [body.trim(), "", "Screenshots:"];
  for (const imagePath of imagePaths) {
    const assetUrl = await uploadLinearFile(imagePath, { makePublic: true });
    lines.push(`![${basename(imagePath)}](${assetUrl})`);
  }
  return lines.join("\n");
}

async function fetchLinearImageAsset(url) {
  const headers = {};
  if (url.includes("uploads.linear.app")) {
    headers.Authorization = requireLinearToken().key;
  }
  return fetch(url, { headers });
}

/**
 * Print Linear issue details
 */
async function printLinearIssueDetails(issue) {
  console.log("");
  boxHeader(`${issue.identifier}: ${issue.title}`);
  console.log("");
  field("state", issue.state?.name || "unknown");
  field("priority", issue.priorityLabel || "none");
  field("team", issue.team ? `${issue.team.key} (${issue.team.name})` : "none");
  if (issue.assignee) field("assignee", issue.assignee.displayName || issue.assignee.name);
  if (issue.creator) field("creator", issue.creator.displayName || issue.creator.name);
  if (issue.project) field("project", issue.project.name);
  if (issue.labels?.nodes?.length > 0) {
    field("labels", issue.labels.nodes.map((l) => l.name).join(", "));
  }
  if (issue.estimate) field("estimate", String(issue.estimate));
  if (issue.dueDate) field("due", issue.dueDate);
  field("created", new Date(issue.createdAt).toLocaleString());
  field("updated", new Date(issue.updatedAt).toLocaleString());
  field("url", issue.url);

  console.log("");
  console.log(hr("─"));
  console.log("");
  console.log(issue.description || "(no description provided)");
  console.log("");
  console.log(hr("─"));

  if (issue.parent) {
    sectionHeader("PARENT ISSUE");
    console.log(`  ${issue.parent.identifier}: ${issue.parent.title}`);
  }

  if (issue.children?.nodes?.length > 0) {
    sectionHeader("SUB-ISSUES");
    console.log("");
    issue.children.nodes.forEach((child) => {
      console.log(`  ${child.identifier}  [${child.state?.name}]  ${child.title}`);
    });
  }

  if (issue.relations?.nodes?.length > 0) {
    sectionHeader("RELATED ISSUES");
    console.log("");
    issue.relations.nodes.forEach((rel) => {
      console.log(`  ${rel.type}: ${rel.relatedIssue.identifier}  [${rel.relatedIssue.state?.name}]  ${rel.relatedIssue.title}`);
    });
  }

  if (issue.attachments?.nodes?.length > 0) {
    sectionHeader("ATTACHMENTS");
    console.log("");
    issue.attachments.nodes.forEach((att) => {
      console.log(`  ${att.title || "attachment"}: ${att.url}`);
    });
  }

  if (issue.comments?.nodes?.length > 0) {
    sectionHeader(`COMMENTS (${issue.comments.nodes.length})`);
    issue.comments.nodes.forEach((comment) => {
      console.log("");
      const author = comment.user?.displayName || comment.user?.name || "unknown";
      const date = new Date(comment.createdAt).toLocaleString();
      console.log(`  ${author} (${date}):`);
      console.log(`  ${comment.body}`);
    });
  }

  // Extract and download images from description
  const imageUrls = extractImageUrls(issue.description);
  if (imageUrls.length > 0) {
    console.log(`\n> ${imageUrls.length} image attachment(s) found. downloading...\n`);

    const outputDir = "/tmp/grog-attachments";
    if (!existsSync(outputDir)) {
      mkdirSync(outputDir, { recursive: true });
    }

    const downloadedFiles = [];
    for (let i = 0; i < imageUrls.length; i++) {
      try {
        const tempPath = join(outputDir, `temp-${Date.now()}-${i}`);
        const response = await fetchLinearImageAsset(imageUrls[i]);
        if (!response.ok) throw new Error(`${response.status}`);
        const buffer = await response.arrayBuffer();
        const contentType = response.headers.get("content-type") || "";
        writeFileSync(tempPath, Buffer.from(buffer));
        const ext = getExtension(contentType);
        const filename = `linear-${issue.identifier}-img-${i + 1}.${ext}`;
        const finalPath = join(outputDir, filename);
        renameSync(tempPath, finalPath);
        console.log(`  > ${finalPath} (${(buffer.byteLength / 1024).toFixed(1)} KB)`);
        downloadedFiles.push(finalPath);
      } catch (err) {
        console.error(`  ! failed to download image ${i + 1}: ${err.message}`);
      }
    }

    if (downloadedFiles.length > 0) {
      sectionHeader("IMAGE ATTACHMENTS");
      console.log("");
      downloadedFiles.forEach((f) => console.log(`  ${f}`));
      console.log("");
      console.log("  (use Read tool to analyze these)");
    }
  }
}

// ─────────────────────────────────────────────────────────
// GitHub API
// ─────────────────────────────────────────────────────────

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
 * Fetch pull request details from GitHub API
 * @param {string} owner
 * @param {string} repo
 * @param {string} prNumber
 */
async function fetchPullRequest(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

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
 * Fetch pull request diff from GitHub API
 * @param {string} owner
 * @param {string} repo
 * @param {string} prNumber
 */
async function fetchPullRequestDiff(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: "application/vnd.github.v3.diff",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API error: ${response.status} ${response.statusText}`,
    );
  }

  return response.text();
}

/**
 * Fetch pull request files (with patch) from GitHub API
 * @param {string} owner
 * @param {string} repo
 * @param {string} prNumber
 */
async function fetchPullRequestFiles(owner, repo, prNumber) {
  const allFiles = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;

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

    const files = await response.json();
    if (files.length === 0) break;
    allFiles.push(...files);
    if (files.length < 100) break;
    page++;
  }

  return allFiles;
}

/**
 * Fetch pull request review comments (inline code comments) from GitHub API
 * @param {string} owner
 * @param {string} repo
 * @param {string} prNumber
 */
async function fetchPullRequestReviewComments(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`;

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
 * Fetch pull request issue comments (conversation comments) from GitHub API
 * @param {string} owner
 * @param {string} repo
 * @param {string} prNumber
 */
async function fetchPullRequestIssueComments(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`;

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
 * Fetch pull request reviews (review decisions) from GitHub API
 * @param {string} owner
 * @param {string} repo
 * @param {string} prNumber
 */
async function fetchPullRequestReviews(owner, repo, prNumber) {
  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews?per_page=100`;

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
 * Print a horizontal rule
 */
function hr(char = "─", width = 60) {
  return char.repeat(width);
}

/**
 * Print a boxed header
 */
function boxHeader(text, width = 60) {
  const inner = width - 2;
  const pad = Math.max(0, inner - text.length);
  const padL = Math.floor(pad / 2);
  const padR = pad - padL;
  console.log("┌" + hr("─", inner) + "┐");
  console.log("│" + " ".repeat(padL) + text + " ".repeat(padR) + "│");
  console.log("└" + hr("─", inner) + "┘");
}

/**
 * Print a section header
 */
function sectionHeader(text, width = 60) {
  console.log("");
  console.log("┌" + hr("─", width - 2) + "┐");
  console.log("│ " + text + " ".repeat(Math.max(0, width - 3 - text.length)) + "│");
  console.log("└" + hr("─", width - 2) + "┘");
}

/**
 * Print a labeled field
 */
function field(label, value) {
  console.log(`  ${label.padEnd(10)} ${value}`);
}

/**
 * Print issue details with image download
 */
async function printIssueDetails(issue, owner, repo) {
  console.log("");
  boxHeader(`#${issue.number}: ${issue.title}`);
  console.log("");
  field("state", issue.state);
  field("author", issue.user?.login || "unknown");
  field("created", new Date(issue.created_at).toLocaleString());
  if (issue.labels?.length > 0) {
    field("labels", issue.labels.map((l) => l.name).join(", "));
  }
  console.log("");
  console.log(hr("─"));
  console.log("");
  console.log(issue.body || "(no description provided)");
  console.log("");
  console.log(hr("─"));

  // Extract and download images
  const imageUrls = extractImageUrls(issue.body);

  if (imageUrls.length > 0) {
    console.log(
      `\n> ${imageUrls.length} image attachment(s) found. downloading...\n`,
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
          `  > ${finalPath} (${(size / 1024).toFixed(1)} KB)`,
        );
        downloadedFiles.push(finalPath);
      } catch (err) {
        console.error(`  ! failed to download image ${i + 1}: ${err.message}`);
      }
    }

    if (downloadedFiles.length > 0) {
      sectionHeader("IMAGE ATTACHMENTS");
      console.log("");
      downloadedFiles.forEach((f) => console.log(`  ${f}`));
      console.log("");
      console.log("  (use Read tool to analyze these)");
    }
  }
}

/**
 * Handle 'solve' command - fetch and display a single issue (GitHub or Linear)
 */
async function handleSolve(issueUrl) {
  const platform = detectPlatform(issueUrl);

  if (platform === "linear") {
    requireLinearToken();
    const parsed = parseLinearIssueUrl(issueUrl);
    if (!parsed) {
      console.error("! error: invalid Linear issue URL");
      console.error("  expected: https://linear.app/workspace/issue/PROJ-123");
      process.exit(1);
    }
    try {
      console.log(`> fetching Linear issue ${parsed.identifier}...`);
      const issue = await fetchLinearIssue(parsed.identifier);
      await printLinearIssueDetails(issue);
    } catch (error) {
      console.error("! error:", error.message);
      process.exit(1);
    }
    return;
  }

  requireGhToken();
  const parsed = parseGitHubIssueUrl(issueUrl);
  if (!parsed) {
    console.error("! error: invalid issue URL");
    console.error("  expected: https://github.com/owner/repo/issues/123");
    console.error("       or:  https://linear.app/workspace/issue/PROJ-123");
    process.exit(1);
  }

  try {
    console.log(
      `> fetching issue #${parsed.issueNumber} from ${parsed.owner}/${parsed.repo}...`,
    );
    const issue = await fetchIssue(
      parsed.owner,
      parsed.repo,
      parsed.issueNumber,
    );
    await printIssueDetails(issue, parsed.owner, parsed.repo);
  } catch (error) {
    console.error("! error:", error.message);
    process.exit(1);
  }
}

async function handleDone(issueRef) {
  if (detectPlatform(issueRef) && detectPlatform(issueRef) !== "linear") {
    console.error("! error: done only supports Linear issues");
    console.error("  usage: grog done <linear-issue-url-or-identifier>");
    process.exit(1);
  }

  requireLinearToken();
  const identifier = parseLinearIssueIdentifier(issueRef);
  if (!identifier) {
    console.error("! error: invalid Linear issue reference");
    console.error("  usage: grog done <linear-issue-url-or-identifier>");
    console.error("  examples:");
    console.error("    grog done https://linear.app/workspace/issue/PROJ-123");
    console.error("    grog done PROJ-123");
    process.exit(1);
  }

  try {
    console.log(`> marking Linear issue ${identifier} as Done...`);
    const result = await markLinearIssueDone(identifier);
    console.log("");
    boxHeader(`${result.issue.identifier}: ${result.issue.title || "Done"}`);
    console.log("");
    field(
      "state",
      `${result.issue.state?.name || result.targetState.name} (${result.issue.state?.type || result.targetState.type})`,
    );
    field("changed", result.changed ? "yes" : "no");
    field("url", result.issue.url || "");
  } catch (error) {
    console.error("! error:", error.message);
    process.exit(1);
  }
}

async function handleStart(issueRef) {
  if (detectPlatform(issueRef) && detectPlatform(issueRef) !== "linear") {
    console.error("! error: start only supports Linear issues");
    console.error("  usage: grog start <linear-issue-url-or-identifier>");
    process.exit(1);
  }

  requireLinearToken();
  const identifier = parseLinearIssueIdentifier(issueRef);
  if (!identifier) {
    console.error("! error: invalid Linear issue reference");
    console.error("  usage: grog start <linear-issue-url-or-identifier>");
    console.error("  examples:");
    console.error("    grog start https://linear.app/workspace/issue/PROJ-123");
    console.error("    grog start PROJ-123");
    process.exit(1);
  }

  try {
    console.log(`> marking Linear issue ${identifier} as In Progress...`);
    const result = await markLinearIssueStarted(identifier);
    console.log("");
    boxHeader(`${result.issue.identifier}: ${result.issue.title || "In Progress"}`);
    console.log("");
    field(
      "state",
      `${result.issue.state?.name || result.targetState.name} (${result.issue.state?.type || result.targetState.type})`,
    );
    field("changed", result.changed ? "yes" : "no");
    field("url", result.issue.url || "");
  } catch (error) {
    console.error("! error:", error.message);
    process.exit(1);
  }
}

/**
 * Handle 'explore' command for a repository
 */
async function handleExploreRepo(owner, repo) {
  console.log(`> fetching issues from ${owner}/${repo}...`);

  const openIssues = await fetchIssues(owner, repo, "open");

  if (openIssues.length === 0) {
    console.log("> no open issues found.");
    process.exit(0);
  }

  console.log("");
  boxHeader(`${owner}/${repo}`);
  console.log("");
  console.log(`  ${openIssues.length} open issue(s)`);

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

  sectionHeader("ISSUES BY LABEL");

  for (const [label, issues] of labelGroups) {
    console.log("");
    console.log(`  [${label}] (${issues.length})`);
    issues.forEach((issue) => {
      console.log(`    #${issue.number}  ${issue.title}`);
    });
  }

  if (unlabeled.length > 0) {
    console.log("");
    console.log(`  [unlabeled] (${unlabeled.length})`);
    unlabeled.forEach((issue) => {
      console.log(`    #${issue.number}  ${issue.title}`);
    });
  }

  sectionHeader("ALL ISSUES");
  console.log("");

  openIssues.forEach((issue, index) => {
    const labels =
      issue.labels?.length > 0
        ? `  [${issue.labels.map((l) => l.name).join(", ")}]`
        : "";
    console.log(`  ${String(index + 1).padStart(3)}.  #${issue.number}  ${issue.title}${labels}`);
  });

  sectionHeader("NEXT STEPS");
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
  console.log(
    `> fetching project #${projectNumber} from ${projectType} ${owner}...`,
  );

  const project = await fetchProjectItems(owner, projectNumber, isOrg);

  console.log("");
  boxHeader(project.title);
  console.log("");
  console.log(`  url: ${project.url}`);

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
    console.log("> no issues found in this project.");
    process.exit(0);
  }

  // Filter out "Done" issues for display
  const activeIssues = issues.filter((i) => i.status.toLowerCase() !== "done");
  const doneCount = issues.length - activeIssues.length;

  console.log(
    `  ${issues.length} issue(s) total  |  ${doneCount} done  |  ${activeIssues.length} active`,
  );

  // Print available statuses with counts
  if (statusOptions.length > 0) {
    sectionHeader("STATUSES");
    console.log("");
    statusOptions.forEach((s) => {
      const count = itemsByStatus.get(s)?.length || 0;
      const marker = s.toLowerCase() === "done" ? "  (hidden)" : "";
      console.log(`  [${s}] ${String(count).padStart(3)} issue(s)${marker}`);
    });
  }

  sectionHeader("NEXT STEPS");
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
${activeIssues.length > 0 ? activeIssues.map((i) => `  ${i.owner}/${i.repo}#${i.number}  ${i.title}`).join("\n") : "  (none)"}
`);
}

/**
 * Print PR details with all context for review
 */
async function printPrDetails(pr, files, reviewComments, issueComments, reviews, diff, owner, repo) {
  console.log("=".repeat(60));
  console.log(`PR #${pr.number}: ${pr.title}`);
  console.log("=".repeat(60));
  console.log(`State: ${pr.state}`);
  console.log(`Author: ${pr.user?.login}`);
  console.log(`Created: ${new Date(pr.created_at).toLocaleString()}`);
  console.log(`Updated: ${new Date(pr.updated_at).toLocaleString()}`);
  console.log(`Branch: ${pr.head?.ref} → ${pr.base?.ref}`);
  console.log(`Mergeable: ${pr.mergeable ?? "unknown"}`);
  if (pr.labels?.length > 0) {
    console.log(`Labels: ${pr.labels.map((l) => l.name).join(", ")}`);
  }
  if (pr.requested_reviewers?.length > 0) {
    console.log(`Requested Reviewers: ${pr.requested_reviewers.map((r) => r.login).join(", ")}`);
  }
  console.log(`Changes: +${pr.additions} -${pr.deletions} across ${pr.changed_files} file(s)`);
  console.log(`URL: ${pr.html_url}`);

  // PR description
  console.log("\n" + "-".repeat(60));
  console.log("DESCRIPTION:");
  console.log("-".repeat(60));
  console.log(pr.body || "(No description provided)");

  // Linked issues (extract from body)
  const issueRefs = (pr.body || "").match(/(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi);
  if (issueRefs) {
    console.log("\n" + "-".repeat(60));
    console.log("LINKED ISSUES:");
    console.log("-".repeat(60));
    issueRefs.forEach((ref) => console.log(`  ${ref}`));
  }

  // File summary
  console.log("\n" + "-".repeat(60));
  console.log("FILES CHANGED:");
  console.log("-".repeat(60));
  files.forEach((file) => {
    const statusIcon =
      file.status === "added" ? "+" :
      file.status === "removed" ? "-" :
      file.status === "renamed" ? "→" : "~";
    const rename = file.previous_filename ? ` (was: ${file.previous_filename})` : "";
    console.log(`  [${statusIcon}] ${file.filename}${rename}  (+${file.additions} -${file.deletions})`);
  });

  // Reviews
  if (reviews.length > 0) {
    console.log("\n" + "-".repeat(60));
    console.log("REVIEWS:");
    console.log("-".repeat(60));
    reviews.forEach((review) => {
      if (review.state === "PENDING") return;
      const date = new Date(review.submitted_at).toLocaleString();
      console.log(`  ${review.user?.login}: ${review.state} (${date})`);
      if (review.body) {
        console.log(`    "${review.body}"`);
      }
    });
  }

  // Review comments (inline code comments)
  if (reviewComments.length > 0) {
    console.log("\n" + "-".repeat(60));
    console.log("INLINE REVIEW COMMENTS:");
    console.log("-".repeat(60));
    reviewComments.forEach((comment) => {
      const line = comment.line || comment.original_line || "?";
      console.log(`\n  ${comment.user?.login} on ${comment.path}:${line}`);
      console.log(`  ${comment.body}`);
      if (comment.diff_hunk) {
        console.log(`  Context:`);
        console.log(`  ${comment.diff_hunk.split("\n").slice(-3).join("\n  ")}`);
      }
    });
  }

  // Conversation comments (non-bot only, bots are usually deploy previews etc.)
  const humanComments = issueComments.filter(
    (c) => !c.user?.login?.includes("[bot]") && c.user?.type !== "Bot" && !c.performed_via_github_app,
  );
  if (humanComments.length > 0) {
    console.log("\n" + "-".repeat(60));
    console.log("CONVERSATION COMMENTS:");
    console.log("-".repeat(60));
    humanComments.forEach((comment) => {
      const date = new Date(comment.created_at).toLocaleString();
      console.log(`\n  ${comment.user?.login} (${date}):`);
      console.log(`  ${comment.body}`);
    });
  }

  // Full diff
  console.log("\n" + "=".repeat(60));
  console.log("FULL DIFF:");
  console.log("=".repeat(60));
  console.log(diff);

  // Download images from PR body
  const imageUrls = extractImageUrls(pr.body);
  if (imageUrls.length > 0) {
    console.log(
      `\nFound ${imageUrls.length} image attachment(s) in PR description. Downloading...\n`,
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
        const filename = `${repo}-pr-${pr.number}-img-${i + 1}.${ext}`;
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
 * Handle 'review' command - fetch PR details for code review (GitHub only)
 */
async function handleReview(prUrl) {
  requireGhToken();
  const parsed = parseGitHubPrUrl(prUrl);
  if (!parsed) {
    console.error("Error: Invalid GitHub pull request URL");
    console.error(
      "Expected format: https://github.com/owner/repo/pull/123",
    );
    process.exit(1);
  }

  try {
    console.log(
      `Fetching PR #${parsed.prNumber} from ${parsed.owner}/${parsed.repo}...\n`,
    );

    // Fetch all PR data in parallel
    const [pr, files, reviewComments, issueComments, reviews, diff] =
      await Promise.all([
        fetchPullRequest(parsed.owner, parsed.repo, parsed.prNumber),
        fetchPullRequestFiles(parsed.owner, parsed.repo, parsed.prNumber),
        fetchPullRequestReviewComments(parsed.owner, parsed.repo, parsed.prNumber),
        fetchPullRequestIssueComments(parsed.owner, parsed.repo, parsed.prNumber),
        fetchPullRequestReviews(parsed.owner, parsed.repo, parsed.prNumber),
        fetchPullRequestDiff(parsed.owner, parsed.repo, parsed.prNumber),
      ]);

    await printPrDetails(
      pr, files, reviewComments, issueComments, reviews, diff,
      parsed.owner, parsed.repo,
    );
  } catch (error) {
    console.error("Error fetching PR:", error.message);
    process.exit(1);
  }
}

/**
 * Handle 'explore' command for Linear team
 */
async function handleExploreLinearTeam(teamKey) {
  console.log(`> fetching issues from Linear team ${teamKey}...`);

  const team = await fetchLinearTeamIssues(teamKey);
  const issues = team.issues?.nodes || [];

  console.log("");
  boxHeader(`${team.key} — ${team.name}`);
  console.log("");
  console.log(`  ${issues.length} active issue(s)`);

  // Group by state
  const byState = new Map();
  issues.forEach((issue) => {
    const state = issue.state?.name || "No Status";
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state).push(issue);
  });

  sectionHeader("ISSUES BY STATUS");

  for (const [state, stateIssues] of byState) {
    console.log("");
    console.log(`  [${state}] (${stateIssues.length})`);
    stateIssues.forEach((issue) => {
      const assignee = issue.assignee?.displayName ? ` @${issue.assignee.displayName}` : "";
      const labels = issue.labels?.nodes?.length > 0 ? `  [${issue.labels.nodes.map((l) => l.name).join(", ")}]` : "";
      console.log(`    ${issue.identifier}  ${issue.title}${assignee}${labels}`);
    });
  }

  sectionHeader("ALL ISSUES");
  console.log("");
  issues.forEach((issue, index) => {
    const priority = issue.priorityLabel ? `[${issue.priorityLabel}]` : "";
    console.log(`  ${String(index + 1).padStart(3)}.  ${issue.identifier}  ${issue.title}  ${priority}`);
  });

  sectionHeader("NEXT STEPS");
  console.log(`
Ask the user which issues they want to work on. They can specify:
- A status name (e.g., "In Progress", "Todo") to work on all issues with that status
- Specific issue identifiers (e.g., "${teamKey}-123, ${teamKey}-456")
- "all" to work on all active issues

Once the user selects, process each issue one by one:
1. Fetch the full issue details using: /grog-solve <linear-issue-url>
2. Implement the solution
3. Commit the changes
4. Move to the next issue
`);
}

/**
 * Handle 'explore' command for Linear workspace (all teams)
 */
async function handleExploreLinearWorkspace(workspace) {
  console.log(`> fetching all teams from Linear workspace ${workspace}...`);

  const teams = await fetchLinearTeams();

  if (teams.length === 0) {
    console.log("> no teams found.");
    process.exit(0);
  }

  console.log("");
  boxHeader(`Linear — ${workspace}`);
  console.log("");

  console.log(`  ${teams.length} team(s)`);

  sectionHeader("TEAMS");
  console.log("");
  for (const team of teams) {
    const count = team.issueCount != null ? ` (${team.issueCount} issues)` : "";
    console.log(`    ${team.key}  ${team.name}${count}`);
  }

  sectionHeader("NEXT STEPS");
  console.log(`
Ask the user which team they want to explore. They can specify:
- A team key (e.g., "${teams[0]?.key || "PROJ"}") to see that team's active issues

Then run: /grog-explore https://linear.app/${workspace}/team/<TEAM_KEY>

Available teams: ${teams.map((t) => t.key).join(", ")}
`);
}

/**
 * Handle 'explore' command for Linear project
 */
async function handleExploreLinearProject(projectSlug) {
  console.log(`> fetching issues from Linear project...`);

  const project = await fetchLinearProjectIssues(projectSlug);
  const issues = project.issues?.nodes || [];

  console.log("");
  boxHeader(project.name);
  console.log("");
  if (project.description) console.log(`  ${project.description}`);
  console.log(`  state: ${project.state}`);
  console.log(`  ${issues.length} active issue(s)`);

  // Group by state
  const byState = new Map();
  issues.forEach((issue) => {
    const state = issue.state?.name || "No Status";
    if (!byState.has(state)) byState.set(state, []);
    byState.get(state).push(issue);
  });

  sectionHeader("ISSUES BY STATUS");

  for (const [state, stateIssues] of byState) {
    console.log("");
    console.log(`  [${state}] (${stateIssues.length})`);
    stateIssues.forEach((issue) => {
      const assignee = issue.assignee?.displayName ? ` @${issue.assignee.displayName}` : "";
      console.log(`    ${issue.identifier}  ${issue.title}${assignee}`);
    });
  }

  sectionHeader("ALL ISSUES");
  console.log("");
  issues.forEach((issue, index) => {
    const priority = issue.priorityLabel ? `[${issue.priorityLabel}]` : "";
    const team = issue.team?.key ? `${issue.team.key}/` : "";
    console.log(`  ${String(index + 1).padStart(3)}.  ${team}${issue.identifier}  ${issue.title}  ${priority}`);
  });

  sectionHeader("NEXT STEPS");
  console.log(`
Ask the user which issues they want to work on. They can specify:
- A status name (e.g., "In Progress", "Todo") to work on all issues with that status
- Specific issue identifiers (e.g., "PROJ-123, PROJ-456")
- "all" to work on all active issues

Once the user selects, process each issue one by one:
1. Fetch the full issue details using: /grog-solve <linear-issue-url>
2. Implement the solution
3. Commit the changes
4. Move to the next issue
`);
}

/**
 * Handle 'explore' command - list issues from a project or repo for batch processing (GitHub or Linear)
 */
async function handleExplore(url) {
  const platform = detectPlatform(url);

  if (platform === "linear") {
    requireLinearToken();
    const parsed = parseLinearUrl(url);
    if (!parsed) {
      console.error("! error: invalid Linear URL");
      console.error("  expected formats:");
      console.error("    https://linear.app/workspace/team/PROJ");
      console.error("    https://linear.app/workspace/project/my-project");
      console.error("    https://linear.app/workspace");
      process.exit(1);
    }

    try {
      if (parsed.type === "team") {
        await handleExploreLinearTeam(parsed.teamKey);
      } else if (parsed.type === "project") {
        await handleExploreLinearProject(parsed.projectSlug);
      } else {
        await handleExploreLinearWorkspace(parsed.workspace);
      }
    } catch (error) {
      console.error("! error:", error.message);
      process.exit(1);
    }
    return;
  }

  requireGhToken();
  const parsed = parseGitHubUrl(url);
  if (!parsed) {
    console.error("! error: invalid URL");
    console.error("  expected formats:");
    console.error("    https://github.com/owner/repo");
    console.error("    https://github.com/orgs/orgname/projects/123");
    console.error("    https://linear.app/workspace/team/PROJ");
    console.error("    https://linear.app/workspace");
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
    console.error("! error:", error.message);
    process.exit(1);
  }
}

function readCliFlag(args, names) {
  const aliases = Array.isArray(names) ? names : [names];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    for (const name of aliases) {
      if (arg === name) return args[i + 1];
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function parseLinearPriority(value) {
  if (!value) return undefined;
  const normalized = String(value).trim().toLowerCase();
  const priorities = {
    none: 0,
    urgent: 1,
    high: 2,
    medium: 3,
    low: 4,
  };
  if (Object.prototype.hasOwnProperty.call(priorities, normalized)) {
    return priorities[normalized];
  }

  const numeric = Number(normalized);
  if (Number.isInteger(numeric) && numeric >= 0 && numeric <= 4) {
    return numeric;
  }

  throw new Error(
    `Invalid Linear priority "${value}". Use none, urgent, high, medium, low, or 0-4.`,
  );
}

async function handleCreate(args) {
  const target = args[0] === "linear" ? "linear" : null;
  const createArgs = target ? args.slice(1) : args;

  if (target !== "linear") {
    console.error("! error: missing create target");
    console.error("  usage: grog create linear --team TEAM --title \"Title\" [--description-file /tmp/body.md]");
    process.exit(1);
  }

  const teamKey = readCliFlag(createArgs, ["--team", "-t"]);
  const title = readCliFlag(createArgs, ["--title"]);
  const description = readCliFlag(createArgs, ["--description", "--body"]) || "";
  const descriptionFile = readCliFlag(createArgs, [
    "--description-file",
    "--body-file",
    "-f",
  ]);
  let priority;
  try {
    priority = parseLinearPriority(readCliFlag(createArgs, ["--priority", "-p"]));
  } catch (err) {
    console.error(`! error: ${err.message}`);
    process.exit(1);
  }

  if (!teamKey) {
    console.error("! error: missing Linear team key");
    console.error("  usage: grog create linear --team TEAM --title \"Title\"");
    process.exit(1);
  }
  if (!title) {
    console.error("! error: missing Linear issue title");
    console.error("  usage: grog create linear --team TEAM --title \"Title\"");
    process.exit(1);
  }

  let body = description;
  if (descriptionFile) {
    try {
      body = readFileSync(descriptionFile, "utf-8");
    } catch (err) {
      console.error(`! error: could not read description file: ${err.message}`);
      process.exit(1);
    }
  }

  requireLinearToken();

  try {
    console.log(`> creating Linear issue in team ${teamKey}...`);
    const issue = await createLinearIssue({
      teamKey,
      title,
      description: body.trim(),
      priority,
    });
    console.log(`> issue created: ${issue.identifier} ${issue.title}`);
    console.log(`> ${issue.url}`);
  } catch (error) {
    console.error("! error:", error.message);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────
// Jam.dev Viewer
// ─────────────────────────────────────────────────────────

function hasFlag(args, flag) {
  return args.includes(flag);
}

function getFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function getOptionalFlagValue(args, flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

function openUrlInBrowser(url) {
  if (process.platform === "darwin") {
    execFileSync("open", [url], { stdio: "ignore" });
    return;
  }
  if (process.platform === "win32") {
    execFileSync("cmd", ["/c", "start", "", url], { stdio: "ignore" });
    return;
  }
  execFileSync("xdg-open", [url], { stdio: "ignore" });
}

function findChromeExecutable() {
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function captureJamScreenshot(url, outputPath) {
  const chrome = findChromeExecutable();
  if (!chrome) {
    throw new Error("Chrome/Chromium executable not found");
  }
  const userDataDir = `/tmp/grog-jam-chrome-${Date.now()}`;
  execFileSync(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--no-first-run",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1440,1400",
      `--screenshot=${outputPath}`,
      url,
    ],
    { stdio: "ignore" },
  );
}

async function fetchJamHtml(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    },
    redirect: "follow",
  });
  const body = await response.text();
  return {
    body,
    contentType: response.headers.get("content-type") || "",
    finalUrl: response.url,
    status: response.status,
  };
}

async function handleJam(args) {
  const urlArg = args.find((arg) => !arg.startsWith("--"));
  const parsed = parseJamUrl(urlArg || "");

  if (!parsed) {
    console.error("! error: missing or invalid Jam URL");
    console.log("  usage: grog jam https://jam.dev/c/<id> [--open] [--telegram] [--json] [--save file] [--screenshot [file]]");
    process.exit(1);
  }

  const shouldOpen = hasFlag(args, "--open");
  const shouldSendTelegram = hasFlag(args, "--telegram");
  const shouldPrintJson = hasFlag(args, "--json");
  const shouldSkipScreenshot = hasFlag(args, "--no-screenshot");
  const savePath = getFlagValue(args, "--save");
  const screenshotFlagValue = getOptionalFlagValue(args, "--screenshot");
  const shouldCaptureScreenshot =
    !shouldSkipScreenshot && (shouldSendTelegram || screenshotFlagValue !== undefined);
  const screenshotPath = shouldCaptureScreenshot
    ? screenshotFlagValue || `/tmp/grog-jam-${parsed.id}.png`
    : undefined;

  const result = {
    id: parsed.id,
    url: parsed.url,
    status: null,
    finalUrl: null,
    title: "",
    description: "",
    image: "",
    assets: [],
    readable: false,
    opened: false,
    screenshotPath: "",
    note: "",
  };

  try {
    const fetched = await fetchJamHtml(parsed.url);
    result.status = fetched.status;
    result.finalUrl = fetched.finalUrl;

    if (fetched.body.length > 0) {
      result.readable = true;
      result.title = extractTitle(fetched.body);
      result.description =
        extractMetaContent(fetched.body, "og:description") ||
        extractMetaContent(fetched.body, "description");
      result.image = extractMetaContent(fetched.body, "og:image");
      result.assets = extractJamAssets(fetched.body).slice(0, 12);
    } else {
      result.note =
        "Jam returned an empty HTML body to the CLI. Open it in an authenticated browser with --open.";
    }
  } catch (error) {
    result.note = `Could not fetch Jam page: ${error.message}`;
  }

  if (shouldOpen) {
    try {
      openUrlInBrowser(parsed.url);
      result.opened = true;
    } catch (error) {
      result.note = result.note
        ? `${result.note} Browser open failed: ${error.message}`
        : `Browser open failed: ${error.message}`;
    }
  }

  if (screenshotPath) {
    try {
      captureJamScreenshot(parsed.url, screenshotPath);
      result.screenshotPath = screenshotPath;
    } catch (error) {
      result.note = result.note
        ? `${result.note} Screenshot failed: ${error.message}`
        : `Screenshot failed: ${error.message}`;
    }
  }

  if (shouldPrintJson) {
    const output = JSON.stringify(result, null, 2);
    console.log(output);
    if (savePath) writeFileSync(savePath, `${output}\n`);
    if (shouldSendTelegram) await handleTelegramSend([output]);
    return;
  }

  const lines = [
    `Jam: ${result.url}`,
    `ID: ${result.id}`,
    result.status ? `HTTP: ${result.status}` : null,
    result.title ? `Title: ${result.title}` : null,
    result.description ? `Description: ${result.description}` : null,
    result.image ? `Image: ${result.image}` : null,
    result.assets.length > 0
      ? `Assets:\n${result.assets.map((asset) => `- ${asset}`).join("\n")}`
      : null,
    result.note ? `Note: ${result.note}` : null,
    result.screenshotPath ? `Screenshot: ${result.screenshotPath}` : null,
    result.opened ? "Opened in browser." : null,
  ].filter(Boolean);

  const summary = lines.join("\n");
  console.log(summary);
  if (savePath) writeFileSync(savePath, `${summary}\n`);
  if (shouldSendTelegram) {
    await handleTelegramSend([summary]);
    if (result.screenshotPath) {
      await handleTelegramSendImage([
        result.screenshotPath,
        `Jam ${result.id}`,
      ]);
    }
  }
}

/**
 * Handle 'answer' command - post a summary comment to a GitHub issue/PR or Linear issue
 */
async function handleAnswer(issueUrl, summaryFilePath, answerArgs = []) {
  if (!summaryFilePath) {
    console.error("! error: missing summary file path");
    console.error("  usage: grog answer <issue-or-pr-url> <path-to-summary-file>");
    process.exit(1);
  }

  let summary;
  try {
    summary = readFileSync(summaryFilePath, "utf-8").trim();
  } catch (err) {
    console.error(`! error: could not read summary file: ${err.message}`);
    process.exit(1);
  }

  if (!summary) {
    console.error("! error: summary file is empty");
    process.exit(1);
  }

  let imagePaths = [];
  try {
    imagePaths = parseImageArgs(answerArgs);
  } catch (error) {
    console.error("! error:", error.message);
    process.exit(1);
  }

  const platform = detectPlatform(issueUrl);

  if (platform === "linear") {
    requireLinearToken();
    const parsed = parseLinearIssueUrl(issueUrl);
    if (!parsed) {
      console.error("! error: invalid Linear issue URL");
      console.error("  expected: https://linear.app/workspace/issue/PROJ-123");
      process.exit(1);
    }

    try {
      if (imagePaths.length > 0) {
        console.log(`> uploading ${imagePaths.length} image(s) to Linear...`);
        summary = await appendLinearImages(summary, imagePaths);
      }
      console.log(`> posting comment to Linear issue ${parsed.identifier}...`);
      const comment = await postLinearComment(parsed.identifier, summary);
      console.log(`> comment posted: ${comment.url || "success"}`);
    } catch (error) {
      console.error("! error:", error.message);
      process.exit(1);
    }
    return;
  }

  if (imagePaths.length > 0) {
    console.error("! error: --image is currently supported only for Linear issues");
    process.exit(1);
  }

  requireGhToken();
  const issueParsed = parseGitHubIssueUrl(issueUrl);
  const prParsed = parseGitHubPrUrl(issueUrl);
  const parsed = issueParsed || prParsed;
  if (!parsed) {
    console.error("! error: invalid issue or PR URL");
    console.error("  expected: https://github.com/owner/repo/issues/123");
    console.error("       or:  https://github.com/owner/repo/pull/123");
    console.error("       or:  https://linear.app/workspace/issue/PROJ-123");
    process.exit(1);
  }

  const number = parsed.issueNumber || parsed.prNumber;
  const type = issueParsed ? "issue" : "PR";

  try {
    console.log(
      `> posting comment to ${parsed.owner}/${parsed.repo}#${number} (${type})...`,
    );

    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/issues/${number}/comments`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body: summary }),
    });

    if (!response.ok) {
      throw new Error(
        `GitHub API error: ${response.status} ${response.statusText}`,
      );
    }

    const comment = await response.json();
    console.log(`> comment posted: ${comment.html_url}`);
  } catch (error) {
    console.error("! error:", error.message);
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────
// Telegram Bridge
// ─────────────────────────────────────────────────────────

async function telegramApi(method, params = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    console.error("! error: TELEGRAM_BOT_TOKEN not set in .env");
    console.error("  create a bot at https://t.me/BotFather and add the token");
    process.exit(1);
  }
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API error: ${data.description}`);
  }
  return data.result;
}

async function downloadTelegramFile(fileId, fileName) {
  const file = await telegramApi("getFile", { file_id: fileId });
  if (!file?.file_path) {
    throw new Error("Telegram did not return a downloadable file path");
  }

  mkdirSync(TELEGRAM_DOWNLOAD_DIR, { recursive: true });

  const safeName = sanitizeTelegramFileName(fileName || basename(file.file_path));
  const localPath = join(TELEGRAM_DOWNLOAD_DIR, `${Date.now()}-${safeName}`);
  const url = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Telegram file download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(localPath, buffer);

  return localPath;
}

async function downloadTelegramDocument(document) {
  return downloadTelegramFile(document.file_id, document.file_name);
}

async function formatTelegramMessage(update) {
  if (update.callback_query) {
    telegramApi("answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(() => {});
    return update.callback_query.data;
  }

  const message = update.message;
  if (!message) return "";
  if (message.text) return message.text;

  const parts = [];
  if (message.caption) parts.push(message.caption);

  if (message.document) {
    const localPath = await downloadTelegramDocument(message.document);
    const fileName = message.document.file_name || basename(localPath);
    parts.push(`file: ${fileName}`);
    parts.push(`saved: ${localPath}`);

    if (isTelegramTextDocument(message.document)) {
      parts.push("--- file content ---");
      parts.push(readFileSync(localPath, "utf-8"));
      parts.push("--- end file content ---");
    } else {
      parts.push("[telegram document saved]");
    }

    return parts.join("\n");
  }

  if (message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    const localPath = await downloadTelegramFile(photo.file_id, `${photo.file_unique_id || photo.file_id}.jpg`);
    return [
      ...parts,
      "photo: telegram-photo.jpg",
      `saved: ${localPath}`,
    ].filter(Boolean).join("\n");
  }

  return [...parts, "[non-text message]"].filter(Boolean).join("\n");
}

function loadTelegramState() {
  try {
    return JSON.parse(readFileSync(TELEGRAM_STATE_FILE, "utf-8"));
  } catch {
    return { offset: 0, chatId: null };
  }
}

function saveTelegramState(state) {
  writeFileSync(TELEGRAM_STATE_FILE, JSON.stringify(state));
}

/**
 * Initialize Telegram bridge — connect to bot, discover chat, send welcome
 */
async function handleTalk() {
  const me = await telegramApi("getMe");
  let chatId = TELEGRAM_CHAT_ID;
  let offset = 0;

  if (!chatId) {
    // Auto-discover: flush pending updates, then wait for a message
    console.log(`> bot: @${me.username}`);
    console.log(
      "> no chat ID configured — send any message to the bot on Telegram to connect.",
    );
    console.log("> waiting...");

    // Flush old updates
    const flush = await telegramApi("getUpdates", { timeout: 0 });
    if (flush.length > 0) {
      offset = Math.max(...flush.map((u) => u.update_id)) + 1;
    }

    // Wait for a fresh message
    const updates = await telegramApi("getUpdates", {
      offset,
      timeout: 60,
    });
    const msg = updates.find((u) => u.message)?.message;
    if (!msg) {
      console.error(
        "! timeout — no message received. try again after messaging the bot.",
      );
      process.exit(1);
    }

    chatId = String(msg.chat.id);
    offset = Math.max(...updates.map((u) => u.update_id)) + 1;
    console.log(
      `> connected to: ${msg.chat.first_name || msg.chat.title || chatId}`,
    );
  } else {
    // Flush pending updates so we start fresh
    const flush = await telegramApi("getUpdates", { timeout: 0 });
    if (flush.length > 0) {
      offset = Math.max(...flush.map((u) => u.update_id)) + 1;
      await telegramApi("getUpdates", { offset, timeout: 0 });
    }
  }

  saveTelegramState({ offset, chatId });

  // Send welcome message
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: 'Grog is online.\n\nSend messages here — they will be processed by the active agent session.\n\nSend "bye" to disconnect.',
  });

  console.log("> grog talk is active");
  console.log(`> bot: @${me.username}`);
  console.log(`> chat: ${chatId}`);
}

/**
 * Send a message to Telegram — accepts a file path or direct text
 */
async function handleTelegramSend(args) {
  const { to, rest } = parseRecipientArgs(args);
  const state = loadTelegramState();
  const target = to ? resolveAddressBookTarget("telegram", to) : null;
  const chatId = target?.value || state.chatId || TELEGRAM_CHAT_ID;

  if (!chatId) {
    console.error('! error: no chat ID — run "grog talk" first');
    process.exit(1);
  }

  const message = readMessageFromArgs(rest);

  if (!message) {
    console.error("! error: empty message");
    process.exit(1);
  }

  // Telegram limit is 4096 chars — split if needed
  const chunks = [];
  for (let i = 0; i < message.length; i += 4000) {
    chunks.push(message.substring(i, i + 4000));
  }

  for (const chunk of chunks) {
    await telegramApi("sendMessage", { chat_id: chatId, text: chunk });
  }

  console.log(`> sent to Telegram${target ? ` (${target.label})` : ""}`);
}

/**
 * Send an image with optional caption to Telegram
 * Usage: grog telegram-send-image <image-path> [caption]
 */
async function handleTelegramSendImage(args) {
  const { to, rest } = parseRecipientArgs(args);
  const state = loadTelegramState();
  const target = to ? resolveAddressBookTarget("telegram", to) : null;
  const chatId = target?.value || state.chatId || TELEGRAM_CHAT_ID;

  if (!chatId) {
    console.error("! error: TELEGRAM_CHAT_ID not set in .env");
    process.exit(1);
  }

  if (!TELEGRAM_BOT_TOKEN) {
    console.error("! error: TELEGRAM_BOT_TOKEN not set in .env");
    process.exit(1);
  }

  const imagePath = rest[0];
  const caption = rest.slice(1).join(" ");

  if (!imagePath) {
    console.error("! error: missing image path");
    console.error("  usage: grog telegram-send-image <image-path> [caption]");
    process.exit(1);
  }

  if (!existsSync(imagePath)) {
    console.error(`! error: file not found: ${imagePath}`);
    process.exit(1);
  }

  const captionArg = caption ? `-F "caption=${caption}"` : "";

  try {
    const cmd = `curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto" -F "chat_id=${chatId}" -F "photo=@${imagePath}" ${captionArg}`;
    const result = execSync(cmd, { encoding: "utf-8" });
    const data = JSON.parse(result);

    if (!data.ok) {
      console.error(`! error: Telegram API error: ${data.description}`);
      process.exit(1);
    }

    console.log(`> image sent to Telegram${target ? ` (${target.label})` : ""}`);
  } catch (err) {
    console.error(`! error: failed to send image: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Notify via Telegram — fire-and-forget, no talk session needed.
 * Uses TELEGRAM_CHAT_ID from .env directly. Initializes state file so
 * telegram-recv can work afterwards without running 'talk' first.
 */
async function handleNotify(args) {
  const { to, rest } = parseRecipientArgs(args);
  const target = to ? resolveAddressBookTarget("telegram", to) : null;
  const chatId = target?.value || TELEGRAM_CHAT_ID;

  if (!chatId) {
    console.error("! error: TELEGRAM_CHAT_ID not set in .env");
    console.error("  add it to ~/.claude/tools/grog/.env or run the installer");
    process.exit(1);
  }

  const message = rest.join(" ");
  if (!message) {
    console.error("! error: empty message");
    process.exit(1);
  }

  // Initialize state file if it doesn't exist so telegram-recv works after
  const state = loadTelegramState();
  if (!state.chatId) {
    // Flush pending updates and set offset
    const flush = await telegramApi("getUpdates", { timeout: 0 });
    const offset = flush.length > 0
      ? Math.max(...flush.map((u) => u.update_id)) + 1
      : 0;
    saveTelegramState({ offset, chatId });
  }

  // Send the message
  const chunks = [];
  for (let i = 0; i < message.length; i += 4000) {
    chunks.push(message.substring(i, i + 4000));
  }
  for (const chunk of chunks) {
    await telegramApi("sendMessage", { chat_id: chatId, text: chunk });
  }

  console.log(`> notified via Telegram${target ? ` (${target.label})` : ""}`);
}

/**
 * Send a prompt with inline keyboard buttons to Telegram and wait for response.
 * Used for tool approval (Yes/Yes Always/No) and questions (with Reply option).
 * Returns the callback data or typed text response.
 */
async function handlePrompt(args) {
  const chatId = TELEGRAM_CHAT_ID;

  if (!chatId) {
    console.error("! error: TELEGRAM_CHAT_ID not set");
    process.exit(1);
  }

  const message = args.join(" ");
  if (!message) {
    console.error("! error: empty message");
    process.exit(1);
  }

  // Initialize state file if needed
  const state = loadTelegramState();
  if (!state.chatId) {
    const flush = await telegramApi("getUpdates", { timeout: 0 });
    const offset = flush.length > 0
      ? Math.max(...flush.map((u) => u.update_id)) + 1
      : 0;
    saveTelegramState({ offset, chatId });
  }

  // Send message with inline keyboard
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: message,
    reply_markup: {
      inline_keyboard: [
        [
          { text: "Yes", callback_data: "yes" },
          { text: "Yes, don't ask again", callback_data: "always" },
          { text: "No", callback_data: "no" },
        ],
        [
          { text: "Reply with text...", callback_data: "reply" },
        ],
      ],
    },
  });

  // Wait for callback_query or text message response (~90s)
  const freshState = loadTelegramState();

  for (let attempt = 0; attempt < 2; attempt++) {
    const params = {
      timeout: 45,
      allowed_updates: ["callback_query", "message"],
    };
    if (freshState.offset) params.offset = freshState.offset;

    const updates = await telegramApi("getUpdates", params);

    // Advance offset for ALL updates
    if (updates.length > 0) {
      freshState.offset = Math.max(...updates.map((u) => u.update_id)) + 1;
      saveTelegramState(freshState);
    }

    // Check for callback query (button press) from our chat
    const callback = updates.find(
      (u) => u.callback_query && String(u.callback_query.message?.chat?.id) === String(chatId),
    );

    if (callback) {
      const data = callback.callback_query.data;

      // Acknowledge the callback to remove the loading spinner
      await telegramApi("answerCallbackQuery", {
        callback_query_id: callback.callback_query.id,
      });

      if (data === "reply") {
        // User wants to type a response — send a follow-up and wait for text
        await telegramApi("sendMessage", {
          chat_id: chatId,
          text: "Type your response:",
          reply_markup: { force_reply: true },
        });

        // Wait for the text message
        for (let textAttempt = 0; textAttempt < 2; textAttempt++) {
          const textParams = { timeout: 45, allowed_updates: ["message"] };
          if (freshState.offset) textParams.offset = freshState.offset;

          const textUpdates = await telegramApi("getUpdates", textParams);

          if (textUpdates.length > 0) {
            freshState.offset = Math.max(...textUpdates.map((u) => u.update_id)) + 1;
            saveTelegramState(freshState);
          }

          const textMsg = textUpdates.find(
            (u) => u.message && String(u.message.chat.id) === String(chatId),
          );

          if (textMsg) {
            console.log(`reply:${textMsg.message.text || ""}`);
            return;
          }
        }

        console.log("[no message]");
        return;
      }

      // Button press: yes, always, no
      console.log(data);
      return;
    }

    // Check for regular text message (user typed instead of pressing button)
    const textMsg = updates.find(
      (u) => u.message && String(u.message.chat.id) === String(chatId),
    );

    if (textMsg) {
      console.log(`reply:${textMsg.message.text || ""}`);
      return;
    }
  }

  console.log("[no message]");
}

/**
 * Wait for a message from Telegram — long-polls for ~90 seconds
 */
async function handleTelegramRecv() {
  const state = loadTelegramState();
  const chatId = state.chatId || TELEGRAM_CHAT_ID;

  if (!chatId) {
    console.error('! error: no chat ID — run "grog talk" first');
    process.exit(1);
  }

  // Poll with retry — up to ~90 seconds before returning [no message]
  for (let attempt = 0; attempt < 2; attempt++) {
    const params = { timeout: 45, allowed_updates: ["message", "callback_query"] };
    if (state.offset) params.offset = state.offset;

    const updates = await telegramApi("getUpdates", params);

    // Filter for our chat only (messages and callback queries)
    const messages = updates.filter(
      (u) => (u.message && String(u.message.chat.id) === String(chatId)) ||
             (u.callback_query && String(u.callback_query.message?.chat?.id) === String(chatId)),
    );

    // Advance offset for ALL updates (including other chats)
    if (updates.length > 0) {
      state.offset = Math.max(...updates.map((u) => u.update_id)) + 1;
      saveTelegramState(state);
    }

    if (messages.length > 0) {
      const texts = (await Promise.all(messages.map(formatTelegramMessage))).join("\n");
      console.log(texts);
      return;
    }
  }

  console.log("[no message]");
}

// ─────────────────────────────────────────────────────────
// WhatsApp Bridge (via Zernio — https://zernio.com/api)
// ─────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function zernioApi(method, path, body) {
  if (!ZERNIO_API_KEY) {
    console.error("! error: zernio API key not set");
    console.error("  add zernio.apiKey to ~/.grog/config.json (get one at https://zernio.com)");
    process.exit(1);
  }
  const opts = { method, headers: { Authorization: `Bearer ${ZERNIO_API_KEY}` } };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${ZERNIO_BASE}${path}`, opts);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    throw new Error(`Zernio API error: ${msg}`);
  }
  return data;
}

function loadWhatsappState() {
  try {
    return JSON.parse(readFileSync(WHATSAPP_STATE_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveWhatsappState(state) {
  writeFileSync(WHATSAPP_STATE_FILE, JSON.stringify(state));
}

/**
 * Resolve the WhatsApp account ID — config/env, else the first connected
 * WhatsApp account on the key.
 */
async function resolveWhatsappAccountId() {
  if (ZERNIO_WA_ACCOUNT_ID) return ZERNIO_WA_ACCOUNT_ID;
  const data = await zernioApi("GET", "/accounts");
  const wa = (data.accounts || []).find((a) => a.platform === "whatsapp");
  if (!wa) {
    console.error("! error: no WhatsApp account connected to this Zernio key");
    console.error("  connect one at https://zernio.com, or set zernio.whatsappAccountId");
    process.exit(1);
  }
  return wa._id;
}

/**
 * Find a conversation for this account, optionally matching a recipient phone.
 * Conversations are returned most-recently-updated first.
 */
async function findWhatsappConversation(accountId, participantId) {
  const data = await zernioApi(
    "GET",
    `/inbox/conversations?accountId=${encodeURIComponent(accountId)}&limit=50`,
  );
  const convs = data.data || [];
  if (participantId) {
    const digits = String(participantId).replace(/\D/g, "");
    return (
      convs.find((c) => String(c.participantId || "").replace(/\D/g, "") === digits) ||
      null
    );
  }
  return convs[0] || null;
}

/**
 * Send freeform text into a conversation (works inside the 24h window).
 * Splits on the WhatsApp ~4096-char body limit.
 */
async function sendWhatsappText(accountId, conversationId, message) {
  const chunks = [];
  for (let i = 0; i < message.length; i += 4000) {
    chunks.push(message.substring(i, i + 4000));
  }
  for (const chunk of chunks) {
    await zernioApi(
      "POST",
      `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
      { accountId, message: chunk },
    );
  }
}

/**
 * Send a freeform image into a WhatsApp conversation (works inside the 24h window).
 * Zernio accepts message attachments as base64 payloads on the conversation message endpoint.
 */
async function sendWhatsappImage(accountId, conversationId, imagePath, caption = "") {
  const contentType = contentTypeForFile(imagePath);
  if (!contentType.startsWith("image/")) {
    throw new Error(`Unsupported WhatsApp image type: ${contentType}`);
  }

  const file = readFileSync(imagePath);
  const size = statSync(imagePath).size;
  const data = await zernioApi(
    "POST",
    `/inbox/conversations/${encodeURIComponent(conversationId)}/messages`,
    {
      accountId,
      message: caption,
      attachments: [
        {
          type: "image",
          filename: basename(imagePath),
          mimeType: contentType,
          size,
          data: file.toString("base64"),
        },
      ],
    },
  );
  return data;
}

async function getWhatsappMessages(accountId, conversationId, limit = 20) {
  const data = await zernioApi(
    "GET",
    `/inbox/conversations/${encodeURIComponent(conversationId)}/messages?accountId=${encodeURIComponent(accountId)}&sortOrder=desc&limit=${limit}`,
  );
  return data.messages || data.data || [];
}

async function isWhatsappFreeformWindowOpen(accountId, conversationId) {
  const msgs = await getWhatsappMessages(accountId, conversationId, 50);
  const latestIncoming = msgs
    .filter((m) => m.direction === "incoming" && m.createdAt)
    .map((m) => Date.parse(m.createdAt))
    .filter(Number.isFinite)
    .sort((a, b) => b - a)[0];

  return latestIncoming
    ? Date.now() - latestIncoming < 24 * 60 * 60 * 1000
    : false;
}

async function waitForWhatsappMessage(accountId, participantId, messageId) {
  let lastMatch = null;
  for (let i = 0; i < 20; i++) {
    const conv = await findWhatsappConversation(accountId, participantId);
    const conversationId = conv?.id || conv?._id;
    if (conversationId) {
      const msgs = await getWhatsappMessages(accountId, conversationId, 20);
      const msg = msgs.find((m) => (m.id || m._id) === messageId);
      if (msg) {
        lastMatch = msg;
        if (msg.deliveryStatus && msg.deliveryStatus !== "sent") return msg;
      }
    }
    await sleep(1000);
  }
  return lastMatch;
}

function assertWhatsappDelivery(message) {
  if (!message || message.deliveryStatus !== "failed") return;

  const err = message.deliveryError || {};
  const code = err.code ? ` ${err.code}` : "";
  const title = err.title || "delivery failed";
  const detail = err.message && err.message !== title ? `: ${err.message}` : "";
  throw new Error(`WhatsApp delivery failed${code}: ${title}${detail}`);
}

/**
 * Initialize the WhatsApp bridge — like Telegram, the user messages the
 * connected number first; we discover the conversation and anchor recv to now.
 */
async function handleWhatsappTalk(args = []) {
  const { to } = parseRecipientArgs(args);
  const target = to ? resolveAddressBookTarget("whatsapp", to) : null;
  const participantId = target?.value || ZERNIO_WA_PARTICIPANT;
  const accountId = await resolveWhatsappAccountId();
  console.log("> channel: whatsapp (via Zernio)");

  let conv = await findWhatsappConversation(accountId, participantId);

  if (!conv) {
    const label = participantId
      ? `from ${participantId}`
      : "to the connected WhatsApp number";
    console.log(`> no conversation yet — send a WhatsApp message ${label} to connect.`);
    console.log("> waiting...");
    for (let i = 0; i < 12 && !conv; i++) {
      await sleep(5000);
      conv = await findWhatsappConversation(accountId, participantId);
    }
    if (!conv) {
      console.error("! timeout — no message received. message the number, then retry.");
      process.exit(1);
    }
  }

  saveWhatsappState({
    accountId,
    conversationId: conv.id,
    participantId: conv.participantId,
    lastSeenAt: conv.updatedTime || new Date().toISOString(),
  });

  console.log(`> connected to: ${conv.participantName || conv.participantId}`);

  try {
    await sendWhatsappText(
      accountId,
      conv.id,
      'Grog is online (WhatsApp).\n\nSend messages here — they will be processed by the active agent session.\n\nSend "bye" to disconnect.',
    );
  } catch (err) {
    console.error(`! welcome not sent: ${err.message}`);
  }

  console.log("> grog talk is active");
  console.log(`> account: ${accountId}`);
  console.log(`> conversation: ${conv.id}`);
}

/**
 * Send a message to WhatsApp — accepts a file path or direct text.
 */
async function handleWhatsappSend(args) {
  const { to, rest } = parseRecipientArgs(args);

  if (isSupportedImagePath(rest[0])) {
    await handleWhatsappSendImage(args);
    return;
  }

  let accountId;
  let conversationId;
  let target = null;

  if (to) {
    target = resolveAddressBookTarget("whatsapp", to);
    accountId = await resolveWhatsappAccountId();
    const conv = await findWhatsappConversation(accountId, target.value);
    if (!conv) {
      console.error(`! error: no active WhatsApp conversation for "${target.label}"`);
      console.error("  use whatsapp-notify with an approved template to start a cold conversation");
      process.exit(1);
    }
    conversationId = conv.id || conv._id;
  } else {
    const state = loadWhatsappState();
    if (!state.conversationId || !state.accountId) {
      console.error('! error: no active conversation — run "grog whatsapp-talk" first');
      process.exit(1);
    }
    accountId = state.accountId;
    conversationId = state.conversationId;
  }

  const message = readMessageFromArgs(rest);

  if (!message) {
    console.error("! error: empty message");
    process.exit(1);
  }

  await sendWhatsappText(accountId, conversationId, message);
  console.log(`> sent to WhatsApp${target ? ` (${target.label})` : ""}`);
}

/**
 * Send an image to WhatsApp — accepts a contact via --to or an active talk state.
 */
async function handleWhatsappSendImage(args) {
  const { to, rest } = parseRecipientArgs(args);
  let accountId;
  let conversationId;
  let participantId;
  let target = null;

  if (to) {
    target = resolveAddressBookTarget("whatsapp", to);
    accountId = await resolveWhatsappAccountId();
    const conv = await findWhatsappConversation(accountId, target.value);
    if (!conv) {
      console.error(`! error: no active WhatsApp conversation for "${target.label}"`);
      console.error("  use whatsapp-notify with an approved template to start a cold conversation, then retry inside the 24h window");
      process.exit(1);
    }
    conversationId = conv.id || conv._id;
    participantId = conv.participantId || target.value;
  } else {
    const state = loadWhatsappState();
    if (!state.conversationId || !state.accountId) {
      console.error('! error: no active conversation — run "grog whatsapp-talk" first');
      process.exit(1);
    }
    accountId = state.accountId;
    conversationId = state.conversationId;
    participantId = state.participantId;
  }

  const imagePath = rest[0];
  const caption = rest.slice(1).join(" ");

  if (!imagePath) {
    console.error("! error: missing image path");
    console.error("  usage: grog whatsapp-send-image [--to contact] <image-path> [caption]");
    process.exit(1);
  }

  if (!existsSync(imagePath)) {
    console.error(`! error: file not found: ${imagePath}`);
    process.exit(1);
  }

  try {
    const data = await sendWhatsappImage(accountId, conversationId, imagePath, caption);
    const messageId = data?.data?.messageId || data?.messageId;
    if (messageId && participantId) {
      const delivered = await waitForWhatsappMessage(accountId, participantId, messageId);
      assertWhatsappDelivery(delivered);
    }
    console.log(`> image sent to WhatsApp${target ? ` (${target.label})` : ""}${messageId ? ` (${messageId})` : ""}`);
  } catch (err) {
    console.error(`! error: failed to send WhatsApp image: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Wait for a WhatsApp message — Zernio's inbox has no long-poll, so we poll
 * the conversation every ~5s for ~90s and return new incoming messages.
 */
async function handleWhatsappRecv() {
  const state = loadWhatsappState();
  if (!state.conversationId || !state.accountId) {
    console.error('! error: no active conversation — run "grog whatsapp-talk" first');
    process.exit(1);
  }
  const sinceMs = state.lastSeenAt ? Date.parse(state.lastSeenAt) : 0;

  for (let attempt = 0; attempt < 18; attempt++) {
    const msgs = await getWhatsappMessages(state.accountId, state.conversationId, 20);

    const fresh = msgs
      .filter((m) => m.direction === "incoming" && Date.parse(m.createdAt) > sinceMs)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

    if (msgs.length > 0) {
      const newest = Math.max(...msgs.map((m) => Date.parse(m.createdAt)));
      if (newest > Date.parse(state.lastSeenAt || 0)) {
        state.lastSeenAt = new Date(newest).toISOString();
        saveWhatsappState(state);
      }
    }

    if (fresh.length > 0) {
      console.log(fresh.map((m) => m.message || "[non-text message]").join("\n"));
      return;
    }
    await sleep(5000);
  }

  console.log("[no message]");
}

/**
 * Notify via WhatsApp — freeform if a conversation is open (inside the 24h
 * window), otherwise re-engage with an approved template.
 */
async function handleWhatsappNotify(args) {
  const { to, rest } = parseRecipientArgs(args);
  const target = to ? resolveAddressBookTarget("whatsapp", to) : null;
  const participantId = target?.value || ZERNIO_WA_PARTICIPANT;
  const message = rest.join(" ");
  if (!message) {
    console.error("! error: empty message");
    process.exit(1);
  }

  const accountId = await resolveWhatsappAccountId();
  const conv = await findWhatsappConversation(accountId, participantId);

  if (conv && await isWhatsappFreeformWindowOpen(accountId, conv.id)) {
    try {
      await sendWhatsappText(accountId, conv.id, message);
      const st = loadWhatsappState();
      if (!st.conversationId) {
        saveWhatsappState({
          accountId,
          conversationId: conv.id,
          participantId: conv.participantId,
          lastSeenAt: new Date().toISOString(),
        });
      }
      console.log(`> notified via WhatsApp${target ? ` (${target.label})` : ""}`);
      return;
    } catch (err) {
      console.error(`> freeform failed (${err.message}); trying template...`);
    }
  }

  const phone = participantId || conv?.participantId;
  if (!phone) {
    console.error("! error: no recipient — set zernio.whatsappParticipantId in config");
    process.exit(1);
  }
  try {
    const data = await zernioApi("POST", "/inbox/conversations", {
      accountId,
      participantId: String(phone).replace(/\D/g, ""),
      templateName: ZERNIO_WA_TEMPLATE.name,
      templateLanguage: ZERNIO_WA_TEMPLATE.language,
      templateParams: [message],
    });
    const messageId = data?.data?.messageId || data?.messageId;
    if (messageId) {
      const delivered = await waitForWhatsappMessage(accountId, phone, messageId);
      assertWhatsappDelivery(delivered);
    }
    console.log(`> notified via WhatsApp template (${ZERNIO_WA_TEMPLATE.name})${target ? ` (${target.label})` : ""}`);
  } catch (err) {
    console.error(`! error: ${err.message}`);
    console.error(`  check the WhatsApp Business Account billing/payment settings for account ${accountId}.`);
    process.exit(1);
  }
}

/**
 * Resolve the bridge channel from CLI flags (--whatsapp/--wa, --telegram/--tg)
 * with GROG_CHANNEL/config.channel as the fallback. Returns the channel plus
 * the args with channel flags stripped out.
 */
function resolveChannelAndArgs(rawArgs) {
  let channel = GROG_CHANNEL;
  const rest = [];
  for (const a of rawArgs) {
    if (a === "--whatsapp" || a === "--wa") channel = "whatsapp";
    else if (a === "--telegram" || a === "--tg") channel = "telegram";
    else rest.push(a);
  }
  return { channel, rest };
}

/**
 * Main function
 */
async function main() {
  const command = process.argv[2];
  const url = process.argv[3];

  if (!command) {
    console.log("");
    boxHeader("GROG");
    console.log("");
    console.log("  usage:");
    console.log("    grog solve <issue-url>          fetch and solve a single issue (GitHub or Linear)");
    console.log("    grog explore <url>              list all issues for batch processing (GitHub or Linear)");
    console.log("    grog review <pr-url>            fetch PR details for code review (GitHub only)");
    console.log("    grog answer <url> <file>        post a summary comment (GitHub or Linear)");
    console.log("    grog create linear --team TEAM --title \"Title\" [--description-file file]");
    console.log("    grog jam <jam-url>              inspect/open a Jam.dev report");
    console.log("    grog start <issue-url|id>       mark a Linear issue as In Progress");
    console.log("    grog done <issue-url|id>        mark a Linear issue as Done");
    console.log("    grog talk                       connect to Telegram for remote interaction");
    console.log("    grog notify <message>           send a quick Telegram notification");
    console.log("    grog contacts list              list saved Telegram/WhatsApp contacts");
    console.log("    grog contacts save me --whatsapp +393341123870 --telegram 123456");
    console.log("");
    console.log("  github examples:");
    console.log("    grog solve https://github.com/owner/repo/issues/123");
    console.log("    grog explore https://github.com/owner/repo");
    console.log("    grog explore https://github.com/orgs/myorg/projects/1");
    console.log("    grog review https://github.com/owner/repo/pull/123");
    console.log("    grog answer https://github.com/owner/repo/issues/123 /tmp/summary.md");
    console.log("");
    console.log("  linear examples:");
    console.log("    grog solve https://linear.app/workspace/issue/PROJ-123");
    console.log("    grog explore https://linear.app/workspace/team/PROJ");
    console.log("    grog explore https://linear.app/workspace");
    console.log("    grog create linear --team PROJ --title \"Bug title\" --description-file /tmp/body.md");
    console.log("    grog answer https://linear.app/workspace/issue/PROJ-123 /tmp/summary.md");
    console.log("    grog start https://linear.app/workspace/issue/PROJ-123");
    console.log("    grog done https://linear.app/workspace/issue/PROJ-123");
    console.log("");
    console.log("  jam examples:");
    console.log("    grog jam https://jam.dev/c/abcd-1234");
    console.log("    grog jam https://jam.dev/c/abcd-1234 --screenshot");
    console.log("    grog jam https://jam.dev/c/abcd-1234 --open");
    console.log("    grog jam https://jam.dev/c/abcd-1234 --telegram");
    console.log("");
    console.log("  messaging examples:");
    console.log("    grog notify --whatsapp --to me \"Message\"");
    console.log("    grog whatsapp-send-image --to me /tmp/screenshot.png \"Caption\"");
    console.log("    grog telegram-send --to me \"Message\"");
    console.log("");
    process.exit(1);
  }

  switch (command) {
    case "solve":
      if (!url) {
        console.error("! error: missing issue URL");
        console.log("  usage: grog solve <github-issue-url>");
        process.exit(1);
      }
      await handleSolve(url);
      break;

    case "explore":
      if (!url) {
        console.error("! error: missing URL");
        console.log("  usage: grog explore <github-repo-or-project-url>");
        process.exit(1);
      }
      await handleExplore(url);
      break;

    case "review":
      if (!url) {
        console.error("Error: Missing PR URL");
        console.log("Usage: grog review <github-pr-url>");
        process.exit(1);
      }
      await handleReview(url);
      break;

    case "answer": {
      const summaryFile = process.argv[4];
      const answerArgs = process.argv.slice(5);
      if (!url) {
        console.error("! error: missing issue URL");
        console.log("  usage: grog answer <issue-url> <path-to-summary-file> [--image path]");
        process.exit(1);
      }
      await handleAnswer(url, summaryFile, answerArgs);
      break;
    }

    case "create": {
      const createArgs = process.argv.slice(3);
      if (createArgs.length === 0) {
        console.error("! error: missing create target");
        console.log("  usage: grog create linear --team TEAM --title \"Title\" [--description-file file]");
        process.exit(1);
      }
      await handleCreate(createArgs);
      break;
    }

    case "jam": {
      const jamArgs = process.argv.slice(3);
      if (jamArgs.length === 0) {
        console.error("! error: missing Jam URL");
        console.log("  usage: grog jam https://jam.dev/c/<id> [--open] [--telegram] [--json] [--screenshot [file]]");
        process.exit(1);
      }
      await handleJam(jamArgs);
      break;
    }

    case "contact":
    case "contacts":
      await handleContacts(process.argv.slice(3));
      break;

    case "done":
      if (!url) {
        console.error("! error: missing Linear issue URL or identifier");
        console.log("  usage: grog done <linear-issue-url-or-identifier>");
        process.exit(1);
      }
      await handleDone(url);
      break;

    case "start":
      if (!url) {
        console.error("! error: missing Linear issue URL or identifier");
        console.log("  usage: grog start <linear-issue-url-or-identifier>");
        process.exit(1);
      }
      await handleStart(url);
      break;

    case "talk": {
      const { channel, rest } = resolveChannelAndArgs(process.argv.slice(3));
      if (channel === "whatsapp") await handleWhatsappTalk(rest);
      else await handleTalk();
      break;
    }

    // Generic channel-agnostic receive (routes by GROG_CHANNEL/config/flag)
    case "recv": {
      const { channel } = resolveChannelAndArgs(process.argv.slice(3));
      if (channel === "whatsapp") await handleWhatsappRecv();
      else await handleTelegramRecv();
      break;
    }

    // Generic channel-agnostic send (routes by GROG_CHANNEL/config/flag)
    case "send": {
      const { channel, rest } = resolveChannelAndArgs(process.argv.slice(3));
      if (rest.length === 0) {
        console.error("! error: missing message or file path");
        console.log("  usage: grog send [--whatsapp|--telegram] [--to contact] <message-or-image-path>");
        process.exit(1);
      }
      if (channel === "whatsapp") await handleWhatsappSend(rest);
      else await handleTelegramSend(rest);
      break;
    }

    case "telegram-send": {
      const sendArgs = process.argv.slice(3);
      if (sendArgs.length === 0) {
        console.error("! error: missing message or file path");
        console.log("  usage: grog telegram-send [--to contact] <message-or-file-path>");
        process.exit(1);
      }
      await handleTelegramSend(sendArgs);
      break;
    }

    case "telegram-recv":
      await handleTelegramRecv();
      break;

    case "whatsapp-talk":
      await handleWhatsappTalk(process.argv.slice(3));
      break;

    case "whatsapp-recv":
      await handleWhatsappRecv();
      break;

    case "whatsapp-send": {
      const waArgs = process.argv.slice(3);
      if (waArgs.length === 0) {
        console.error("! error: missing message or file path");
        console.log("  usage: grog whatsapp-send [--to contact] <message-or-file-path>");
        process.exit(1);
      }
      await handleWhatsappSend(waArgs);
      break;
    }

    case "whatsapp-send-image": {
      const imageArgs = process.argv.slice(3);
      if (imageArgs.length === 0) {
        console.error("! error: missing image path");
        console.log("  usage: grog whatsapp-send-image [--to contact] <image-path> [caption]");
        process.exit(1);
      }
      await handleWhatsappSendImage(imageArgs);
      break;
    }

    case "whatsapp-notify": {
      const waArgs = process.argv.slice(3);
      if (waArgs.length === 0) {
        console.error("! error: missing message");
        console.log("  usage: grog whatsapp-notify [--to contact] <message>");
        process.exit(1);
      }
      await handleWhatsappNotify(waArgs);
      break;
    }

    case "notify": {
      const { channel, rest } = resolveChannelAndArgs(process.argv.slice(3));
      if (rest.length === 0) {
        console.error("! error: missing message");
        console.log("  usage: grog notify [--whatsapp|--telegram] [--to contact] <message>");
        process.exit(1);
      }
      if (channel === "whatsapp") await handleWhatsappNotify(rest);
      else await handleNotify(rest);
      break;
    }

    case "prompt": {
      const promptArgs = process.argv.slice(3);
      if (promptArgs.length === 0) {
        console.error("! error: missing message");
        console.error("  usage: grog prompt <message>");
        process.exit(1);
      }
      await handlePrompt(promptArgs);
      break;
    }

    case "telegram-send-image": {
      const imageArgs = process.argv.slice(3);
      if (imageArgs.length === 0) {
        console.error("! error: missing image path");
        console.error("  usage: grog telegram-send-image <image-path> [caption]");
        process.exit(1);
      }
      await handleTelegramSendImage(imageArgs);
      break;
    }

    default:
      // Backwards compatibility: if the argument looks like a URL, auto-detect command
      if (command.includes("linear.app") && command.includes("/issue/")) {
        await handleSolve(command);
      } else if (command.includes("linear.app")) {
        await handleExplore(command);
      } else if (command.includes("github.com") && command.includes("/issues/")) {
        await handleSolve(command);
      } else if (command.includes("github.com") && command.includes("/pull/")) {
        await handleReview(command);
      } else if (command.includes("github.com")) {
        await handleExplore(command);
      } else if (command.includes("jam.dev/")) {
        await handleJam([command]);
      } else {
        console.error(`! error: unknown command '${command}'`);
        console.log("  available: solve, explore, review, answer, create, jam, start, done, contacts");
        process.exit(1);
      }
  }
}

main();
