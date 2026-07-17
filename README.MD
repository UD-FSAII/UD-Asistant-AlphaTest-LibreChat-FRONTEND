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

## Building from source (when you change React code)
The image is prebuilt by default. To ship a code change (e.g. a UI customization), switch the
override from `image:` to `build:` and build locally:
```bash
# in docker-compose.override.yml, replace the api service's
#   image: ghcr.io/danny-avila/librechat:v0.8.7
# with
#   build: .
docker compose build api        # uses this repo's Dockerfile (Node per .nvmrc, currently 24.16.0)
docker compose up -d --force-recreate api
```
Document any React/source change here under "What this fork changes vs upstream" so the diff
from stock v0.8.7 stays legible.

## Upstream / updates
`origin` = this fork (`UD-FSAII/...`), `upstream` = `danny-avila/LibreChat`. We're pinned at
v0.8.7 + our commits and do not auto-track. To pull a specific upstream security fix, cherry-pick
it from `upstream` rather than merging their whole `main`.

**Full reference:** the parent project's root `README.md` (sections cited throughout).