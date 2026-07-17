# nginx Load Balancing for vLLM — Setup

Fans LibreChat's single LLM endpoint across **2 identical Qwen3 backends**
(Spark A local, Spark B remote over the UD network). Direct proxy, no SSH
tunnels — justified because `:8000` is **blocked off-campus** (verified) and
both Sparks share the same `VLLM_API_KEY`.

```
LibreChat ──baseURL──► vllm-lb (nginx) ──► 172.22.0.1:8000   (Spark A, local host vLLM)
                                        └─► 128.175.<B>:8000  (Spark B, remote)
```

Files: `vllm-lb.conf` (nginx), `vllm-lb.compose.yml` (service), this doc.

---

## STEP 0 — Preflight (do these BEFORE starting nginx)

### 0a. Confirm each Spark's vLLM bind (the one unknown)
nginx must reach BOTH backends. vLLM only accepts connections on the
interface it's bound to (`--host`).

- **Spark B (remote) — the one that matters most.** From Spark A, run:
  ```bash
  curl -s -H "Authorization: Bearer $VLLM_API_KEY" \
       http://128.175.<B>:8000/v1/models
  ```
  - Get a JSON model list → Spark B is bound to a routable interface. Good.
  - Connection refused / timeout → Spark B's vLLM is bound to `127.0.0.1`
    only. Fix: relaunch it with `--host 0.0.0.0` (see launch_vllm.py), OR
    bind it to the specific 128.175 IP. Since `:8000` is firewalled
    off-campus, `0.0.0.0` here means "reachable within UD," not "world."

- **Spark A (local).** From *inside* a container on `librechat_default`:
  ```bash
  docker run --rm --network librechat_default curlimages/curl \
    -s -H "Authorization: Bearer $VLLM_API_KEY" \
    http://172.22.0.1:8000/v1/models
  ```
  If this fails, Spark A's vLLM is bound to `127.0.0.1` and the docker
  gateway can't reach it. Relaunch with `--host 0.0.0.0` (it will still be
  firewalled off-campus). This is the SAME 172.22.0.1 rule already in your
  librechat.yaml, so if LibreChat currently reaches vLLM directly, this
  already works.

### 0b. Confirm the network name
```bash
docker network ls | grep librechat
```
Use `librechat_default`. If you see `librechat_devcontainer_default`, ignore
it (the known stray).

### 0c. Set the Spark B IP
Edit `vllm-lb.conf` → replace `128.175.224.15` with Spark B's real IP.
(Handoff notes Spark A = 128.175.224.14; confirm B's actual address.)

---

## STEP 1 — Start the load balancer

Put `vllm-lb.conf` and `vllm-lb.compose.yml` in the same directory
(e.g. `FRONTEND/LibreChat/vllm-lb/`), then:

```bash
cd FRONTEND/LibreChat/vllm-lb
docker compose -f vllm-lb.compose.yml up -d
docker logs vllm-lb          # should show nginx started, no upstream errors
```

Verify from inside the network that the LB answers and reaches a backend:
```bash
docker run --rm --network librechat_default curlimages/curl \
  -s http://vllm-lb:8000/lb-health          # -> "vllm-lb ok"

docker run --rm --network librechat_default curlimages/curl \
  -s -H "Authorization: Bearer $VLLM_API_KEY" \
  http://vllm-lb:8000/v1/models             # -> model list, proving fan-out
```

---

## STEP 2 — Point LibreChat at the LB

In `librechat.yaml`, change the vLLM custom endpoint baseURL:

```yaml
  custom:
    - name: "vLLM"
      apiKey: "${VLLM_API_KEY}"
      baseURL: "http://vllm-lb:8000/v1"     # was http://172.22.0.1:8000/v1
```

The API key is unchanged — nginx forwards the Authorization header
untouched, and both Sparks accept the same key.

Restart just the api container to reload config:
```bash
cd FRONTEND/LibreChat
docker compose up -d api
```

Send a chat message and confirm streaming still works token-by-token
(that's the `proxy_buffering off` block doing its job).

---

## STEP 3 — Confirm both backends actually receive traffic
Tail vLLM logs on BOTH Sparks while you send several chat requests. You
should see requests land on each. With `least_conn` and light beta traffic,
distribution won't be 50/50 — it follows active load, which is correct.

---

## Rollback (fast)
If anything misbehaves, revert LibreChat to the direct backend and stop nginx:
```bash
# librechat.yaml: baseURL back to http://172.22.0.1:8000/v1
cd FRONTEND/LibreChat && docker compose up -d api
docker compose -f vllm-lb/vllm-lb.compose.yml down
```
You're back to single-Spark with zero residue.

---

## Behavior notes / gotchas
- **Streaming:** `proxy_buffering off` + HTTP/1.1 keepalive is what preserves
  SSE. Without it, users see the whole reply appear at once after a long wait.
- **Failover is connection-level only.** If a backend refuses a connection,
  nginx retries the other. If a backend dies *mid-stream* (after headers are
  sent), that one response fails — nginx can't un-send a stream. The next
  request routes around the dead box via passive health checks.
- **A down backend is invisible to users** after the first few failures trip
  `max_fails`, until `fail_timeout` elapses and nginx probes it again.
- **Adding a 3rd+ Spark later:** add one `server ...:8000` line to the
  upstream block and `docker exec vllm-lb nginx -s reload`. No LibreChat change.
- **This is HTTP, internal to librechat_default.** TLS for end users is the
  NEXT roadmap item (HTTPS reverse proxy in front of LibreChat) — separate
  layer, don't conflate it with this internal LB.
- **Same-box note:** nginx and Spark A's vLLM share hardware. The LB is
  featherweight (idle nginx ~ a few MB), so it won't meaningfully tax the GPU
  box, but it does mean Spark A is a single point of failure for the LB
  itself. Acceptable for beta; revisit if you later move the LB to a 3rd host.
```
