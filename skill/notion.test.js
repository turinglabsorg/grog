import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, test } from "node:test";

import {
  NotionClient,
  NotionUsageError,
  buildProperties,
  chunkBlocks,
  markdownToBlocks,
  notionCodeLanguage,
  parseNotionArgs,
  parseNotionId,
  richText,
} from "./notion.js";

const ID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const HEX = ID.replace(/-/g, "");

describe("parseNotionId", () => {
  test("reads app.notion.com, notion.so, dashed and bare ids", () => {
    assert.equal(parseNotionId(`https://app.notion.com/p/${HEX}`), ID);
    assert.equal(parseNotionId(`https://www.notion.so/acme/Launch-plan-${HEX}`), ID);
    assert.equal(parseNotionId(`https://www.notion.so/acme/Launch-plan-${HEX}?pvs=4`), ID);
    assert.equal(parseNotionId(`https://www.notion.so/acme/Docs?p=${HEX}&pm=s`), ID);
    assert.equal(parseNotionId(ID.toUpperCase()), ID);
    assert.equal(parseNotionId(HEX), ID);
  });

  test("refuses anything without a full id", () => {
    assert.equal(parseNotionId(""), null);
    assert.equal(parseNotionId("https://www.notion.so/acme/Launch-plan"), null);
    assert.equal(parseNotionId(HEX.slice(1)), null);
    assert.equal(parseNotionId(`${HEX}0`), null);
  });
});

describe("richText", () => {
  test("bold, italic, strike, code and links", () => {
    const items = richText("a **bold** and *it* ~~old~~ `x = 1` [site](https://example.com/site) end");
    const by = (content) => items.find((item) => item.text.content === content);
    assert.deepEqual(by("bold").annotations, { bold: true });
    assert.deepEqual(by("it").annotations, { italic: true });
    assert.deepEqual(by("old").annotations, { strikethrough: true });
    assert.deepEqual(by("x = 1").annotations, { code: true });
    assert.deepEqual(by("site").text.link, { url: "https://example.com/site" });
    assert.equal(items.map((item) => item.text.content).join(""), "a bold and it old x = 1 site end");
  });

  test("nested marks and links inside bold", () => {
    const items = richText("**see [docs](https://example.com) now**");
    assert.deepEqual(items.map((item) => [item.text.content, item.annotations, item.text.link?.url]), [
      ["see ", { bold: true }, undefined],
      ["docs", { bold: true }, "https://example.com"],
      [" now", { bold: true }, undefined],
    ]);
  });

  test("a relative or script link stays plain text", () => {
    for (const href of ["./plan.md", "javascript:alert"]) {
      const items = richText(`[here](${href})`);
      assert.equal(items.length, 1);
      assert.equal(items[0].text.content, "here");
      assert.equal(items[0].text.link, undefined);
    }
  });

  test("snake_case and escaped markers are literal", () => {
    assert.deepEqual(richText("over_staging and pg_stat_statements").map((i) => i.annotations), [undefined]);
    assert.equal(richText("2 \\* 3 \\*not italic\\*")[0].text.content, "2 * 3 *not italic*");
  });

  test("splits text over 2000 characters", () => {
    const items = richText("x".repeat(4500));
    assert.deepEqual(items.map((item) => item.text.content.length), [2000, 2000, 500]);
  });
});

describe("markdownToBlocks", () => {
  test("headings, paragraphs, dividers and soft line breaks", () => {
    const blocks = markdownToBlocks("# One\n\n## Two\n\n#### Four\n\nfirst line\nsecond line\n\n---\n\nnext");
    assert.deepEqual(blocks.map((b) => b.type), ["heading_1", "heading_2", "heading_3", "paragraph", "divider", "paragraph"]);
    assert.equal(blocks[3].paragraph.rich_text[0].text.content, "first line second line");
  });

  test("bullets, numbers, tasks and one level of nesting", () => {
    const blocks = markdownToBlocks("- one\n  - child\n    - grandchild\n  continued\n- [x] done\n- [ ] todo\n\n1. first\n2. second");
    assert.deepEqual(blocks.map((b) => b.type), ["bulleted_list_item", "to_do", "to_do", "numbered_list_item", "numbered_list_item"]);
    const children = blocks[0].bulleted_list_item.children;
    assert.deepEqual(children.map((c) => c.bulleted_list_item.rich_text.map((t) => t.text.content).join("")), ["child", "grandchild continued"]);
    assert.equal(blocks[1].to_do.checked, true);
    assert.equal(blocks[2].to_do.checked, false);
  });

  test("fenced code keeps its text and maps the language", () => {
    const [code] = markdownToBlocks("```ts\nconst a = 1;\n**not bold**\n```");
    assert.equal(code.type, "code");
    assert.equal(code.code.language, "typescript");
    assert.equal(code.code.rich_text[0].text.content, "const a = 1;\n**not bold**");
    assert.equal(notionCodeLanguage("weird"), "plain text");
    assert.equal(notionCodeLanguage("sh"), "shell");
  });

  test("tables with a header row, inline marks and escaped pipes", () => {
    const [table] = markdownToBlocks("| Task | Where |\n|---|:--:|\n| `migrate` | a \\| b |\n| **x** |");
    assert.equal(table.type, "table");
    assert.equal(table.table.table_width, 2);
    assert.equal(table.table.has_column_header, true);
    const rows = table.table.children.map((row) => row.table_row.cells.map((cell) => cell.map((t) => t.text.content).join("")));
    assert.deepEqual(rows, [["Task", "Where"], ["migrate", "a | b"], ["x", ""]]);
    assert.deepEqual(table.table.children[1].table_row.cells[0][0].annotations, { code: true });
  });

  test("quotes and GitHub alerts as callouts", () => {
    const blocks = markdownToBlocks("> plain quote\n> still quote\n\n> [!WARNING]\n> Off switches\n>\n> second paragraph");
    assert.equal(blocks[0].type, "quote");
    assert.equal(blocks[0].quote.rich_text[0].text.content, "plain quote still quote");
    assert.equal(blocks[1].type, "callout");
    assert.equal(blocks[1].callout.icon.emoji, "⚠️");
    assert.equal(blocks[1].callout.rich_text[0].text.content, "Off switches\nsecond paragraph");
  });

  test("an image line becomes an external image", () => {
    const [image] = markdownToBlocks("![shot](https://example.com/a.png)");
    assert.equal(image.type, "image");
    assert.equal(image.image.external.url, "https://example.com/a.png");
  });
});

describe("chunkBlocks", () => {
  test("at most 100 blocks per request", () => {
    const blocks = markdownToBlocks(Array.from({ length: 250 }, (_, i) => `p${i}`).join("\n\n"));
    assert.deepEqual(chunkBlocks(blocks).map((chunk) => chunk.length), [100, 100, 50]);
  });

  test("tables count their rows toward the element limit", () => {
    const table = `| a | b |\n|---|---|\n${Array.from({ length: 98 }, (_, i) => `| ${i} | x |`).join("\n")}`;
    const blocks = markdownToBlocks(Array.from({ length: 12 }, () => table).join("\n\n"));
    const chunks = chunkBlocks(blocks);
    assert.ok(chunks.length > 1);
    for (const chunk of chunks) {
      const elements = chunk.reduce((sum, b) => sum + 1 + (b.table?.children?.length || 0), 0);
      assert.ok(elements <= 900, `chunk has ${elements} elements`);
    }
  });
});

describe("buildProperties", () => {
  const schema = {
    Name: { type: "title" },
    Status: { type: "status", status: { options: [{ name: "Not started" }, { name: "In progress" }] } },
    Type: { type: "select" },
    Tags: { type: "multi_select" },
    Project: { type: "relation" },
    Due: { type: "date" },
    Points: { type: "number" },
    Owner: { type: "people" },
  };

  test("maps each supported type", () => {
    const props = buildProperties(schema, [
      "status=in progress",
      "Type=Spec",
      "Tags=a, b",
      `Project=https://app.notion.com/p/${HEX}`,
      "Due=2026-10-20..2026-10-27",
      "Points=3",
    ]);
    assert.deepEqual(props.Status, { status: { name: "In progress" } });
    assert.deepEqual(props.Type, { select: { name: "Spec" } });
    assert.deepEqual(props.Tags, { multi_select: [{ name: "a" }, { name: "b" }] });
    assert.deepEqual(props.Project, { relation: [{ id: ID }] });
    assert.deepEqual(props.Due, { date: { start: "2026-10-20", end: "2026-10-27" } });
    assert.deepEqual(props.Points, { number: 3 });
  });

  test("refuses unknown properties, unknown statuses and unsupported types", () => {
    assert.throws(() => buildProperties(schema, ["Colour=red"]), NotionUsageError);
    assert.throws(() => buildProperties(schema, ["Status=Shipped"]), /no status "Shipped"/);
    assert.throws(() => buildProperties(schema, ["Owner=me"]), /people property/);
    assert.throws(() => buildProperties(schema, ["Project=not-a-link"]), /Notion page links/);
    assert.throws(() => buildProperties(schema, ["Due=next week"]), /ISO date/);
  });
});

describe("parseNotionArgs", () => {
  test("create needs a parent, a title and a file", () => {
    assert.throws(() => parseNotionArgs(["create", "--title", "T", "--file", "a.md"]), /--parent/);
    assert.throws(() => parseNotionArgs(["create", "--parent", HEX, "--file", "a.md"]), /--title/);
    assert.throws(() => parseNotionArgs(["create", "--parent", HEX, "--title", "T"]), /--file/);
    assert.throws(() => parseNotionArgs(["create", "--parent", "nope", "--title", "T", "--file", "a.md"]), /not a Notion link/);
    const parsed = parseNotionArgs(["create", "--parent", HEX, "--title", "T", "--file", "a.md", "--prop", "Type=Spec", "-w", "acme"]);
    assert.equal(parsed.parentId, ID);
    assert.equal(parsed.workspace, "ACME");
    assert.deepEqual(parsed.props, ["Type=Spec"]);
  });

  test("append and replace take the page as an argument", () => {
    assert.equal(parseNotionArgs(["replace", HEX, "--file", "a.md"]).pageId, ID);
    assert.throws(() => parseNotionArgs(["append", "--file", "a.md"]), /needs the page/);
    assert.throws(() => parseNotionArgs(["append", HEX, "--file", "a.md", "--title", "T"]), /use replace/);
  });

  test("search joins its words; unknown commands and bad workspaces are refused", () => {
    assert.equal(parseNotionArgs(["search", "launch", "plan", "--workspace", "ACME"]).query, "launch plan");
    assert.throws(() => parseNotionArgs(["delete", HEX]), /unknown notion command/);
    assert.throws(() => parseNotionArgs(["search", "--workspace", "../etc"]), /--workspace/);
  });
});

test("the client retries a 429 and scrubs the token from errors", async () => {
  const token = "ntn_secret_token_value";
  const calls = [];
  const replies = [
    new Response("{}", { status: 429, headers: { "retry-after": "1" } }),
    new Response(JSON.stringify({ code: "unauthorized", message: `bad token ${token}` }), { status: 401 }),
  ];
  const client = new NotionClient({
    token,
    base: "http://notion.test/v1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return replies.shift();
    },
    sleep: async () => {},
  });
  await assert.rejects(client.search(""), (err) => {
    assert.match(err.message, /notion 401 unauthorized/);
    assert.ok(!err.message.includes(token));
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${token}`);
  assert.equal(calls[0].init.headers["Notion-Version"], "2022-06-28");
});

// ─── the CLI against a stand-in Notion API and a stand-in hush ───

const cliPath = join(dirname(fileURLToPath(import.meta.url)), "index.js");
const TOKEN = "ntn_never_print_this_token";
const DB_ID = ID;
const PAGE_ID = "11111111-2222-3333-4444-555555555555";
const scratch = mkdtempSync(join(tmpdir(), "grog-notion-"));
const bin = join(scratch, "bin");
const hushLog = join(scratch, "hush.log");
const doc = join(scratch, "plan.md");
const bigDoc = join(scratch, "big.md");

let server;
let api;
let requests;
let failWith;

const database = {
  object: "database",
  id: DB_ID,
  url: `https://app.notion.com/p/${HEX}`,
  title: [{ plain_text: "Docs" }],
  properties: {
    Name: { type: "title" },
    Status: { type: "status", status: { options: [{ name: "In progress" }] } },
    Type: { type: "select" },
  },
};
const page = {
  object: "page",
  id: PAGE_ID,
  url: "https://app.notion.com/p/11111111222233334444555555555555",
  parent: { type: "database_id", database_id: DB_ID },
  properties: { Name: { type: "title", title: [{ plain_text: "Old plan" }] } },
};

before(async () => {
  mkdirSync(bin);
  // Hands out the token only for ACME_NOTION_TOKEN, and logs every name it was asked for.
  writeFileSync(join(bin, "hush"), `#!/bin/sh\nwhile [ "$1" != "--name" ] && [ $# -gt 0 ]; do shift; done\necho "$2" >> "${hushLog}"\n[ "$2" = "ACME_NOTION_TOKEN" ] || exit 1\nprintf '%s\\n' "${TOKEN}"\n`);
  chmodSync(join(bin, "hush"), 0o755);
  writeFileSync(doc, "# Plan\n\nSome **text**.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n");
  writeFileSync(bigDoc, Array.from({ length: 230 }, (_, i) => `- item ${i}`).join("\n"));
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (failWith) return send(failWith.status, failWith.body);
      const path = req.url.replace(/^\/v1/, "").split("?")[0];
      if (req.method === "POST" && path === "/search") return send(200, { results: [database, page], has_more: false });
      if (req.method === "GET" && path === `/pages/${DB_ID}`) return send(400, { code: "validation_error", message: "is a database" });
      if (req.method === "GET" && path === `/databases/${DB_ID}`) return send(200, database);
      if (req.method === "GET" && path === `/pages/${PAGE_ID}`) return send(200, page);
      if (req.method === "POST" && path === "/pages") return send(200, { object: "page", id: PAGE_ID, url: page.url });
      if (req.method === "PATCH" && path === `/pages/${PAGE_ID}`) return send(200, page);
      if (req.method === "PATCH" && path === `/blocks/${PAGE_ID}/children`) return send(200, { results: [] });
      if (req.method === "GET" && path === `/blocks/${PAGE_ID}/children`) {
        const cursor = new URL(req.url, "http://x").searchParams.get("start_cursor");
        return cursor
          ? send(200, { results: [{ id: "old-3" }], has_more: false })
          : send(200, { results: [{ id: "old-1" }, { id: "old-2" }], has_more: true, next_cursor: "c2" });
      }
      if (req.method === "DELETE" && path.startsWith("/blocks/old-")) return send(200, {});
      send(404, { code: "object_not_found", message: `no route ${req.method} ${path}` });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  api = `http://127.0.0.1:${server.address().port}/v1`;
});

beforeEach(() => {
  requests = [];
  failWith = null;
  rmSync(hushLog, { force: true });
});

after(() => {
  server?.close();
  rmSync(scratch, { recursive: true, force: true });
});

function grog(args, cwd = scratch) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, "notion", ...args], {
      cwd,
      env: { PATH: `${bin}:${process.env.PATH}`, HOME: scratch, GROG_NOTION_API: api },
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (out += chunk));
    child.on("close", (code) => resolve({ code, out }));
  });
}

function hushNames() {
  try {
    return readFileSync(hushLog, "utf8").trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

test("create writes a database row with its properties and the body", async () => {
  const { code, out } = await grog(["create", "--parent", `https://app.notion.com/p/${HEX}`, "--title", "Launch plan", "--file", doc, "--prop", "Status=In progress", "--prop", "Type=Spec", "--workspace", "acme"]);
  assert.equal(code, 0, out);
  assert.ok(!out.includes(TOKEN));
  assert.match(out, /created "Launch plan" \(3 blocks\) in "Docs"/);
  assert.deepEqual(hushNames(), ["ACME_NOTION_TOKEN"]);
  const create = requests.find((r) => r.method === "POST" && r.url === "/v1/pages");
  assert.equal(create.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(create.headers["notion-version"], "2022-06-28");
  assert.deepEqual(create.body.parent, { database_id: DB_ID });
  assert.equal(create.body.properties.Name.title[0].text.content, "Launch plan");
  assert.deepEqual(create.body.properties.Status, { status: { name: "In progress" } });
  assert.deepEqual(create.body.children.map((b) => b.type), ["heading_1", "paragraph", "table"]);
});

test("a long document is created in request-sized parts", async () => {
  const { code, out } = await grog(["create", "--parent", HEX, "--title", "Big", "--file", bigDoc, "--workspace", "ACME"]);
  assert.equal(code, 0, out);
  const create = requests.find((r) => r.method === "POST" && r.url === "/v1/pages");
  const appends = requests.filter((r) => r.method === "PATCH" && r.url === `/v1/blocks/${PAGE_ID}/children`);
  assert.equal(create.body.children.length, 100);
  assert.deepEqual(appends.map((r) => r.body.children.length), [100, 30]);
});

test("replace settles the title first, then swaps every old block for the new body", async () => {
  const { code, out } = await grog(["replace", page.url, "--file", doc, "--title", "New plan", "--workspace", "ACME"]);
  assert.equal(code, 0, out);
  assert.match(out, /3 blocks removed, 3 written/);
  const order = requests.map((r) => `${r.method} ${r.url.replace(/\?.*/, "")}`);
  const patchPage = order.indexOf(`PATCH /v1/pages/${PAGE_ID}`);
  const firstDelete = order.findIndex((line) => line.startsWith("DELETE"));
  assert.ok(patchPage >= 0 && patchPage < firstDelete, order.join("\n"));
  assert.deepEqual(requests.filter((r) => r.method === "DELETE").map((r) => r.url), ["/v1/blocks/old-1", "/v1/blocks/old-2", "/v1/blocks/old-3"]);
  assert.equal(requests.find((r) => r.method === "PATCH" && r.url === `/v1/pages/${PAGE_ID}`).body.properties.Name.title[0].text.content, "New plan");
});

test("a status the database does not have is refused before anything is written", async () => {
  const { code, out } = await grog(["create", "--parent", HEX, "--title", "T", "--file", doc, "--prop", "Status=Shipped", "--workspace", "ACME"]);
  assert.equal(code, 1);
  assert.match(out, /no status "Shipped"/);
  assert.ok(requests.every((r) => r.method === "GET"), requests.map((r) => r.method).join(","));
});

test("usage errors and a missing workspace stop before hush and the network", async () => {
  for (const args of [
    ["create", "--parent", HEX, "--file", doc, "--workspace", "ACME"],
    ["create", "--parent", HEX, "--title", "T", "--file", join(scratch, "missing.md"), "--workspace", "ACME"],
    ["append", HEX, "--file", doc],
  ]) {
    const { code } = await grog(args);
    assert.equal(code, 1, args.join(" "));
  }
  assert.equal(requests.length, 0);
  assert.deepEqual(hushNames(), []);
});

test("the workspace can come from the project's .grog file", async () => {
  const project = join(scratch, "project");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, ".grog"), "workspace=LINEARONLY\nnotion=acme\n");
  const { code, out } = await grog(["search"], project);
  assert.equal(code, 0, out);
  assert.match(out, /database\s+Docs/);
  assert.deepEqual(hushNames(), ["ACME_NOTION_TOKEN"]);
});

test("another workspace's secret is never used, and API errors never echo the token", async () => {
  const other = await grog(["search", "--workspace", "OTHER"]);
  assert.equal(other.code, 1);
  assert.match(other.out, /store it in hush as OTHER_NOTION_TOKEN/);
  assert.equal(requests.length, 0);

  failWith = { status: 401, body: { code: "unauthorized", message: `API token ${TOKEN} is invalid` } };
  const { code, out } = await grog(["search", "--workspace", "ACME"]);
  assert.equal(code, 1);
  assert.match(out, /notion 401 unauthorized/);
  assert.ok(!out.includes(TOKEN));
});
