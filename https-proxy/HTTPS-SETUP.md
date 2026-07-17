# HTTPS Reverse Proxy (DuckDNS + Let's Encrypt DNS-01 + nginx)

Puts a real, browser-trusted HTTPS front door on LibreChat. Also gives browsers
the **secure context** they require to grant mic access — this is what unblocks
**browser STT** (speech-to-text) for remote users.

```
User (on UD VPN) ──https://udassistant.duckdns.org──► https-proxy (nginx :443, TLS)
                                                            │  proxy_pass
                                                            ▼
                                                   LibreChat api :3080
```

**Design choices:**
- **DuckDNS + DNS-01** because the host is **UD-internal only** (not reachable
  from the public internet). The usual HTTP-01 challenge needs inbound
  reachability on port 80; DNS-01 proves domain control via a TXT record instead,
  so it works on an internal host. The cert is fully Let's-Encrypt-trusted (no
  warnings).
- **Access is VPN-gated by design.** The DuckDNS name resolves publicly, but the
  host only answers on the UD network, so off-campus users need the UD VPN. That's
  intended.
- **certbot runs separately from nginx.** Cert lives in `/etc/letsencrypt` on the
  host; nginx mounts it read-only. Renewal is decoupled from the proxy.

Files: `ud-assistant.conf` (nginx), `https-proxy.compose.yml` (service), this doc.

---

## STEP 1 — Get a DuckDNS hostname + token
1. Go to https://www.duckdns.org and sign in (GitHub/Google/etc).
2. Create a subdomain, e.g. `udassistant` → gives you `udassistant.duckdns.org`.
3. Copy your **token** (shown at the top of the dashboard). Treat it like a
   password — it grants DNS control of your subdomain.
4. Point the subdomain at the host's UD IP (in the DuckDNS dashboard, set the
   "current ip" to the LibreChat host's 128.x address, or leave it — for DNS-01
   the A record doesn't even need to be correct, but setting it lets VPN users
   resolve the name to the right box).

> DuckDNS propagates almost instantly, which makes DNS-01 fast.

---

## STEP 2 — Put your hostname into the configs
Replace the placeholder `udassistant.duckdns.org` everywhere:
```bash
cd ~/Projects/UD-Assistant/FRONTEND/LibreChat/https-proxy
sed -i 's/udassistant\.duckdns\.org/YOURNAME.duckdns.org/g' ud-assistant.conf
grep server_name ud-assistant.conf          # confirm
```
(If you keep the name `udassistant`, no edit needed.)

---

## STEP 3 — Issue the certificate (certbot DNS-01, in a container)
No need to install certbot on the host — run it in a one-shot container with the
DuckDNS plugin. This writes the cert to the host's `/etc/letsencrypt`.

First, put your token in an env var (avoids shell-history leakage):
```bash
read -rs DUCKDNS_TOKEN        # paste token, press enter (input hidden)
export DUCKDNS_TOKEN
```

**Test with staging first** (Let's Encrypt rate-limits real certs; staging avoids
burning your quota on typos). Replace the email + domain:
```bash
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -e DUCKDNS_TOKEN="$DUCKDNS_TOKEN" \
  infinityofspace/certbot_dns_duckdns:latest \
  certonly \
    --non-interactive --agree-tos \
    --email you@udel.edu \
    --preferred-challenges dns \
    --authenticator dns-duckdns \
    --dns-duckdns-token "$DUCKDNS_TOKEN" \
    --dns-duckdns-propagation-seconds 60 \
    -d "udassistant.duckdns.org" \
    --staging
```
If that succeeds ("The dry run was successful" / cert saved under a staging path),
**re-run WITHOUT `--staging`** to get the real cert:
```bash
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -e DUCKDNS_TOKEN="$DUCKDNS_TOKEN" \
  infinityofspace/certbot_dns_duckdns:latest \
  certonly \
    --non-interactive --agree-tos \
    --email you@udel.edu \
    --preferred-challenges dns \
    --authenticator dns-duckdns \
    --dns-duckdns-token "$DUCKDNS_TOKEN" \
    --dns-duckdns-propagation-seconds 60 \
    -d "udassistant.duckdns.org"
```
Verify the cert landed on the host:
```bash
sudo ls /etc/letsencrypt/live/udassistant.duckdns.org/
# expect: cert.pem  chain.pem  fullchain.pem  privkey.pem
```

> **Optional — wildcard:** to cover future subdomains, add `-d "*.udassistant.duckdns.org"`
> in a SEPARATE certbot call (DuckDNS allows only one TXT record at a time, so you
> can't do the bare domain and the wildcard in one command).

---

## STEP 4 — Point LibreChat at the HTTPS hostname
LibreChat needs to know its own public URL (for OAuth callbacks, absolute links,
CORS). In your LibreChat `.env`:
```dotenv
DOMAIN_CLIENT=https://udassistant.duckdns.org
DOMAIN_SERVER=https://udassistant.duckdns.org
```
Do NOT publish the api container's :3080 to the host anymore — the proxy reaches
it over the docker network by name (`api:3080`). If your compose maps `3080:3080`,
you can remove that (optional; the proxy works either way, but closing it keeps
plain-HTTP off the host).

Apply:
```bash
cd ~/Projects/UD-Assistant/FRONTEND/LibreChat
docker compose up -d api
```

---

## STEP 5 — Start the HTTPS proxy
```bash
cd ~/Projects/UD-Assistant/FRONTEND/LibreChat/https-proxy
docker compose -f https-proxy.compose.yml up -d
docker logs https-proxy          # nginx started, no cert/path errors
```

Test from the host:
```bash
curl -I https://udassistant.duckdns.org/health   # over VPN/UD network
# expect: HTTP/2 200, and NO cert warning (real Let's Encrypt cert)
```
Then open `https://udassistant.duckdns.org` in a browser (on the UD network / VPN).
Padlock should be clean. Send a chat message — confirm streaming works. Try the
mic — STT should now be available (secure context satisfied).

---

## STEP 6 — Auto-renewal (Let's Encrypt certs last 90 days)
Renewal re-runs the same DNS-01 flow. Set up a systemd timer on the host that
runs certbot renew in the container weekly, then reloads nginx.

Create `/etc/systemd/system/certbot-renew.service`:
```ini
[Unit]
Description=Renew Let's Encrypt certs (DuckDNS DNS-01)

[Service]
Type=oneshot
# Token read from an env file so it's not in the unit. Create /etc/duckdns.env
# containing:  DUCKDNS_TOKEN=your-token   (chmod 600)
EnvironmentFile=/etc/duckdns.env
ExecStart=/usr/bin/docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -e DUCKDNS_TOKEN=${DUCKDNS_TOKEN} \
  infinityofspace/certbot_dns_duckdns:latest \
  renew --dns-duckdns-propagation-seconds 60
# Reload nginx so it picks up the new cert (no downtime):
ExecStartPost=/usr/bin/docker exec https-proxy nginx -s reload
```

Create `/etc/systemd/system/certbot-renew.timer`:
```ini
[Unit]
Description=Weekly Let's Encrypt renewal

[Timer]
OnCalendar=Sun 03:00
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

Enable it:
```bash
sudo sh -c 'echo "DUCKDNS_TOKEN=YOUR_TOKEN" > /etc/duckdns.env && chmod 600 /etc/duckdns.env'
sudo systemctl daemon-reload
sudo systemctl enable --now certbot-renew.timer
systemctl list-timers | grep certbot        # confirm it's scheduled
```
Test the renewal path without waiting a week:
```bash
sudo systemctl start certbot-renew.service
journalctl -u certbot-renew.service --no-pager | tail -20
```
certbot only actually renews when <30 days remain, so an early run is a safe no-op.

---

## Rollback
```bash
# stop the proxy; LibreChat still serves on :3080 directly (if you kept that port)
docker compose -f https-proxy.compose.yml down
# revert .env DOMAIN_* to http://<host-ip>:3080 and: docker compose up -d api
```

---

## Gotchas
- **Cert path mismatch = nginx won't start.** The `ssl_certificate` paths in
  `ud-assistant.conf` must exactly match `/etc/letsencrypt/live/<yourname>/`.
  If you renamed the domain, `sed` both the conf AND re-check the live dir name.
- **DNS-01 needs the token, not port reachability.** If issuance fails with an
  NXDOMAIN/TXT error, the token is wrong or the domain name is mistyped — it is
  NOT a firewall problem (DNS-01 doesn't touch your host's inbound ports).
- **Port 80/443 already in use?** Only the proxy should publish them. Make sure no
  other container maps 80/443 on the host.
- **STT still not offered after HTTPS?** Confirm the browser shows a clean padlock
  (secure context). A self-signed/warning cert does NOT satisfy the secure-context
  requirement in all browsers; the real Let's Encrypt cert does.
- **HSTS caution:** the config sends HSTS (forces HTTPS for 6 months). Don't enable
  it until HTTPS definitely works, or browsers will refuse plain HTTP to this name.
  It's on by default here since this host is meant to be HTTPS-only.
- **90-day expiry:** if you skip the renewal timer, the cert dies in 90 days and
  browsers will error. Set up STEP 6.



Edit zone DNS API token was successfully created
Copy this token to access the Cloudflare API. For security this will not be shown again. Learn more


Test this token
To confirm your token is working correctly, copy and paste the below CURL command in a terminal shell to test.


curl "https://api.cloudflare.com/client/v4/user/tokens/verify" \
-H "Authorization: Bearer YOUR_CLOUDFARE_TOKEN"