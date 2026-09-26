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
- TLS uses a wildcard certificate for the domain, reloaded on SIGHUP.
- Nothing about requests is logged beyond counts.

Standard library only (Python 3.10+).
"""

import asyncio
import hashlib
import hmac
import json
import logging
import os
import secrets
import signal
import ssl
import time

DOMAIN = os.environ.get("GROG_RELAY_DOMAIN", "grooooog.space").lower()
CONTROL_HOST = "up." + DOMAIN
CERT = os.environ.get("GROG_RELAY_CERT", "/etc/grog-relay/fullchain.pem")
KEY = os.environ.get("GROG_RELAY_KEY", "/etc/grog-relay/privkey.pem")
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


tunnels = {}


def token_ok(token):
    try:
        with open(TOKEN_SHA256, encoding="ascii") as handle:
            expected = handle.read().strip()
    except OSError:
        return False
    given = hashlib.sha256(str(token or "").encode()).hexdigest()
    return bool(expected) and hmac.compare_digest(given, expected)


def new_code():
    while True:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(10))
        if code not in tunnels:
            return code


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
        tunnel = tunnels.get(str(request.get("code") or ""))
        if tunnel is None or not hmac.compare_digest(tunnel.secret, str(request.get("secret") or "")):
            if len(tunnels) >= MAX_TUNNELS:
                writer.write(json.dumps({"error": "too many open links"}).encode() + b"\n")
                return await close(writer)
            tunnel = Tunnel(new_code(), secrets.token_hex(16), str(request.get("label") or "")[:80])
            tunnels[tunnel.code] = tunnel
            log.info("tunnel %s opened (%d open)", tunnel.code, len(tunnels))
        elif tunnel.control is not None:
            await close(tunnel.control)
        writer.write(json.dumps({
            "url": f"https://{tunnel.code}.{DOMAIN}",
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
    code = host[: -len("." + DOMAIN)] if host.endswith("." + DOMAIN) else ""
    tunnel = tunnels.get(code)
    if tunnel is None or tunnel.control is None:
        title = "grog" if host in (DOMAIN, CONTROL_HOST) else "This link is not open"
        text = "Public links to work in progress." if title == "grog" else \
            "Nothing is being shared at this address right now. Ask for a new link."
        writer.write(http_response("404 Not Found", page(title, text)))
        return await close(writer)
    stream = await tunnel.stream()
    if stream is None:
        writer.write(http_response("502 Bad Gateway", page(
            "The app did not answer", "The link is open, but the app behind it did not respond. Try again.")))
        return await close(writer)
    stream_reader, stream_writer, done = stream
    tunnel.served += 1
    try:
        stream_writer.write(head)
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
    if not (host == DOMAIN or host.endswith("." + DOMAIN)):
        host = DOMAIN
    if not path.startswith("/"):
        path = "/"
    writer.write(http_response("301 Moved Permanently", "", f"Location: https://{host}{path}\r\n"))
    await close(writer)


async def sweep():
    while True:
        await asyncio.sleep(10)
        now = time.monotonic()
        for code, tunnel in list(tunnels.items()):
            if tunnel.control is None and tunnel.gone_since and now - tunnel.gone_since > GRACE:
                del tunnels[code]
                log.info("tunnel %s closed after serving %d connections (%d open)", code, tunnel.served, len(tunnels))


def tls_context():
    context = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.set_alpn_protocols(["http/1.1"])
    context.load_cert_chain(CERT, KEY)
    return context


async def main():
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    context = tls_context()
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGHUP, lambda: (context.load_cert_chain(CERT, KEY), log.info("certificate reloaded")))
    https = await asyncio.start_server(serve_https, port=HTTPS_PORT, ssl=context, ssl_handshake_timeout=15)
    http = await asyncio.start_server(serve_http, port=HTTP_PORT)
    log.info("grog relay for %s on :%d and :%d", DOMAIN, HTTPS_PORT, HTTP_PORT)
    asyncio.ensure_future(sweep())
    async with https, http:
        await asyncio.gather(https.serve_forever(), http.serve_forever())


if __name__ == "__main__":
    asyncio.run(main())
