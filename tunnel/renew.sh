#!/bin/sh
# Renew the relay's wildcard certificate from this machine and install it on the
# relay. The DNS token that proves the domain stays in hush here; the relay only
# ever receives the certificate and its key. lego renews only when it is due, so
# running this weekly is cheap.
set -eu
DOMAIN=${GROG_RELAY_DOMAIN:-grooooog.space}
RELAY=${GROG_RELAY_SSH:-root@139.59.154.158}
DNS_TOKEN=${GROG_RELAY_DNS_TOKEN_NAME:-TURINGLABS_DIGITALOCEAN_TOKEN}
DIR=${GROG_RELAY_LEGO_DIR:-$HOME/.config/grog-relay/lego}
export PATH="$HOME/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

CRT="$DIR/certificates/_.$DOMAIN.crt"
KEY="$DIR/certificates/_.$DOMAIN.key"

DO_PROPAGATION_TIMEOUT=300 hush run --name "$DNS_TOKEN" --env DO_AUTH_TOKEN --redact -- \
  lego run --accept-tos --dns digitalocean --dns.propagation.disable-rns \
  -d "*.$DOMAIN" -d "$DOMAIN" --path "$DIR" --log.format text

local_sum=$(shasum -a 256 "$CRT" | cut -c1-64)
remote_sum=$(ssh -n -o BatchMode=yes "$RELAY" "sha256sum /etc/grog-relay/fullchain.pem | cut -c1-64")
if [ "$local_sum" = "$remote_sum" ]; then
  echo "relay already has the current certificate"
  exit 0
fi
ssh -o BatchMode=yes "$RELAY" 'umask 027; cat > /etc/grog-relay/fullchain.pem.new' < "$CRT"
ssh -o BatchMode=yes "$RELAY" 'umask 027; cat > /etc/grog-relay/privkey.pem.new' < "$KEY"
ssh -n -o BatchMode=yes "$RELAY" 'cd /etc/grog-relay && chown root:grogrelay fullchain.pem.new privkey.pem.new &&
  mv fullchain.pem.new fullchain.pem && mv privkey.pem.new privkey.pem && systemctl reload grog-relay'
echo "installed the renewed certificate on $RELAY"
