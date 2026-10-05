#!/usr/bin/env python3
"""grog relay: a public HTTPS link to a port on a machine that cannot be reached.

`grog up <port>` connects out to this relay (the control connection) and gets a
link, https://<code>.<domain>. Every visitor's connection to that link is paired
with a fresh connection the client opens back to the relay for it (a stream),
and the bytes are piped both ways, so HTTP, keep-alive and WebSockets all pass.

- Only a client holding the tunnel token can open a link; the relay keeps its
  SHA-256, never the token.
- The code in a link is random: whoever has the link can open it, nobody can
  guess it. A link lives while its client is connected, plus a short grace
  period for reconnects, then it is gone.
- A client can also ask for a fixed host: a name under the domain, or a site
  domain of ours (one with a certificate in the domains directory, e.g.
  alienwatch.buzz and its subdomains). Fixed hosts are guessable, so they are
  for things meant to be seen. A new claim with the token takes the host over,
  which is how a restarted `grog serve` gets its sites back.
- TLS uses a wildcard certificate for the domain, and each site domain its own,
  picked by SNI; all are reloaded on SIGHUP.
- Open links survive a restart of the relay: their hosts and secrets are kept
  in a state file (readable by the relay's user only), so clients reconnect to
  the same address within the grace period.
- Nothing about requests is logged beyond counts.
- A request for a site domain (a domain with a certificate here) is stamped
  with `x-grog-country`, the country where that visitor's network is
  registered. The address is looked up on the relay and is not logged or
  sent on. `grog up` links are not stamped: their bytes pass untouched.

Standard library only (Python 3.10+), plus country.py beside this file.
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import signal
import ssl
import time

import country

DOMAIN = os.environ.get("GROG_RELAY_DOMAIN", "grooooog.space").lower()
CONTROL_HOST = "up." + DOMAIN
CERT = os.environ.get("GROG_RELAY_CERT", "/etc/grog-relay/fullchain.pem")
KEY = os.environ.get("GROG_RELAY_KEY", "/etc/grog-relay/privkey.pem")
DOMAINS_DIR = os.environ.get("GROG_RELAY_DOMAINS_DIR", "/etc/grog-relay/domains")
STATE = os.environ.get("GROG_RELAY_STATE", "/var/lib/grog-relay/state.json")
TOKEN_SHA256 = os.environ.get("GROG_RELAY_TOKEN_SHA256", "/etc/grog-relay/token.sha256")
HTTPS_PORT = int(os.environ.get("GROG_RELAY_HTTPS_PORT", "443"))
HTTP_PORT = int(os.environ.get("GROG_RELAY_HTTP_PORT", "80"))

MAX_TUNNELS = 64
MAX_WAITING = 32
MAX_HEAD = 64 * 1024
FIRST_LINE_WAIT = 15
STREAM_WAIT = 15
GRACE = 90
PING_EVERY = 20
CODE_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
RESERVED = {"up", "www"}
HOSTNAME = re.compile(r"^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$")

log = logging.getLogger("grog-relay")


class Tunnel:
    def __init__(self, code, secret, label):
        self.code = code
        self.secret = secret
        self.label = label
        self.control = None
        self.waiting = {}
        self.next_id = 0
        self.gone_since = None
        self.served = 0

    async def stream(self):
        """Ask the client for a stream and wait until it connects back."""
        if self.control is None or len(self.waiting) >= MAX_WAITING:
            return None
        self.next_id += 1
        stream_id = self.next_id
        future = asyncio.get_running_loop().create_future()
        self.waiting[stream_id] = future
        try:
            self.control.write(b"N %d\n" % stream_id)
            await self.control.drain()
            return await asyncio.wait_for(future, STREAM_WAIT)
        except (asyncio.TimeoutError, ConnectionError, OSError):
            return None
        finally:
            self.waiting.pop(stream_id, None)


tunnels = {}  # host -> Tunnel
dirty = False  # tunnels changed since the state file was written


def mark_dirty():
    global dirty
    dirty = True


def save_state():
    """Write the open links (host, secret, label) for the next start; owner-only."""
    global dirty
    data = {host: {"secret": t.secret, "label": t.label} for host, t in tunnels.items()}
    try:
        temporary = STATE + ".tmp"
        with open(os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as handle:
            json.dump(data, handle)
        os.replace(temporary, STATE)
        dirty = False
    except OSError as error:
        log.warning("state not saved: %s", error)


def load_state():
    """Bring back the links of the last run, waiting for their clients."""
    try:
        with open(STATE, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return
    now = time.monotonic()
    for host, entry in (data or {}).items():
        if not isinstance(entry, dict) or not isinstance(entry.get("secret"), str):
            continue
        if not (host.endswith("." + DOMAIN) or site_of(host)):
            continue
        tunnel = Tunnel(host, entry["secret"], str(entry.get("label") or "")[:80])
        tunnel.gone_since = now
        tunnels[host] = tunnel
    if tunnels:
        log.info("waiting for %d link(s) of the last run to reconnect", len(tunnels))
site_contexts = {}  # site domain -> SSLContext


def site_of(host):
    """The site domain whose certificate covers host (apex or one label below), if any."""
    for domain in site_contexts:
        if host == domain or (host.endswith("." + domain) and "." not in host[: -len(domain) - 1]):
            return domain
    return None


def claimable(host):
    """Whether a client may ask for this fixed host."""
    if not HOSTNAME.match(host):
        return False
    if host.endswith("." + DOMAIN):
        label = host[: -len(DOMAIN) - 1]
        return "." not in label and label not in RESERVED
    return site_of(host) is not None


def token_ok(token):
    try:
        with open(TOKEN_SHA256, encoding="ascii") as handle:
            expected = handle.read().strip()
    except OSError:
        return False
    given = hashlib.sha256(str(token or "").encode()).hexdigest()
    return bool(expected) and hmac.compare_digest(given, expected)


def new_host():
    while True:
        host = "".join(secrets.choice(CODE_ALPHABET) for _ in range(10)) + "." + DOMAIN
        if host not in tunnels:
            return host


def http_response(status, body, extra=""):
    data = body.encode()
    return (
        f"HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\n"
        f"Content-Length: {len(data)}\r\nConnection: close\r\n{extra}\r\n"
    ).encode() + data


def page(title, text):
    return (
        "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
        f"<title>{title}</title><body style='font:16px system-ui;margin:3em auto;max-width:36em;"
        f"padding:0 1em;color:#333'><h1 style='font-size:1.3em'>{title}</h1><p>{text}</p>"
    )


def host_of(head):
    for line in head.split(b"\r\n")[1:]:
        name, _, value = line.partition(b":")
        if name.strip().lower() == b"host":
            return value.strip().decode("latin-1").lower().rsplit(":", 1)[0] if b"]" not in value else ""
    return ""


def stamp_country(head, ip):
    """Drop a client-supplied country and, when we know one, write ours.

    Bytes after the header block stay as they arrived. A head we could not
    finish is left alone.
    """
    marker = b"\r\n\r\n"
    at = head.find(marker)
    if at < 0:
        return head
    lines = head[:at].split(b"\r\n")
    kept = [lines[0]]
    spoofed = False
    for line in lines[1:]:
        if line.split(b":", 1)[0].strip().lower() == b"x-grog-country":
            spoofed = True
            continue
        kept.append(line)
    cc = country.country_of(ip)
    if not spoofed and not cc:
        return head
    if len(cc) == 2 and cc.isalpha() and cc.isupper():
        kept.append(b"x-grog-country: " + cc.encode("ascii"))
    return b"\r\n".join(kept) + head[at:]


def prepare_head(head, host, ip):
    """Stamp a site domain. Any other host, including a grog up link, is unchanged."""
    if not site_of(host):
        return head
    return stamp_country(head, ip)


async def close(writer):
    try:
        writer.close()
        await writer.wait_closed()
    except Exception:
        pass


async def pipe(reader, writer):
    try:
        while True:
            data = await reader.read(65536)
            if not data:
                break
            writer.write(data)
            await writer.drain()
    except Exception:
        pass


async def splice(a, b):
    """Pipe two connections both ways; when either side ends, close both."""
    (ra, wa), (rb, wb) = a, b
    tasks = [asyncio.ensure_future(pipe(ra, wb)), asyncio.ensure_future(pipe(rb, wa))]
    await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in tasks:
        task.cancel()
    await asyncio.gather(close(wa), close(wb), return_exceptions=True)


async def serve_control(tunnel, reader, writer):
    tunnel.control = writer
    tunnel.gone_since = None

    async def ping():
        while True:
            await asyncio.sleep(PING_EVERY)
            writer.write(b"P\n")
            await writer.drain()

    pinger = asyncio.ensure_future(ping())
    try:
        while True:
            line = await asyncio.wait_for(reader.readline(), PING_EVERY * 3)
            if not line:
                break
    except Exception:
        pass
    finally:
        pinger.cancel()
        if tunnel.control is writer:
            tunnel.control = None
            tunnel.gone_since = time.monotonic()
            log.info("tunnel %s disconnected", tunnel.code)
        await close(writer)


async def serve_client(first, reader, writer):
    try:
        request = json.loads(first)
    except ValueError:
        return await close(writer)
    op = request.get("op")
    if op == "open":
        if not token_ok(request.get("token")):
            writer.write(json.dumps({"error": "invalid tunnel token"}).encode() + b"\n")
            return await close(writer)
        label = str(request.get("label") or "")[:80]
        wanted = str(request.get("domain") or "").strip().lower().rstrip(".")
        tunnel = tunnels.get(str(request.get("code") or ""))
        if wanted:
            if not claimable(wanted):
                writer.write(json.dumps({"error": f"this relay does not serve {wanted[:100]}"}).encode() + b"\n")
                return await close(writer)
            tunnel = tunnels.get(wanted)
            if tunnel is None:
                if len(tunnels) >= MAX_TUNNELS:
                    writer.write(json.dumps({"error": "too many open links"}).encode() + b"\n")
                    return await close(writer)
                tunnel = Tunnel(wanted, secrets.token_hex(16), label)
                tunnels[wanted] = tunnel
                mark_dirty()
                log.info("tunnel %s opened (%d open)", wanted, len(tunnels))
            else:
                if tunnel.control is not None:
                    try:
                        tunnel.control.write(b"T\n")
                        await tunnel.control.drain()
                    except Exception:
                        pass
                    await close(tunnel.control)
                tunnel.secret = secrets.token_hex(16)
                mark_dirty()
                log.info("tunnel %s taken over", wanted)
        elif tunnel is None or not hmac.compare_digest(tunnel.secret, str(request.get("secret") or "")):
            if len(tunnels) >= MAX_TUNNELS:
                writer.write(json.dumps({"error": "too many open links"}).encode() + b"\n")
                return await close(writer)
            tunnel = Tunnel(new_host(), secrets.token_hex(16), label)
            tunnels[tunnel.code] = tunnel
            mark_dirty()
            log.info("tunnel %s opened (%d open)", tunnel.code, len(tunnels))
        elif tunnel.control is not None:
            await close(tunnel.control)
        writer.write(json.dumps({
            "url": f"https://{tunnel.code}",
            "code": tunnel.code,
            "secret": tunnel.secret,
        }).encode() + b"\n")
        await writer.drain()
        return await serve_control(tunnel, reader, writer)
    if op == "stream":
        tunnel = tunnels.get(str(request.get("code") or ""))
        future = tunnel.waiting.get(request.get("id")) if tunnel else None
        if future is None or future.done() or not hmac.compare_digest(tunnel.secret, str(request.get("secret") or "")):
            return await close(writer)
        done = asyncio.get_running_loop().create_future()
        future.set_result((reader, writer, done))
        await done
        return
    await close(writer)


async def serve_https(reader, writer):
    try:
        first = await asyncio.wait_for(reader.readline(), FIRST_LINE_WAIT)
    except Exception:
        return await close(writer)
    if first.startswith(b"{"):
        return await serve_client(first, reader, writer)
    head = first
    try:
        while b"\r\n\r\n" not in head and len(head) < MAX_HEAD:
            chunk = await asyncio.wait_for(reader.read(65536), FIRST_LINE_WAIT)
            if not chunk:
                return await close(writer)
            head += chunk
    except Exception:
        return await close(writer)
    host = host_of(head)
    tunnel = tunnels.get(host)
    if tunnel is None or tunnel.control is None:
        if host in (DOMAIN, CONTROL_HOST):
            title, text = "grog", "Public links to work in progress."
        elif site_of(host):
            title, text = "This site is offline", "It is not being served right now. Please try again later."
        else:
            title, text = "This link is not open", "Nothing is being shared at this address right now. Ask for a new link."
        writer.write(http_response("404 Not Found", page(title, text)))
        return await close(writer)
    stream = await tunnel.stream()
    if stream is None:
        writer.write(http_response("502 Bad Gateway", page(
            "The app did not answer", "The link is open, but the app behind it did not respond. Try again.")))
        return await close(writer)
    stream_reader, stream_writer, done = stream
    tunnel.served += 1
    peer = writer.get_extra_info("peername")
    try:
        stream_writer.write(prepare_head(head, host, peer[0] if peer else ""))
        await stream_writer.drain()
        await splice((reader, writer), (stream_reader, stream_writer))
    finally:
        if not done.done():
            done.set_result(None)


async def serve_http(reader, writer):
    try:
        head = await asyncio.wait_for(reader.read(MAX_HEAD), FIRST_LINE_WAIT)
    except Exception:
        return await close(writer)
    path = head.split(b" ", 2)[1].decode("latin-1") if head.count(b" ") >= 2 else "/"
    host = host_of(head) or DOMAIN
    if not (host == DOMAIN or host.endswith("." + DOMAIN) or site_of(host)):
        host = DOMAIN
    if not path.startswith("/"):
        path = "/"
    writer.write(http_response("301 Moved Permanently", "", f"Location: https://{host}{path}\r\n"))
    await close(writer)


async def sweep():
    while True:
        await asyncio.sleep(5)
        if dirty:
            save_state()
        now = time.monotonic()
        for code, tunnel in list(tunnels.items()):
            if tunnel.control is None and tunnel.gone_since and now - tunnel.gone_since > GRACE:
                del tunnels[code]
                mark_dirty()
                log.info("tunnel %s closed after serving %d connections (%d open)", code, tunnel.served, len(tunnels))


def tls_context(cert, key):
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.set_alpn_protocols(["http/1.1"])
    context.load_cert_chain(cert, key)
    return context


def load_sites():
    """One context per site domain: DOMAINS_DIR/<domain>/{fullchain,privkey}.pem."""
    contexts = {}
    try:
        names = sorted(os.listdir(DOMAINS_DIR))
    except OSError:
        names = []
    for name in names:
        folder = os.path.join(DOMAINS_DIR, name)
        if not HOSTNAME.match(name):
            continue
        try:
            contexts[name] = tls_context(os.path.join(folder, "fullchain.pem"), os.path.join(folder, "privkey.pem"))
        except (OSError, ssl.SSLError) as error:
            log.warning("site %s skipped: %s", name, error)
    return contexts


def pick_context(ssl_object, server_name, _context):
    domain = site_of((server_name or "").lower())
    if domain:
        ssl_object.context = site_contexts[domain]


async def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    global site_contexts
    context = tls_context(CERT, KEY)
    context.sni_callback = pick_context
    site_contexts = load_sites()
    load_state()

    def reload():
        global site_contexts
        context.load_cert_chain(CERT, KEY)
        site_contexts = load_sites()
        log.info("certificates reloaded; sites: %s", ", ".join(site_contexts) or "none")

    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGHUP, reload)
    stop = asyncio.Event()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    loop.add_signal_handler(signal.SIGINT, stop.set)
    https = await asyncio.start_server(serve_https, port=HTTPS_PORT, ssl=context, ssl_handshake_timeout=15)
    http = await asyncio.start_server(serve_http, port=HTTP_PORT)
    log.info("grog relay for %s on :%d and :%d; sites: %s", DOMAIN, HTTPS_PORT, HTTP_PORT, ", ".join(site_contexts) or "none")
    sweeper = asyncio.ensure_future(sweep())
    await stop.wait()
    # Save first, then close without waiting: open tunnels never end on their
    # own, and Server.wait_closed() would wait for them.
    sweeper.cancel()
    save_state()
    https.close()
    http.close()
    for tunnel in tunnels.values():
        if tunnel.control is not None:
            tunnel.control.transport.abort()
    log.info("stopped; %d link(s) kept for the next start", len(tunnels))

if __name__ == "__main__":
    asyncio.run(main())
