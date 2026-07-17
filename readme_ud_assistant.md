# UD Assistant — LibreChat Deployment (Quick Start)

A self-hosted, branded LibreChat instance backed by a local vLLM (Qwen3) model, with
document Q&A (RAG/File Search), SearXNG web search, and a simplified UI. This README is the
working reference for setup, the commands that actually work in this environment, and the
gotchas we hit (native-Linux Docker networking, secret hygiene, Meilisearch key rotation).

> **Environment assumptions** (this deployment): native Linux Docker (not Docker Desktop),
> vLLM running in its own container on the same host, the Docker bridge gateway is
> `172.22.0.1`. If your bridge gateway differs, find it with
> `docker network inspect librechat_default | grep Gateway` and substitute throughout.

---

## Contents

| # | Section | What's in it |
|---|---|---|
| 1 | [Architecture at a glance](#1-architecture-at-a-glance) | Repo layout, service map, the `172.22.0.1` gateway rule |
| 2 | [Start the backend models (vLLM)](#2-start-the-backend-models-vllm--backendmodels) | Launch LLM/embed/reranker from `BACKEND/Models` |
| 3 | [Full startup sequence](#3-full-startup-sequence-the-canonical-order) | **The canonical order** to bring everything up |
| 4 | [Quick status / log commands](#4-quick-status--log-commands) | ps + logs for api, rag_api, ocr-service |
| 5 | [`.env` essentials](#5-env-essentials) | Secrets, vLLM key, RAG, web search, branding vars |
| 6 | [`librechat.yaml`](#6-librechatyaml-current-working-config) | Current config: Qwen3-VL, image upload, web search, artifacts, tuned prompt, context/loop limits |
| 6A | [Model, prompt & hardening tuning](#6a-model-prompt--hardening-tuning-how-the-config-above-was-arrived-at) | Why each setting exists: vision, temp, search prompt, the 2 tester-found bugs & fixes |
| 7 | [`docker-compose.override.yml`](#7-docker-composeoverrideyml-mounts-networking-branding) | Mounts, pinned image, networking, branding mounts |
| 8 | [Branding (logos + tab title)](#8-branding-logos--tab-title) | Replace logo/favicon; fix the tab-title flash |
| 9 | [Useful operational commands](#9-useful-operational-commands) | Restart, reachability tests, Mongo inspection |
| 10 | [Model picker & hiding features](#10-controlling-the-model-picker--hiding-features) | `user_provided` endpoints, hide agents, disable MCP |
| 11 | [Registration & user accounts](#11-registration--user-accounts-closed-beta) | Closed beta: create/delete users by hand |
| 12 | [Document File Search & OCR](#12-document-file-search--ocr-scanned-pdfs) | Two upload modes; secured OCR service + forked rag_api for scanned PDFs |
| 13 | [Web search (SearXNG + Firecrawl)](#13-web-search-searxng--self-hosted-firecrawl) | Fully-local web search: SearXNG + self-hosted multi-arch Firecrawl |
| 13A | [LLM load balancing (nginx)](#13a-llm-load-balancing-nginx-across-multiple-vllm-devices) | nginx reverse proxy fanning `:8000` across multiple vLLM devices (2 Sparks) |
| 13B | [HTTPS reverse proxy (Cloudflare certs)](#13b-https-reverse-proxy-nginx--cloudflare-dns-01-certs) | Browser-trusted HTTPS via nginx + Let's Encrypt DNS-01; unblocks STT; account-creation runbook |
| 14 | [Meilisearch key rotation](#14-meilisearch-master-key-rotation-the-painful-one) | The 403 fix when rotating `MEILI_MASTER_KEY` |
| 14A | [Observability with Langfuse + masking](#14a-observability-with-langfuse-self-hosted--privacy-masking) | Self-hosted Langfuse, two-tier consent masking proxy, opt-in mgmt, metrics script |
| 14B | [Per-user stats app](#14b-per-user-stats-app-metricsalphatestudassistantcom) | Authenticated self-serve stats page on `metrics.alphatest.udassistant.com`; subdomain + cert setup |
| 14C | [Admin console — feedback + usage](#14c-admin-console--feedback--all-user-usage-feedbackalphatestudassistantcom) | Admin-only two-tab console (feedback triage + all-user usage) on `feedback.alphatest.udassistant.com` |
| 15 | [Network exposure & port lockdown](#15-network-exposure--port-lockdown-security) | What's exposed; closing Mongo/admin-panel/OCR |
| 16 | [Data & safety notes](#16-data--safety-notes) | Bind mounts vs volumes; what `down -v` wipes |
| 17 | [Wiping users & chats](#17-wiping-users--chats-full-or-partial-reset) | Full/partial reset commands |
| 18 | [Known gotchas (quick index)](#18-known-gotchas-quick-index) | Symptom → cause → fix table |
| 19 | [Still open / roadmap](#19-still-open--roadmap) | Remaining V1 work + V2 agent integration |

---

## 1. Architecture at a glance

**Repo layout** (three folders in the project — commands below are labelled with which one
to run them from):
```
project/
├── FRONTEND/LibreChat     # the LibreChat stack (docker compose): api, mongodb,
│                          #   meilisearch, rag_api, vectordb + librechat.yaml, override
├── BACKEND/Models         # the vLLM launcher (launch_vllm.py) — LLM/embed/reranker
│                          #   + the OCR service (ocr_wrapper/)
└── BACKEND/rag_api        # the FORKED rag_api (OCR fallback patch) — built into an image
```

```
browser ──▶ LibreChat (api, :3080)                       [FRONTEND/LibreChat]
                ├── MongoDB        (chat-mongodb)   app data: users, chats, roles
                ├── Meilisearch    (chat-meilisearch) conversation search index
                └── rag_api        ── pgvector (vectordb)   document RAG / File Search
                        │                                   [image built from BACKEND/rag_api]
                        ├─ embeddings: huggingface (in-process, sentence-transformers)
                        └─ OCR fallback ─▶ OCR service (host :8003)  [BACKEND/Models/ocr_wrapper]
            chat ──▶ vLLM LLM server (host :8000)   Qwen3-30B        [BACKEND/Models]
            (embed :8001 / reranker :8002 also launched there)
            search ─▶ SearXNG (host :8888)  +  Firecrawl scraper (when running)
```

Key point: services in containers cannot reach the host via `localhost` —
use the bridge gateway IP `172.22.0.1` instead.

> **Which repo runs what:**
> - `docker compose ...` (LibreChat stack) → **FRONTEND/LibreChat**
> - vLLM launch + OCR service build/run → **BACKEND/Models**
> - building the forked rag_api image → **BACKEND/rag_api**

---

## 2. Start the backend models (vLLM) — `BACKEND/Models`

The LLM/embedding/reranker run as vLLM containers, launched by `launch_vllm.py` (uses the
Docker SDK). It launches them in sequence and health-gates each before starting the next.

```bash
cd BACKEND/Models
# one-time: pip install docker requests python-dotenv   (in your venv)
python src/launch_vllm.py
```

This starts:
- **LLM** `Qwen/Qwen3-VL-30B-A3B-Instruct-FP8` on **:8000** — a **vision-language (VL)**
  model (understands images, not just text). Launched with:
  - `--enable-auto-tool-choice --tool-call-parser hermes` (REQUIRED for File/Web Search tool calls)
  - `--max-model-len 200000` (200k context window — see tuning notes in section 6A)
  - `--gpu-memory-utilization 0.65` (~74 GB used on the Spark; plenty of headroom)
  - `--limit-mm-per-prompt '{"image": 1, "video": 1}'` and `--max-num-seqs 20` (multimodal limits)
  - `--trust-remote-code`
- **Embedding** `BAAI/bge-base-en-v1.5` on **:8001**.
- **Reranker** `BAAI/bge-reranker-base` on **:8002**.

> **Model history:** started on `Qwen3-30B-A3B-Instruct-2507-FP8` (text-only), briefly tried
> `Qwen3.6-35B-A3B-FP8` (text-only, thinking model — leaked `<think>` tags into output because
> vLLM needs `--reasoning-parser qwen3` for thinking models; see section 6A), then settled on
> **`Qwen3-VL-30B-A3B-Instruct-FP8`** because the beta needs IMAGE understanding. VL + instruct
> (not the Thinking VL variant) avoids the reasoning-parser complexity while adding vision.

The script blocks and cleans up the containers on Ctrl-C. Check readiness:
```bash
curl http://localhost:8000/v1/models -H "Authorization: Bearer $VLLM_API_KEY"
# confirm the 200k window actually loaded (vLLM silently caps if KV cache won't fit):
docker logs vllm-qwen 2>&1 | grep -i "max model len\|maximum concurrency"
# want: "Using max model len 200000" + a concurrency figure (~2.26x at full context)
```

> **Notes:**
> - Requires `HF_TOKEN` and `VLLM_API_KEY` in `BACKEND/Models/.env`. **Keep that file's
>   secrets out of git and rotate any that leak** (HF token, provider API keys).
> - **Embeddings:** we later switched rag_api to run embeddings in-process via HuggingFace
>   (`EMBEDDINGS_PROVIDER=huggingface`) to free ~7-10% VRAM. If you rely on that, the `:8001`
>   embed container isn't strictly needed by rag_api — but the launcher still starts it.
> - **Concurrency tradeoff:** at the full 200k window, vLLM reports ~2.26x concurrency — i.e.
>   ~2 simultaneous near-max-length conversations per GPU before queueing. Short chats get far
>   more. The nginx LB across both Sparks (section 13A) doubles this. If requests queue under
>   load, raise `--gpu-memory-utilization` (VRAM headroom exists) or lower `--max-model-len`.
> - For **multiple GPUs / load balancing**, run identical LLM containers and put nginx in
>   front (section 13A — DONE, across 2 Sparks).

---

## 3. Full startup sequence (the canonical order)

Bring everything up in THIS order. Order matters only because the OCR container must join the
LibreChat Docker network, which the LibreChat stack creates.

**1. Backend models (vLLM)** — from `BACKEND/Models`:
```bash
cd BACKEND/Models
python src/launch_vllm.py            # LLM :8000, embed :8001, reranker :8002
# wait until it prints all services healthy; leave it running
```

**2. LibreChat stack** — from `FRONTEND/LibreChat` (creates the `librechat_default` network):
```bash
cd FRONTEND/LibreChat
docker compose up -d api mongodb meilisearch rag_api vectordb
```
> Explicit service list omits the admin-panel (sensitive, not used in V1 — section 15).
> A bare `docker compose up -d` would start it.

**3. OCR service** — from `BACKEND/Models`, attached to the network, NO host port (section 12.3):
```bash
cd BACKEND/Models
docker run -d --restart unless-stopped \
  --network librechat_default \
  --name ocr-service \
  -e OCR_SELF_BASE_URL=http://ocr-service:8003 \
  local-ocr-service
```
(Build first only if the OCR code changed: `docker build --no-cache -t local-ocr-service ./ocr_wrapper`)

**4. Web search services** — from `BACKEND/WebSearch`, attached to the network, no host ports (section 13):
```bash
# SearXNG
cd BACKEND/WebSearch
docker run -d --restart unless-stopped --network librechat_default \
  --name searxng -v "$(pwd)/searxng:/etc/searxng" searxng/searxng:latest
# Firecrawl (multi-container)
cd BACKEND/WebSearch/firecrawl
docker compose up -d
```

**5. LLM load balancer (nginx)** — only if balancing across multiple vLLM devices (section 13A).
Attached to the network, no host port:
```bash
cd FRONTEND/LibreChat/vllm-lb
docker compose -f vllm-lb.compose.yml up -d
```
> Skip this if running a single vLLM device (LibreChat then points `baseURL` directly at
> `172.22.0.1:8000/v1`). With the LB, `baseURL` is `http://vllm-lb:8000/v1` (section 13A.5).

**6. HTTPS reverse proxy** — the public front door (section 13B). Publishes :443, terminates
TLS, proxies to LibreChat. Required before real users; also unblocks browser STT:
```bash
cd FRONTEND/LibreChat/https-proxy
docker compose -f https-proxy.compose.yml up -d
```

**7. Verify:**
```bash
docker network ls | grep librechat                              # confirm network name
sudo ss -tlnp | grep -E '8003|8080|3002'                        # NOT exposed -> nothing
docker exec rag_api curl -s http://ocr-service:8003/health      # {"status":"ok"}
docker exec rag_api curl -s -o /dev/null -w "%{http_code}\n" http://firecrawl-api:3002/   # a number
docker compose logs api 2>&1 | grep -i "connected to mongo"     # Connected to MongoDB
```
Then open **http://localhost:3080** — first account registered becomes ADMIN.

**Shutdown:**
```bash
cd FRONTEND/LibreChat && docker compose down
docker stop ocr-service searxng                  # (Ctrl-C the vLLM launcher)
cd BACKEND/WebSearch/firecrawl && docker compose down
```

> First-time-only prerequisites: `cp .env.example .env` and create `librechat.yaml` (sections
> 5–7), build the forked rag_api image (section 12.4), build the OCR image (section 12.3), and
> set up SearXNG + Firecrawl (section 13).

---

## 4. Quick status / log commands

From **FRONTEND/LibreChat**:
```bash
docker compose ps                          # what's running + ports
docker compose logs --tail=40 api          # LibreChat app logs
docker compose logs -f rag_api             # RAG / embedding / OCR-fallback logs
docker logs -f ocr-service                 # OCR service logs (separate container)
```

---

## 5. `.env` essentials

Generate fresh secrets (NEVER ship the .env.example defaults):
```bash
openssl rand -hex 16   # CREDS_IV
openssl rand -hex 32   # CREDS_KEY, JWT_SECRET, JWT_REFRESH_SECRET, MEILI_MASTER_KEY
```

```dotenv
# --- secrets (use your generated values) ---
CREDS_KEY=<64 hex>
CREDS_IV=<32 hex>
JWT_SECRET=<64 hex>
JWT_REFRESH_SECRET=<64 hex>
MEILI_MASTER_KEY=<64 hex>

# --- vLLM key (your model's API key) ---
VLLM_API_KEY=<your-vllm-key>

# --- RAG / embeddings (document File Search) ---
EMBEDDINGS_PROVIDER=openai
RAG_OPENAI_BASEURL=http://172.22.0.1:8001/v1
RAG_OPENAI_API_KEY=<your-vllm-key>
EMBEDDINGS_MODEL=BAAI/bge-base-en-v1.5
RAG_USE_FULL_CONTEXT=true
# RAG_API_URL=http://rag_api:8000   # normally injected by compose; uncomment if missing

# --- web search (SearXNG + local scraper) ---
SEARXNG_INSTANCE_URL=http://172.22.0.1:8888
FIRECRAWL_API_URL=http://172.22.0.1:3002
FIRECRAWL_API_KEY=placeholder-any-value

# --- UI branding ---
APP_TITLE=UD Assistant
CUSTOM_FOOTER="UD Assistant — built on [LibreChat](https://librechat.ai)"
```

> **CRITICAL .env gotcha:** do NOT put inline `#` comments after a value.
> `KEY=abc # old value` makes the value literally `abc # old value`.
> Put notes on their own line above the variable. This bit us hard with
> `MEILI_MASTER_KEY` (caused persistent 403s).

---

## 6. `librechat.yaml` (current working config)

> This reflects the CURRENT live config: Qwen3-VL model, image upload, web search, artifacts,
> the tuned system prompt, context-limit handling, and the tool-loop guardrail. Deeper
> explanation of the tuning decisions is in **section 6A**. Validates on `version: 1.3.13`.

```yaml
version: 1.3.13
cache: true

ocr:
  strategy: "mistral_ocr"
  apiKey: "placeholder"                    # any value; our Tesseract OCR ignores it
  baseURL: "http://ocr-service:8003/v1"

fileConfig:
  endpoints:
    vLLM:                                  # MUST match the custom endpoint name exactly
      fileLimit: 5                         # max files per message
      fileSizeLimit: 20                    # MB per file
      totalSizeLimit: 50                   # MB per message (all files)
      supportedMimeTypes:
        - "image/.*"                       # images -> vision model ("Upload to Provider")
  ocr:
    supportedMimeTypes:
      - "^application/pdf$"
      - "^image/(jpeg|gif|png|webp|heic|heif)$"
  serverFileSizeLimit: 100                 # global server-wide cap (MB)

interface:
  agents: false
  fileSearch: true
  webSearch: true
  modelSelect: true                        # keep model selector (needed with modelSpecs)
  parameters: true                         # keep the parameters/settings panel
  presets: true
  # Tells users how to attach an image (the "Upload to Provider" label can't be renamed
  # without a source rebuild — it's compiled into the JS bundle; see section 6A).
  customWelcome: "Welcome to UD Assistant! To analyze an image, click the attachment icon and choose 'Upload to Provider'. To ask about a document, use 'Upload for File Search'."

endpoints:
  agents:
    disableBuilder: true
    recursionLimit: 8                      # HARD cap on agent steps — kills tool-call loops
    maxRecursionLimit: 12                  # ceiling for any UI-configured recursionLimit
    capabilities:
      - "file_search"
      - "context"
      - "ocr"
      - "web_search"
      - "artifacts"

  custom:
    - name: "vLLM"
      apiKey: "${VLLM_API_KEY}"
      baseURL: "http://vllm-lb:8000/v1"    # the nginx LB (section 13A). Direct: 172.22.0.1:8000
      models:
        default: ["Qwen/Qwen3-VL-30B-A3B-Instruct-FP8"]
        fetch: true
      titleConvo: true
      titleModel: "Qwen/Qwen3-VL-30B-A3B-Instruct-FP8"
      modelDisplayLabel: "Qwen3-30B"
      maxContextTokens: 180000             # under vLLM's 200k; truncates old msgs instead of bricking
      addParams:
        temperature: 0.1                   # low temp = obedient tool use, less confabulation
        max_tokens: 4096                   # response cap

modelSpecs:
  enforce: false                           # prompt/params are DEFAULTS; users can still tweak
  prioritize: true                         # this spec is the default on new chats
  list:
    - name: "ud-assistant"
      label: "UD Assistant"
      default: true
      description: "University of Delaware assistant"
      webSearch: true                      # search badge ON by default (still toggleable)
      fileSearch: true                     # file search ON by default
      artifacts: true                      # artifacts (React/HTML/Mermaid) enabled
      preset:
        endpoint: "vLLM"
        model: "Qwen/Qwen3-VL-30B-A3B-Instruct-FP8"
        temperature: 0.1
        promptPrefix: |
          Your job is to give the user a correct, complete answer.

          The single most important rule: for FACTUAL questions about the real world, you must NEVER answer from memory — you must search first. This overrides everything else. Guessing a name, title, date, or fact without searching is a serious error.

          FACTUAL (specific people, "who is/are", job titles, leadership, office-holders, current events, dates, prices, statistics, or anything that may have changed since your training): you MUST call web_search first, every time. Then answer ONLY from the results. If the search does not clearly answer it, say you could not confirm it — do NOT guess.

          GROUNDED-GENERATIVE (diagrams, summaries, or explanations about a real, specific institution, program, or process): do ONE search to ground it, then produce the output.

          PURELY CREATIVE (generic writing, code, math, concept explanations, poems): answer directly, NO search.

          UPLOADED DOCUMENTS: answer from the document, not the web.

          Anti-loop rules (about search COUNT, never an excuse to skip a required factual search):
          - Never run the SAME search twice, and never exceed TWO searches total per question.
          - After your searches, STOP and write the answer, even if incomplete. Never loop.

          You cannot perfectly reproduce logos, trademarks, or exact visual designs of real organizations. If asked to recreate a specific logo and told it is wrong, do NOT keep searching — acknowledge you cannot reliably reproduce it and offer an original design instead.

          When producing Mermaid diagrams: begin with "flowchart TD", keep node labels short and plain, avoid parentheses/colons/quotes in node text, and ensure valid syntax.

webSearch:
  searchProvider: "searxng"
  searxngInstanceUrl: "${SEARXNG_INSTANCE_URL}"
  scraperProvider: "firecrawl"
  firecrawlApiKey: "${FIRECRAWL_API_KEY}"
  firecrawlApiUrl: "${FIRECRAWL_API_URL}"
  rerankerType: "none"

# Browser-based speech (Web Speech API): no API keys, no server cost. STT (mic) requires
# HTTPS for remote users (works over the section 13B proxy); TTS works over http too.
speech:
  speechTab:
    conversationMode: true
    speechToText:
      engineSTT: "browser"
      languageSTT: "English (US)"
    textToSpeech:
      engineTTS: "browser"
      languageTTS: "en"
      cacheTTS: true
```

> **YAML gotcha:** `interface` sub-keys must match their expected type. Setting
> `mcpServers: false` under `interface` CRASHES startup (it expects an object, not a
> boolean). To hide MCP, use role permissions instead (see section 10).

---

## 6A. Model, prompt & hardening tuning (how the config above was arrived at)

This section explains the *why* behind the non-obvious settings in section 6 — all
hard-won through testing (much of it from a friend's excellent bug report). If you change the
model or touch these, read this first.

### 6A.1 Vision model + image upload
- The model is **VL (vision-language)** so users can upload images and have the model *see*
  them. Requires the multimodal vLLM flags (section 2) AND the `fileConfig.endpoints.vLLM`
  block with `image/.*` (section 6), which surfaces the **"Upload to Provider"** option that
  routes images to the model as vision input.
- **Three upload paths, keep them straight:** "Upload to Provider" → image to the vision model;
  "Upload for File Search" → document to RAG; "Upload as Text" → OCR text into the prompt.
  Images should use Provider; documents should use File Search.
- **Paste also works:** Ctrl+V an image straight into the chat — same vision path, zero config.
- **The "Upload to Provider" label can't be renamed** via config — LibreChat compiles UI
  strings into the JS bundle (there's no runtime `translation.json` in `dist/`; only source
  files that were build inputs). Renaming requires a source rebuild (not worth it for a beta).
  Workaround: the `customWelcome` line tells users what the button does.

### 6A.2 Temperature 0.1
Low temperature makes a 30B model far more obedient to the system prompt (reliably triggers
search when told to) and much less prone to confabulation (inventing names, fake citations).
Set both in `addParams` (endpoint default) and the modelSpec preset.

### 6A.3 The system prompt (search discipline)
Getting search to fire on facts but NOT on creative tasks took several iterations:
- Too weak ("search first") → model answered UD-president question from memory, hallucinated.
- Too absolute ("ALWAYS search ANY question") → model searched for a Mermaid flowchart and
  spiralled into 25+ searches until the context overflowed and the chat bricked.
- The working version uses **three explicit categories** (FACTUAL / GROUNDED-GENERATIVE /
  PURELY CREATIVE) with FACTUAL as a hard override, plus anti-loop limits. It's a *nudge*, not
  a guarantee — a 30B model judges the categories approximately. The `recursionLimit` is the
  hard backstop.
- Note: `{{current_date}}` does NOT reliably interpolate inside `promptPrefix` (it's a Prompt
  Library feature). Don't rely on it; the search-grounding handles currency anyway.

### 6A.4 Two bugs the beta tester found, and their fixes

**Bug 1 — Context overflow bricked the whole conversation.** Once a chat exceeded the model's
window, EVERY subsequent message (even "hi") errored, because the full history is re-sent each
turn and always overflowed. Root cause: no `maxContextTokens` set, so LibreChat didn't truncate
before hitting vLLM's hard limit.
- **Fix:** `maxContextTokens: 180000` (under the 200k `--max-model-len`). LibreChat now drops
  oldest messages to fit instead of erroring — the chat degrades (forgets early turns) but never
  bricks. The bigger 200k window also makes hitting the wall rare in the first place.
- **No summarization:** LibreChat truncates (drop-oldest); automatic recursive summarization is
  an unmerged upstream feature. At a 200k window it's unnecessary. For long documents, steer
  users to **File Search** (retrieval keeps active context small) rather than pasting.

**Bug 2 — Tool-call loop.** Asked to reproduce a specific logo in SVG, the model confabulated,
and when told it was wrong it spiralled into 13-25+ web searches trying to "fix" it, eventually
overflowing context and triggering Bug 1.
- **Fix (hard cap):** `recursionLimit: 8` + `maxRecursionLimit: 12` under `endpoints.agents` —
  the agent physically cannot exceed ~8 steps, so a loop dies fast instead of running to
  LangGraph's default of 50.
- **Fix (prompt):** the "you cannot reproduce logos… don't keep searching, offer an original
  instead" line, plus the "STOP and answer, never loop" anti-loop rules.

**Regression tests to hand a tester after any prompt/model change:**
- Long paste (2000+ chars) then a short "hi" → the "hi" must succeed (no brick).
- "Who is the president of UD?" → searches once, returns the answer with a citation.
- "Make a Mermaid flowchart of a generic process" → answers instantly, no search, renders.
- "Draw the UD logo in SVG" then "that's wrong" → admits it can't, does NOT loop-search.

### 6A.5 Reasoning models (if you ever switch)
If you move to a **Thinking** model (e.g. a `-Thinking` Qwen variant), add
`--reasoning-parser qwen3` to the vLLM launch, or the `<think>...</think>` reasoning leaks into
the visible answer. Instruct (non-thinking) models like the current VL-Instruct don't need it.
Beware a known vLLM streaming bug where reasoning+streaming misroutes tokens — test streaming
after switching.

---

## 7. `docker-compose.override.yml` (mounts, networking, branding)

```yaml
services:
  api:
    volumes:
      - ./librechat.yaml:/app/librechat.yaml
      - ./client/public/assets:/app/client/public/assets
      # per-FILE logo/favicon overrides (never mount the whole dir over dist/assets —
      # it hides the JS bundle and white-screens the app). logo.svg = the login + header logo:
      - ./client/public/assets/logo.svg:/app/client/dist/assets/logo.svg
      - ./client/public/assets/favicon-16x16.png:/app/client/dist/assets/favicon-16x16.png
      - ./client/public/assets/favicon-32x32.png:/app/client/dist/assets/favicon-32x32.png
      - ./client/public/assets/apple-touch-icon-180x180.png:/app/client/dist/assets/apple-touch-icon-180x180.png
      - ./client/public/assets/icon-192x192.png:/app/client/dist/assets/icon-192x192.png
      # custom tab title — extract from the RUNNING container first, and RE-EXTRACT after any
      # image change (its hashed script refs must match the image — see section 8):
      - ./index.html:/app/client/dist/index.html
    extra_hosts:
      - "host.docker.internal:host-gateway"
    image: ghcr.io/danny-avila/librechat:v0.8.7   # pinned stable (off dev:latest)

  # forked rag_api with OCR fallback for scanned PDFs (built in section 12.4).
  # Omit this whole block to use the stock rag_api (digital PDFs only).
  rag_api:
    image: rag-api-ocr:local
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - OCR_FALLBACK_ENABLED=true
      - OCR_FALLBACK_URL=http://ocr-service:8003/v1/ocr
      - OCR_FALLBACK_MIN_CHARS=500
      - OCR_FALLBACK_TIMEOUT=120

  mongodb:
    ports:
      - "127.0.0.1:27017:27017"   # localhost only (or remove the block entirely — see §14)
```

> The OCR service itself is NOT in this compose file — it's launched separately from
> `BACKEND/Models` and attached to this stack's network (section 12.3). Only `rag_api`'s
> env here points at it (`ocr-service:8003`).

> **Security note:** the LibreChat example override ships Mongo as `27017:27017`
> (bound to `0.0.0.0`, i.e. exposed to your whole network with NO auth). Change it to
> `127.0.0.1:27017:27017` as above, or remove the ports block entirely. Same caution for
> Meilisearch (7700) — don't publish DB ports publicly.

> **Image-pin note:** pinning `v0.8.7` (stable) avoids the `dev:latest` regressions
> (e.g. the disappearing File Search option). Re-extract `index.html` whenever you change
> this tag — that file is version-specific and white-screens on mismatch.

> **Mount gotcha:** the host file/dir MUST exist before Docker mounts it. If it doesn't,
> Docker creates an empty DIRECTORY in its place and breaks things (this caused a
> white screen + "permission denied" on index.html). Always create/extract the file first.

---

## 8. Branding (logos + tab title)

Logos/favicons: replace files in `client/public/assets/`, mount per-file into
`dist/assets` (section 7). Then hard-refresh (Ctrl-Shift-R) or use incognito — the browser
caches logos/favicons aggressively.

Tab title flashes "LibreChat" then "UD Assistant": the static `index.html` has the old
title hardcoded; `APP_TITLE` updates it after React loads. To fix the first frame, override
`index.html` — but extract the COMPILED one (correct hashed script tags), not the source:
```bash
docker compose cp api:/app/client/dist/index.html ./index.html
# edit <title>LibreChat</title> -> <title>UD Assistant</title>, leave script tags alone
# then add the index.html mount (section 7) and restart
```

---

## 9. Useful operational commands

Restart after config/env changes:
```bash
docker compose down && docker compose up -d api mongodb meilisearch rag_api vectordb
```

Verify the container can reach vLLM (auth with your key):
```bash
docker compose exec api node -e "fetch('http://172.22.0.1:8000/v1/models',{headers:{Authorization:'Bearer YOUR_KEY'}}).then(r=>r.text()).then(console.log).catch(e=>console.error('FAIL:',e.message))"
```

Inspect MongoDB:
```bash
docker compose exec mongodb mongosh LibreChat --eval "show collections"
docker compose exec mongodb mongosh LibreChat --eval "db.users.countDocuments()"
```

Hide a feature via role permission (example: hide MCP button for USER role):
```bash
docker compose exec mongodb mongosh LibreChat --eval 'db.roles.updateOne({name:"USER"},{$set:{"permissions.MCP_SERVERS.USE":false}})'
docker compose restart api
```
> Permission keys are nested OBJECTS — always set `permissions.<FEATURE>.USE`,
> never `permissions.<FEATURE>` as a bare boolean (that corrupts the role).

Check a setting actually reached the container:
```bash
docker compose exec api env | grep <VAR>
docker compose exec api cat /app/librechat.yaml | head -40
```

---

## 10. Controlling the model picker & hiding features

The model selector and several UI buttons are driven by THREE different sources. Know which
controls what, and avoid mixing them for the same feature (pick one source of truth):

- **`.env` keys** → which built-in provider endpoints appear (OpenAI, Anthropic, …)
- **`librechat.yaml` `interface:`** → re-seeds USER permissions at startup (e.g. agents)
- **Mongo role permissions** → runtime per-role toggles (MCP, agents, etc.)

> A DB wipe resets all role permissions to defaults, so agents/MCP/etc. reappear after a
> reset. Re-apply the steps below, OR rely on the `librechat.yaml` `interface:` block which
> re-seeds on every startup (more reproducible).

### 8a. Remove unwanted provider endpoints (the `user_provided` trick)

Endpoints like OpenAI/Anthropic/Google show up in the picker because `.env` sets their key
to the literal value `user_provided` — which tells LibreChat to show the endpoint and let
each user paste their OWN key. To REMOVE an endpoint from the picker, blank its key:

```dotenv
# show the endpoint, users bring their own key:
OPENAI_API_KEY=user_provided
# OR hide it entirely — blank it:
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_KEY=
ASSISTANTS_API_KEY=
```
Then `docker compose down && docker compose up -d api mongodb meilisearch rag_api vectordb`. Your vLLM custom endpoint is unaffected
(its key comes from `librechat.yaml`, not these).

> `user_provided` = bring-your-own-key (endpoint visible, no central cost to you).
> Blank = endpoint hidden. Real key = you provide it centrally for all users.

### 8b. Hide the Agents endpoint from the picker

Set it in `librechat.yaml` (preferred — reproducible, re-seeds on startup):
```yaml
interface:
  agents: false
```
> **Tradeoff:** chat runs through the agent framework under the hood, so fully disabling
> agents can suppress the "Upload for File Search" option. If you need document Q&A
> (File Search), keep the agent capabilities (see section 6 yaml) and instead hide agents at
> the ROLE level so the framework still works but the picker entry is gone:
```bash
docker compose exec mongodb mongosh LibreChat --eval 'db.roles.updateOne({name:"USER"},{$set:{"permissions.AGENTS.USE":false}})'
docker compose exec mongodb mongosh LibreChat --eval 'db.roles.updateOne({name:"ADMIN"},{$set:{"permissions.AGENTS.USE":false}})'
docker compose restart api
```

### 8c. Disable the MCP button (via Mongo commands)

`interface.mcpServers` does NOT accept a boolean (it's the server-definitions object — a
bool there CRASHES startup). Hide MCP via role permissions instead. Set BOTH roles (you view
as ADMIN, and admins see everything unless their role is also restricted):
```bash
docker compose exec mongodb mongosh LibreChat --eval 'db.roles.updateOne({name:"USER"},{$set:{"permissions.MCP_SERVERS.USE":false}})'
docker compose exec mongodb mongosh LibreChat --eval 'db.roles.updateOne({name:"ADMIN"},{$set:{"permissions.MCP_SERVERS.USE":false}})'
docker compose restart api
```
Verify, then hard-refresh the browser:
```bash
docker compose exec mongodb mongosh LibreChat --eval "db.roles.findOne({name:'USER'})"
# confirm: MCP_SERVERS.USE: false
```

> **Permission rule (applies to ALL role edits):** keys are nested OBJECTS — always
> `permissions.<FEATURE>.USE`, never `permissions.<FEATURE>` as a bare boolean. A bare
> boolean replaces the whole object and corrupts the role (this broke RUN_CODE once).

---

## 11. Registration & user accounts (closed beta)

V1 uses **closed registration**: no public signup. You (the admin) create every account by
hand from emails users send you. No email/SMTP infrastructure needed at this scale —
accounts are usable immediately, no verification round-trip.

### 9a. `.env` settings
```dotenv
ALLOW_REGISTRATION=false            # no public self-signup
ALLOW_SOCIAL_REGISTRATION=false
ALLOW_EMAIL_LOGIN=true              # email/password login on
ALLOW_UNVERIFIED_EMAIL_LOGIN=true   # skip email verification (no SMTP needed)
```
Apply:
```bash
docker compose down && docker compose up -d api mongodb meilisearch rag_api vectordb
```

### 9b. Create the admin account FIRST
The first account created becomes ADMIN. Do this before handing out any other accounts:
```bash
docker compose exec api npm run create-user
```
Prompts: email, password, name, "Email verified?" → answer **Y** (so it can log in right
away). Make this one yours.

### 9c. Create a beta user (repeat per tester)
```bash
docker compose exec api npm run create-user
```
Same prompts, answer **Y** to email-verified each time. Use the INTERACTIVE prompts (no
password as a CLI argument — that leaks into shell history).

### 9d. Remove a user
```bash
docker compose exec api npm run delete-user someone@example.com
```

> **Beta-scale caveats:**
> - You distribute the initial password to each user yourself (no self-service reset without
>   email configured). If someone forgets it, delete + recreate, or add SMTP later.
> - Hand-provisioning doesn't scale past a small beta. For a wider rollout, revisit either
>   email + self-service password reset, or domain-restricted OPEN registration
>   (`registration.allowedDomains` in `librechat.yaml` + `ALLOW_REGISTRATION=true`).

---

## 12. Document File Search & OCR (scanned PDFs)

This is the core V1 feature: upload a document and ask questions about it. Two upload modes,
and two document types, need to work — here's how they map and what we built to make scanned
docs work everywhere.

### 12.1 The two upload modes
- **Upload as Text** — extracts the document's text and injects it into the prompt. Good for
  one-off questions on a single doc. Routes through the OCR strategy for scanned files.
- **Upload for File Search (RAG)** — embeds the document into pgvector and retrieves relevant
  chunks at query time. Good for larger/many docs. Enable it via the **Tools dropdown**
  (next to the paperclip) FIRST, then the "Upload for File Search" option appears in the clip.

### 12.2 The problem we solved
- **Digital PDFs** (real text layer) → both modes work out of the box.
- **Scanned/image PDFs** → LibreChat's built-in extractors get no text. "Upload as Text"
  could use OCR, but **File Search sends files straight to `rag_api`, which does its own
  extraction and never calls the OCR strategy** — so scanned PDFs embedded as EMPTY content
  and the model replied "no visible content."

We fixed this in two pieces: (A) a local OCR service that mimics the Mistral OCR API, and
(B) a small fork of `rag_api` that calls that OCR service when a PDF extracts as near-empty.

### 12.3 Piece A — the local OCR service (Tesseract as "Mistral")

LibreChat only speaks to specific commercial OCR providers. To keep data on-prem, we run a
local Tesseract service that **mimics the Mistral OCR API**, and point LibreChat's
`mistral_ocr` strategy at it via a `baseURL` override — LibreChat thinks it's Mistral.

The service (`ocr_wrapper/ocr_app.py` + `Dockerfile`) implements Mistral's full upload-first
flow (this matters — LibreChat uses all of it):
- `POST /v1/files` — receives the upload, returns a file `id`
- `GET  /v1/files/{id}/url` — returns a signed URL pointing back at itself
- `GET  /v1/files/{id}/content` — serves the raw bytes
- `POST /v1/ocr` — accepts a data-URL / signed-URL / remote URL, OCRs (images directly,
  PDFs page-by-page via poppler+pdf2image), returns `{"pages":[{"index":0,"markdown":...}]}`

**Build & run** (from **BACKEND/Models**, where `ocr_wrapper/` lives). The service runs
**on the LibreChat Docker network with NO published host port** — so it's reachable by the
`api`/`rag_api` containers by name (`ocr-service`) but NOT exposed to your network:
```bash
cd BACKEND/Models
docker build --no-cache -t local-ocr-service ./ocr_wrapper   # only when code changes
docker run -d --restart unless-stopped \
  --network librechat_default \
  --name ocr-service \
  -e OCR_SELF_BASE_URL=http://ocr-service:8003 \
  local-ocr-service
```

> **Security:** NO `-p` flag. Publishing `-p 8003:8003` binds to `0.0.0.0` (whole network,
> no auth) — the OCR endpoints would be hittable by anyone. Attaching to the Docker network
> instead means only your own containers can reach it. The LibreChat stack must be up first
> (it creates `librechat_default`). Confirm the network name with
> `docker network ls | grep librechat` — if your folder isn't named `librechat`, use
> `<foldername>_default`.

**`librechat.yaml` OCR block** (the interception — note the service-name URL):
```yaml
ocr:
  strategy: "mistral_ocr"
  apiKey: "placeholder"                    # any value; Tesseract ignores it
  baseURL: "http://ocr-service:8003/v1"    # the OCR container by name, NOT Mistral
```

**Verify it's secured + reachable:**
```bash
sudo ss -tlnp | grep 8003                              # should return NOTHING (not exposed)
docker exec rag_api curl -s http://ocr-service:8003/health   # {"status":"ok"} (reachable internally)
```

**Test OCR directly** (JSON+base64, not `-F file=`; use --data @file to dodge "Argument list
too long"). Since there's no host port now, run the test FROM a container on the network:
```bash
IMG=$(base64 -w0 test.png)
printf '{"model":"mistral-ocr-latest","document":{"type":"image_url","image_url":"data:image/png;base64,%s"}}' "$IMG" > /tmp/ocr_body.json
# copy body into a container and curl from there, or temporarily add -p to test standalone
docker exec -i rag_api curl -s -X POST http://ocr-service:8003/v1/ocr \
  -H "Content-Type: application/json" --data @- < /tmp/ocr_body.json
```
Expect `{"pages":[{"index":0,"markdown":"...text..."}],...}`.

> This alone makes **"Upload as Text"** work for scanned docs. File Search still needs Piece B.

### 12.4 Piece B — forked `rag_api` with an OCR fallback

`rag_api`'s embed path (`store_data_in_vector_db`) calls `loader.lazy_load()` and never
touches the OCR strategy. We patch `app/utils/document_loader.py` so the PDF loader
(`SafePyPDFLoader`) checks the extracted text and, if it's near-empty (a scanned PDF), calls
the OCR service and embeds that text instead. The fallback lives in a shared helper used by
**both `lazy_load()` and `load()`** — critical, since the embed path uses `lazy_load()`.

**Build the fork** (in **BACKEND/rag_api** — this folder holds the forked source; if starting
fresh, clone into it):
```bash
cd BACKEND/rag_api
# first time only, if the folder is empty:
#   git clone https://github.com/danny-avila/rag_api.git .
cp /path/to/document_loader.py app/utils/document_loader.py   # the patched file
grep -c "_pages_with_ocr" app/utils/document_loader.py        # expect 3
# Build from the base matching your running image. We run the FULL dev image
# (local huggingface embeddings), so use Dockerfile (NOT Dockerfile.lite):
docker build --no-cache -f Dockerfile -t rag-api-ocr:local .
```

**Point the compose override at the fork** (edit the EXISTING `rag_api` block — don't add a
second one):
```yaml
services:
  rag_api:
    image: rag-api-ocr:local
    extra_hosts:
      - "host.docker.internal:host-gateway"
    environment:
      - OCR_FALLBACK_ENABLED=true
      - OCR_FALLBACK_URL=http://ocr-service:8003/v1/ocr
      - OCR_FALLBACK_MIN_CHARS=500        # <this many extracted chars -> treat as scanned, OCR it
      - OCR_FALLBACK_TIMEOUT=120
```
> `OCR_FALLBACK_MIN_CHARS`: scanned PDFs often have a little junk text (page footers/URLs)
> that sneaks past a low threshold, so OCR gets skipped. We raised it to 500. Tune per your
> docs — too high risks OCR-ing digital PDFs unnecessarily (slower).

**Restart & verify the running container has the patch:**
```bash
docker compose down && docker compose up -d api mongodb meilisearch rag_api vectordb
docker compose exec rag_api grep -c "_pages_with_ocr" app/utils/document_loader.py   # expect 3
```

### 12.5 End-to-end test
Upload the scanned PDF via **File Search**, watching both logs:
```bash
docker compose logs -f rag_api        # terminal 1
docker logs -f ocr-service            # terminal 2
```
Success during the UPLOAD (not the question):
- rag_api: `PDF ... yielded only N chars; attempting OCR fallback.` → `OCR fallback produced NNNN chars...`
- ocr-service: `POST /v1/ocr ... 200 OK`

Then ask a question → the model answers from the OCR'd content.

### 12.6 Gotchas / notes
- **OCR service must be running** whenever rag_api needs it; the fork calls `http://ocr-service:8003` (same Docker network).
- **`RAG_USE_FULL_CONTEXT=true` must be OFF** — it triggers a `/documents/{id}/context` lookup
  that 404s on custom endpoints. We commented it out; leaving it on breaks File Search.
- **vLLM tool-calling required** for File Search — launch the LLM with
  `--enable-auto-tool-choice --tool-call-parser hermes` (Qwen3), or you get a 400
  "auto tool choice requires..." error.
- **You now maintain a `rag_api` fork.** On upstream updates, re-apply the ~60-line patch to
  `document_loader.py` and rebuild. Pin the git commit you built from.
- **Speed:** OCR runs during upload; scanned multi-page PDFs take seconds/page. Fine for beta.
- **Pure images (png/jpg) into File Search** aren't covered by the PDF-loader patch — add a
  similar hook to their loader path later if users need it.
- Rebuild not taking effect? Docker cached the layer — add `--no-cache`.

---

## 13. Web search (SearXNG + self-hosted Firecrawl)

Fully local web search: **SearXNG** (meta-search) finds results, **Firecrawl** (self-hosted)
scrapes the pages. No external/cloud services. Both live in `BACKEND/WebSearch/` and attach
to the LibreChat Docker network (no published host ports).

### 13.1 SearXNG

**File — `BACKEND/WebSearch/searxng/settings.yml`:**
```yaml
use_default_settings: true
server:
  secret_key: "REPLACE_WITH_openssl_rand_-hex_32"
  limiter: false
search:
  formats:
    - html
    - json          # REQUIRED — LibreChat can't parse results without JSON enabled
```

**Run** (kill any existing first; attached to the network, no host port):
```bash
docker stop searxng 2>/dev/null; docker rm searxng 2>/dev/null
cd BACKEND/WebSearch
docker run -d --restart unless-stopped \
  --network librechat_default \
  --name searxng \
  -v "$(pwd)/searxng:/etc/searxng" \
  searxng/searxng:latest
```
LibreChat reaches it as `http://searxng:8080` (internal container port 8080).

### 13.2 Firecrawl (self-hosted, official multi-arch repo)

> Use the OFFICIAL `firecrawl/firecrawl` repo — it publishes **multi-arch (arm64) images**.
> The `firecrawl-simple` fork does NOT build on ARM (its puppeteer service installs
> amd64-only google-chrome). This matters on Apple Silicon / ARM servers.

**Clone into `BACKEND/WebSearch/firecrawl`:**
```bash
cd BACKEND/WebSearch
git clone https://github.com/firecrawl/firecrawl.git
cd firecrawl
```

**Edit `docker-compose.yaml` — 5 changes:**
1. `x-common-service` (top): uncomment `image: ghcr.io/firecrawl/firecrawl`, comment out `build: apps/api`.
2. `playwright-service`: uncomment `image: ghcr.io/firecrawl/playwright-service:latest`, comment out its `build:`.
3. `nuq-postgres`: uncomment `image: ghcr.io/firecrawl/nuq-postgres:latest`, comment out its `build:`.
   (This image is amd64-only → runs under QEMU emulation on ARM. Expect a platform warning; it works.)
4. `api` service: add `container_name: firecrawl-api` (right after `api:`), and comment out its `ports:` block (no host exposure).
5. Bottom `networks:` block — join the LibreChat network:
   ```yaml
   networks:
     backend:
       external: true
       name: librechat_default
   ```
   (Every service keeps `networks: - backend`; only the top-level block changes.)

**File — `BACKEND/WebSearch/firecrawl/.env`:**
```dotenv
PORT=3002
INTERNAL_PORT=3002
HOST=0.0.0.0
USE_DB_AUTHENTICATION=false
REDIS_URL=redis://redis:6379
POSTGRES_USER=postgres
POSTGRES_PASSWORD=postgres
POSTGRES_DB=postgres
BULL_AUTH_KEY=REPLACE_WITH_openssl_rand_-hex_32
LOGGING_LEVEL=info
```

**Run** (LibreChat stack must be up first — it owns `librechat_default`):
```bash
cd BACKEND/WebSearch/firecrawl
docker compose config >/dev/null && echo "compose valid"   # validate before pull
docker compose pull            # if 401: docker login ghcr.io with a PAT (read:packages)
docker compose up -d
```
Verify LibreChat can reach it:
```bash
docker exec rag_api curl -s -o /dev/null -w "%{http_code}\n" http://firecrawl-api:3002/
```

### 13.3 Wire into LibreChat

**`FRONTEND/LibreChat/.env`:**
```dotenv
SEARXNG_INSTANCE_URL=http://searxng:8080
FIRECRAWL_API_URL=http://firecrawl-api:3002
FIRECRAWL_API_KEY=this-is-a-placeholder     # self-hosted ignores it
```

**`FRONTEND/LibreChat/librechat.yaml`** — TWO gates (same pattern as File Search):
```yaml
interface:
  webSearch: true            # (1) surfaces the toggle
endpoints:
  agents:
    capabilities:
      - "web_search"         # (2) enables the tool  (alongside file_search, context, ocr)
webSearch:
  searchProvider: "searxng"
  searxngInstanceUrl: "${SEARXNG_INSTANCE_URL}"
  scraperProvider: "firecrawl"
  firecrawlApiKey: "${FIRECRAWL_API_KEY}"
  firecrawlApiUrl: "${FIRECRAWL_API_URL}"
  rerankerType: "none"       # no Jina/Cohere; raw SearXNG order
```

Restart, hard-refresh, enable **Web Search in the Tools dropdown** (next to the paperclip).

### 13.4 Gotchas / notes
- **Both gates required:** `interface.webSearch: true` AND the `web_search` capability — miss
  either and the toggle won't appear (same as File Search).
- **SearXNG needs `json` in `formats`** or you get empty results / config prompts.
- **Firecrawl is heavy:** 6 containers (api, playwright, redis, rabbitmq, nuq-postgres, +
  optional foundationdb), ~8GB RAM, multi-GB Playwright image. Mind your VRAM/RAM budget
  alongside vLLM.
- **`rerankerType: "none"`** gives raw SearXNG order (mediocre relevance). A reranker
  improves quality but needs Jina/Cohere (cloud) or a self-hosted FlashRank wrapper — later.
- **Service-name collision:** Firecrawl's internal service is `api`; `container_name:
  firecrawl-api` gives it a distinct name so it doesn't clash with LibreChat's `api` on the
  shared network. Reach it as `http://firecrawl-api:3002`.
- Env vars must reach the container: `docker compose exec api env | grep -E "SEARXNG|FIRECRAWL"`.

---

## 13A. LLM load balancing (nginx across multiple vLLM devices)

Fans LibreChat's single LLM endpoint across **N identical vLLM backends** (here: two DGX
Sparks running the same Qwen3 model). An nginx container acts as a reverse proxy / load
balancer; LibreChat points at it instead of at one Spark directly.

```
LibreChat ──baseURL──► vllm-lb (nginx) ──► 172.22.0.1:8000    (Spark A, host-run vLLM, SAME box)
                                        └─► 128.4.188.154:8000 (Spark B, remote over UD network)
```

**Scope:** LLM inference only (`:8000`). Embeddings (`:8001`) are NOT load-balanced — they
stay local (or run in-process in rag_api via HuggingFace, section 5). Don't route
`RAG_OPENAI_BASEURL` through the LB.

### 13A.1 Why direct proxy (not SSH tunnels)
Two designs were considered: SSH tunnels (bind each vLLM to `127.0.0.1`, tunnel to the LB
host — max isolation) vs. a direct proxy over the UD network. We use the **direct proxy**
because:
- `:8000` is **firewalled off-campus** (verified: reachable from within UD, refused/timeout
  from a non-UD connection). So the GPUs aren't world-exposed.
- Both Sparks run vLLM with the **same `VLLM_API_KEY`**, so nginx just forwards the
  `Authorization` header untouched — no per-backend auth rewriting.

The API key is a second layer, not the only thing between the internet and the GPUs. If the
off-campus firewall ever changes, revisit the SSH-tunnel option.

### 13A.2 Topology gotcha (the 172.22.0.1 rule again)
nginx runs as a container on `librechat_default`, on the SAME box as Spark A. From inside
that container:
- Spark A's **host-run** vLLM is reached via the docker gateway **`172.22.0.1:8000`**
  — NOT `127.0.0.1` (loopback inside the container is the container itself).
- Spark B is a plain routable IP (`128.4.188.154:8000`) over the UD network.

Each Spark's vLLM must be bound so the LB can reach it (`--host 0.0.0.0`); binding
`127.0.0.1`-only makes it unreachable. This is safe here because `:8000` is firewalled
off-campus — `0.0.0.0` means "reachable within UD," not "world."

### 13A.3 Files
Kept in `FRONTEND/LibreChat/vllm-lb/`:
- `vllm-lb.conf` — the nginx config (upstream + reverse proxy, below)
- `vllm-lb.compose.yml` — the nginx service definition

**`vllm-lb.conf`:**
```nginx
# Custom log format: records WHICH backend served each request.
#   $upstream_addr = the Spark that handled it (172.22.0.1 = A, 128.4.188.154 = B)
log_format lb '$remote_addr -> $upstream_addr '
              '[$status] req=$request_time upstream=$upstream_response_time '
              '"$request"';

upstream vllm_backends {
    # least_conn: route to whichever backend has the fewest ACTIVE requests.
    # Correct for LLM traffic where request cost varies wildly (short chat vs.
    # long generation). Round-robin would pile long requests onto a busy box.
    least_conn;

    server 172.22.0.1:8000     max_fails=3 fail_timeout=30s;   # Spark A (local, via gateway)
    server 128.4.188.154:8000  max_fails=3 fail_timeout=30s;   # Spark B (remote) — EDIT IP

    # Passive health checks: after 3 fails within 30s, nginx marks the backend
    # down for 30s, then retries. (Active checks need nginx-plus; passive is fine.)

    keepalive 32;
}

server {
    listen 8000;
    server_name _;

    access_log /var/log/nginx/access.log lb;   # shows up in `docker logs vllm-lb`
    client_max_body_size 0;                     # no cap — RAG context can be large

    location / {
        proxy_pass http://vllm_backends;

        # SSE / streaming — critical for token-by-token output:
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection "";
        proxy_http_version 1.1;
        chunked_transfer_encoding on;

        # Generous timeouts — long generations must not be cut off:
        proxy_connect_timeout 10s;
        proxy_send_timeout    600s;
        proxy_read_timeout    600s;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Retry the OTHER backend on connection-level failure (vLLM is stateless).
        # Does NOT retry once headers are sent (can't un-stream a live response).
        proxy_next_upstream error timeout http_502 http_503 http_504;
        proxy_next_upstream_tries 2;
    }

    location = /lb-health {
        access_log off;
        return 200 "vllm-lb ok\n";
        add_header Content-Type text/plain;
    }
}
```

**`vllm-lb.compose.yml`:**
```yaml
services:
  vllm-lb:
    image: nginx:1.27-alpine
    container_name: vllm-lb
    restart: unless-stopped
    networks:
      - librechat_default
    volumes:
      - ./vllm-lb.conf:/etc/nginx/conf.d/default.conf:ro
    extra_hosts:
      - "host.docker.internal:host-gateway"
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8000/lb-health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
    # NO ports: block — internal-only, reached by name (vllm-lb) on the network,
    # same isolation pattern as ocr-service / searxng / firecrawl.

networks:
  librechat_default:
    external: true
    name: librechat_default
```
> No `nginx` install needed — it runs as the `nginx:1.27-alpine` container, pulled
> automatically. No published ports: LibreChat reaches it as `http://vllm-lb:8000`.

### 13A.4 Deploy
```bash
# 0. Preflight — confirm Spark B is reachable + serving from Spark A:
curl -s -H "Authorization: Bearer $VLLM_API_KEY" http://128.4.188.154:8000/v1/models
#    JSON model list = good. Refused/timeout = Spark B bound 127.0.0.1 → relaunch --host 0.0.0.0

# 1. Put vllm-lb.conf + vllm-lb.compose.yml in FRONTEND/LibreChat/vllm-lb/, edit the Spark B IP.

# 2. Start the LB:
cd FRONTEND/LibreChat/vllm-lb
docker compose -f vllm-lb.compose.yml up -d
docker logs vllm-lb          # nginx started, no upstream errors

# 3. Verify the LB reaches a backend (from inside the network):
docker run --rm --network librechat_default curlimages/curl \
  -s -H "Authorization: Bearer $VLLM_API_KEY" http://vllm-lb:8000/v1/models
```

### 13A.5 Point LibreChat at the LB
In `librechat.yaml`, change ONLY the vLLM endpoint baseURL (key stays the same — nginx
forwards it):
```yaml
  custom:
    - name: "vLLM"
      apiKey: "${VLLM_API_KEY}"
      baseURL: "http://vllm-lb:8000/v1"     # was http://172.22.0.1:8000/v1
```
Restart just the api container:
```bash
cd FRONTEND/LibreChat && docker compose up -d api
```
Send a chat message and confirm it still streams token-by-token.

### 13A.6 Verify the split + watch traffic
The access log records which Spark served each request. Tail it:
```bash
docker logs -f vllm-lb
```
Example (healthy):
```
172.22.0.6 -> 172.22.0.1:8000    [200] req=0.9  ... "POST /v1/chat/completions HTTP/1.1"   # Spark A
172.22.0.6 -> 128.4.188.154:8000 [200] req=1.2  ... "POST /v1/chat/completions HTTP/1.1"   # Spark B
```
> **`least_conn` only spreads OVERLAPPING requests.** A single user sending one message at a
> time will look like it always hits Spark A — that's correct: each request finishes before
> the next starts, so A always has "fewest connections" (zero). To SEE the split, generate
> concurrent load (multiple browser tabs, or a parallel curl burst):
> ```bash
> for i in $(seq 1 10); do
>   docker run --rm --network librechat_default curlimages/curl -s -o /dev/null \
>     -H "Authorization: Bearer $VLLM_API_KEY" http://vllm-lb:8000/v1/models &
> done; wait
> docker logs --tail 12 vllm-lb          # expect a MIX of both addresses
> ```
> Under real multi-user beta traffic, load spreads automatically.

### 13A.7 Operations
- **Add a 3rd+ Spark:** add one `server <ip>:8000 ...` line to the `upstream` block, then
  `docker exec vllm-lb nginx -s reload`. No LibreChat change.
- **Edit the config live (zero downtime):** validate then reload:
  ```bash
  docker exec vllm-lb nginx -t && docker exec vllm-lb nginx -s reload
  ```
- **A down Spark is invisible to users** after `max_fails` trips, until `fail_timeout`
  elapses and nginx re-probes it.
- **Failover is connection-level only.** If a backend dies MID-stream (after headers sent),
  that one response fails — nginx can't un-send a stream. The next request routes around it.
- **Rollback** to single-Spark:
  ```bash
  # librechat.yaml: baseURL back to http://172.22.0.1:8000/v1
  cd FRONTEND/LibreChat && docker compose up -d api
  docker compose -f vllm-lb/vllm-lb.compose.yml down
  ```

### 13A.8 Gotchas hit during setup
- **Placeholder IP left in the config.** The template ships a placeholder Spark B IP
  (`128.175.224.15`). If not replaced with the real one (`128.4.188.154`), you get
  `connect() failed (113: Host is unreachable)` on every Spark-B attempt, ~3s wasted per
  request before nginx falls back to Spark A. Fix: `sed -i 's/OLD_IP/NEW_IP/' vllm-lb.conf`
  then `nginx -t && nginx -s reload`.
- **`can not modify /etc/nginx/conf.d/default.conf (read-only file system?)`** on startup is
  HARMLESS — it's the `:ro` mount doing its job; the ipv6 entrypoint script just can't edit
  the config, which nginx doesn't need.
- **`client request body is buffered to a temporary file`** is a minor warning (request body
  exceeded the in-memory buffer), not an error. Ignore for beta.
- **This LB is plain HTTP, internal to `librechat_default`** — correct for an internal LB.
  TLS for end users is a SEPARATE layer (HTTPS reverse proxy in front of LibreChat, section 13B).
- **Same-box caveat:** the LB shares hardware with Spark A. nginx is featherweight so it
  won't tax the GPU box, but Spark A is then a single point of failure for the LB itself.
  Acceptable for beta; move the LB to a 3rd host if that matters later.

### 13A.9 Startup order note
The `vllm-lb` container has `restart: unless-stopped`, so it self-heals across reboots. It
depends on the `librechat_default` network existing, so bring the LibreChat stack up first
(step 2 of section 3) if you ever fully tear everything down. Start the LB after that:
```bash
cd FRONTEND/LibreChat/vllm-lb && docker compose -f vllm-lb.compose.yml up -d
```

---

## 13B. HTTPS reverse proxy (nginx + Cloudflare DNS-01 certs)

Puts a real, browser-trusted HTTPS front door on LibreChat. This is required before
real users, and it also gives browsers the **secure context** they need to grant mic
access — which is what **unblocks browser STT** (speech-to-text) for remote users.

```
User (on UD VPN) ──https://alphatest.udassistant.com──► https-proxy (nginx :443, TLS)
                                                              │  proxy_pass
                                                              ▼
                                                     LibreChat api :3080
```

**Design decisions (and why):**
- **The host is UD-internal only.** Access is over the UD VPN by design; the box is not
  publicly reachable. This is intentional, not a limitation to fix.
- **Certs via DNS-01, not HTTP-01.** The usual HTTP-01 challenge needs the host reachable
  from the public internet on port 80 — ours isn't. DNS-01 proves domain control by writing
  a TXT record via the DNS provider's API instead, so it works on an internal host. The cert
  is fully Let's-Encrypt-trusted (no browser warnings).
- **Cloudflare** as registrar + DNS (we bought `udassistant.com` there; DNS is auto-managed,
  no nameserver transfer). DuckDNS was used earlier as a free stopgap — the flow is identical,
  only the plugin/token differ. Both are documented below.
- **certbot runs separate from nginx.** Cert lives in `/etc/letsencrypt` on the host; nginx
  mounts it read-only. Renewal is decoupled from the proxy.
- **443-only.** We don't publish port 80 (a host process was already using it, and we don't
  need the http→https redirect for a VPN beta where users get the full `https://` link).

Files (in `FRONTEND/LibreChat/https-proxy/`): `ud-assistant.conf` (nginx),
`https-proxy.compose.yml` (service).

### 13B.1 Buy the domain + point it at the host (Cloudflare)
1. Buy the domain at Cloudflare Registrar (wholesale pricing, free DNSSEC, DNS auto-managed).
2. Create a DNS **A record** for the hostname you'll use, e.g.:
   - Name: `alphatest`  (gives `alphatest.udassistant.com`)
   - IPv4: `128.175.224.14`  (the LibreChat host — confirm with `ip route`, it's the `src` IP)
   - **Proxy status: DNS only (GREY cloud), NOT proxied (orange).**
3. **Ignore Cloudflare's "Proxying is required…" banner.** Proxying CANNOT work here: the host
   is UD-internal, so Cloudflare's edge can't reach it, and proxying would break the VPN-direct
   model AND replace your Let's Encrypt cert at the edge. Grey cloud = Cloudflare just answers
   DNS with your IP; the browser connects straight to your host and sees your real cert.

### 13B.2 Create a scoped Cloudflare API token
Cloudflare dashboard → **My Profile → API Tokens → Create Token** → "Edit zone DNS" template.
- Permission: **Zone → DNS → Edit**
- Zone Resources: **Include → Specific zone → udassistant.com** (the PARENT zone, not the
  subdomain — certbot looks up the zone by parent domain)
- Copy the token once (shown only once).

Store it in a credentials file:
```bash
mkdir -p ~/.secrets/certbot
cat > ~/.secrets/certbot/cloudflare.ini << 'EOF'
dns_cloudflare_api_token = PASTE_YOUR_CLOUDFLARE_TOKEN_HERE
EOF
chmod 600 ~/.secrets/certbot/cloudflare.ini
```

### 13B.3 Issue the certificate (staging first, then real)
Run certbot in a one-shot container with the Cloudflare plugin. **Staging first** — it uses a
test CA so a typo doesn't burn the real Let's Encrypt rate limit. Replace the email + hostname.
```bash
# STAGING (test):
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v ~/.secrets/certbot:/secrets:ro \
  certbot/dns-cloudflare certonly \
    --non-interactive --agree-tos --email you@example.com \
    --dns-cloudflare --dns-cloudflare-credentials /secrets/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    -d alphatest.udassistant.com \
    --staging
```
Once staging says "Successfully received certificate", get the **real** one — drop `--staging`
and add `--force-renewal` (so it overwrites the staging cert now sitting in the live dir):
```bash
# REAL:
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v ~/.secrets/certbot:/secrets:ro \
  certbot/dns-cloudflare certonly \
    --non-interactive --agree-tos --email you@example.com \
    --dns-cloudflare --dns-cloudflare-credentials /secrets/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    -d alphatest.udassistant.com \
    --force-renewal
```
Cert saves to `/etc/letsencrypt/live/alphatest.udassistant.com/` (`fullchain.pem` + `privkey.pem`).

> **Permissions gotcha (we hit this):** certbot in the container runs as root and needs to
> READ the token file and WRITE `/etc/letsencrypt` + logs. If the token is `chmod 600` owned
> by your host user, container-root can't read it → `PermissionError: /secrets/cloudflare.ini`.
> Fix: `chmod 644 ~/.secrets/certbot/cloudflare.ini` for the manual run (the file's "unsafe
> permissions" warning is harmless). Do NOT add `--user $(id -u)` to fix the read — it then
> can't write `/var/log/letsencrypt`. After issuance you can `chmod 600` back; the scheduled
> renewal runs as root and reads 600 fine.

> **DuckDNS alternative (free, no domain purchase):** get a name + token at duckdns.org, then
> use the `infinityofspace/certbot_dns_duckdns` image instead:
> `... certonly --authenticator dns-duckdns --dns-duckdns-token "$DUCKDNS_TOKEN"
> --dns-duckdns-propagation-seconds 60 -d yourname.duckdns.org`. Everything else below is identical.
> Note DuckDNS's A record must point at the host IP too (set it in the dashboard, or
> `curl "https://www.duckdns.org/update?domains=NAME&token=TOKEN&ip=128.175.224.14"`).

### 13B.4 The nginx config
`ud-assistant.conf` (443-only). Edit `server_name` + the two `ssl_certificate` paths to match
your hostname:
```nginx
# Included INSIDE the image's http{} block — only http-level directives here (map, server),
# no `http {` wrapper (that causes: "server directive is not allowed here").
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name alphatest.udassistant.com;

    ssl_certificate     /etc/letsencrypt/live/alphatest.udassistant.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/alphatest.udassistant.com/privkey.pem;

    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    add_header Strict-Transport-Security "max-age=15768000" always;

    client_max_body_size 0;   # LibreChat RAG uploads can be large

    location / {
        proxy_pass http://api:3080;          # LibreChat api container, by name on the network

        # WebSocket + SSE (LibreChat streams tokens over both):
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_buffering off;

        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_connect_timeout 10s;
        proxy_send_timeout    600s;
        proxy_read_timeout    600s;
    }
}
```

`https-proxy.compose.yml`:
```yaml
services:
  https-proxy:
    image: nginx:1.27-alpine
    container_name: https-proxy
    restart: unless-stopped
    networks:
      - librechat_default
    ports:
      - "443:443"                    # the ONE service that publishes a host port (front door)
    volumes:
      - ./ud-assistant.conf:/etc/nginx/conf.d/default.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro    # nginx reads the cert; renewal happens on host
    healthcheck:
      test: ["CMD", "wget", "--no-check-certificate", "-qO-", "https://127.0.0.1/health"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

networks:
  librechat_default:
    external: true
    name: librechat_default
```

### 13B.5 Point LibreChat at the HTTPS hostname
LibreChat `.env`:
```dotenv
DOMAIN_CLIENT=https://alphatest.udassistant.com
DOMAIN_SERVER=https://alphatest.udassistant.com
```
```bash
cd FRONTEND/LibreChat && docker compose up -d api
```

### 13B.6 Start the proxy + verify
```bash
cd FRONTEND/LibreChat/https-proxy
docker compose -f https-proxy.compose.yml up -d --force-recreate
docker exec https-proxy nginx -t          # config OK?
docker logs https-proxy                    # want a clean start, no [emerg]
```
Confirm the REAL cert is being served (issuer must NOT say STAGING):
```bash
echo | openssl s_client -connect alphatest.udassistant.com:443 \
  -servername alphatest.udassistant.com 2>/dev/null | openssl x509 -noout -issuer -subject
# want: issuer=...Let's Encrypt...  CN = R10/R11/E5/E6   (NOT "(STAGING)")
#       subject=CN = alphatest.udassistant.com
```
Then open `https://alphatest.udassistant.com` in a **fresh incognito window** (bypasses any
cached staging cert): clean padlock, LibreChat login, streaming works, and the mic/STT is now
available.

### 13B.7 Auto-renewal (certs expire every 90 days)
Renewal re-runs the same DNS-01 flow. systemd timer on the host, weekly, then reloads nginx.

`/etc/systemd/system/certbot-renew.service`:
```ini
[Unit]
Description=Renew Let's Encrypt certs (Cloudflare DNS-01)

[Service]
Type=oneshot
ExecStart=/usr/bin/docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v /root/.secrets/certbot:/secrets:ro \
  certbot/dns-cloudflare renew \
    --dns-cloudflare --dns-cloudflare-credentials /secrets/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30
ExecStartPost=/usr/bin/docker exec https-proxy nginx -s reload
```
`/etc/systemd/system/certbot-renew.timer`:
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
Enable + test (copy the token where root can read it):
```bash
sudo mkdir -p /root/.secrets/certbot
sudo cp ~/.secrets/certbot/cloudflare.ini /root/.secrets/certbot/ && sudo chmod 600 /root/.secrets/certbot/cloudflare.ini
sudo systemctl daemon-reload
sudo systemctl enable --now certbot-renew.timer
systemctl list-timers | grep certbot
sudo systemctl start certbot-renew.service            # test now (no-op if >30 days left)
journalctl -u certbot-renew.service --no-pager | tail -20
```

### 13B.8 Create user accounts (closed beta) — full runbook
Registration is closed (no public signup); the admin creates every account by hand. This is
the same as section 11, recapped here so HTTPS bring-up + user onboarding is one flow. Users
then log in at `https://alphatest.udassistant.com` (over the UD VPN).

**a. `.env` settings** (no SMTP needed at this scale):
```dotenv
ALLOW_REGISTRATION=false            # no public self-signup
ALLOW_SOCIAL_REGISTRATION=false
ALLOW_EMAIL_LOGIN=true              # email/password login on
ALLOW_UNVERIFIED_EMAIL_LOGIN=true   # skip email verification (no SMTP)
```
Apply:
```bash
cd FRONTEND/LibreChat
docker compose down && docker compose up -d api mongodb meilisearch rag_api vectordb
```

**b. Create the ADMIN account FIRST** (the first account created becomes ADMIN — make it yours):
```bash
docker compose exec api npm run create-user
```
Prompts: email, password, name, "Email verified?" → answer **Y** (so it can log in immediately).

**c. Create a beta user** (repeat per tester):
```bash
docker compose exec api npm run create-user
```
Same prompts, answer **Y** to email-verified each time. Use the INTERACTIVE prompts — don't
pass the password as a CLI argument (it leaks into shell history).

**d. Remove a user:**
```bash
docker compose exec api npm run delete-user email@example.com
```

**e. Verify accounts exist:**
```bash
docker compose exec mongodb mongosh LibreChat --eval "db.users.find({}, {email:1, role:1}).pretty()"
```

**f. Onboard the tester:** send them the URL `https://alphatest.udassistant.com`, their email +
password, and a note that they must be **on the UD VPN** to reach it (the host is UD-internal).

### 13B.9 Gotchas hit during setup
- **`"server" directive is not allowed here`** on nginx start → the conf has an `http {`
  wrapper or a stray brace. The file is included INSIDE the image's `http{}` already; only
  `map`/`server` belong at top level. Replace with the clean 443-only file above.
- **Port 80/443 `address already in use`** → a host process (a host-installed nginx) already
  binds it. Check `sudo ss -tlnp | grep ':443 '`. Either stop it
  (`sudo systemctl disable --now nginx`) or stay 443-only.
- **Site loads but wrong box / doesn't load** → the DNS A record points at the wrong IP. Check
  `dig +short alphatest.udassistant.com` — it must equal the host's `128.175.224.14`, not the
  gateway (`.224.1`). DNS-01 issuance still SUCCEEDS with a wrong A record (it validates via
  TXT, not reachability), so a good cert + unreachable site = check the A record.
- **Browser says "not secure" / red crossed-out HTTPS** → nginx is serving the STAGING cert.
  Verify with the `openssl ... -issuer` command; if it says `(STAGING)`, re-issue real with
  `--force-renewal` and `nginx -s reload`. If openssl shows a REAL issuer but the browser still
  warns, it's cached — use incognito or clear the site's HSTS at `chrome://net-internals/#hsts`.
- **`PermissionError: /secrets/cloudflare.ini`** → see the permissions gotcha in 13B.3.
- **HSTS caution:** the config sends HSTS (forces HTTPS for 6 months). Fine here (HTTPS-only
  host), but it means you can't fall back to plain HTTP on this name once a browser has seen it.

### 13B.10 Rollback
```bash
docker compose -f https-proxy.compose.yml down          # stop the proxy
# revert .env DOMAIN_* to http://128.175.224.14:3080 (if api :3080 is still published) and:
cd FRONTEND/LibreChat && docker compose up -d api
```

---

## 14. Meilisearch master-key rotation (the painful one)

Meilisearch bakes the master key into its DATA DIR on first init; the stored key beats the
env var on later starts. So rotating `MEILI_MASTER_KEY` requires wiping its data:

```bash
# 1. fix .env (no inline # comment on the key!)
# 2. find the real data dir (note the version suffix):
docker inspect chat-meilisearch --format '{{ range .Mounts }}{{ .Source }} -> {{ .Destination }}{{ "\n" }}{{ end }}'
# 3. down, remove the WHOLE dir (not /*), up:
docker compose down
sudo rm -rf /path/to/meili_data_vX.Y.Z
docker compose up -d api mongodb meilisearch rag_api vectordb
# 4. verify no 403s:
docker compose logs api 2>&1 | grep -i meili | tail -10
```
This wipes only the search index (chats/users live in Mongo). Old conversations become
searchable again as they re-index.

---

## 14A. Observability with Langfuse (self-hosted) + privacy masking

Full LLM observability — per-message traces, tokens, latency, cost, tool calls — via a
**self-hosted Langfuse** stack, with a **two-tier consent masking proxy** so we control
exactly what content is stored. This section covers deploying Langfuse, wiring LibreChat to
it through the masking proxy, and managing which users opt in.

### 14A.0 Why the masking proxy exists (read this first)
LibreChat's built-in Langfuse integration is on/off only — it stores the FULL prompt,
completion, system prompt, and web-search results. There is **no built-in field control**:
- Langfuse's own server-side masking callback requires an **Enterprise license** (silently
  ignored on the OSS edition — the env vars do nothing).
- LibreChat exposes no client-side `mask` hook (its tracing lives in a bundled dependency;
  GitHub librechat#13529 is an open request for configurability).

So to get field-level control on the free/OSS stack **without forking LibreChat**, we run a
small **OTLP masking proxy** between LibreChat and Langfuse. LibreChat points its
`LANGFUSE_BASE_URL` at the proxy; the proxy intercepts each trace, applies the tier rules,
and forwards the masked trace to the real Langfuse.

```
LibreChat api ──OTLP/json POST──▶ mask-proxy ──masked──▶ Langfuse web (:3000)
(LANGFUSE_BASE_URL = proxy)        (:8080)               (ClickHouse/Postgres/MinIO)
```

### 14A.1 The two tiers
Decided **per trace** by the trace's `userId` vs. an opt-in allowlist:

- **Tier 1 — opt-out (default, everyone not in the allowlist):** METRICS ONLY. All message
  text, system prompts, web-search results (both the `content` string AND the structured
  `artifact.web_search` object), and tool-call query args are stripped. Kept: tokens
  in/out/total, latency, time-to-first-token, cost, model, timestamps, IDs. In the Langfuse
  UI these traces read "This trace has no input or output."
- **Tier 2 — opt-in (userId in the allowlist):** metrics PLUS user input + assistant final
  output. System prompts are still dropped. Web-search results are reduced to a marker
  (bodies/URLs removed). Applies to `AgentRun` and `TitleRun` alike.

> Masking is FIELD-LEVEL and was verified against real traces. The web-search results were a
> subtle leak: they live in a structured `artifact.web_search.organic` field SEPARATE from
> the `content` string, so masking `content` alone leaked them. The proxy strips both. After
> any LibreChat image upgrade, RE-VERIFY masking (upgrades can change the trace shape).

### 14A.2 Deploy the Langfuse stack
Langfuse v3 is a six-container stack (web, worker, ClickHouse, Postgres, Redis, MinIO). Ours
lives in `BACKEND/Langfuse/` (moved from an old test dir; volumes preserved via a pinned
`COMPOSE_PROJECT_NAME`).

```bash
cd ~/Projects/UD-Assistant/BACKEND/Langfuse
# .env MUST contain (prevents the rename from orphaning trace-history volumes):
#   COMPOSE_PROJECT_NAME=langfuse_testing
docker compose up -d
docker compose ps                          # all six healthy
curl -s http://172.22.0.1:3000/api/public/health   # {"status":"OK","version":"3.x"}
```
Volumes are `langfuse_testing_*` (postgres/clickhouse/minio). **Never `docker compose down -v`**
— that deletes trace history. Plain `down` is safe.

> Fresh install instead: `git clone https://github.com/langfuse/langfuse`, set all `# CHANGEME`
> secrets in its compose (use `openssl rand -hex 32` for DB passwords — base64 breaks the
> connection URL), `docker compose up -d`, first UI account = admin.

### 14A.3 Get API keys
Langfuse UI (`http://<host>:3000`) → project (create "UD-Assistant") → **Settings → API Keys
→ Create**. Copy the public (`pk-lf-…`) and secret (`sk-lf-…`). Secret shown once.

### 14A.4 Deploy the masking proxy
Lives in `BACKEND/Observability/mask-proxy/` (`mask_proxy.py`, `Dockerfile`,
`requirements.txt`, `mask-proxy.compose.yml`, `PROXY-SETUP.md`).

```bash
cd ~/Projects/UD-Assistant/BACKEND/Observability/mask-proxy
# set the opt-in allowlist (comma-separated LibreChat userIds — see 14A.6):
export OPT_IN_USER_IDS="6a4293a4a5aea273997ece76"
docker compose -f mask-proxy.compose.yml up -d --build
# health (from inside LibreChat's network):
docker run --rm --network librechat_default curlimages/curl -s http://mask-proxy:8080/_mask/health
# -> {"status":"ok","upstream":"http://172.22.0.1:3000","opt_in_count":1}
```
`mask-proxy.compose.yml` attaches to `librechat_default` and sets
`LANGFUSE_UPSTREAM_URL=http://172.22.0.1:3000` (the real Langfuse) and `FAIL_OPEN=false`
(on masking error, drop the batch rather than store unmasked — fail SAFE for compliance).

### 14A.5 Point LibreChat at the proxy (not directly at Langfuse)
In `FRONTEND/LibreChat/.env` (NO spaces around `=`, NO inline `#` comments — both break it):
```dotenv
LANGFUSE_PUBLIC_KEY=pk-lf-xxxxxxxx
LANGFUSE_SECRET_KEY=sk-lf-xxxxxxxx
LANGFUSE_BASE_URL=http://mask-proxy:8080
```
**Critical:** the `api` container does NOT auto-load these from `.env`. Add them to the `api`
service's `environment:` block in `docker-compose.override.yml` so they're injected:
```yaml
services:
  api:
    environment:
      - LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
      - LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY}
      - LANGFUSE_BASE_URL=${LANGFUSE_BASE_URL}
```
Then:
```bash
cd ~/Projects/UD-Assistant/FRONTEND/LibreChat
docker compose up -d --force-recreate api
docker compose exec api env | grep LANGFUSE      # confirm all three are present
```

### 14A.6 Managing opt-in userIds
The tier is chosen by the trace's `userId` (LibreChat's Mongo user id). To opt a user IN,
add their id to `OPT_IN_USER_IDS` on the mask-proxy and recreate it.

Find a user's id (any of):
```bash
# from Mongo by email:
docker compose exec mongodb mongosh LibreChat --eval \
  'db.users.find({email:"person@udel.edu"},{_id:1,email:1}).forEach(u=>print(u._id+"  "+u.email))'
# or list all:
docker compose exec mongodb mongosh LibreChat --eval \
  'db.users.find({},{email:1}).forEach(u=>print(u._id+"  "+u.email))'
# or read it off any of their traces in the Langfuse UI (the userId field)
```
Update the allowlist and recreate:
```bash
cd ~/Projects/UD-Assistant/BACKEND/Observability/mask-proxy
export OPT_IN_USER_IDS="id-aaa,id-bbb,id-ccc"     # comma-separated, no spaces
docker compose -f mask-proxy.compose.yml up -d --force-recreate
docker run --rm --network librechat_default curlimages/curl -s \
  http://mask-proxy:8080/_mask/health              # opt_in_count reflects the new list
```
> There is no in-chat opt-in toggle — LibreChat can't carry a per-request consent flag without
> a frontend fork. Consent is managed here via the allowlist (e.g. from a separate sign-up
> form / list you maintain).

### 14A.7 Verify both tiers (MANDATORY for compliance)
Watch the proxy while chatting: `docker logs -f mask-proxy` →
`masked OTLP/json: N spans (X tier1, Y tier2), Z attrs transformed`.

1. **Opt-out user** sends a web-search message → open the trace in Langfuse → confirm NO input
   text, NO output, NO system prompt, and the ToolMessage `artifact` is `{}` (empty). Metrics
   (tokens/latency/model) present. UI shows "This trace has no input or output."
2. **Opt-in user** → input + final answer present, NO `role:system` message, web results
   reduced to a marker.

Screenshot the opt-out trace as compliance evidence.

### 14A.8 Metrics reporting script
`BACKEND/Observability/metrics/langfuse_metrics.py` pulls the (masking-safe) metrics and plots
them per user and per session: tokens in/out (separated), latency, trace count, and **tool
calls** (counted from `type=="TOOL"` observations — structural, survives masking in both tiers).
```bash
cd ~/Projects/UD-Assistant/BACKEND/Observability/metrics
conda create -n ud-metrics python=3.12 -y && conda activate ud-metrics
pip install -r requirements.txt                  # requests, matplotlib, python-dotenv
cp .env.example .env                             # fill in keys; BASE_URL = REAL langfuse :3000, NOT the proxy
python langfuse_metrics.py --days 7              # -> metrics_out/*.csv + *.png
```

### 14A.9 Privacy & retention notes
- **Deleting a conversation in LibreChat does NOT delete its Langfuse traces** — the two
  systems have separate storage and there's no delete signal. Traces persist independently.
  Mitigate with a **retention policy** in Langfuse (auto-delete after N days) and reflect this
  in the opt-in consent language.
- **Purge the pre-masking traces.** Any traces captured before the proxy was working contain
  UNMASKED content (full prompts + web results). Delete them in the UI / via retention before
  widening the beta.
- Langfuse's `.env` holds real secrets (a weak reused password, a LangSmith key) — **gitignore
  it** and rotate before/after the first push.

### 14A.10 Langfuse gotchas hit during setup
- `.env` vars not reaching the LibreChat `api` container → must be in the override
  `environment:` block; also killed by spaces-around-`=` and inline `#` comments.
- The masking callback (`LANGFUSE_INGESTION_MASKING_CALLBACK_URL`) silently does nothing on
  OSS — Enterprise-only. Hence the proxy.
- LibreChat sends OTLP as **`application/json`**, not protobuf — the proxy masks the JSON path.
- Rebuilds not taking effect → the edited `mask_proxy.py` wasn't in the build folder; verify
  with `docker exec mask-proxy grep -c <marker> /app/mask_proxy.py` before testing.
- Container name conflict on rebuild → `docker rm -f mask-proxy` first.

---

## 14B. Per-user stats app (`metrics.alphatest.udassistant.com`)

A standalone, authenticated web page where **each user sees their own** usage stats
(conversations, messages, searches/tools, tokens in/out, latency, activity over time). Lives
in `BACKEND/Observability/stats-app/` and is served on its own subdomain over the same nginx
HTTPS proxy as the chat.

This is **Phase 1** — a separate page, not embedded in the LibreChat chat UI. Embedding would
require forking LibreChat's frontend; deferred until the beta proves demand. The stats API +
auth already exist, so Phase 2 would only change *where it renders*.

### 14B.1 How it works
- **Auth:** reuses LibreChat's own accounts — validates email + password against the LibreChat
  Mongo `users` collection with bcrypt (`provider: "local"`). Same login users already have.
- **Isolation:** a user's Mongo `_id` IS their Langfuse `userId`, so every query is scoped to
  the authenticated caller — nobody can see anyone else's stats.
- **Data:** pulls the masking-safe metrics from Langfuse (works for both consent tiers — tokens,
  latency, tool counts survive masking regardless of opt-in).
- **Endpoints:** `POST /api/login` (bcrypt → signed, expiring session token), `GET /api/mystats`
  (token → userId → Langfuse query), `GET /` (single-page frontend), `GET /api/health`.

### 14B.2 Security posture (important)
This service can read password hashes from Mongo, so it is held to the same bar as LibreChat:
- **VPN-internal only. Never publish its port to a public interface.** It is NOT published to
  the host at all — only nginx (on `librechat_default`) can reach it, as `http://stats-app:8090`.
- Give it read-only Mongo access if possible; set a strong `SESSION_SECRET`.

### 14B.3 Deploy the app
Files in `BACKEND/Observability/stats-app/` (`stats_api.py`, `page.py`, `Dockerfile`,
`requirements.txt`, `stats-app.compose.yml`, `.env.example`, `README.md`).

The compose attaches to `librechat_default` with **no published ports** (nginx reaches it
internally by container name — mirrors how the proxy reaches `api:3080`):
```yaml
services:
  stats-app:
    build: .
    image: ud-stats-app:local
    container_name: stats-app
    restart: unless-stopped
    environment:
      - MONGO_URI=mongodb://mongodb:27017
      - MONGO_DB=LibreChat
      - LANGFUSE_BASE_URL=http://172.22.0.1:3000     # real Langfuse, NOT the mask-proxy
      - LANGFUSE_PUBLIC_KEY=${LANGFUSE_PUBLIC_KEY}
      - LANGFUSE_SECRET_KEY=${LANGFUSE_SECRET_KEY}
      - SESSION_SECRET=${SESSION_SECRET}
      - SESSION_TTL_MIN=60
    networks: [librechat_default]
networks:
  librechat_default: { external: true, name: librechat_default }
```
```bash
cd ~/Projects/UD-Assistant/BACKEND/Observability/stats-app
cp .env.example .env      # LANGFUSE_* keys + SESSION_SECRET=$(openssl rand -hex 32)
docker compose -f stats-app.compose.yml up -d --build
docker network inspect librechat_default | grep stats-app   # confirm it's on the network
```

### 14B.4 Add the subdomain (Cloudflare DNS)
Cloudflare → `udassistant.com` → DNS → Add record:
- **Type** `A`, **Name** `metrics.alphatest` (Cloudflare appends the zone →
  `metrics.alphatest.udassistant.com`), **IPv4** = same host IP as the `alphatest` record,
  **Proxy status** `DNS only` (grey cloud — the host is VPN-internal; orange-cloud proxying
  would break it), **TTL** Auto.

### 14B.5 Issue the certificate (same DNS-01 flow as 13B)
Reuses the certbot Docker container + Cloudflare token from 13B — the token already has zone
access, so it covers any subdomain automatically (no manual TXT record). Skip staging (the flow
is already proven). Replace the email:
```bash
docker run --rm \
  -v /etc/letsencrypt:/etc/letsencrypt \
  -v ~/.secrets/certbot:/secrets:ro \
  certbot/dns-cloudflare certonly \
    --non-interactive --agree-tos --email you@example.com \
    --dns-cloudflare --dns-cloudflare-credentials /secrets/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    -d metrics.alphatest.udassistant.com
```
Cert lands at `/etc/letsencrypt/live/metrics.alphatest.udassistant.com/`. nginx already mounts
`/etc/letsencrypt:ro`, so it sees the new cert on reload — no compose change. Renewal is
automatic (certbot renews all certs under `/etc/letsencrypt/renewal/` together).
> Permissions gotcha (same as 13B): if the run errors `PermissionError: /secrets/cloudflare.ini`,
> `chmod 644 ~/.secrets/certbot/cloudflare.ini` and re-run.

### 14B.6 Add the nginx server block
Append to `FRONTEND/LibreChat/https-proxy/ud-assistant.conf` (no WebSocket/SSE bits — the stats
app is plain request/response; proxies by container name like the chat block):
```nginx
# --- HTTPS :443 -> UD Assistant personal stats app ---
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name metrics.alphatest.udassistant.com;

    ssl_certificate     /etc/letsencrypt/live/metrics.alphatest.udassistant.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/metrics.alphatest.udassistant.com/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_session_cache   shared:SSL:10m;
    ssl_session_timeout 1d;
    add_header Strict-Transport-Security "max-age=15768000" always;

    location / {
        proxy_pass http://stats-app:8090;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_connect_timeout 10s;
        proxy_send_timeout    60s;
        proxy_read_timeout    60s;
    }
}
```
Then verify the block is actually present and reload:
```bash
grep -c "metrics.alphatest" ~/Projects/UD-Assistant/FRONTEND/LibreChat/https-proxy/ud-assistant.conf   # >=1
docker exec https-proxy grep -c "metrics.alphatest" /etc/nginx/conf.d/default.conf                     # >=1 (read-only mount reflects host file)
docker exec https-proxy nginx -t
docker exec https-proxy nginx -s reload
```

### 14B.7 Verify
```bash
# nginx must serve the CORRECT cert for the metrics host (not the chat's, via fallback):
echo | openssl s_client -connect 127.0.0.1:443 -servername metrics.alphatest.udassistant.com 2>/dev/null \
  | openssl x509 -noout -subject
# -> subject=CN = metrics.alphatest.udassistant.com
```
Then browse `https://metrics.alphatest.udassistant.com/` over VPN (hard-refresh to clear any
cached "not secure"): secure padlock + the login page. Sign in with a UD Assistant account →
stats render.

### 14B.8 Gotchas hit during setup
- **Browser "not secure" / wrong cert served** (`subject=CN = alphatest...`): the new `server`
  block wasn't actually in `ud-assistant.conf`, so nginx fell back to the first/default server
  block's cert. `nginx -t`/reload still "succeed" because the existing config is valid on its
  own — a clean reload does NOT prove the new block is present. Always `grep -c "metrics.alphatest"`
  the live config after editing.
- **`certbot: command not found`** on the host: there is no host certbot — issuance is the
  certbot **Docker container** with the Cloudflare DNS plugin (13B). Use the `docker run` above.
- nginx runs in a container, so it can't reach the app on the host's `127.0.0.1`. Both containers
  share `librechat_default`; nginx proxies to `http://stats-app:8090` by name. If `nginx -t`
  errors `host not found in upstream stats-app`, the app isn't on that network.

---

## 14C. Admin console — feedback + all-user usage (`feedback.alphatest.udassistant.com`)

An **admin-only** two-tab console: **Feedback** (triage 👎 + comments, and feedback
analytics) and **Usage** (all users' stats — collective + per-user + per-session
drill-down, with charts). Lives in `BACKEND/Observability/feedback-admin/`, served on
its own subdomain, gated to `role: "ADMIN"` accounts. Separate from the per-user stats
app (14B) so the tool that reads *everyone's* data is isolated.

### 14C.1 Access & data
- **Login:** bcrypt against LibreChat Mongo `users`, AND requires `role == "ADMIN"`
  (non-admins rejected even with a valid password). The admin check is one function
  (`_is_admin`) — adjust if your schema differs. (Verified: `ch1@gmail.com` has
  `role: "ADMIN"`.)
- **Feedback:** LibreChat posts each 👍/👎 (+ tag/comment) to Langfuse as a
  `user-feedback` score (`/api/public/scores`) — these BYPASS the mask-proxy, so
  ratings + comments are stored in full. The console joins each score to its trace for
  the rated response. Score value may serialize as `true/false` or `1/0`; the code
  normalizes both (`_norm_value`).
- **Usage:** aggregates all users' traces/observations — tokens in/out, latency, tool
  calls, conversations, messages. Metrics survive masking in BOTH tiers, so usage is
  complete for every user regardless of opt-in.

### 14C.2 Masking interaction (by design)
- Feedback tab: a Tier-1 (opt-out) user's 👎 shows the rating + comment, but the rated
  **response text is blank** ("not stored"). Tier-2 (opt-in) users show the response too.
  The comment is usually the actionable part, so Tier-1 feedback is still useful.
- Usage tab: fully populated for everyone (metrics aren't masked).

### 14C.3 Deploy
Files: `feedback_admin_api.py`, `page.py`, `Dockerfile`, `requirements.txt`,
`feedback-admin.compose.yml`, `.env.example`, `README.md`. Compose attaches to
`librechat_default`, no published ports (nginx reaches it as `feedback-admin:8091`).
```bash
cd ~/Projects/UD-Assistant/BACKEND/Observability/feedback-admin
cp .env.example .env      # LANGFUSE_* keys + SESSION_SECRET=$(openssl rand -hex 32)
docker compose -f feedback-admin.compose.yml up -d --build
docker exec feedback-admin env | grep LANGFUSE     # MUST show real keys (see gotcha below)
```

### 14C.4 Subdomain + cert + nginx (mirror 14B)
1. Cloudflare A record `feedback.alphatest` → same host IP, grey cloud (DNS only).
2. Cert via the certbot Docker container (reuses the Cloudflare token):
   ```bash
   docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v ~/.secrets/certbot:/secrets:ro \
     certbot/dns-cloudflare certonly --non-interactive --agree-tos --email you@example.com \
     --dns-cloudflare --dns-cloudflare-credentials /secrets/cloudflare.ini \
     --dns-cloudflare-propagation-seconds 30 -d feedback.alphatest.udassistant.com
   ```
3. Append an nginx server block to `ud-assistant.conf` — same as 14B's block, but change
   `server_name` to `feedback.alphatest.udassistant.com`, the two cert paths to
   `.../feedback.alphatest.udassistant.com/...`, and `proxy_pass http://feedback-admin:8091`.
4. **Order matters:** the cert (step 2) and the running container (step 3 deploy) must
   BOTH exist before reloading nginx, or `nginx -t` fails (missing cert file / unknown
   upstream). Then:
   ```bash
   grep -c "feedback.alphatest" ~/Projects/UD-Assistant/FRONTEND/LibreChat/https-proxy/ud-assistant.conf  # >=1
   docker exec https-proxy nginx -t && docker exec https-proxy nginx -s reload
   echo | openssl s_client -connect 127.0.0.1:443 -servername feedback.alphatest.udassistant.com 2>/dev/null | openssl x509 -noout -subject
   # want: subject=CN = feedback.alphatest.udassistant.com
   ```
5. Browse `https://feedback.alphatest.udassistant.com/` over VPN, log in with the ADMIN
   account.

### 14C.5 Using it
- **Feedback tab:** cards (total/up/down/positive-rate), daily up/down trend, per-user
  table (most 👎 first), and a feedback list. "Only 👎" checkbox for triage; 7/30/90/180-day
  windows.
- **Usage tab:** collective cards (active users, messages, tokens in, tokens out, tool
  calls), grouped bar charts (tokens in/out per user; avg latency per user), and a per-user
  table where **clicking a row expands that user's per-session breakdown**.

### 14C.6 Prerequisites & gotchas
- **Feedback feature must exist in the LibreChat image** (score-to-Langfuse landed ~June
  2026). Confirmed working here (a 👍 produced `user-feedback: True` + a `clear_well_written`
  tag on the trace). If scores don't appear, the image may predate it, or set
  `LANGFUSE_TRACING_ENVIRONMENT` explicitly (a known bug filed scores under a different
  environment than the trace).
- **Empty dashboard + `401 Unauthorized` in `docker logs feedback-admin`** → the Langfuse
  API keys didn't reach the container (placeholder `.env`, or spaces around `=`). Fix `.env`,
  `up -d --force-recreate`, and re-check with `docker exec feedback-admin env | grep LANGFUSE`.
  Test the keys directly: `curl -s -o /dev/null -w "%{http_code}\n" -u "pk:sk"
  "http://172.22.0.1:3000/api/public/scores?limit=1"` (200 = good).
- **Usage tab performance:** it fetches observations per trace across ALL users (N+1). Fine
  for the beta; if it slows as usage grows, shorten the default window or add caching.
- `LANGFUSE_BASE_URL` here is the REAL Langfuse `:3000` (reading), not the mask-proxy.

---

## 15. Network exposure & port lockdown (security)

By default the LibreChat compose publishes several ports to `0.0.0.0` (the whole network).
For a real deployment, only the web app (behind HTTPS) should be reachable. Lock the rest to
localhost or don't publish them at all.

**Check what's currently exposed:**
```bash
docker compose ps          # look at the PORTS column
ss -tlnp | grep -E '27017|3004|7700|5432|3080'
```
A `0.0.0.0:PORT->` prefix = exposed to the network. Internal-only services show just
`PORT/tcp` (no `0.0.0.0`).

### MongoDB (27017) — closed
The example override ships `27017:27017` (exposed, and Mongo has NO auth). We REMOVED the
`mongodb` ports block from `docker-compose.override.yml` entirely — the api reaches Mongo
over the internal Docker network by service name, so no host port is needed.
- Verify: `chat-mongodb` shows `27017/tcp` (no `0.0.0.0`), and `ss -tlnp | grep 27017`
  returns nothing.
- App still connects: `docker compose logs api 2>&1 | grep -i "connected to mongo"`.
- (If you ever need host GUI access, use `- "127.0.0.1:27017:27017"` instead of removing —
  loopback only.)

### Admin panel (3004) — NOT RUN in V1
The admin panel (role/permission GUI) was published on `0.0.0.0:3004->3000` — a sensitive
service that shouldn't be network-reachable. For V1 we manage roles via `mongosh` commands
(section 11) instead, so we DON'T run the panel at all:
```bash
docker compose stop admin-panel
docker compose rm -f admin-panel
```
**Start the stack with the explicit service list** (omits admin-panel) — use this instead of
a bare `docker compose up -d`:
```bash
docker compose up -d api mongodb meilisearch rag_api vectordb
```
- Verify: `docker compose ps` does NOT list admin-panel; `ss -tlnp | grep 3004` is empty.
- (To re-enable later, just `docker compose up -d admin-panel` — but it needs
  `ADMIN_PANEL_SESSION_SECRET` and, on plain HTTP, `ADMIN_PANEL_SESSION_COOKIE_SECURE=false`.
  If you keep it, localhost-bind it: add an `admin-panel` block to the override with
  `ports: ["127.0.0.1:3004:3000"]`.)

### Meilisearch (7700) / pgvector (5432) — already internal
These show no `0.0.0.0` prefix by default — good, leave them internal. Do NOT add port
mappings for them.

### OCR service (8003) — internal, on the Docker network (no host port)
The OCR service has NO authentication, so it must never be published. We run it attached to
`librechat_default` with no `-p` flag (section 12.3), so only the `api`/`rag_api` containers
reach it by name (`ocr-service`). Verify: `sudo ss -tlnp | grep 8003` returns nothing.
> Do NOT launch it with `-p 8003:8003` (binds `0.0.0.0`, exposes the unauthenticated
> endpoints to your whole network). Binding to `172.22.0.1` also fails ("cannot assign
> requested address") — the network-attached approach is the correct fix.

### Web search: SearXNG (8080) / Firecrawl (3002) — internal, no host ports
Both run on `librechat_default` with no published ports (section 13). SearXNG has no auth;
Firecrawl's endpoints shouldn't be public either. LibreChat reaches them as `http://searxng:8080`
and `http://firecrawl-api:3002`. Verify: `sudo ss -tlnp | grep -E '8080|3002'` returns nothing.
> Firecrawl's own compose defaults to `ports: - "3002:3002"` — we comment that out and join
> the LibreChat network instead. Same principle: internal services are never published.

### The web app (3080) — exposed on purpose, but HTTP for now
`api` on `0.0.0.0:3080` is the user entrypoint, so it's meant to be reachable. BUT it's plain
HTTP right now — fine for local testing, NOT for real users. Put it behind an HTTPS reverse
proxy (roadmap / deployment plan Phase 5) and don't expose 3080 directly to the internet.

> **Rule of thumb:** databases and admin tools = never published (internal network only).
> Only the web entrypoint is public, and only behind HTTPS.

---

## 16. Data & safety notes

- Data lives in HOST BIND MOUNTS (e.g. `meili_data_vX.Y.Z`) and Docker volumes
  (e.g. `librechat_pgdata2`), NOT all in named volumes — so `docker compose down -v` does
  NOT necessarily wipe everything, and `rm -rf` on a bind path does. Know which is which
  before deleting.
- Plain `docker compose down` = safe (keeps data). `down -v` = removes named volumes.
- Mongo has NO auth by default — keep its port localhost-only or unpublished (section 15).

---

## 17. Wiping users & chats (full or partial reset)

> **IRREVERSIBLE.** This deletes ALL accounts including the ADMIN. After wiping, the first
> account you re-register becomes the new admin, and role-permission edits (hidden MCP, etc.)
> reset to defaults — re-apply them afterward (section 11).

Users and chats live in MongoDB. Message content is ALSO mirrored into Meilisearch (search
index) and uploaded-doc embeddings live in pgvector — clean those too for a true reset.

**Option A — clear just users + chats (keeps roles/agents/config):**
```bash
docker compose exec mongodb mongosh LibreChat --eval '
  db.users.deleteMany({});
  db.conversations.deleteMany({});
  db.messages.deleteMany({});
  db.sessions.deleteMany({});
  db.transactions.deleteMany({});
  db.balances.deleteMany({});
  print("cleared users + chats");
'
```

**Option B — full blank slate (drops the entire Mongo DB: users, chats, roles, agents,
presets, memories):**
```bash
docker compose exec mongodb mongosh LibreChat --eval 'db.dropDatabase()'
```

**Then clear the mirrors** (do while planning a restart):
```bash
# Meilisearch search index (host bind mount — note the version suffix):
docker compose down
sudo rm -rf /home/escobarc/Projects/UD-Assistant/librechat/LibreChat/meili_data_v1.35.1

# (optional) pgvector embeddings from uploaded documents — skip to keep indexed docs:
docker volume rm librechat_pgdata2

# bring it back up:
docker compose up -d api mongodb meilisearch rag_api vectordb
```

After restart: register a fresh account at http://localhost:3080 (becomes the new admin),
then re-apply any role-permission changes from section 11.

Quick guidance: **Option A** if you only want to clear people/conversations but keep your
role config; **Option B + clearing Meilisearch + pgvector** for a clean foundation before a
real deployment (no leftover test data).

---

## 18. Known gotchas (quick index)

| Symptom | Cause | Fix |
|---|---|---|
| `localhost` unreachable from container | container loopback ≠ host | use `172.22.0.1` |
| App crashes on startup (ZodError) | `interface.mcpServers: false` (bool) | remove it; use role perms |
| White screen | dir mounted over `dist/assets` or bad `index.html` | per-file mounts; extract compiled index.html |
| White screen AFTER image change | stale `index.html` references old hashed bundles | re-extract `index.html` from the new image |
| Logo won't update | browser cache | hard-refresh / incognito |
| Login-screen logo still LibreChat | it's `logo.svg` (same file); cache or path | confirm `logo.svg` mounted; hard-refresh |
| Unwanted endpoint in picker (OpenAI etc.) | `<PROVIDER>_API_KEY=user_provided` in .env | blank the key (section 10a) |
| Meilisearch 403 invalid key | inline `#` in key OR stale stored key | clean .env line + wipe meili data dir |
| "File Search" option missing from clip | not toggled in Tools dropdown first | enable File Search in Tools dropdown (next to clip), then it appears |
| Image upload: "Upload to Provider" missing on vLLM endpoint | custom endpoint needs `image/.*` declared | add `fileConfig.endpoints.vLLM` with `image/.*` (section 6/6A.1) |
| Model leaks `<think>` tags into answers | thinking model without reasoning parser | add `--reasoning-parser qwen3` to vLLM, or use an Instruct model (6A.5) |
| Every message errors after a long one (conversation bricked) | no `maxContextTokens`; history overflows the window forever | set `maxContextTokens` under vLLM's `--max-model-len` (6A.4) |
| Model loops on 13-25+ web searches, then chat crashes | no agent step cap + over-aggressive prompt | `recursionLimit: 8` + scoped prompt + "don't loop on logos" line (6A.4) |
| Model hallucinates facts instead of searching | temp too high / prompt too weak | temperature 0.1 + FACTUAL-override prompt (6A.2/6A.3) |
| File Search: `400 auto tool choice requires...` | vLLM launched without tool-calling | relaunch vLLM `--enable-auto-tool-choice --tool-call-parser hermes` |
| File Search: `404 file_id not found` on query | `RAG_USE_FULL_CONTEXT=true` | comment it OUT of .env, restart |
| Scanned PDF in File Search → "no visible content" | RAG doesn't OCR; embeds empty text | forked rag_api OCR fallback (section 12.4) |
| OCR service gets 404 on `/v1/files` | wrapper missing Mistral upload-first flow | implement `/v1/files` + signed-url endpoints (section 12.3) |
| OCR fallback never fires (empty ocr logs) | patch in `.load()` but embed uses `.lazy_load()` | patch shared helper used by BOTH (section 12.4) |
| Port already allocated (e.g. 3000) | another service/admin-panel on that port | free it or remap (e.g. `ADMIN_PANEL_PORT=3004`) |
| Web search toggle missing | needs BOTH `interface.webSearch:true` AND `web_search` capability | add both (section 13.3) |
| Web search returns nothing | SearXNG JSON format not enabled | add `- json` to `formats` in settings.yml |
| Firecrawl build fails on ARM (exit 100, chrome) | firecrawl-simple installs amd64 chrome | use official `firecrawl/firecrawl` multi-arch images (section 13.2) |
| Firecrawl `api` name clashes with LibreChat | both services named `api` on the network | set `container_name: firecrawl-api` |
| GHCR pull 401 unauthorized | rate-limit / auth | `docker login ghcr.io` with a PAT (read:packages) |
| LB: `connect() failed (113: Host is unreachable)` | placeholder Spark IP left in `vllm-lb.conf` | replace with real IP, `nginx -t && nginx -s reload` (section 13A.8) |
| LB: all traffic hits one Spark | `least_conn` only spreads OVERLAPPING requests; single-user traffic is sequential | expected — test with concurrent load (section 13A.6) |
| LB: `can not modify .../default.conf (read-only...)` on startup | the `:ro` config mount | harmless — ignore (section 13A.8) |
| HTTPS: browser "not secure" / red HTTPS | nginx serving the STAGING cert | re-issue real with `--force-renewal`, `nginx -s reload`; incognito to bypass cache (13B.9) |
| HTTPS: `"server" directive is not allowed here` | conf has `http {` wrapper / stray brace | use the clean 443-only conf (13B.4) |
| HTTPS: site loads wrong box / won't load | DNS A record points at wrong IP (gateway not host) | `dig +short <host>` must equal `128.175.224.14` (13B.9) |
| cert: `PermissionError: /secrets/cloudflare.ini` | container-root can't read a 600 token file | `chmod 644` the token for manual runs (13B.3) |

---

## 19. Still open / roadmap

- [x] Document File Search working for digital AND scanned PDFs (OCR + forked rag_api, section 12)
- [x] Pin a stable LibreChat image (currently `v0.8.7`, off `dev:latest`)
- [x] Local Firecrawl scraper for full web search (SearXNG + Firecrawl, section 13)
- [x] nginx load balancing across multiple identical vLLM devices (2 Sparks, section 13A)
- [x] HTTPS reverse proxy (nginx + Cloudflare DNS-01 certs) for VPN access + STT (section 13B)
- [x] Vision model + image upload (Qwen3-VL-30B-A3B-Instruct, 200k context) (sections 2, 6A)
- [x] Prompt tuning + tool-loop & context-overflow hardening (section 6A.4)
- [x] Observability: self-hosted Langfuse + two-tier consent masking proxy (metrics-only by
  default, opt-in for input/output; system prompts & web-results always stripped) — section 14A
- [ ] Registration policy + access control for the university community
- [ ] Backups (Mongo + pgvector) and monitoring (+ disk-usage alert — a 100% disk event once took out the stack; `docker system prune` / `builder prune` reclaim space)
- [ ] V2: integrate the UD-Assistant agent (decomposition + sandboxed Excel compute)
      as an OpenAI-compatible endpoint behind LibreChat