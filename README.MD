# LibreChat — UD Assistant fork

Fork of [`danny-avila/LibreChat`](https://github.com/danny-avila/LibreChat), **pinned at
tag `v0.8.7`**, customized for UD Assistant. This is the chat frontend/API for the whole
system — a self-hosted, branded LibreChat backed by a local vLLM (Qwen3-VL) model, with
document Q&A, web search, and a simplified UI.

> This README consolidates everything LibreChat-related. It's the working reference for this
> repo; the parent project's root `README.md` has the same material in full context (section
> numbers referenced below, e.g. "root §6").

---

## What this fork changes vs upstream
The code diff from stock v0.8.7 is small; most customization is config + a few asset/HTML
overrides mounted at runtime:

- **UI: message Edit button hidden** — `client/src/components/Chat/Messages/HoverButtons.tsx`.
  A constant `ENABLE_MESSAGE_EDIT_BUTTON = false` gates the existing `isEditableEndpoint`
  condition, so no Edit (pencil) button renders on **any** message, user prompts or assistant
  replies. Users should not be able to rewrite what the assistant said (or their own prompts)
  in the UI. Set the constant to `true` to restore upstream behavior.
  *Note:* the up-arrow keyboard shortcut (`hooks/Input/useHandleKeyUp.ts`) looks the button up
  by id and already guards on `if (!element) return;`, so it degrades to a no-op. No change needed there.
- **Branding** — replaced logos/favicons in `client/public/assets/` (`logo.svg`,
  `favicon-16x16.png`, `favicon-32x32.png`, `icon-192x192.png`, `apple-touch-icon-180x180.png`)
  and a custom `index.html` to fix the tab-title flash. (root §9)
- **Deployment config carried in-repo** — `docker-compose.override.yml`, `librechat.yaml`,
  and the two nginx stacks below.
- **`https-proxy/`** — nginx HTTPS reverse proxy (TLS termination, subdomains). (root §16)
- **`vllm-lb/`** — nginx load balancer fanning LLM requests across multiple vLLM devices. (root §15)

Everything else is stock v0.8.7. **Pinned** — deliberately does NOT track upstream's latest;
don't use GitHub's "Sync fork" button (it would un-pin us). Pull upstream security fixes manually.

---

## How it runs (deployment)
LibreChat runs from the **prebuilt image** `ghcr.io/danny-avila/librechat:v0.8.7` via
`docker-compose.override.yml` — the source in this repo matches that tag, so you can switch
to a local `build:` if you need to change React code (see "Building from source" below).

### `.env` essentials (root §5)
Key variables (never commit real values — `.env` is gitignored):
- `VLLM_API_KEY`, and the endpoint config pointing at the vLLM LLM (`:8000`, or the LB).
- `RAG_API_URL` → the rag_api container; web-search vars (SearXNG/Firecrawl).
- Branding: `APP_TITLE`, `CUSTOM_FOOTER` (used for the usage-stats link).
- `MEILI_MASTER_KEY` (see rotation gotcha, root §17).
- `UID`/`GID` set to your host user (silences compose warnings; correct file ownership).
- `LANGFUSE_*` point at the **mask-proxy**, not Langfuse directly (observability, root §18).

> `.env` traps that bit us repeatedly: no spaces around `=`, no inline `#` comments, and
> appending with `echo >>` when the file lacks a trailing newline GLUES lines together.

### `librechat.yaml` (root §6)
The working config: Qwen3-VL endpoint (`user_provided` so no key box shows), image upload,
web search, artifacts, the tuned system prompt (search discipline), context/loop limits, and
the `ocr` block pointing at the local OCR service (`http://ocr-service:8003/v1`).

### `docker-compose.override.yml` (root §8)
Pinned image, the branding file mounts (per-file into `dist/assets`), the custom `index.html`
mount, networking, and the `LANGFUSE_*`/`CUSTOM_FOOTER` environment injection.

---

## Branding (root §9)
Replace files in `client/public/assets/` and mount per-file into `dist/assets` (override §8),
then hard-refresh (browsers cache logos aggressively). The tab title flashes "LibreChat" then
"UD Assistant" because the static `index.html` hardcodes the old title — fix by overriding the
**compiled** `index.html` (extract with `docker compose cp api:/app/client/dist/index.html .`,
edit the `<title>`, leave the hashed script tags alone), then mount it.

## Controlling the model picker & hiding features (root §11)
- Remove unwanted provider endpoints with the `user_provided` trick.
- Hide the Agents endpoint from the picker.
- Disable the MCP button via Mongo commands.

## Registration & user accounts — closed beta (root §12)
Registration is closed; create/delete users by hand. **Create the admin account FIRST**
(it gets `role: ADMIN`, which the admin console requires), then beta users. Full runbook in
root §16.8.

## Meilisearch master-key rotation (root §17)
The painful 403 fix when rotating `MEILI_MASTER_KEY` — the key lives in two places; rotate both.

---

## `https-proxy/` — HTTPS reverse proxy (root §16)
nginx terminating TLS in front of LibreChat (and the stats/admin subdomains), with
Let's Encrypt DNS-01 certs via Cloudflare. Files: `ud-assistant.conf`, `https-proxy.compose.yml`,
`HTTPS-SETUP.md`.

- Proxies by container name over `librechat_default` (e.g. `proxy_pass http://api:3080`).
- Serves multiple subdomains via separate `server` blocks: the chat
  (`alphatest.udassistant.com`), per-user stats (`metrics.alphatest...`), and admin console
  (`feedback.alphatest...`).
- **Certs** issued with the certbot Docker container + Cloudflare DNS plugin (no host certbot):
  ```bash
  docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v ~/.secrets/certbot:/secrets:ro \
    certbot/dns-cloudflare certonly --non-interactive --agree-tos --email you@example.com \
    --dns-cloudflare --dns-cloudflare-credentials /secrets/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 -d <hostname>
  ```
- **Gotcha:** after editing a server block, `grep -c` the live config and verify the served
  cert with `openssl s_client ... -servername <host> | openssl x509 -noout -subject` — nginx
  `-t`/reload succeed even if a new block is missing, silently serving the wrong cert.

See `https-proxy/HTTPS-SETUP.md` for the full runbook. Full detail: root §16.

## `vllm-lb/` — LLM load balancing (root §15)
nginx reverse proxy fanning LLM inference across multiple vLLM devices (the two DGX Sparks),
roughly doubling concurrency. Files: `vllm-lb.conf`, `vllm-lb.compose.yml`, `nginx-lb-SETUP.md`.

- **Scope: LLM inference only (`:8000`).** Embeddings run in-process in rag_api, not balanced —
  don't route `RAG_OPENAI_BASEURL` through the LB.
- Uses direct proxy (not SSH tunnels); mind the `172.22.0.1` gateway rule for host reachability.

See `vllm-lb/nginx-lb-SETUP.md` for the full runbook. Full detail: root §15.

---

## Building from source
This fork **builds locally** rather than pulling upstream's prebuilt image, because it
contains React source changes (see "What this fork changes"). In `docker-compose.override.yml`
the `api` service is:
```yaml
    # image: ghcr.io/danny-avila/librechat:v0.8.7   # upstream prebuilt (rollback: swap the comments)
    build:
      context: .
      dockerfile: Dockerfile
    image: ud-librechat:local
```
Build and deploy:
```bash
docker compose build api                      # ~2 min; Dockerfile sets NODE_OPTIONS=--max-old-space-size=6144
docker compose up -d --force-recreate api
docker compose logs --tail 20 api             # want "Server listening", no errors
```
Then **hard-refresh the browser (Ctrl-Shift-R) or use incognito** — the JS bundle caches hard,
and a stale cache is the most common reason a UI change appears not to have worked.

**Rollback:** swap the comments back to `image: ghcr.io/danny-avila/librechat:v0.8.7` and
recreate. That image stays cached locally, so rollback takes under a minute. Note the
prebuilt image does **not** contain our UI changes.

Document any React/source change under "What this fork changes vs upstream" so the diff from
stock v0.8.7 stays legible.

---

## Deployment gotchas 

Building from source recreates containers, which activates settings that were previously
dormant. Three failures hit in sequence on the first source build — **none caused by the code
change itself**. All three surfaced to users as **502 Bad Gateway** from nginx.

### 1. Do NOT set `UID`/`GID` in `.env`
`docker-compose.yml` applies `user: "${UID}:${GID}"` to **three** services: `api`, `mongodb`,
and `meilisearch`. When `UID`/`GID` are unset, this resolves to `user: ":"`, which Docker
ignores, so each container runs as its image default. **That is the working configuration.**

Setting `UID=1008`/`GID=1008` (to silence the compose warnings) forces all three services to
the same UID and breaks two of them:
- **LibreChat** crash-loops: `EACCES: permission denied, open '/app/logs/error-*.log'`
- **MongoDB** crash-loops: `Failed to read metadata from /data/db/storage.bson`

**The compose warnings about unset UID/GID are harmless. Leave them.**

### 2. This host uses Docker userns-remap
`/etc/docker/daemon.json` sets `"userns-remap": "default"` and `/etc/subuid` maps
`dockremap:100000:65536`, so **container UID N = host UID 100000 + N**.

Correct host ownership for the bind mounts:

| Host path | Owner | Why |
|---|---|---|
| `logs/`, `uploads/`, `images/` | `100000:100000` | LibreChat image runs as container root (UID 0) |
| `data-node/` | `100999:100000` | MongoDB image runs as container UID 999 |

If you ever chown these, use the remapped values above — **not** your host UID. Chowning to a
plain host UID (e.g. `1008`) grants access to an identity the container never uses, and the
EACCES persists.

> **Never chown `data-node/` casually** — it holds the entire chat database.

### 3. `librechat.yaml` is schema-validated
A stray top-level `mongodb:` key (a compose block pasted into the wrong file) caused:
```
Invalid custom config file at /app/librechat.yaml:
Unrecognized key(s) in object: 'mongodb'
Exiting due to invalid configuration.
```
Only LibreChat's documented keys belong in `librechat.yaml`; container/port settings belong in
`docker-compose.override.yml`. Do **not** set `CONFIG_BYPASS_VALIDATION=true` to work around
this — the validator is catching a real mistake.

### Diagnosing a 502
`502 Bad Gateway` from nginx almost always means the `api` container is not up. In order:
```bash
docker ps -a | grep -i librechat        # "Restarting" = crash loop → read the logs
docker compose logs --tail 30 api       # the actual error
docker logs chat-mongodb --tail 20      # api cannot start if Mongo is down
ls -ldn logs uploads images data-node   # ownership per the table above
```
From nginx's perspective:
- `wget: bad address 'api:3080'` → the container is not on `librechat_default` (usually because
  it is crash-looping and never joined).
- `Connection refused` → it is on the network but not listening: either still starting (allow
  30–60s) or dying on startup.

### Restarting after config/env changes
For LibreChat-only config changes:
```bash
docker compose up -d --force-recreate api
```
For a full-stack restart, **do not name services individually** — services added later
(mask-proxy, stats-app, feedback-admin, ocr-service, searxng, …) would be left behind:
```bash
docker compose down && docker compose up -d
```
After any `down`, confirm with `docker ps` that everything you expect is actually back.

---

## Upstream / updates
`origin` = this fork (`UD-FSAII/...`), `upstream` = `danny-avila/LibreChat`. We're pinned at
v0.8.7 + our commits and do not auto-track. To pull a specific upstream security fix, cherry-pick
it from `upstream` rather than merging their whole `main`.

**Full reference:** the parent project's root `README.md` (sections cited throughout).