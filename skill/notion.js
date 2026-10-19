// Notion for grog: Markdown in, Notion blocks out, through the public REST API.
// The token never leaves this module except in the Authorization header; every
// error message that could echo it is scrubbed first.

export const NOTION_VERSION = "2022-06-28";

const MAX_CHILDREN = 100;
const MAX_ELEMENTS = 900;
const MAX_TEXT = 2000;
const MAX_RICH_TEXT_ITEMS = 100;
const MAX_TABLE_ROWS = 100;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;

export function notionApiBase(env = process.env) {
  return String(env.GROG_NOTION_API || "https://api.notion.com/v1").replace(/\/+$/, "");
}

/** A page or database id from a Notion URL, a dashed UUID or 32 hex characters. */
export function parseNotionId(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  let hex = null;
  const query = input.match(/[?&]p=([0-9a-f]{32})\b/i);
  const dashed = input.match(/\b([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\b/i);
  if (query) {
    hex = query[1];
  } else if (dashed) {
    hex = dashed.slice(1).join("");
  } else {
    const path = input.split(/[?#]/)[0];
    const matches = path.match(/(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi);
    if (matches) hex = matches[matches.length - 1];
  }
  if (!hex) return null;
  hex = hex.toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ─── inline Markdown → rich text ─────────────────────────

const ESCAPABLE = "\\`*_{}[]()#+-.!~|>";
const ESCAPE_BASE = 0xe000;

function protectEscapes(text) {
  return text.replace(/\\([\\`*_{}[\]()#+\-.!~|>])/g, (_, ch) => String.fromCharCode(ESCAPE_BASE + ESCAPABLE.indexOf(ch)));
}

function restoreEscapes(text) {
  return text.replace(/[-]/g, (ch) => ESCAPABLE[ch.charCodeAt(0) - ESCAPE_BASE]);
}

const INLINE_PATTERNS = [
  { kind: "code", re: /`([^`]+)`/ },
  { kind: "link", re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
  { kind: "bold", re: /\*\*(.+?)\*\*/ },
  { kind: "bold", re: /__(.+?)__/ },
  { kind: "strike", re: /~~(.+?)~~/ },
  { kind: "italic", re: /\*(?![\s*])([^*]+?)\*/ },
  { kind: "italic", re: /(?<![\w])_(?![\s_])([^_]+?)_(?![\w])/ },
];

function nextInline(text) {
  let best = null;
  for (const pattern of INLINE_PATTERNS) {
    const match = pattern.re.exec(text);
    if (!match) continue;
    if (!best || match.index < best.index || (match.index === best.index && match[0].length > best.length)) {
      best = { kind: pattern.kind, index: match.index, length: match[0].length, inner: match[1], href: match[2] };
    }
  }
  return best;
}

function pushText(out, content, annotations, link) {
  if (!content) return;
  const item = { type: "text", text: { content: restoreEscapes(content) } };
  if (link) item.text.link = { url: link };
  const set = Object.entries(annotations).filter(([, on]) => on);
  if (set.length) item.annotations = Object.fromEntries(set);
  out.push(item);
}

function parseInline(text, annotations, link, out) {
  let rest = text;
  while (rest) {
    const match = nextInline(rest);
    if (!match) {
      pushText(out, rest, annotations, link);
      return;
    }
    pushText(out, rest.slice(0, match.index), annotations, link);
    if (match.kind === "code") {
      pushText(out, match.inner, { ...annotations, code: true }, link);
    } else if (match.kind === "link") {
      const href = restoreEscapes(match.href);
      parseInline(match.inner, annotations, SAFE_LINK.test(href) ? href : link, out);
    } else if (match.kind === "bold") {
      parseInline(match.inner, { ...annotations, bold: true }, link, out);
    } else if (match.kind === "italic") {
      parseInline(match.inner, { ...annotations, italic: true }, link, out);
    } else {
      parseInline(match.inner, { ...annotations, strikethrough: true }, link, out);
    }
    rest = rest.slice(match.index + match.length);
  }
}

function splitLongItems(items) {
  const out = [];
  for (const item of items) {
    const content = item.text.content;
    if (content.length <= MAX_TEXT) {
      out.push(item);
      continue;
    }
    for (let i = 0; i < content.length; i += MAX_TEXT) {
      out.push({ ...item, text: { ...item.text, content: content.slice(i, i + MAX_TEXT) } });
    }
  }
  return out;
}

/** Inline Markdown (bold, italic, strike, code, links) as Notion rich text. */
export function richText(text) {
  const out = [];
  parseInline(protectEscapes(String(text ?? "")), {}, null, out);
  return splitLongItems(out);
}

function plainRichText(text) {
  return splitLongItems([{ type: "text", text: { content: String(text ?? "") } }]).filter((item) => item.text.content);
}

// ─── block Markdown → blocks ─────────────────────────────

const CODE_LANGUAGES = new Set([
  "abap", "arduino", "bash", "basic", "c", "clojure", "coffeescript", "c++", "c#", "css", "dart", "diff", "docker",
  "elixir", "elm", "erlang", "flow", "fortran", "f#", "gherkin", "glsl", "go", "graphql", "groovy", "haskell", "html",
  "java", "javascript", "json", "julia", "kotlin", "latex", "less", "lisp", "livescript", "lua", "makefile", "markdown",
  "markup", "matlab", "mermaid", "nix", "objective-c", "ocaml", "pascal", "perl", "php", "plain text", "powershell",
  "prolog", "protobuf", "python", "r", "reason", "ruby", "rust", "sass", "scala", "scheme", "scss", "shell", "solidity",
  "sql", "swift", "typescript", "vb.net", "verilog", "vhdl", "visual basic", "webassembly", "xml", "yaml",
]);

const CODE_ALIASES = {
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript", node: "javascript",
  ts: "typescript", tsx: "typescript", sh: "shell", zsh: "shell", console: "shell", terminal: "shell",
  py: "python", yml: "yaml", md: "markdown", rs: "rust", golang: "go", dockerfile: "docker",
  cpp: "c++", cs: "c#", csharp: "c#", kt: "kotlin", rb: "ruby", sol: "solidity", txt: "plain text",
  text: "plain text", plaintext: "plain text", ps1: "powershell", proto: "protobuf",
};

export function notionCodeLanguage(tag) {
  const lang = String(tag || "").trim().toLowerCase();
  if (CODE_LANGUAGES.has(lang)) return lang;
  return CODE_ALIASES[lang] || "plain text";
}

function block(type, body) {
  return { object: "block", type, [type]: body };
}

function textBlocks(type, items, extra = {}) {
  if (items.length <= MAX_RICH_TEXT_ITEMS) return [block(type, { rich_text: items, ...extra })];
  const out = [];
  for (let i = 0; i < items.length; i += MAX_RICH_TEXT_ITEMS) {
    out.push(block(type, { rich_text: items.slice(i, i + MAX_RICH_TEXT_ITEMS), ...extra }));
  }
  return out;
}

function softJoin(lines) {
  const paragraphs = [];
  let current = [];
  for (const line of lines) {
    if (line.trim()) {
      current.push(line.trim());
    } else if (current.length) {
      paragraphs.push(current.join(" "));
      current = [];
    }
  }
  if (current.length) paragraphs.push(current.join(" "));
  return paragraphs.join("\n");
}

const CALLOUTS = {
  NOTE: { emoji: "ℹ️", color: "blue_background" },
  TIP: { emoji: "💡", color: "green_background" },
  IMPORTANT: { emoji: "❗", color: "purple_background" },
  WARNING: { emoji: "⚠️", color: "orange_background" },
  CAUTION: { emoji: "🛑", color: "red_background" },
};

function quoteBlocks(lines) {
  const head = lines[0].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(.*)$/i);
  if (!head) return textBlocks("quote", richText(softJoin(lines)));
  const style = CALLOUTS[head[1].toUpperCase()];
  const text = softJoin([head[2], ...lines.slice(1)]);
  return textBlocks("callout", richText(text), { icon: { type: "emoji", emoji: style.emoji }, color: style.color });
}

function codeBlock(text, tag) {
  return block("code", { rich_text: plainRichText(text), language: notionCodeLanguage(tag) });
}

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function listItemBlock(marker, text) {
  const task = text.match(/^\[([ xX])\]\s+(.*)$/);
  if (task) return block("to_do", { rich_text: richText(task[2]), checked: task[1].toLowerCase() === "x" });
  const type = /^\d/.test(marker) ? "numbered_list_item" : "bulleted_list_item";
  return block(type, { rich_text: richText(text) });
}

function lastListTarget(items) {
  const parent = items[items.length - 1];
  const children = parent[parent.type].children;
  return children && children.length ? children[children.length - 1] : parent;
}

// Notion takes two levels of nesting per request, so deeper items join the
// second level instead of being dropped.
function parseList(lines, start) {
  const items = [];
  let baseIndent = null;
  let i = start;
  while (i < lines.length) {
    const match = lines[i].match(LIST_ITEM);
    if (!match) {
      const continuation = lines[i].match(/^\s{2,}(\S.*)$/);
      if (continuation && items.length) {
        const target = lastListTarget(items);
        target[target.type].rich_text.push(...richText(` ${continuation[1]}`));
        i++;
        continue;
      }
      break;
    }
    const indent = match[1].replace(/\t/g, "    ").length;
    if (baseIndent === null) baseIndent = indent;
    const item = listItemBlock(match[2], match[3]);
    if (indent > baseIndent && items.length) {
      const parent = items[items.length - 1];
      (parent[parent.type].children ||= []).push(item);
    } else {
      items.push(item);
    }
    i++;
  }
  return { items, next: i };
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line || "") && line.includes("-");
}

// A cell keeps its other escapes for richText; only an escaped pipe becomes a pipe.
function restoreCellEscapes(text) {
  return text.replace(/[\ue000-\ue012]/g, (ch) => {
    const original = ESCAPABLE[ch.charCodeAt(0) - ESCAPE_BASE];
    return original === "|" ? "|" : `\\${original}`;
  });
}

function splitRow(line) {
  let row = protectEscapes(line.trim());
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => restoreCellEscapes(cell.trim()));
}

function tableBlocks(header, rows) {
  const width = header.length;
  const asRow = (cells) => block("table_row", { cells: Array.from({ length: width }, (_, k) => richText(cells[k] ?? "")) });
  const out = [];
  const perTable = MAX_TABLE_ROWS - 1;
  for (let i = 0; i < Math.max(rows.length, 1); i += perTable) {
    const children = [asRow(header), ...rows.slice(i, i + perTable).map(asRow)];
    out.push(block("table", { table_width: width, has_column_header: true, has_row_header: false, children }));
  }
  return out;
}

/** GitHub-flavoured Markdown as Notion blocks. */
export function markdownToBlocks(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (!paragraph.length) return;
    blocks.push(...textBlocks("paragraph", richText(paragraph.join(" "))));
    paragraph = [];
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    const fence = trimmed.match(/^(```+|~~~+)\s*([^\s`]*)/);
    if (fence) {
      flush();
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push(codeBlock(body.join("\n"), fence[2]));
      continue;
    }
    if (!trimmed) {
      flush();
      i++;
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      flush();
      blocks.push(...textBlocks(`heading_${Math.min(heading[1].length, 3)}`, richText(heading[2])));
      i++;
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(trimmed)) {
      flush();
      blocks.push(block("divider", {}));
      i++;
      continue;
    }
    if (trimmed.startsWith("|") && isTableSeparator(lines[i + 1])) {
      flush();
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(splitRow(lines[i++]));
      blocks.push(...tableBlocks(header, rows));
      continue;
    }
    if (trimmed.startsWith(">")) {
      flush();
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) quote.push(lines[i++].trim().replace(/^>\s?/, ""));
      blocks.push(...quoteBlocks(quote));
      continue;
    }
    const image = trimmed.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)$/);
    if (image) {
      flush();
      blocks.push(block("image", { type: "external", external: { url: image[2] }, caption: richText(image[1]) }));
      i++;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      flush();
      const { items, next } = parseList(lines, i);
      blocks.push(...items);
      i = next;
      continue;
    }
    paragraph.push(trimmed);
    i++;
  }
  flush();
  return blocks;
}

function elementCount(item) {
  const children = item[item.type]?.children || [];
  return 1 + children.reduce((sum, child) => sum + elementCount(child), 0);
}

/** Request-sized groups: at most 100 blocks and well under 1000 elements each. */
export function chunkBlocks(blocks) {
  const chunks = [];
  let current = [];
  let elements = 0;
  for (const item of blocks) {
    const size = elementCount(item);
    if (current.length && (current.length >= MAX_CHILDREN || elements + size > MAX_ELEMENTS)) {
      chunks.push(current);
      current = [];
      elements = 0;
    }
    current.push(item);
    elements += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

// ─── database properties ─────────────────────────────────

export class NotionUsageError extends Error {}

function findProperty(schema, name) {
  if (schema[name]) return [name, schema[name]];
  const lower = name.toLowerCase();
  return Object.entries(schema).find(([key]) => key.toLowerCase() === lower) || null;
}

export function titlePropertyName(schema) {
  const entry = Object.entries(schema || {}).find(([, prop]) => prop.type === "title");
  return entry ? entry[0] : null;
}

function propertyValue(name, prop, raw) {
  const value = String(raw).trim();
  switch (prop.type) {
    case "title":
      return { title: richText(value) };
    case "rich_text":
      return { rich_text: richText(value) };
    case "select":
      return { select: value ? { name: value } : null };
    case "multi_select":
      return { multi_select: value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => ({ name: part })) };
    case "status": {
      const options = (prop.status?.options || []).map((option) => option.name);
      const match = options.find((option) => option.toLowerCase() === value.toLowerCase());
      if (!match) throw new NotionUsageError(`property "${name}" has no status "${value}" (options: ${options.join(", ")})`);
      return { status: { name: match } };
    }
    case "number": {
      const number = Number(value);
      if (!value || !Number.isFinite(number)) throw new NotionUsageError(`property "${name}" needs a number, got "${value}"`);
      return { number };
    }
    case "checkbox":
      if (/^(true|yes|1|x)$/i.test(value)) return { checkbox: true };
      if (/^(false|no|0)$/i.test(value)) return { checkbox: false };
      throw new NotionUsageError(`property "${name}" needs true or false, got "${value}"`);
    case "url":
      return { url: value || null };
    case "email":
      return { email: value || null };
    case "phone_number":
      return { phone_number: value || null };
    case "date": {
      const [start, end] = value.split("..").map((part) => part.trim());
      const iso = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;
      if (!iso.test(start) || (end && !iso.test(end))) {
        throw new NotionUsageError(`property "${name}" needs an ISO date (2026-10-27 or 2026-10-20..2026-10-27), got "${value}"`);
      }
      return { date: end ? { start, end } : { start } };
    }
    case "relation": {
      const ids = value.split(",").map((part) => part.trim()).filter(Boolean).map((part) => [part, parseNotionId(part)]);
      const bad = ids.find(([, id]) => !id);
      if (bad) throw new NotionUsageError(`property "${name}" needs Notion page links or ids, got "${bad[0]}"`);
      return { relation: ids.map(([, id]) => ({ id })) };
    }
    default:
      throw new NotionUsageError(`property "${name}" is a ${prop.type} property, which grog cannot set`);
  }
}

/** --prop Name=value pairs as a properties payload, checked against the database schema. */
export function buildProperties(schema, pairs) {
  const properties = {};
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new NotionUsageError(`--prop needs Name=value, got "${pair}"`);
    const name = pair.slice(0, eq).trim();
    const found = findProperty(schema, name);
    if (!found) throw new NotionUsageError(`the database has no property "${name}" (properties: ${Object.keys(schema).join(", ")})`);
    const [key, prop] = found;
    properties[key] = propertyValue(key, prop, pair.slice(eq + 1));
  }
  return properties;
}

// ─── CLI arguments ───────────────────────────────────────

const SUBCOMMANDS = ["search", "create", "append", "replace"];
const VALUE_FLAGS = new Set(["--workspace", "-w", "--parent", "--title", "--file", "-f", "--prop", "--icon"]);

function flagValues(args, names) {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    for (const name of names) {
      if (args[i] === name) values.push(args[i + 1]);
      else if (args[i].startsWith(`${name}=`)) values.push(args[i].slice(name.length + 1));
    }
  }
  return values;
}

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i].split("=")[0];
    if (VALUE_FLAGS.has(flag)) {
      if (!args[i].includes("=")) i++;
      continue;
    }
    if (args[i].startsWith("--")) continue;
    out.push(args[i]);
  }
  return out;
}

function single(args, names, label) {
  const values = flagValues(args, names);
  if (values.length > 1) throw new NotionUsageError(`${label} given more than once`);
  const value = values[0];
  if (value !== undefined && (!value || value.startsWith("--"))) throw new NotionUsageError(`${label} needs a value`);
  return value;
}

/**
 * Everything a notion command needs, validated before any token is read or
 * request is made. Throws NotionUsageError.
 */
export function parseNotionArgs(args) {
  const [sub, ...rest] = args;
  if (!SUBCOMMANDS.includes(sub)) throw new NotionUsageError(`unknown notion command "${sub ?? ""}" (use ${SUBCOMMANDS.join(", ")})`);
  const workspace = single(rest, ["--workspace", "-w"], "--workspace");
  if (workspace !== undefined && !/^[A-Za-z][A-Za-z0-9_]*$/.test(workspace)) {
    throw new NotionUsageError(`--workspace must be letters, digits and underscores, got "${workspace}"`);
  }
  const parsed = { sub, workspace: workspace?.toUpperCase() };

  if (sub === "search") {
    parsed.query = positionals(rest).join(" ");
    return parsed;
  }

  parsed.file = single(rest, ["--file", "-f"], "--file");
  if (!parsed.file) throw new NotionUsageError("--file <markdown file> is required");
  parsed.title = single(rest, ["--title"], "--title");
  parsed.icon = single(rest, ["--icon"], "--icon");
  parsed.props = flagValues(rest, ["--prop"]);
  for (const pair of parsed.props) {
    if (!pair || pair.indexOf("=") <= 0) throw new NotionUsageError(`--prop needs Name=value, got "${pair ?? ""}"`);
  }

  if (sub === "create") {
    const parent = single(rest, ["--parent"], "--parent");
    if (!parent) throw new NotionUsageError("--parent <page or database link> is required");
    parsed.parentId = parseNotionId(parent);
    if (!parsed.parentId) throw new NotionUsageError(`--parent is not a Notion link or id: "${parent}"`);
    if (!parsed.title || !parsed.title.trim()) throw new NotionUsageError("--title is required");
    return parsed;
  }

  const [target] = positionals(rest);
  if (!target) throw new NotionUsageError(`grog notion ${sub} needs the page link or id`);
  parsed.pageId = parseNotionId(target);
  if (!parsed.pageId) throw new NotionUsageError(`not a Notion link or id: "${target}"`);
  if (sub === "append" && (parsed.title || parsed.props.length)) {
    throw new NotionUsageError("append only adds blocks; use replace to change the title or properties");
  }
  return parsed;
}

// ─── API client ──────────────────────────────────────────

export class NotionError extends Error {
  constructor(status, code, message) {
    super(`notion ${status}${code ? ` ${code}` : ""}: ${message}`);
    this.status = status;
    this.code = code;
  }
}

export function plainTitle(object) {
  if (object?.object === "database") return (object.title || []).map((t) => t.plain_text || "").join("");
  const title = Object.values(object?.properties || {}).find((prop) => prop.type === "title");
  return (title?.title || []).map((t) => t.plain_text || "").join("");
}

export class NotionClient {
  constructor({ token, base = notionApiBase(), fetchImpl = fetch, sleep } = {}) {
    if (!token) throw new Error("no Notion token");
    this.token = token;
    this.base = base;
    this.fetch = fetchImpl;
    this.sleep = sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  scrub(text) {
    return String(text ?? "").split(this.token).join("[redacted]");
  }

  async request(method, path, body) {
    for (let attempt = 0; ; attempt++) {
      const response = await this.fetch(`${this.base}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const raw = await response.text();
      let data = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        data = {};
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 4) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.sleep(Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt, 10000));
        continue;
      }
      if (!response.ok) {
        throw new NotionError(response.status, data.code, this.scrub(data.message || raw.slice(0, 300) || response.statusText));
      }
      return data;
    }
  }

  async search(query) {
    const results = [];
    let cursor;
    for (let page = 0; page < 10; page++) {
      const body = { page_size: 100 };
      if (query) body.query = query;
      if (cursor) body.start_cursor = cursor;
      const data = await this.request("POST", "/search", body);
      results.push(...(data.results || []));
      if (!data.has_more || !data.next_cursor) break;
      cursor = data.next_cursor;
    }
    return results;
  }

  /** A page or a database, whichever the id is. */
  async retrieve(id) {
    try {
      return await this.request("GET", `/pages/${id}`);
    } catch (err) {
      if (!(err instanceof NotionError) || ![400, 404].includes(err.status)) throw err;
      try {
        return await this.request("GET", `/databases/${id}`);
      } catch {
        throw err;
      }
    }
  }

  async appendChildren(blockId, blocks) {
    let written = 0;
    for (const chunk of chunkBlocks(blocks)) {
      await this.request("PATCH", `/blocks/${blockId}/children`, { children: chunk });
      written += chunk.length;
    }
    return written;
  }

  async createPage({ parent, properties, blocks, icon }) {
    const [first = [], ...rest] = chunkBlocks(blocks);
    const body = { parent, properties, children: first };
    if (icon) body.icon = { type: "emoji", emoji: icon };
    const page = await this.request("POST", "/pages", body);
    for (const chunk of rest) await this.request("PATCH", `/blocks/${page.id}/children`, { children: chunk });
    return page;
  }

  async listChildren(blockId) {
    const children = [];
    let cursor;
    do {
      const query = `?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`;
      const data = await this.request("GET", `/blocks/${blockId}/children${query}`);
      children.push(...(data.results || []));
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return children;
  }

  async replaceChildren(pageId, blocks) {
    const old = await this.listChildren(pageId);
    for (const child of old) await this.request("DELETE", `/blocks/${child.id}`);
    const written = await this.appendChildren(pageId, blocks);
    return { removed: old.length, written };
  }

  async updatePage(pageId, { properties, icon }) {
    const body = {};
    if (properties && Object.keys(properties).length) body.properties = properties;
    if (icon) body.icon = { type: "emoji", emoji: icon };
    if (!Object.keys(body).length) return null;
    return this.request("PATCH", `/pages/${pageId}`, body);
  }
}
