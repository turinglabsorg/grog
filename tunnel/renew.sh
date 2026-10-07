#!/bin/sh
# Renew the relay's certificates from this machine and install them on the
# relay: the wildcard of the relay's domain, and one per site domain listed in
# $GROG_RELAY_SITES_FILE (one domain per line, e.g. alienwatch.buzz, optionally
# followed by the DNS that serves it: digitalocean, the default, or
# cloudflare; each gets its apex and wildcard). The DNS tokens that prove the
# domains stay in hush here; the relay only ever receives certificates and
# keys. lego renews only when a certificate is due, so running this weekly is
# cheap. A site that fails is reported and the others still renew.
set -eu
DOMAIN=${GROG_RELAY_DOMAIN:-grooooog.space}
RELAY=${GROG_RELAY_SSH:-root@139.59.154.158}
DNS_TOKEN=${GROG_RELAY_DNS_TOKEN_NAME:-TURINGLABS_DIGITALOCEAN_TOKEN}
CF_TOKEN=${GROG_RELAY_CLOUDFLARE_TOKEN_NAME:-CLOUDFLARE_PERSONAL_TOKEN}
DIR=${GROG_RELAY_LEGO_DIR:-$HOME/.config/grog-relay/lego}
SITES_FILE=${GROG_RELAY_SITES_FILE:-$HOME/.config/grog-relay/sites}
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

# obtain <domain> [dns]: get or renew apex + wildcard through the DNS that
# serves the domain. A fixed wait instead of propagation checks: right after a
# nameserver change, resolvers still answer for the old servers and the checks
# never pass.
obtain() {
  dns=${2:-digitalocean}
  case "$dns" in
    digitalocean) token=$DNS_TOKEN env=DO_AUTH_TOKEN ;;
    cloudflare) token=$CF_TOKEN env=CF_DNS_API_TOKEN ;;
    *) echo "$1: unknown DNS $dns (digitalocean or cloudflare)" >&2; return 1 ;;
  esac
  hush run --name "$token" --env "$env" --redact -- \
    lego run --accept-tos --dns "$dns" --dns.propagation.wait 30s \
    -d "$1" -d "*.$1" --path "$DIR" --log.format text < /dev/null
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
failed=""
obtain "$DOMAIN" >/dev/null 2>&1 || obtain "$DOMAIN"
[ -n "$(install_cert "$DIR/certificates/_.$DOMAIN.crt" "$DIR/certificates/_.$DOMAIN.key" /etc/grog-relay)" ] && changed="$changed $DOMAIN"
if [ -f "$SITES_FILE" ]; then
  while read -r site provider _; do
    case "$site" in ""|\#*) continue ;; esac
    if ! obtain "$site" "$provider" >/dev/null 2>&1 && ! obtain "$site" "$provider"; then
      failed="$failed $site"
      continue
    fi
    [ -n "$(install_cert "$DIR/certificates/$site.crt" "$DIR/certificates/$site.key" "/etc/grog-relay/domains/$site")" ] && changed="$changed $site"
  done < "$SITES_FILE"
fi
if [ -n "$changed" ]; then
  ssh -n -o BatchMode=yes "$RELAY" "systemctl reload grog-relay"
  echo "installed on $RELAY:$changed"
else
  echo "relay already has every current certificate"
fi
if [ -n "$failed" ]; then
  echo "could not renew:$failed" >&2
  exit 1
fi
