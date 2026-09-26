# grog relay

`grog up <port>` gives a local port a public HTTPS link, `https://<code>.grooooog.space`, that anyone with the link can open, from any device, with no VPN. This directory is the server side: one small relay on a public host.

## How it works

```
visitor ──https──▶ relay (droplet) ◀──tls── grog up ──▶ localhost:<port>
                     pairs the two          (dials out; nothing listens here)
```

1. `grog up` connects out to `up.grooooog.space` (the control connection), presents the tunnel token, and gets a link.
2. A visitor opens the link. The relay asks the client, over the control connection, for a stream.
3. The client opens a new connection to the relay for it and one to `localhost:<port>`, and pipes the two. HTTP, keep-alive and WebSockets pass untouched.

A link lives while `grog up` runs. On a dropped connection the client reclaims the same link within 90 seconds; after that it is gone.

## Security

- **The machine running `grog up` accepts no inbound connection.** The client dials out and only ever connects to the one port it was started with, on loopback. It runs no commands and reads no files; it checks every message from the relay, so a relay in the wrong hands could still only send traffic to that port.
- **Only token holders open links.** The token is 32 random bytes kept in hush (`GROG_TUNNEL_TOKEN`); grog reads it from there and never prints it. The relay stores its SHA-256 only (`/etc/grog-relay/token.sha256`). To rotate: `hush generate GROG_TUNNEL_TOKEN --force`, then write the new hash to the relay.
- **Links are unguessable, not secret.** The code is 10 random characters (50 bits); the wildcard certificate keeps codes out of certificate-transparency logs. Whoever has a link can open the app behind it, so the app is what is exposed: share links only for apps that are fine to show.
- **The relay host holds no account credentials.** The certificate is obtained on the machine that has the DNS token (`renew.sh`) and only the certificate and key are copied to the relay.
- **The relay is contained:** an unprivileged user with only `CAP_NET_BIND_SERVICE`, a hardened systemd unit (read-only filesystem, no home, 256 MB), bounded open links and waiting streams, and no logging of request contents. The droplet accepts SSH by key only, has a firewall open on 22/80/443 only, and applies security updates automatically.

## Deploy

On an Ubuntu host with the domain's `A @` and `A *` records pointing at it:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin grogrelay
install -d -m 755 /opt/grog-relay && install -d -m 750 -o root -g grogrelay /etc/grog-relay
cp relay.py /opt/grog-relay/ && cp grog-relay.service /etc/systemd/system/
# /etc/grog-relay: fullchain.pem, privkey.pem, token.sha256 (root:grogrelay, 640)
systemctl daemon-reload && systemctl enable --now grog-relay
```

`renew.sh` gets or renews the wildcard certificate with [lego](https://go-acme.github.io/lego/) and DigitalOcean DNS, from the machine that keeps the DNS token in hush, and installs it on the relay when it changed; run it weekly (a launchd or cron job). Settings: `GROG_RELAY_DOMAIN`, `GROG_RELAY_SSH`, `GROG_RELAY_DNS_TOKEN_NAME`, `GROG_RELAY_LEGO_DIR`.

## Client settings

`grog up` reads `~/.grog/config.json` `tunnel` (`host`, default `up.grooooog.space`; `tokenName`, default `GROG_TUNNEL_TOKEN`) or `GROG_TUNNEL_HOST` / `GROG_TUNNEL_TOKEN`.

Dev servers that check the Host header need to allow the domain: Vite `server.allowedHosts: ['.grooooog.space']`, Next.js `allowedDevOrigins: ['*.grooooog.space']`.

## Test

`skill/tunnel.test.js` runs the relay with a throwaway CA and checks the whole path: a page, parallel requests, a WebSocket, a wrong token, an unknown link, closing, and a hostile relay.
