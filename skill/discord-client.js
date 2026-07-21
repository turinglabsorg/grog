import { basename, join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import WebSocket from "ws";

export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_DOWNLOAD_DIR = "/tmp/grog-discord-files";

const DISCORD_MESSAGE_CHANNEL_TYPES = new Set([0, 5, 10, 11, 12]);
const DISCORD_GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);

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
    gatewayUrl = null,
  }) {
    this.token = token;
    this.apiBase = apiBase.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.downloadDir = downloadDir;
    this.allowedAttachmentHosts = new Set(allowedAttachmentHosts);
    this.maxAttachmentBytes = maxAttachmentBytes;
    this.gatewayUrl = gatewayUrl;
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
        const error = new Error(`Discord API error: ${detail}`);
        error.status = response.status;
        error.code = data?.code;
        throw error;
      }

      return data;
    }

    throw new Error("Discord API rate limit retry failed");
  }

  getCurrentUser() {
    return this.request("GET", "/users/@me");
  }

  getGatewayBot() {
    return this.request("GET", "/gateway/bot");
  }

  listGuilds({ limit = 200, before, after } = {}) {
    const params = new URLSearchParams({ limit: String(Math.min(200, Math.max(1, limit))) });
    if (before) params.set("before", before);
    if (after) params.set("after", after);
    return this.request("GET", `/users/@me/guilds?${params}`);
  }

  async listAllGuilds() {
    const guilds = [];
    let after = null;

    for (;;) {
      const page = await this.listGuilds({ limit: 200, after });
      guilds.push(...page);
      if (page.length < 200) return guilds;
      const nextAfter = page.at(-1)?.id;
      if (!nextAfter || nextAfter === after) return guilds;
      after = nextAfter;
    }
  }

  listGuildChannels(guildId) {
    return this.request("GET", `/guilds/${encodeURIComponent(guildId)}/channels`);
  }

  getGuild(guildId) {
    return this.request("GET", `/guilds/${encodeURIComponent(guildId)}`);
  }

  listActiveGuildThreads(guildId) {
    return this.request("GET", `/guilds/${encodeURIComponent(guildId)}/threads/active`);
  }

  async discoverMessageChannels() {
    const guilds = await this.listAllGuilds();
    const channels = [];

    for (const guild of guilds) {
      const [guildChannels, activeThreads] = await Promise.all([
        this.listGuildChannels(guild.id),
        this.listActiveGuildThreads(guild.id),
      ]);
      const messageChannels = [
        ...guildChannels.filter((channel) => DISCORD_MESSAGE_CHANNEL_TYPES.has(channel.type)),
        ...(activeThreads?.threads || []).filter((channel) => DISCORD_MESSAGE_CHANNEL_TYPES.has(channel.type)),
      ];
      for (const channel of messageChannels) {
        channels.push({
          ...channel,
          guildId: guild.id,
          guildName: guild.name || guild.id,
          isThread: channel.type === 10 || channel.type === 11 || channel.type === 12,
        });
      }
    }

    return { guilds, channels };
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

  async waitForMessage({ timeoutMs = 90000, session = null, channelIds = null, ignoreUserId = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    let currentSession = session;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) return { message: null, session: currentSession };

      try {
        return await this.waitForGatewayMessageOnce({
          timeoutMs: remainingMs,
          session: currentSession,
          channelIds,
          ignoreUserId,
        });
      } catch (error) {
        if (error.invalidSession) {
          currentSession = null;
          continue;
        }
        if (error.reconnect && error.session) {
          currentSession = error.session;
          continue;
        }
        throw error;
      }
    }

    throw new Error("Discord Gateway reconnect limit reached");
  }

  async waitForGatewayMessageOnce({ timeoutMs, session, channelIds, ignoreUserId }) {
    this.requireToken();
    let gatewayBase = session?.resumeGatewayUrl || this.gatewayUrl;
    if (!gatewayBase) {
      const gateway = await this.getGatewayBot();
      if (gateway?.session_start_limit?.remaining === 0) {
        throw new Error("Discord Gateway session start limit is exhausted");
      }
      gatewayBase = gateway.url;
    }
    const gatewayUrl = new URL(gatewayBase);
    gatewayUrl.searchParams.set("v", "10");
    gatewayUrl.searchParams.set("encoding", "json");

    const allowedChannels = channelIds ? new Set(channelIds.map(String)) : null;
    const gatewaySession = session ? { ...session } : {};

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(gatewayUrl);
      let settled = false;
      let heartbeatAcknowledged = true;
      let heartbeatTimer = null;
      let firstHeartbeatTimer = null;

      const cleanup = () => {
        clearInterval(heartbeatTimer);
        clearTimeout(firstHeartbeatTimer);
        clearTimeout(timeoutTimer);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
          socket.terminate();
        }
      };
      const finish = (result) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(result);
      };
      const fail = (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const send = (payload) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
      };
      const heartbeat = () => {
        if (!heartbeatAcknowledged) {
          const error = new Error("Discord Gateway heartbeat was not acknowledged");
          error.reconnect = true;
          error.session = gatewaySession;
          fail(error);
          return;
        }
        heartbeatAcknowledged = false;
        send({ op: 1, d: gatewaySession.sequence ?? null });
      };
      const timeoutTimer = setTimeout(
        () => finish({ message: null, session: gatewaySession }),
        timeoutMs,
      );

      socket.on("message", (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw.toString());
        } catch {
          return;
        }

        if (payload.s !== null && payload.s !== undefined) gatewaySession.sequence = payload.s;

        if (payload.op === 10) {
          const interval = payload.d.heartbeat_interval;
          firstHeartbeatTimer = setTimeout(() => {
            heartbeat();
            heartbeatTimer = setInterval(heartbeat, interval);
          }, Math.floor(Math.random() * interval));

          if (gatewaySession.sessionId && gatewaySession.sequence !== undefined) {
            send({
              op: 6,
              d: {
                token: this.token,
                session_id: gatewaySession.sessionId,
                seq: gatewaySession.sequence,
              },
            });
          } else {
            send({
              op: 2,
              d: {
                token: this.token,
                intents: DISCORD_GATEWAY_INTENTS,
                properties: {
                  os: process.platform,
                  browser: "grog",
                  device: "grog",
                },
              },
            });
          }
          return;
        }

        if (payload.op === 11) {
          heartbeatAcknowledged = true;
          return;
        }
        if (payload.op === 1) {
          heartbeatAcknowledged = true;
          heartbeat();
          return;
        }
        if (payload.op === 7) {
          const error = new Error("Discord Gateway requested reconnect");
          error.reconnect = true;
          error.session = gatewaySession;
          fail(error);
          return;
        }
        if (payload.op === 9) {
          const error = new Error("Discord Gateway session is invalid");
          error.invalidSession = true;
          fail(error);
          return;
        }
        if (payload.op !== 0) return;

        if (payload.t === "READY") {
          gatewaySession.sessionId = payload.d.session_id;
          gatewaySession.resumeGatewayUrl = payload.d.resume_gateway_url;
          gatewaySession.userId = payload.d.user?.id;
          return;
        }
        if (payload.t !== "MESSAGE_CREATE") return;

        const message = payload.d;
        if (ignoreUserId && message.author?.id === ignoreUserId) return;
        if (gatewaySession.userId && message.author?.id === gatewaySession.userId) return;
        if (allowedChannels && !allowedChannels.has(String(message.channel_id))) return;
        finish({ message, session: gatewaySession });
      });

      socket.on("close", (code, reason) => {
        if (settled) return;
        const error = new Error(`Discord Gateway closed (${code}${reason?.length ? `: ${reason}` : ""})`);
        if (code === 4007 || code === 4009) {
          error.invalidSession = true;
        } else if (code === 4004) {
          error.message = "Discord Gateway authentication failed";
        } else if (code === 4010 || code === 4011) {
          error.message = "Discord Gateway requires a valid sharding configuration";
        } else if (code === 4012) {
          error.message = "Discord Gateway rejected the API version";
        } else if (code === 4013 || code === 4014) {
          error.message = "Discord Gateway rejected the configured intents; enable Message Content Intent";
        } else {
          error.reconnect = true;
          error.session = gatewaySession;
        }
        fail(error);
      });
      socket.on("error", (cause) => {
        const error = new Error(`Discord Gateway connection failed: ${cause.message}`);
        error.cause = cause;
        fail(error);
      });
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
