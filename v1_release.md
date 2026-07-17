# UD Assistant — V1 Feature Scope

What the V1 (beta) release of the UD Assistant is and isn't. Status is marked honestly:
✅ working/verified · 🟡 in progress / being debugged · 🔜 planned, not yet built · ❌ out of scope for V1.

---

## Stack / architecture

| Layer | Choice | Status |
|---|---|---|
| **Frontend / UI** | LibreChat (pinned stable image `v0.8.6`), branded as UD Assistant | ✅ |
| **Chat model** | Qwen3-30B-A3B-Instruct-FP8 on vLLM (OpenAI-compatible) | ✅ |
| **Embeddings** | `BAAI/bge-base-en-v1.5` on vLLM (for document RAG) | ✅ |
| **Reranker** | `BAAI/bge-reranker-base` on vLLM | 🟡 available, not yet wired into search |
| **App database** | MongoDB (users, chats, roles) | ✅ |
| **Vector store** | pgvector (document embeddings for RAG) | ✅ |
| **Search index** | Meilisearch (conversation search) | ✅ |
| **RAG service** | LibreChat rag_api (lite image, remote embeddings) | ✅ |
| **Web search** | SearXNG + local scraper | 🔜 planned, not in V1 |
| **Load balancing** | nginx in front of vLLM (multiple identical devices) | 🔜 planned, not yet built |
| **HTTPS / public access** | reverse proxy (Caddy/nginx) | 🔜 required before public use |

---

## What the chatbot CAN do (V1)

- ✅ **General conversation** — chat with Qwen3 for Q&A, writing help, explanations, etc.
- ✅ **Conversation history** — chats are saved per user; searchable via the search bar.
- ✅ **Multiple users** — each has their own private account, chats, and history.
- ✅ **Document Q&A (File Search / RAG)** 🟡 — upload a document (PDF, text, etc.), the
  assistant retrieves relevant passages and answers grounded in them. *(Being finalized —
  depends on vLLM tool-calling, currently in debug.)*
- ✅ **"Upload as Text"** — drop a document's full text into the prompt for one-off questions
  (works without RAG; good for short docs).
- ✅ **Memory** — optional per-user memory of stated preferences/facts across chats
  (if enabled).
- ✅ **Browser-based speech** — voice input (mic) and read-aloud, using the user's own
  browser. *(Mic input requires HTTPS for remote users; works on localhost now.)*
- ✅ **Bookmarks / tags** — organize conversations with labels.
- ✅ **Prompt templates** — saved reusable prompts with variables.

## What the chatbot CANNOT do (V1 — out of scope)

- ❌ **Code execution / Code Interpreter** — no running of generated code. *(Sandboxing
  untrusted code is complex and a security risk; deferred.)*
- ❌ **Spreadsheet computation** — cannot compute over Excel data (e.g. "average grade by
  department"). RAG retrieves text passages; it does NOT do calculations on tabular data.
  *(This is the headline feature of the separate UD-Assistant agent — planned for V2.)*
- ❌ **Web search** — no live internet lookups in V1 (SearXNG planned later).
- ❌ **Agents / agent builder** — hidden; no custom multi-tool agents for users.
- ❌ **MCP tools / external integrations** — disabled.
- ❌ **Image generation** — not configured.
- ❌ **Self-service signup** — closed beta; accounts are created by the admin only.
- ❌ **Self-service password reset** — no email configured; admin manages passwords.
- ❌ **Multiple model choice** — single model (Qwen3); no OpenAI/Anthropic/etc. endpoints.

---

## Access & accounts (V1 beta)

- **Closed registration** — no public signup. The admin creates each account from emails
  beta testers provide.
- **Email/password login**, no email verification step (beta scale).
- **Small beta group** — hand-provisioned; not yet sized for a full-community rollout.

---

## Known constraints / honest caveats

- **Context window:** ~30k tokens. Long chats drop the oldest messages; very large
  documents may exceed context (RAG mitigates this by retrieving only relevant chunks).
- **Document analysis = retrieval, not computation.** The assistant can find and quote what
  a document *says*; it cannot crunch numbers in a spreadsheet. Set user expectations here.
- **Concurrency** bounded by the single vLLM model until nginx load balancing is added.
- **HTTP only right now** — must move behind HTTPS before real/remote users (mic input and
  secure sessions depend on it).
- **Beta = expect rough edges** — file search and a few features are freshly wired.

---

## Roadmap (post-V1)

- 🔜 Finish + harden document File Search (tool-calling, reranking).
- 🔜 nginx load balancing across multiple vLLM devices.
- 🔜 HTTPS reverse proxy for public access.
- 🔜 SearXNG web search.
- 🔜 Backups + monitoring.
- 🔜 **V2:** integrate the UD-Assistant agent — query decomposition, **sandboxed Excel
  computation**, per-session retrieval — as an OpenAI-compatible endpoint behind LibreChat.