/**
 * Optional reranking for LibreChat's file_search (UD-Assistant patch).
 *
 * Mounted next to fileSearch.js (docker-compose.override.yml) and used only by the agents listed in
 * FILE_SEARCH_RERANK_AGENTS. For those agents, file_search asks each file for `depth` passages instead of 5, keeps
 * the `depth` closest overall (no per-file limit), asks a rerank service (an OpenAI-style /v1/rerank endpoint, such
 * as vLLM's) to score them against the query, and gives the model the 10 best. This is the reranker measured in
 * BACKEND/AGENTS/UD-CATALOG-AGENT/lab (strategy S2_R4).
 *
 * Settings (LibreChat .env):
 *   FILE_SEARCH_RERANK_AGENTS      comma-separated agent ids, or * for every agent; empty or unset = off (stock search)
 *   FILE_SEARCH_RERANK_URL         e.g. http://host.docker.internal:8002/v1/rerank
 *   FILE_SEARCH_RERANK_MODEL       the served model name
 *   FILE_SEARCH_RERANK_DEPTH       passages to rerank (default 50)
 *   FILE_SEARCH_RERANK_TIMEOUT_MS  default 5000
 *   FILE_SEARCH_RERANK_API_KEY_ENV the env var holding the service key (default VLLM_API_KEY); the key is never logged
 *
 * Failure is never fatal: on any error or timeout the result is exactly the stock one (each file's 5 closest,
 * then the 10 closest overall) and a warning is logged.
 *
 * No LibreChat imports, so it can be tested on its own: node --test patches/fileSearchRerank.test.js
 */
'use strict';

const STOCK_K = 5; // passages per file in stock LibreChat
const TOP = 10; // passages given to the model

function positiveInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function settingsFromEnv(env = process.env) {
  const agents = String(env.FILE_SEARCH_RERANK_AGENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    agents,
    url: String(env.FILE_SEARCH_RERANK_URL || '').trim(),
    model: String(env.FILE_SEARCH_RERANK_MODEL || '').trim(),
    depth: positiveInt(env.FILE_SEARCH_RERANK_DEPTH, 50),
    timeoutMs: positiveInt(env.FILE_SEARCH_RERANK_TIMEOUT_MS, 5000),
    apiKey: env[env.FILE_SEARCH_RERANK_API_KEY_ENV || 'VLLM_API_KEY'] || '',
  };
}

/**
 * Is reranking on for this agent? Off unless a URL, a model and the agent (or *) are all set. `*` means every
 * agent, never a search without one (files attached to a plain chat keep the stock search).
 */
function enabledFor(settings, agentId) {
  if (!agentId || !settings || !settings.url || !settings.model || settings.agents.length === 0) {
    return false;
  }
  return settings.agents.includes('*') || settings.agents.includes(agentId);
}

/** The k to ask each file for. */
function perFileK(settings, agentId) {
  return enabledFor(settings, agentId) ? Math.max(settings.depth, STOCK_K) : STOCK_K;
}

function byDistance(a, b) {
  return a.distance - b.distance;
}

/**
 * Stock selection: each file's STOCK_K closest, merged, the TOP closest overall.
 * @param {Array<Array<{distance: number}>>} perFile passages per file, each list in the order rag_api returned it
 */
function stockTop(perFile) {
  return perFile
    .flatMap((list) => [...list].sort(byDistance).slice(0, STOCK_K))
    .sort(byDistance)
    .slice(0, TOP);
}

/** The `depth` closest passages overall, with no per-file limit. */
function candidates(perFile, depth) {
  return perFile.flat().sort(byDistance).slice(0, depth);
}

/** POST {model, query, documents} -> scores aligned with documents. */
async function scoreWithService(settings, query, documents, fetchImpl = globalThis.fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }
    const res = await fetchImpl(settings.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: settings.model, query, documents }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`rerank service answered HTTP ${res.status}`);
    }
    const data = await res.json();
    const scores = new Array(documents.length).fill(Number.NEGATIVE_INFINITY);
    for (const item of data.results || []) {
      const i = Number(item.index);
      if (Number.isInteger(i) && i >= 0 && i < documents.length) {
        scores[i] = Number(item.relevance_score);
      }
    }
    if (scores.some((s) => !Number.isFinite(s))) {
      throw new Error('rerank service returned scores for only part of the passages');
    }
    return scores;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The passages to give the model.
 * @param {object} args
 * @param {string} args.query
 * @param {Array<Array<{distance: number, content: string}>>} args.perFile one list per file (what rag_api returned)
 * @param {object} args.settings from settingsFromEnv()
 * @param {string} [args.agentId]
 * @param {(settings, query, documents) => Promise<number[]>} [args.score] the scorer (tests pass a fake)
 * @param {{warn: Function, debug?: Function}} [args.logger]
 * @returns {Promise<{results: Array, reranked: boolean}>}
 */
async function selectPassages({ query, perFile, settings, agentId, score = scoreWithService, logger = console }) {
  if (!enabledFor(settings, agentId)) {
    return { results: stockTop(perFile), reranked: false };
  }
  const cand = candidates(perFile, settings.depth);
  if (cand.length === 0) {
    return { results: [], reranked: false };
  }
  try {
    const started = Date.now();
    const scores = await score(
      settings,
      query,
      cand.map((p) => String(p.content || '').trim()),
    );
    const order = cand
      .map((p, i) => ({ p, i, s: scores[i] }))
      .sort((a, b) => b.s - a.s || a.i - b.i); // ties keep the distance order
    if (logger.debug) {
      logger.debug(`[file_search] reranked ${cand.length} passages in ${Date.now() - started} ms`);
    }
    return { results: order.slice(0, TOP).map((x) => x.p), reranked: true };
  } catch (error) {
    logger.warn(`[file_search] rerank failed, using the stock search: ${error && error.message}`);
    return { results: stockTop(perFile), reranked: false };
  }
}

module.exports = {
  STOCK_K,
  TOP,
  settingsFromEnv,
  enabledFor,
  perFileK,
  stockTop,
  candidates,
  scoreWithService,
  selectPassages,
};
