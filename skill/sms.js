import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const API = "https://zernio.com/api/v1";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const identifier = value => value?.id || value?._id;
const print = value => console.log(JSON.stringify(value));

export const SMS_HELP = {
  "sms-numbers": "grog sms-numbers [--number NUMBER|contact] [--json]",
  "sms-enable": "grog sms-enable --number NUMBER|contact [--json]",
  "sms-talk": "grog sms-talk --number NUMBER|contact [--json]",
  "sms-read": "grog sms-read --number NUMBER|contact [--sender SENDER] [--contains TEXT] [--since ISO] [--limit 20] [--json]",
  "sms-recv": "grog sms-recv --number NUMBER|contact [--sender SENDER] [--contains TEXT] [--since ISO] [--timeout 60] [--json]\n         grog sms-recv --number NUMBER --since ISO --contains PROVIDER --otp-env LOGIN_OTP -- COMMAND [ARG...]",
  "sms-send": "grog sms-send --number NUMBER|contact --to NUMBER|contact [--idempotency-key KEY] <message-or-file>",
};

export function smsPhone(value) {
  const input = String(value || "").trim();
  if (!/^\+?[1-9][\d ()-]{6,24}$/.test(input)) throw new Error("SMS numbers must use an international country code");
  const digits = input.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) throw new Error("Invalid international SMS number");
  return `+${digits}`;
}

function parse(command, args, defaults, resolveContact, readMessage) {
  if (!Object.hasOwn(SMS_HELP, `sms-${command}`)) throw new Error("Unknown SMS command");
  const allowed = new Set(["number"]);
  if (["read", "recv"].includes(command)) for (const flag of ["sender", "contains", "since"]) allowed.add(flag);
  if (command === "read") allowed.add("limit");
  if (command === "recv") for (const flag of ["timeout", "otp-env"]) allowed.add(flag);
  if (command === "send") for (const flag of ["to", "idempotency-key"]) allowed.add(flag);
  const options = {number: defaults.smsNumber, limit: 20, timeout: 60, command: []};
  const positional = [];
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--") {options.command = args.slice(index + 1); break;}
    if (arg === "--json") continue;
    if (arg.startsWith("--")) {
      const [flag, ...tail] = arg.slice(2).split("=");
      if (!allowed.has(flag) || seen.has(flag)) throw new Error(`Invalid or repeated SMS option --${flag}`);
      seen.add(flag);
      const value = tail.length ? tail.join("=") : args[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${flag}`);
      options[flag] = value;
    } else positional.push(arg);
  }
  if (command !== "send" && positional.length) throw new Error("Unexpected SMS arguments");
  if (options.command.length && !options["otp-env"]) throw new Error("A child command requires --otp-env");
  const resolve = value => resolveContact?.(value) || value;
  if (options.number) options.number = smsPhone(resolve(options.number));
  if (command !== "numbers" && !options.number) throw new Error("Select the owned SMS number with --number (or zernio.smsNumber)");
  for (const [name, minimum, maximum] of [["limit", 1, 100], ["timeout", 0, 300]]) {
    if (!/^\d+$/.test(String(options[name])) || Number(options[name]) < minimum || Number(options[name]) > maximum) throw new Error(`--${name} must be between ${minimum} and ${maximum}`);
    options[name] = Number(options[name]);
  }
  if (options.since) {
    if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(options.since) || !Number.isFinite(Date.parse(options.since))) throw new Error("--since requires an ISO timestamp with timezone");
    options.since = Date.parse(options.since);
  }
  if (options["otp-env"]) {
    const envName = options["otp-env"];
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(envName) || /^(PATH|HOME|USER|LOGNAME|LANG|LC_ALL|TMPDIR|TEMP|TMP|NODE_OPTIONS|ZERNIO_API_KEY|BW_SESSION)$/.test(envName)) throw new Error("Use a dedicated environment name for the SMS code");
    if (!options.command.length || !options.since || !(options.sender || options.contains)) throw new Error("--otp-env requires --since, --sender or --contains, and -- COMMAND");
    if (Date.now() - options.since > 300000 || options.since > Date.now() + 5000) throw new Error("SMS code capture requires a fresh --since timestamp (last five minutes)");
  }
  if (command === "send") {
    if (!options.to || !positional.length) throw new Error("SMS send requires --to and a message or UTF-8 file");
    options.to = smsPhone(resolve(options.to));
    options.message = readMessage(positional);
    if (!options.message.trim() || options.message.length > 1530) throw new Error("SMS text must contain 1–1530 characters (carrier Unicode limits also apply)");
    options.key = options["idempotency-key"] || randomUUID();
    if (options.key.length > 255 || /[\x00-\x1f\x7f]/.test(options.key)) throw new Error("Invalid SMS idempotency key");
  }
  return options;
}

export class SmsClient {
  constructor(token, base = process.env.GROG_ZERNIO_API || API) {
    const url = new URL(base);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((base !== API && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) throw new Error("GROG_ZERNIO_API only permits a loopback test server");
    this.base = base.replace(/\/+$/, "");
    this.token = token;
  }

  async request(method, path, body, headers = {}) {
    let response;
    try {
      response = await fetch(`${this.base}${path}`, {
        method, redirect: "error", signal: AbortSignal.timeout(10000),
        headers: {Authorization: `Bearer ${this.token}`, ...(body ? {"Content-Type": "application/json"} : {}), ...headers},
        ...(body ? {body: JSON.stringify(body)} : {}),
      });
    } catch {throw new Error("Zernio SMS request failed or timed out; delivery may be unknown for a send");}
    if (!response.ok) throw new Error(`Zernio SMS request refused (HTTP ${response.status})`);
    try {return await response.json();} catch {throw new Error("Zernio returned an invalid SMS response");}
  }

  async numbers() {
    const data = await this.request("GET", "/phone-numbers");
    if (!Array.isArray(data.numbers)) throw new Error("Zernio did not return an owned-number list");
    return data.numbers.map(number => ({
      id: identifier(number), phoneNumber: number.phoneNumber, country: number.country,
      status: number.status, smsCapable: number.smsCapable, smsRequested: number.smsRequested,
      domesticOnly: number.domesticOnly, smsSendApproved: number.smsSendApproved,
    }));
  }

  async owned(phone) {
    const matches = (await this.numbers()).filter(number => {
      try {return smsPhone(number.phoneNumber) === phone;} catch {return false;}
    });
    if (matches.length !== 1 || !matches[0].id) throw new Error("SMS number is not uniquely owned by this Zernio account");
    if (matches[0].status !== "active") throw new Error("Selected SMS number is not active");
    if (matches[0].smsCapable === false) throw new Error("Selected number cannot receive SMS");
    return matches[0];
  }

  async account(number) {
    const data = await this.request("GET", "/accounts?platform=sms");
    if (!Array.isArray(data.accounts)) throw new Error("Zernio did not return SMS accounts");
    const accounts = data.accounts.filter(account => {
      if (account.platform !== "sms" || account.isActive === false) return false;
      try {return smsPhone(account.username) === smsPhone(number.phoneNumber);} catch {return false;}
    });
    if (accounts.length !== 1 || !identifier(accounts[0])) throw new Error("No unique active SMS account for this number; check grog sms-numbers or enable it with grog sms-enable");
    return identifier(accounts[0]);
  }

  async messages(accountId, options) {
    const messages = [];
    let cursor;
    const visited = new Set();
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({accountId, platform: "sms", sortOrder: "desc", limit: "100"});
      if (cursor) query.set("cursor", cursor);
      const data = await this.request("GET", `/inbox/conversations?${query}`);
      if (data.meta?.accountsFailed || data.meta?.failedAccounts?.length || data.meta?.accountsSkipped?.length) throw new Error("Zernio could not read the selected SMS account");
      if (!Array.isArray(data.data)) throw new Error("Invalid SMS conversation response");
      for (const conversation of data.data) {
        if (conversation.platform !== "sms" || conversation.accountId !== accountId) continue;
        if (options.sender && String(conversation.participantId).toLowerCase() !== options.sender.toLowerCase()) continue;
        if (options.since && Number.isFinite(Date.parse(conversation.updatedTime)) && Date.parse(conversation.updatedTime) < options.since) continue;
        let messageCursor;
        const seenPages = new Set();
        for (let index = 0; index < 20; index++) {
          const params = new URLSearchParams({accountId, sortOrder: "desc", limit: "100"});
          if (messageCursor) params.set("cursor", messageCursor);
          const batch = await this.request("GET", `/inbox/conversations/${encodeURIComponent(conversation.id)}/messages?${params}`);
          if (!Array.isArray(batch.messages)) throw new Error("Invalid SMS message response");
          let beforeSince = false;
          for (const message of batch.messages) {
            if (message.accountId !== accountId || message.platform !== "sms" || message.conversationId !== conversation.id || !message.id || message.isDeleted) continue;
            const stamp = Date.parse(message.createdAt);
            if (!Number.isFinite(stamp)) continue;
            if (options.since && stamp < options.since) {beforeSince = true; continue;}
            if (options.contains && !String(message.message || "").toLowerCase().includes(options.contains.toLowerCase())) continue;
            messages.push({id: message.id, conversationId: conversation.id, accountId, direction: message.direction,
              sender: message.senderId || conversation.participantId, text: String(message.message || ""),
              createdAt: message.createdAt, deliveryStatus: message.deliveryStatus});
          }
          if (!batch.pagination?.hasMore || beforeSince) break;
          const next = batch.pagination.nextCursor;
          if (!next || seenPages.has(next) || index === 19) throw new Error("SMS message pagination is incomplete");
          seenPages.add(next); messageCursor = next;
        }
      }
      if (!data.pagination?.hasMore) break;
      const next = data.pagination.nextCursor;
      if (!next || visited.has(next) || page === 19) throw new Error("SMS conversation pagination is incomplete");
      visited.add(next); cursor = next;
    }
    return [...new Map(messages.map(message => [message.id, message])).values()]
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
  }
}

function stateFile(scope) {
  const dir = join(homedir(), ".grog", "sms-state");
  mkdirSync(dir, {recursive: true, mode: 0o700});
  return join(dir, `${createHash("sha256").update(scope).digest("hex")}.json`);
}
function loadState(scope) {
  try {return JSON.parse(readFileSync(stateFile(scope), "utf8"));} catch (error) {
    if (error.code === "ENOENT") return {};
    throw new Error("Cannot read SMS receive state");
  }
}
function saveState(scope, state) {
  const temporary = `${stateFile(scope)}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, {mode: 0o600});
  renameSync(temporary, stateFile(scope));
}
function receiveLock(scope) {
  const file = `${stateFile(scope)}.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        if (readFileSync(file, "utf8") === String(process.pid)) unlinkSync(file);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const pid = Number(readFileSync(file, "utf8"));
      try {
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid SMS receive lock");
        process.kill(pid, 0);
      } catch (probe) {
        if (probe.code === "ESRCH") {unlinkSync(file); continue;}
        throw probe;
      }
      throw new Error("Another SMS receiver is already active for this number");
    }
  }
  throw new Error("Could not acquire SMS receive lock");
}

async function childWithCode(command, name, code, apiToken) {
  const env = {};
  for (const key of ["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"]) if (process.env[key]) env[key] = process.env[key];
  env[name] = code;
  return await new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {env, shell: false, stdio: ["ignore", "pipe", "pipe"]});
    const output = {out: [], err: []};
    let bytes = 0, overflow = false;
    const timer = setTimeout(() => {overflow = true; child.kill("SIGKILL");}, 120000);
    for (const [stream, key] of [[child.stdout, "out"], [child.stderr, "err"]]) stream.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) {overflow = true; child.kill("SIGKILL");}
      else output[key].push(chunk);
    });
    child.on("error", () => {clearTimeout(timer); reject(new Error("Could not start SMS code consumer"));});
    child.on("close", status => {
      clearTimeout(timer);
      if (overflow) {reject(new Error("SMS code consumer exceeded its output or execution limit")); return;}
      const redact = chunks => Buffer.concat(chunks).toString("utf8").split(code).join("[redacted SMS code]").split(apiToken).join("[redacted credential]");
      process.stdout.write(redact(output.out)); process.stderr.write(redact(output.err));
      resolve(status ?? 1);
    });
  });
}

export async function handleSms(command, args, context) {
  const options = parse(command, args, context.config.zernio || {}, context.resolveContact, context.readMessage);
  new SmsClient("");
  const token = process.env.ZERNIO_API_KEY;
  if (!token) {
    const name = context.config.zernio?.smsTokenName || "ZERNIO_API_KEY";
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error("Invalid zernio.smsTokenName hush name");
    return await new Promise((resolve, reject) => {
      const child = spawn("hush", ["run", "--name", name, "--env", "ZERNIO_API_KEY", "--redact", "--", process.execPath, context.cliPath, ...process.argv.slice(2)], {stdio: "inherit"});
      child.on("error", () => reject(new Error(`Store the SMS credential in hush as ${name}`)));
      child.on("close", status => resolve(status ?? 1));
    });
  }
  const client = new SmsClient(token);
  if (command === "numbers") {
    let numbers = await client.numbers();
    if (options.number) numbers = numbers.filter(number => smsPhone(number.phoneNumber) === options.number);
    print({numbers}); return 0;
  }
  const number = await client.owned(options.number);
  if (command === "enable") {
    const data = await client.request("POST", `/phone-numbers/${encodeURIComponent(number.id)}/sms`);
    print({number: options.number, enabled: data.enabled, smsCapable: data.smsCapable, notReady: data.notReady,
      domesticOnly: data.domesticOnly, needsRegistration: data.needsRegistration, registrationStatus: data.registrationStatus});
    return data.enabled && data.smsCapable !== false && !data.notReady ? 0 : 1;
  }
  const accountId = await client.account(number);
  if (command === "send") {
    const result = await client.request("POST", "/sms/messages", {from: options.number, to: options.to, text: options.message}, {"Idempotency-Key": options.key});
    print({id: result.id, conversationId: result.conversationId, status: result.status, idempotencyKey: options.key}); return 0;
  }
  const scope = `${accountId}:${options.number}`;
  if (command === "read") {
    print({number: options.number, messages: (await client.messages(accountId, options)).slice(-options.limit)}); return 0;
  }
  const release = receiveLock(scope);
  try {
  const state = loadState(scope);
  const prior = state.since ? state : {since: new Date().toISOString(), seen: []};
  if (command === "talk") {
    const next = {...prior, since: new Date().toISOString()}; saveState(scope, next);
    print({ready: true, number: options.number, accountId, since: next.since}); return 0;
  }
  options.since ??= Date.parse(prior.since);
  const seen = new Set(prior.seen || []);
  const deadline = Date.now() + options.timeout * 1000;
  do {
    const messages = (await client.messages(accountId, options)).filter(message => message.direction === "incoming" && !seen.has(message.id));
    for (const message of messages) {
      let code;
      if (options["otp-env"]) {
        if (Date.now() - Date.parse(message.createdAt) > 300000 || Date.parse(message.createdAt) > Date.now() + 5000) continue;
        const codes = [...new Set(message.text.match(/\b\d{6}\b/g) || [])];
        if (codes.length !== 1) continue;
        [code] = codes;
      }
      const currentEntry = loadState(scope);
      if ((currentEntry.seen || []).includes(message.id)) continue;
      const next = {since: currentEntry.since || prior.since, seen: [...new Set([...(currentEntry.seen || []), message.id])].slice(-2000)};
      saveState(scope, next);
      if (code) {
        const status = await childWithCode(options.command, options["otp-env"], code, token);
        print({event: "sms-code-consumed", messageId: message.id, childExitCode: status}); return status;
      }
      print({number: options.number, message}); return 0;
    }
    if (Date.now() >= deadline) break;
    await sleep(Math.min(3000, deadline - Date.now()));
  } while (Date.now() <= deadline);
  print({number: options.number, message: null, timedOut: true}); return 2;
  } finally {release();}
}
