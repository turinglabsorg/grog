import { basename, join } from "path";
import { mkdirSync, writeFileSync } from "fs";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_DOWNLOAD_DIR = "/tmp/grog-discord-files";

const DEFAULT_ATTACHMENT_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

function safeFileName(value) {
  const name = basename(String(value || "discord-attachment")).replace(/[^a-zA-Z0-9._-]/g, "_");
  return name || "discord-attachment";
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isDiscordTextAttachment(attachment) {
  const name = String(attachment?.filename || "").toLowerCase();
  const mime = String(attachment?.content_type || "").toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (["application/json", "application/xml", "application/yaml", "application/x-yaml"].includes(mime)) return true;
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
    ".xml",
  ].some((suffix) => name.endsWith(suffix));
}

export class DiscordClient {
  constructor({
    token,
    apiBase = DISCORD_API_BASE,
    fetchImpl = fetch,
    downloadDir = DISCORD_DOWNLOAD_DIR,
    allowedAttachmentHosts = DEFAULT_ATTACHMENT_HOSTS,
    maxAttachmentBytes = 100 * 1024 * 1024,
  }) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.downloadDir = downloadDir;
    this.allowedAttachmentHosts = new Set(allowedAttachmentHosts);
    this.maxAttachmentBytes = maxAttachmentBytes;
  }

  requireToken() {
    if (!this.token) {
      throw new Error("Discord bot token is not configured");
    }
  }

  async request(method, path, body) {
    this.requireToken();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const headers = {
        Authorization: `Bot ${this.token}`,
        "User-Agent": "DiscordBot (https://github.com/turinglabsorg/grog, 1.0)",
      };
      const options = { method, headers };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        options.body = JSON.stringify(body);
      }

      const response = await this.fetchImpl(`${this.apiBase}${path}`, options);
      const data = response.status === 204 ? null : await response.json().catch(() => null);

      if (response.status === 429 && attempt < 2) {
        const retryAfterMs = Math.max(250, Number(data?.retry_after || 1) * 1000);
        await sleep(retryAfterMs);
        continue;
      }

      if (!response.ok) {
        const detail = data?.message || `${response.status} ${response.statusText}`;
        throw new Error(`Discord API error: ${detail}`);
      }

      return data;
    }

    throw new Error("Discord API rate limit retry failed");
  }

  getCurrentUser() {
    return this.request("GET", "/users/@me");
  }

  getChannel(channelId) {
    return this.request("GET", `/channels/${encodeURIComponent(channelId)}`);
  }

  listMessages(channelId, { limit = 50, before, after, around } = {}) {
    const params = new URLSearchParams({ limit: String(Math.min(100, Math.max(1, limit))) });
    if (before) params.set("before", before);
    if (after) params.set("after", after);
    if (around) params.set("around", around);
    return this.request("GET", `/channels/${encodeURIComponent(channelId)}/messages?${params}`);
  }

  sendMessage(channelId, content) {
    return this.request("POST", `/channels/${encodeURIComponent(channelId)}/messages`, {
      content,
      allowed_mentions: { parse: [] },
    });
  }

  async downloadAttachment(attachment, messageId) {
    const url = new URL(attachment.url);
    if (!this.allowedAttachmentHosts.has(url.hostname)) {
      throw new Error(`Discord attachment host is not allowed: ${url.hostname}`);
    }
    if (Number(attachment.size || 0) > this.maxAttachmentBytes) {
      throw new Error(`Discord attachment exceeds ${this.maxAttachmentBytes} bytes`);
    }

    const response = await this.fetchImpl(url);
    const finalUrl = new URL(response.url || url);
    if (!this.allowedAttachmentHosts.has(finalUrl.hostname)) {
      throw new Error(`Discord attachment redirect host is not allowed: ${finalUrl.hostname}`);
    }
    if (!response.ok) {
      throw new Error(`Discord attachment download failed: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > this.maxAttachmentBytes) {
      throw new Error(`Discord attachment exceeds ${this.maxAttachmentBytes} bytes`);
    }

    mkdirSync(this.downloadDir, { recursive: true });
    const attachmentId = String(attachment.id || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "_");
    const localPath = join(this.downloadDir, `${messageId}-${attachmentId}-${safeFileName(attachment.filename)}`);
    writeFileSync(localPath, buffer, { mode: 0o600 });
    return localPath;
  }
}
