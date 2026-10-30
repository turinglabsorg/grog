import { execFile, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// The desktop an agent works on: the same image Cora gives its own agents, so a browser
// there is an ordinary browser on a real X display — the sessions stay in its volume and
// a site sees a person, not a script.
const IMAGE = process.env.GROG_DESK_IMAGE || "cora-box:latest";
// Agents often run with a PATH that lacks Docker Desktop's /usr/local/bin.
const DOCKER = process.env.GROG_DOCKER || ["/usr/local/bin/docker", "/opt/homebrew/bin/docker"].find((path) => existsSync(path)) || "docker";
const CDP_ACTIONS = ["text", "query", "html", "eval", "cookies", "storage", "network", "targets", "goto"];
const LEASE = "/home/agent/.grog-desk-lease";
const LEASE_MS = 10 * 60 * 1000;

export const DESKTOP_HELP = {
  desktop: [
    "grog desktop up [--name default] [--image IMAGE]      start it, or adopt the one already running",
    "grog desktop status [--name default] [--json]         container, tailnet, how it asks for a password",
    "grog desktop open <url> [--name default]              open the url in its Chromium",
    "grog desktop shot [--out FILE] [--name default]       a jpeg of the screen",
    "grog desktop read <action> [argument]                 text|query|html|eval|cookies|storage|network|targets|goto",
    "grog desktop type --secret HUSH_NAME [--name default] type a secret into the focused field, blind",
    "grog desktop type --text TEXT                         type plain text",
    "grog desktop paste --file FILE | --text TEXT          put text in its clipboard, then Ctrl+V there",
    "grog desktop key <combo> | click <x> <y>              send one key or one click",
    "grog desktop run -- <command...>                      run a command inside it",
    "grog desktop who [--name default]                     who used it last",
    "grog desktop down|rm [--volumes] [--name default]     stop it, or remove it",
  ].join("\n  "),
};

const container = (name) => `grog-desk${name === "default" ? "" : `-${name}`}`;
const homeVolume = (name) => `${container(name)}-home`;
const sysVolume = (name) => `${container(name)}-sys`;

function docker(args, { input, encoding = "utf8" } = {}) {
  return execFileSync(DOCKER, args, { input, encoding, maxBuffer: 64 * 1024 * 1024 });
}

function quiet(args) {
  try {
    return docker(args).trim();
  } catch {
    return "";
  }
}

function parse(args) {
  const options = { name: process.env.GROG_DESK_NAME || "default" };
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") { rest.push(...args.slice(index + 1)); break; }
    else if (argument.startsWith("--")) {
      const key = argument.slice(2);
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) options[key] = true;
      else { options[key] = value; index += 1; }
    } else rest.push(argument);
  }
  return { options, rest };
}

const state = (name) => quiet(["inspect", "-f", "{{.State.Running}}", container(name)]);

function inside(name, argv, { root = false, detach = false, input, encoding = "utf8" } = {}) {
  const who = root ? ["-u", "root"] : ["-u", "agent", "-w", "/home/agent", "-e", "HOME=/home/agent", "-e", "USER=agent"];
  const flags = detach ? ["-d"] : ["-i"];
  return docker(["exec", ...flags, ...who, "-e", "DISPLAY=:1", container(name), ...argv], { input, encoding });
}

/** Who touched it last: one desktop, several agents, and only one mouse. */
function lease(name, { take = false } = {}) {
  const owner = `${process.env.GROG_AGENT || process.env.USER || "agent"}@${process.env.HOSTNAME || "host"}`;
  const previous = quiet(["exec", "-u", "agent", container(name), "sh", "-c", `cat ${LEASE} 2>/dev/null`]);
  let held = null;
  try { held = previous ? JSON.parse(previous) : null; } catch {}
  if (take) inside(name, ["sh", "-c", `cat > ${LEASE}`], { input: JSON.stringify({ owner, at: Date.now() }) });
  if (!held || held.owner === owner) return null;
  return Date.now() - held.at < LEASE_MS ? held : null;
}

function tailscale(name) {
  const raw = quiet(["exec", "-u", "root", container(name), "tailscale", "--socket=/run/tailscale/tailscaled.sock", "status", "--json"]);
  if (!raw) return { state: "unknown" };
  try {
    const data = JSON.parse(raw);
    const self = data.Self || {};
    return {
      state: data.BackendState,
      name: String(self.DNSName || self.HostName || "").replace(/\.$/, ""),
      ip: (self.TailscaleIPs || [])[0] || "",
      authUrl: data.AuthURL || "",
    };
  } catch {
    return { state: "unknown" };
  }
}

/** How the VNC server asks for a password, read from the handshake rather than guessed. */
function vncAuth(name) {
  const probe = `
const net = require("net");
const socket = net.connect(5900, "127.0.0.1");
socket.setTimeout(4000);
socket.once("data", () => {
  socket.write("RFB 003.008\\n");
  socket.once("data", (reply) => {
    const types = [...reply.subarray(1, 1 + reply[0])];
    console.log(types.includes(2) ? "password" : types.includes(1) ? "none" : "unknown");
    socket.destroy();
  });
});
socket.on("error", () => console.log("closed"));
socket.on("timeout", () => { console.log("closed"); socket.destroy(); });
`;
  return (quiet(["exec", "-u", "agent", container(name), "node", "-e", probe]) || "unknown").trim();
}

function start(name, image) {
  docker(["volume", "create", homeVolume(name)]);
  docker(["volume", "create", sysVolume(name)]);
  docker(["run", "-d", "--name", container(name), "--shm-size", "1g", "--cap-add", "NET_ADMIN",
    "-e", `TZ=${process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}`,
    "-v", `${homeVolume(name)}:/home/agent`, "-v", `${sysVolume(name)}:/var/lib/cora`, image]);
}

async function handleUp(options) {
  const name = options.name;
  const running = state(name);
  if (running === "true") console.log(`already up: ${container(name)} (kept as it is)`);
  else if (running === "false") { docker(["start", container(name)]); console.log(`started again: ${container(name)}`); }
  else { start(name, options.image || IMAGE); console.log(`created: ${container(name)}`); }
  await new Promise((resolve) => setTimeout(resolve, running === "true" ? 0 : 8000));
  const net = tailscale(name);
  if (net.state === "NeedsLogin" || (!net.ip && net.state !== "Running")) {
    const up = quiet(["exec", "-u", "root", container(name), "tailscale", "--socket=/run/tailscale/tailscaled.sock",
      "up", "--ssh", `--hostname=${container(name)}`, "--accept-dns=false", "--timeout=20s"]);
    const url = /https:\/\/login\.tailscale\.com\/\S+/.exec(up)?.[0];
    if (url) console.log(`authorize it on your tailnet: ${url}`);
  }
  await handleStatus(options);
}

async function handleStatus(options) {
  const name = options.name;
  const running = state(name);
  const net = running === "true" ? tailscale(name) : { state: "off" };
  const auth = running === "true" ? vncAuth(name) : "off";
  const held = running === "true" ? lease(name) : null;
  const report = {
    container: container(name),
    running: running === "true",
    tailnet: net.state,
    host: net.name || "",
    ip: net.ip || "",
    screen: net.ip ? `vnc://${net.ip}` : "",
    browserScreen: net.ip ? `http://${net.ip}:6080/` : "",
    password: auth === "password" ? "required" : auth === "none" ? "not asked" : auth,
    inUseBy: held ? held.owner : "",
  };
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else for (const [key, value] of Object.entries(report)) if (value !== "") console.log(`${key}: ${value}`);
  if (net.authUrl) console.log(`authorize it on your tailnet: ${net.authUrl}`);
}

function requireUp(name) {
  if (state(name) !== "true") throw new Error(`the desktop ${container(name)} is not up: grog desktop up --name ${name}`);
}

function warnLease(name) {
  const held = lease(name, { take: true });
  if (held) console.error(`! ${held.owner} was using this desktop ${Math.round((Date.now() - held.at) / 60000)} minutes ago`);
}

export async function handleDesktop(args) {
  const [command = "status", ...rest] = args;
  const { options, rest: positional } = parse(rest);
  const name = options.name;

  switch (command) {
    case "up": return handleUp(options);
    case "status": return handleStatus(options);

    case "open": {
      requireUp(name);
      const url = positional[0];
      if (!/^https?:\/\//i.test(url || "")) throw new Error("open needs an http(s) url");
      warnLease(name);
      inside(name, ["sh", "-c", `nohup chromium ${JSON.stringify(url)} >/tmp/chromium.log 2>&1 &`], { detach: true });
      console.log(`opening ${url}`);
      return;
    }

    case "shot": {
      requireUp(name);
      const out = options.out || join(mkdtempSync(join(tmpdir(), "grog-desk-")), "screen.jpg");
      const image = inside(name, ["import", "-silent", "-window", "root", "-quality", "70", "jpg:-"], { encoding: "buffer" });
      writeFileSync(out, image);
      console.log(out);
      return;
    }

    case "read": {
      requireUp(name);
      const action = positional[0];
      if (!CDP_ACTIONS.includes(action)) throw new Error(`read takes one of: ${CDP_ACTIONS.join(", ")}`);
      const argument = positional.slice(1).join(" ");
      console.log(inside(name, ["cora-cdp", action, ...(argument ? [argument] : [])]).trim());
      return;
    }

    case "type": {
      requireUp(name);
      warnLease(name);
      if (options.secret) {
        // The value reaches xdotool through the environment of the child, never a command line.
        const hush = process.env.GROG_HUSH || [join(homedir(), ".local/bin/hush"), "/usr/local/bin/hush"].find((path) => existsSync(path)) || "hush";
        await new Promise((resolve, reject) => {
          const child = spawn(hush, ["run", "--name", String(options.secret), "--env", "GROG_DESK_SECRET", "--redact", "--",
            DOCKER, "exec", "-i", "-e", "GROG_DESK_SECRET", "-u", "agent", "-e", "DISPLAY=:1", container(name),
            "sh", "-c", 'xdotool type --delay 25 -- "$GROG_DESK_SECRET"'], { stdio: ["ignore", "inherit", "inherit"] });
          child.on("error", reject);
          child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`typing ${options.secret} failed`))));
        });
        console.log(`typed ${options.secret} (never shown)`);
        return;
      }
      const text = options.text === true ? "" : options.text || positional.join(" ");
      if (!text) throw new Error("type needs --secret NAME or --text TEXT");
      inside(name, ["xdotool", "type", "--delay", "25", "--", text]);
      console.log("typed");
      return;
    }

    case "paste": {
      requireUp(name);
      const text = options.file ? readFileSync(String(options.file), "utf8") : options.text === true ? "" : String(options.text || positional.join(" "));
      if (!text) throw new Error("paste needs --file FILE or --text TEXT");
      // X keeps two selections and apps read either one: fill both, as autocutsel expects.
      inside(name, ["sh", "-c", "xclip -selection clipboard -display :1 && echo"], { input: text });
      inside(name, ["sh", "-c", "xclip -selection primary -display :1 && echo"], { input: text });
      console.log(`${text.length} characters are in its clipboard: Ctrl+V to drop them in`);
      return;
    }

    case "key": {
      requireUp(name);
      warnLease(name);
      const keys = positional.filter(Boolean);
      if (!keys.length) throw new Error("key needs a combo, e.g. ctrl+l or Return");
      inside(name, ["xdotool", "key", "--", ...keys]);
      console.log(`sent ${keys.join(" ")}`);
      return;
    }

    case "click": {
      requireUp(name);
      warnLease(name);
      const [x, y] = positional.map((value) => String(Math.round(Number(value))));
      if (!x || !y || x === "NaN" || y === "NaN") throw new Error("click needs x and y");
      inside(name, ["xdotool", "mousemove", x, y, "click", "1"]);
      console.log(`clicked ${x},${y}`);
      return;
    }

    case "run": {
      requireUp(name);
      if (!positional.length) throw new Error("run needs a command after --");
      console.log(inside(name, ["bash", "-lc", positional.join(" ")]).trim());
      return;
    }

    case "who": {
      requireUp(name);
      const held = lease(name);
      console.log(held ? `${held.owner}, ${Math.round((Date.now() - held.at) / 60000)} minutes ago` : "nobody in the last ten minutes");
      return;
    }

    case "down": {
      docker(["stop", "-t", "5", container(name)]);
      console.log(`stopped: ${container(name)} (volumes kept)`);
      return;
    }

    case "rm": {
      quiet(["rm", "-f", container(name)]);
      if (options.volumes) {
        quiet(["volume", "rm", "-f", homeVolume(name), sysVolume(name)]);
        console.log(`removed: ${container(name)} and its sessions`);
      } else console.log(`removed: ${container(name)} (sessions kept in ${homeVolume(name)})`);
      return;
    }

    default:
      console.log(`usage:\n  ${DESKTOP_HELP.desktop}`);
      process.exitCode = 1;
  }
}
