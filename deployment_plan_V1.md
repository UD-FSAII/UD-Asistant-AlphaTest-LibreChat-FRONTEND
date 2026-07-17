# UD Assistant — V1 Deployment Plan (Regular LibreChat)

**Scope:** Ship a production LibreChat instance for the university community, backed by
your existing vLLM/Qwen model, with working document RAG (File Search), load-balanced
across multiple identical vLLM devices via nginx, and the baseline security/access controls
a public-facing deployment needs. **Out of scope for V1:** the UD-Assistant agent
integration (decomposition/compute/sandbox) — that's V2.

Each phase ends in a verifiable state. Do them in order; don't move on until the
verify step passes.

---

## Phase 0 — Pre-flight: lock down what's already exposed

These are open issues from the build so far. Do them FIRST — they're fast and they're
currently live risks.

- [x] **Rotate all secrets that were ever shared/pasted.** Regenerate and replace in `.env`:
  - [x] `CREDS_KEY` = `openssl rand -hex 32`
  - [x] `CREDS_IV` = `openssl rand -hex 16`
  - [x] `JWT_SECRET` = `openssl rand -hex 32`
  - [x] `JWT_REFRESH_SECRET` = `openssl rand -hex 32`
  - [x] `MEILI_MASTER_KEY` = `openssl rand -hex 32` (then restart Meilisearch)
  - [x] After rotating, `docker compose down && docker compose up -d`. Note: rotating
        `CREDS_KEY/IV` invalidates any per-user stored credentials; fine if none rely on it.
- [x] **Close the MongoDB port.** In `docker-compose.override.yml`, change the mongodb
      mapping to localhost-only or remove it:
      `- "127.0.0.1:27017:27017"` (or delete the `ports:` block entirely).
- [x] **Confirm Meilisearch / pgvector / qdrant ports are not published** to `0.0.0.0`.
      Check `docker compose ps` — only the web entrypoint should be publicly bound.
- [x] **Decide registration policy** (Phase 4 finalizes it) — but at minimum confirm
      `ALLOW_REGISTRATION` is intentional, not accidentally open.

**Verify:** `docker compose ps` shows no database port on `0.0.0.0`; app still starts clean
(`docker compose logs --tail=40 api`, no errors).

---

## Phase 1 — Finish RAG / File Search (the core V1 capability)

File Search is the headline document-QA feature. From the build, embeddings are wired
(`rag_api` initialized `OpenAIEmbeddings` against your 8001 embed server), but the File
Search *option* wasn't appearing. Resolve that here.

### 1.1 Confirm the embedding path end-to-end
- [x] `.env` has:
  ```
  EMBEDDINGS_PROVIDER=openai
  RAG_OPENAI_BASEURL=http://172.22.0.1:8001/v1
  RAG_OPENAI_API_KEY=<vllm key>
  EMBEDDINGS_MODEL=BAAI/bge-base-en-v1.5
  RAG_USE_FULL_CONTEXT=true          # needed for retrieval to reach custom endpoints
  ```
- [x] `RAG_API_URL=http://rag_api:8000` is present in the api container
      (`docker compose exec api env | grep RAG_API_URL`).

### 1.2 Resolve the missing "File Search" upload option
The option is gated by agent capabilities. Symptom seen: "Upload as Text" present,
"File Search" absent.
- [ ] In `librechat.yaml`, ensure:
  ```yaml
  interface:
    fileSearch: true
  endpoints:
    agents:
      capabilities:
        - "file_search"
        - "context"
        - "ocr"
  ```
- [ ] Confirm USER role permission `FILE_SEARCH.USE: true`
      (`docker compose exec mongodb mongosh LibreChat --eval "db.roles.findOne({name:'USER'})"`).
- [ ] If still missing after restart + hard refresh: this is the suspected **dev-image
      regression**. Pin a stable release (Phase 6 covers image pinning) and re-test —
      stable `v0.8.6` is the known-good target.

### 1.3 Verify
- [ ] Stream rag_api logs: `docker compose logs -f rag_api`
- [ ] Upload a single PDF via "Upload for File Search".
- [ ] Confirm a `POST .../embeddings 200` to `172.22.0.1:8001` appears.
- [ ] Ask a question about the PDF; confirm the model answers FROM the document (if it
      ignores the doc, verify `RAG_USE_FULL_CONTEXT=true` took effect).

**Exit criteria:** A user can upload a PDF and get grounded answers with the model actually
using the document content.

---

## Phase 2 — vLLM tool-calling (decide if needed for V1)

File Search uses a retrieval tool; on some setups it needs the model to support tool-calling.
Your launcher did NOT include tool-calling flags.

- [ ] Decide: does V1 need native tool-calling? (File Search via `RAG_USE_FULL_CONTEXT`
      may work without it by stuffing context directly. Test Phase 1.3 first.)
- [ ] **If File Search works without it** → skip this phase for V1.
- [ ] **If it needs tool-calling** → relaunch vLLM with:
  ```
  --enable-auto-tool-choice --tool-call-parser hermes
  ```
  (use the parser matching Qwen3 — verify against vLLM docs for your version)
- [ ] Re-test File Search after relaunch.

**Exit criteria:** documented decision; File Search confirmed working either way.

---

## Phase 3 — Load balancing: nginx in front of vLLM

**Chosen design:** nginx reverse-proxies a single virtual endpoint to N identical vLLM
devices. LibreChat sees ONE `baseURL`; nginx fans out with health checks. Adding/removing a
device = one nginx line, zero LibreChat change.

**Why nginx and not LibreChat-side:** LibreChat custom endpoints take a single baseURL with
no health-aware rotation. nginx gives least-connection balancing, health checks, and
failover. Devices are identical, so no weighting needed.

### 3.1 nginx config (`nginx/vllm-lb.conf`)
- [ ] Use `least_conn` (LLM streams are long-lived; least-connections beats round-robin).
- [ ] Disable proxy buffering so SSE streams pass through.
- [ ] Set generous timeouts (long generations).
- [ ] Passive health checks via `max_fails` / `fail_timeout` (open-source nginx);
      active health checks need nginx Plus or a sidecar — passive is fine for V1.

```nginx
upstream vllm_pool {
    least_conn;
    server 192.168.1.11:8000 max_fails=3 fail_timeout=30s;
    server 192.168.1.12:8000 max_fails=3 fail_timeout=30s;
    server 192.168.1.13:8000 max_fails=3 fail_timeout=30s;
    keepalive 32;
}

server {
    listen 8000;

    location / {
        proxy_pass http://vllm_pool;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;

        # SSE / streaming: do NOT buffer
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;

        # pass the auth header through to vLLM
        proxy_set_header Authorization $http_authorization;
    }
}
```

### 3.2 Run nginx
Two options:
- [ ] **Option A (recommended): nginx as a container** in the LibreChat compose network so
      LibreChat reaches it by name. Add to override:
  ```yaml
  vllm-lb:
    image: nginx:stable
    container_name: vllm-lb
    restart: always
    volumes:
      - ./nginx/vllm-lb.conf:/etc/nginx/conf.d/default.conf:ro
  ```
- [ ] **Option B:** nginx on the host pointing at the device IPs; LibreChat reaches it via
      the gateway IP. Use only if you prefer host-level nginx.

### 3.3 Point LibreChat at the pool
- [ ] In `librechat.yaml`, change the vLLM endpoint baseURL:
  ```yaml
  baseURL: "http://vllm-lb:8000/v1"     # Option A (container, by service name)
  # or "http://172.22.0.1:8000/v1" if nginx is the host LB on 8000
  ```
- [ ] **Important:** the embedding (8001) and reranker (8002) services — decide whether
      those also need balancing. For V1, if one device handles embeddings/rerank fine, leave
      them pointed at a single device. If not, give them their own upstream pools (same
      pattern, separate `upstream` blocks + listen ports).

### 3.4 Verify
- [ ] From the api container:
  ```bash
  docker compose exec api node -e "fetch('http://vllm-lb:8000/v1/models',{headers:{Authorization:'Bearer <key>'}}).then(r=>r.text()).then(console.log).catch(e=>console.error('FAIL:',e.message))"
  ```
- [ ] Generate load (several concurrent chats) and confirm requests spread across devices
      (watch each device's vLLM logs — each should receive traffic).
- [ ] Kill one device; confirm nginx routes around it (passive health check) and chat
      continues on the survivors.

**Exit criteria:** LibreChat talks to one stable endpoint; load spreads across devices;
one device can die without taking chat down.

---

## Phase 4 — Access control & user management

- [ ] **Registration policy.** Decide:
  - [ ] Open registration restricted to university email domain
        (`ALLOW_REGISTRATION=true` + domain allowlist), OR
  - [ ] Closed registration (`ALLOW_REGISTRATION=false`), admin invites / creates users.
- [ ] If domain-restricting, set the allowed-domains config and test a non-domain email is
      rejected.
- [ ] **Confirm admin account** is the intended one (first registered = admin).
- [ ] **Rate limits** — review the violation/limit settings already in `.env`
      (`LIMIT_CONCURRENT_MESSAGES`, `MESSAGE_IP_MAX`, etc.). Tune for expected class sizes;
      the defaults are reasonable but a 200-student cohort may need adjustment.
- [ ] **Decide MCP/agents/other UI** final state (you've already hidden agents + MCP) —
      confirm the USER role matches the intended student-facing surface.

**Verify:** a test non-admin account sees only the intended features; registration behaves
per policy.

---

## Phase 5 — HTTPS & public access (reverse proxy)

LibreChat does not do TLS itself. For real users (and for microphone/clipboard browser
features, and secure cookies), you need HTTPS.

- [ ] Stand up a reverse proxy in front of LibreChat (Caddy is simplest — automatic certs;
      nginx if you prefer manual/existing certs).
- [ ] Point a real hostname (university subdomain) at the host.
- [ ] Proxy `:443` → LibreChat `:3080`, with SSE/websocket passthrough (buffering off,
      long timeouts — same streaming concerns as the vLLM LB).
- [ ] Set `DOMAIN_CLIENT` / `DOMAIN_SERVER` in `.env` to the `https://` hostname.
- [ ] Set secure-cookie behavior appropriately now that you're on HTTPS.
- [ ] Ensure only `:443` (and `:80` redirect) are publicly open; `:3080` stays internal.

**Verify:** site loads over `https://`, login works, cookies set, streaming chat works
through the proxy.

> **Caddy note:** a Caddyfile of ~5 lines (`yourhost { reverse_proxy localhost:3080 }`)
> handles certs automatically. Confirm SSE streams (LibreChat chat) pass through — Caddy
> handles this by default; nginx needs `proxy_buffering off`.

---

## Phase 6 — Stabilize the image (stop riding `dev:latest`)

You're on `librechat-dev:latest`, which tracks unreleased main and caused transient
breakage (the File Search regression). For a deployment, pin a stable release.

- [ ] Identify current stable tag (target: `v0.8.6` or newer stable, NOT rc/dev).
- [ ] Switch cleanly: ideally `git checkout v0.8.6` of the LibreChat repo so compose files,
      default config, AND image all match — rather than overriding one image line on top of
      dev compose (avoids dev/stable config drift).
- [ ] Bump `librechat.yaml` `version:` to the matching schema (e.g. `1.3.x`) to clear the
      "outdated config" warning.
- [ ] Re-run Phases 1–5 verifies on the pinned image (especially File Search — confirm the
      regression is absent on stable).

**Verify:** clean startup on a pinned version; File Search works; all prior config intact.

---

## Phase 7 — Backups & operational basics

- [ ] **Backups.** Schedule a recurring dump of MongoDB (users, chats) and pgvector
      (embeddings) to off-host storage. Test a restore once.
- [ ] **Volume safety.** Document that `docker compose down -v` and host bind-mount folders
      (`data-node`, etc.) hold real data — never wipe casually.
- [ ] **Disk encryption** (if the host policy/threat model warrants) — LUKS on the data
      volume. Decide based on data sensitivity (grade data may warrant it).
- [ ] **Monitoring.** At minimum: a health check on the LibreChat entrypoint and on each
      vLLM device; alert if a device drops out of the pool.
- [ ] **Log retention.** Confirm logs don't grow unbounded (`LOG_TO_FILE` rotation).

**Verify:** a backup exists and restores; you'd notice if a vLLM device died.

---

## Phase 8 — Pre-launch load test & dry run

- [ ] Simulate expected concurrency (e.g. 30–50 simultaneous chats) and confirm:
  - [ ] nginx spreads load across devices.
  - [ ] Latency/throughput acceptable under load (vLLM batching + multiple devices).
  - [ ] No single device saturates while others idle (confirms `least_conn` working).
- [ ] Test File Search under concurrency (multiple users uploading + querying).
- [ ] Test failover under load (drop a device mid-test).
- [ ] Walk the full student journey: register → log in → chat → upload doc → ask about it.

**Verify:** the system holds at expected load and degrades gracefully, not catastrophically.

---

## Quick reference: the V1 dependency map

```
                          ┌─────────────┐
   students ──https──▶    │ Caddy/nginx │  (Phase 5, TLS)
                          └──────┬──────┘
                                 ▼ :3080
                          ┌─────────────┐
                          │  LibreChat  │──┬── MongoDB (app data)
                          │   (api)     │  ├── Meilisearch (search)
                          └──────┬──────┘  └── rag_api ── pgvector (RAG)
                                 │                   └─embeds→ vLLM device (8001)
                                 ▼ one baseURL
                          ┌─────────────┐
                          │  vllm-lb    │  (Phase 3, nginx least_conn)
                          │  (nginx)    │
                          └──┬───┬───┬──┘
                             ▼   ▼   ▼
                          dev1 dev2 dev3   (identical Qwen3 on vLLM :8000)
```

---

## Sequencing & effort (deadline-oriented)

| Phase | What | Effort | Can ship without? |
|---|---|---|---|
| 0 | Lock down exposed secrets/ports | 1–2 hrs | **No — do first** |
| 1 | File Search working | 0.5–1 day | No (core feature) |
| 2 | vLLM tool-calling (if needed) | 0.5 day | Maybe (test first) |
| 3 | nginx vLLM load balancing | 0.5–1 day | No (you required it) |
| 4 | Access control | 0.5 day | No |
| 5 | HTTPS reverse proxy | 0.5 day | **No — public access** |
| 6 | Pin stable image | 0.5 day | Strongly recommended |
| 7 | Backups & ops | 0.5 day | Backups: no. Rest: soon-after OK |
| 8 | Load test & dry run | 0.5–1 day | No |

**Critical path for the deadline:** 0 → 1 → 3 → 5 are the non-negotiables (secure, core
feature, load balancing, public HTTPS). 2 is conditional. 6 should happen before launch to
avoid dev-build surprises. 7's backups and 8's load test are launch-blockers for a real
cohort even if they feel optional.

**Rough total:** ~4–6 focused days for a defensible V1, depending on how Phase 2 resolves
and how much load testing (Phase 8) you do.
```