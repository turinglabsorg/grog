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

A link lives while `grog up` runs. On a dropped connection the client reclaims the same link within 90 seconds; after that it is gone. The relay pings the client every 20 seconds, and a control connection that hears nothing for 75 seconds counts as dropped: a relay or network that went away without a reset (a restart, a sleep, a router) would otherwise leave the client waiting on a dead connection and the link offline. The relay keeps open links across its own restarts (`/var/lib/grog-relay/state.json`, readable by its user only), so a restart or a security update does not change any address.

## Fixed addresses and site domains

`grog up <port> --domain <host>` asks for a fixed host instead of a random code:

- a name under the relay's domain, one label deep, like `demo.grooooog.space` (`up` and `www` are reserved);
- or a **site domain** of ours, apex or one label below, like `alienwatch.buzz` or `www.alienwatch.buzz`. The relay serves a site domain once its certificate is in `/etc/grog-relay/domains/<domain>/` and picks it by SNI.

A new claim with the token takes a fixed host over and tells the previous client, which stops; that is how a restarted machine gets its sites back without waiting. Fixed hosts are guessable: they are for things meant to be seen.

## Persistent sites: `grog serve`

A site domain is never served by a one-off `grog up`. `grog serve` keeps every site in `~/.grog/sites.json` online and follows changes to the file within seconds:

```json
{
  "alienwatch.buzz":     { "dir": "~/Sites/alienwatch.buzz" },
  "www.alienwatch.buzz": { "redirect": "https://alienwatch.buzz" },
  "app.alienwatch.buzz": { "port": 4000 },
  "api.alienwatch.buzz": { "run": "npm start", "cwd": "~/GIT/api", "port": 4100 }
}
```

- `dir`: static files, served by grog itself: nothing outside the folder (symlinks included), no hidden files or folders (`.env`, `.git`), GET and HEAD only, no listings. A scanner path is 404 and is not counted.
- `redirect`: a 301 to that address, keeping the path. A scanner path is 404 instead, and is not counted.
- `port`: an app already listening on that port. A scanner path is 404 from grog and never reaches the app. A known bot is proxied and not counted.
- `run` + `port`: the command that starts the app (in `cwd`, with `PORT` set), restarted when it exits.
- `board`: the live page for this `grog serve`. One host, password in `~/.grog/board-auth.json` (scrypt hash only). It lists every site and whether its tunnel is up, and the page views grog itself answered. Counts go to `~/.grog/board.sqlite`. A view is a document (no css, js, or images). A port site is counted by a localhost proxy in front of that port; `grog up` stays a raw pipe and counts nothing. Visitors are a first-party cookie, stored only as a hash. A referral is the previous site's host, or direct. A campaign keeps only `utm_source`, `utm_medium` and `utm_campaign`. The country is the two-letter code described below. The board also keeps a short log of those documents: time, host, path, country, referral, and campaign. Scanner paths (hidden files, dot segments, script leftovers, known panels) are answered 404 before the site and are not counted. A known bot user-agent is served and not counted. An empty user-agent is still counted.

A site is public and always up, so it is a production build, never a dev server (`npm run dev`, `vite`, `next dev`: dev servers have had bugs that read any file on the machine). Build output goes in `dir`; an app with its own server uses `run` with its production start command.

On the Mac Pro `grog serve` runs as the launchd agent `space.grooooog.serve` (`KeepAlive`, log `~/Library/Logs/grog-serve.log`), so the sites come back after a crash or a reboot once the user session is up.

### Adding a site domain

1. Pick the DNS that serves the domain:
   - DigitalOcean: at the registrar, set the nameservers to `ns1.digitalocean.com`, `ns2.digitalocean.com`, `ns3.digitalocean.com`, and add the domain in DigitalOcean DNS (the account with the relay).
   - Cloudflare: add the domain as a zone in the Cloudflare account and make it active. The hush token named by `GROG_RELAY_CLOUDFLARE_TOKEN_NAME` (default `CLOUDFLARE_PERSONAL_TOKEN`) needs DNS edit on that zone.
2. Add `A @`, `A www` and `A *` pointing at the relay. On Cloudflare the proxy stays off (DNS only): the relay terminates TLS with its own certificate.
3. Add the domain to `~/.config/grog-relay/sites`, followed by `cloudflare` when Cloudflare serves its DNS (`alienwatch.buzz cloudflare`), and run `renew.sh`: it gets the apex + wildcard certificate and installs it on the relay, which picks it up at once. The weekly run keeps it renewed.
4. Add its hosts to `~/.grog/sites.json`.

## Security

- **The machine running `grog up` accepts no inbound connection.** The client dials out and only ever connects to the one port it was started with, on loopback. It runs no commands and reads no files; it checks every message from the relay, so a relay in the wrong hands could still only send traffic to that port.
- **Only token holders open links.** The token is 32 random bytes kept in hush (`GROG_TUNNEL_TOKEN`); grog reads it from there and never prints it. The relay stores its SHA-256 only (`/etc/grog-relay/token.sha256`). To rotate: `hush generate GROG_TUNNEL_TOKEN --force`, then write the new hash to the relay.
- **Links are unguessable, not secret.** The code is 10 random characters (50 bits); the wildcard certificate keeps codes out of certificate-transparency logs. Whoever has a link can open the app behind it, so the app is what is exposed: share links only for apps that are fine to show.
- **The relay host holds no account credentials.** The certificate is obtained on the machine that has the DNS tokens (`renew.sh`) and only the certificate and key are copied to the relay.
- **The relay is contained:** an unprivileged user with only `CAP_NET_BIND_SERVICE`, a hardened systemd unit (read-only filesystem, no home, 256 MB), bounded open links and waiting streams, and no logging of request contents. The droplet accepts SSH by key only, has a firewall open on 22/80/443 only, and applies security updates automatically.
- **Site domains learn a country, and nothing else does.** For a host covered by a certificate in the domains directory, the relay adds `x-grog-country: IT` (where that visitor's network is registered) and drops any copy the visitor sent. The address is not logged and is not sent to the machine running `grog serve`, which removes the header before the site's own app sees the request. `grog up` links are not stamped: those bytes pass untouched. The table is `country.db` next to `relay.py`, built by `build_country.py` from the public RIR delegation files. A missing table means no header.

## Deploy

On an Ubuntu host with the domain's `A @` and `A *` records pointing at it:

```bash
useradd --system --no-create-home --shell /usr/sbin/nologin grogrelay
install -d -m 755 /opt/grog-relay && install -d -m 750 -o root -g grogrelay /etc/grog-relay
cp relay.py /opt/grog-relay/ && cp grog-relay.service /etc/systemd/system/
# /etc/grog-relay: fullchain.pem, privkey.pem, token.sha256 (root:grogrelay, 640)
systemctl daemon-reload && systemctl enable --now grog-relay
```

`renew.sh` gets or renews the certificates with [lego](https://go-acme.github.io/lego/) and a DNS-01 challenge, from the machine that keeps the DNS tokens in hush: the relay's wildcard, and apex + wildcard of every site domain in `~/.config/grog-relay/sites`. Each line of that file is a domain, optionally followed by the DNS that serves it: `digitalocean` (the default) or `cloudflare`. It installs what changed on the relay and reloads it; a site that fails is reported, the others still renew, and the script exits 1. Run it weekly (a launchd or cron job). Settings: `GROG_RELAY_DOMAIN`, `GROG_RELAY_SSH`, `GROG_RELAY_DNS_TOKEN_NAME` (DigitalOcean), `GROG_RELAY_CLOUDFLARE_TOKEN_NAME`, `GROG_RELAY_LEGO_DIR`, `GROG_RELAY_SITES_FILE`.

## Client settings

`grog up` reads `~/.grog/config.json` `tunnel` (`host`, default `up.grooooog.space`; `tokenName`, default `GROG_TUNNEL_TOKEN`) or `GROG_TUNNEL_HOST` / `GROG_TUNNEL_TOKEN`. `GROG_TUNNEL_SILENCE_MS` changes the 75-second silence limit (the tests shorten it).

Dev servers that check the Host header need to allow the domain: Vite `server.allowedHosts: ['.grooooog.space']`, Next.js `allowedDevOrigins: ['*.grooooog.space']`.

## Test

`skill/tunnel.test.js` runs the relay with a throwaway CA and checks the whole path: a page, parallel requests, a WebSocket, a wrong token, an unknown link, closing, a hostile relay, a site domain with its own certificate, fixed and refused names, a takeover, `grog serve` (static files, refused paths, redirects, removing a site) and a relay restart that keeps the link. `tunnel/country_test.py` checks the country table and that only a site domain is stamped.
