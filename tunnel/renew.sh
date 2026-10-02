#!/bin/sh
# Renew the relay's certificates from this machine and install them on the
# relay: the wildcard of the relay's domain, and one per site domain listed in
# $GROG_RELAY_SITES_FILE (one domain per line, e.g. alienwatch.buzz; each gets
# its apex and wildcard). The DNS token that proves the domains stays in hush
# here; the relay only ever receives certificates and keys. lego renews only
# when a certificate is due, so running this weekly is cheap.
set -eu
DOMAIN=${GROG_RELAY_DOMAIN:-grooooog.space}
RELAY=${GROG_RELAY_SSH:-root@139.59.154.158}
DNS_TOKEN=${GROG_RELAY_DNS_TOKEN_NAME:-TURINGLABS_DIGITALOCEAN_TOKEN}
DIR=${GROG_RELAY_LEGO_DIR:-$HOME/.config/grog-relay/lego}
SITES_FILE=${GROG_RELAY_SITES_FILE:-$HOME/.config/grog-relay/sites}
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

# lego run <first domain> <name of its files>: get or renew apex + wildcard.
# A fixed wait instead of propagation checks: right after a nameserver change,
# resolvers still answer for the old servers and the checks never pass.
obtain() {
  hush run --name "$DNS_TOKEN" --env DO_AUTH_TOKEN --redact -- \
    lego run --accept-tos --dns digitalocean --dns.propagation.wait 30s \
    -d "$1" -d "*.$1" --path "$DIR" --log.format text
}

# install <local crt> <local key> <remote folder>: copy if changed; prints "changed".
install_cert() {
  local_sum=$(shasum -a 256 "$1" | cut -c1-64)
  remote_sum=$(ssh -n -o BatchMode=yes "$RELAY" "sha256sum $3/fullchain.pem 2>/dev/null | cut -c1-64")
  [ "$local_sum" = "$remote_sum" ] && return 0
  ssh -n -o BatchMode=yes "$RELAY" "install -d -m 750 -o root -g grogrelay $3"
  ssh -o BatchMode=yes "$RELAY" "umask 027; cat > $3/fullchain.pem.new" < "$1"
  ssh -o BatchMode=yes "$RELAY" "umask 027; cat > $3/privkey.pem.new" < "$2"
  ssh -n -o BatchMode=yes "$RELAY" "cd $3 && chown root:grogrelay fullchain.pem.new privkey.pem.new &&
    mv fullchain.pem.new fullchain.pem && mv privkey.pem.new privkey.pem"
  echo changed
}

changed=""
obtain "$DOMAIN" >/dev/null 2>&1 || obtain "$DOMAIN"
[ -n "$(install_cert "$DIR/certificates/_.$DOMAIN.crt" "$DIR/certificates/_.$DOMAIN.key" /etc/grog-relay)" ] && changed="$changed $DOMAIN"
if [ -f "$SITES_FILE" ]; then
  while IFS= read -r site; do
    site=$(printf %s "$site" | tr -d '[:space:]')
    case "$site" in ""|\#*) continue ;; esac
    obtain "$site" >/dev/null 2>&1 || obtain "$site"
    [ -n "$(install_cert "$DIR/certificates/$site.crt" "$DIR/certificates/$site.key" "/etc/grog-relay/domains/$site")" ] && changed="$changed $site"
  done < "$SITES_FILE"
fi
if [ -n "$changed" ]; then
  ssh -n -o BatchMode=yes "$RELAY" "systemctl reload grog-relay"
  echo "installed on $RELAY:$changed"
else
  echo "relay already has every current certificate"
fi
