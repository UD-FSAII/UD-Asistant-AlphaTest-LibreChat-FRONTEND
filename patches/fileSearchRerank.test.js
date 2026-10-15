/**
 * Tests for fileSearchRerank.js (no LibreChat dependencies): node --test patches/fileSearchRerank.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('./fileSearchRerank');

const AGENT = 'agent_ud';
const ON = {
  FILE_SEARCH_RERANK_AGENTS: `${AGENT}, agent_other`,
  FILE_SEARCH_RERANK_URL: 'http://reranker.test/v1/rerank',
  FILE_SEARCH_RERANK_MODEL: 'reranker-model',
  VLLM_API_KEY: 'secret-key',
};
const quiet = { warn: () => {}, debug: () => {} };

/** perFile[f] = `n` passages of file f, closest first, distances interleaved across files. */
function makePerFile(files, n, start = 0.1) {
  return Array.from({ length: files }, (_, f) =>
    Array.from({ length: n }, (_, i) => ({
      content: `file${f} passage${i}`,
      distance: start + i * 0.01 + f * 0.001,
      filename: `F${f}.txt`,
    })),
  );
}

/** Stock LibreChat: each file returns its 5 closest; flatten, sort by distance, keep 10. */
function stockLibreChat(perFile) {
  return perFile
    .flatMap((list) => list.slice(0, 5))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 10);
}

test('settings: off unless agents, url and model are all set; * means every agent, never no agent', () => {
  const on = R.settingsFromEnv(ON);
  assert.deepEqual(on.agents, [AGENT, 'agent_other']);
  assert.equal(on.depth, 50);
  assert.equal(on.timeoutMs, 5000);
  assert.equal(on.apiKey, 'secret-key');
  assert.equal(R.enabledFor(on, AGENT), true);
  assert.equal(R.enabledFor(on, 'agent_unlisted'), false);
  assert.equal(R.enabledFor(on, undefined), false);
  assert.equal(R.enabledFor(R.settingsFromEnv({ ...ON, FILE_SEARCH_RERANK_AGENTS: '' }), AGENT), false);
  assert.equal(R.enabledFor(R.settingsFromEnv({ ...ON, FILE_SEARCH_RERANK_URL: '' }), AGENT), false);
  assert.equal(R.enabledFor(R.settingsFromEnv({ ...ON, FILE_SEARCH_RERANK_MODEL: '' }), AGENT), false);
  assert.equal(R.enabledFor(R.settingsFromEnv({}), AGENT), false);
  const star = R.settingsFromEnv({ ...ON, FILE_SEARCH_RERANK_AGENTS: '*' });
  assert.equal(R.enabledFor(star, 'agent_any'), true);
  assert.equal(R.enabledFor(star, undefined), false);
  assert.equal(R.settingsFromEnv({ ...ON, FILE_SEARCH_RERANK_DEPTH: 'lots' }).depth, 50);
  assert.equal(R.settingsFromEnv({ ...ON, FILE_SEARCH_RERANK_API_KEY_ENV: 'OTHER', OTHER: 'k2' }).apiKey, 'k2');
});

test('per-file k: 5 when off (stock), depth when on', () => {
  const on = R.settingsFromEnv({ ...ON, FILE_SEARCH_RERANK_DEPTH: '50' });
  assert.equal(R.perFileK(on, AGENT), 50);
  assert.equal(R.perFileK(on, 'agent_unlisted'), 5);
  assert.equal(R.perFileK(R.settingsFromEnv({}), AGENT), 5);
});

test('stock selection equals stock LibreChat, also when files returned more than 5', () => {
  for (const [files, n] of [
    [38, 5],
    [38, 50],
    [3, 2],
    [1, 50],
  ]) {
    const perFile = makePerFile(files, n);
    assert.deepEqual(R.stockTop(perFile), stockLibreChat(perFile));
  }
});

test('candidates are the closest overall, with no per-file limit', () => {
  const perFile = makePerFile(4, 50);
  perFile[2] = perFile[2].map((p, i) => ({ ...p, distance: 0.001 + i * 0.0001 }));
  const cand = R.candidates(perFile, 50);
  assert.equal(cand.length, 50);
  assert.equal(cand.filter((p) => p.filename === 'F2.txt').length, 50);
  assert.ok(cand.every((p, i) => i === 0 || cand[i - 1].distance <= p.distance));
});

test('enabled: the 10 best by rerank score, ties keep the distance order', async () => {
  const settings = R.settingsFromEnv(ON);
  const perFile = makePerFile(10, 50);
  const seen = [];
  const score = async (s, query, docs) => {
    seen.push({ query, n: docs.length });
    return docs.map((d, i) => (i === 49 ? 1 : i === 48 ? 0.9 : 0.5));
  };
  const { results, reranked } = await R.selectPassages({
    query: 'q',
    perFile,
    settings,
    agentId: AGENT,
    score,
    logger: quiet,
  });
  const cand = R.candidates(perFile, 50);
  assert.equal(reranked, true);
  assert.deepEqual(seen, [{ query: 'q', n: 50 }]);
  assert.equal(results.length, 10);
  assert.equal(results[0], cand[49]);
  assert.equal(results[1], cand[48]);
  assert.deepEqual(results.slice(2), cand.slice(0, 8));
});

test('disabled agent: stock result, the reranker is never called', async () => {
  const perFile = makePerFile(38, 5);
  let calls = 0;
  const { results, reranked } = await R.selectPassages({
    query: 'q',
    perFile,
    settings: R.settingsFromEnv(ON),
    agentId: 'agent_unlisted',
    score: async () => {
      calls += 1;
      return [];
    },
    logger: quiet,
  });
  assert.equal(calls, 0);
  assert.equal(reranked, false);
  assert.deepEqual(results, stockLibreChat(perFile));
});

test('a failing reranker falls back to exactly the stock result and warns without the key', async () => {
  const perFile = makePerFile(38, 50);
  const warnings = [];
  const { results, reranked } = await R.selectPassages({
    query: 'q',
    perFile,
    settings: R.settingsFromEnv(ON),
    agentId: AGENT,
    score: async () => {
      throw new Error('rerank service answered HTTP 503');
    },
    logger: { warn: (m) => warnings.push(m), debug: () => {} },
  });
  assert.equal(reranked, false);
  assert.deepEqual(results, stockLibreChat(perFile));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /HTTP 503/);
  assert.doesNotMatch(warnings[0], /secret-key/);
});

test('no passages at all: nothing to rerank', async () => {
  const { results } = await R.selectPassages({
    query: 'q',
    perFile: [[], []],
    settings: R.settingsFromEnv(ON),
    agentId: AGENT,
    score: async () => assert.fail('must not be called'),
    logger: quiet,
  });
  assert.deepEqual(results, []);
});

test('the service call: body, bearer key, scores by index', async () => {
  const settings = R.settingsFromEnv(ON);
  let sent;
  const fetchImpl = async (url, init) => {
    sent = { url, init };
    return {
      ok: true,
      json: async () => ({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.2 },
        ],
      }),
    };
  };
  const scores = await R.scoreWithService(settings, 'query', ['a', 'b'], fetchImpl);
  assert.deepEqual(scores, [0.2, 0.9]);
  assert.equal(sent.url, ON.FILE_SEARCH_RERANK_URL);
  assert.equal(sent.init.headers.Authorization, 'Bearer secret-key');
  assert.deepEqual(JSON.parse(sent.init.body), { model: 'reranker-model', query: 'query', documents: ['a', 'b'] });
});

test('the service call fails on HTTP errors, partial scores and timeouts', async () => {
  const settings = { ...R.settingsFromEnv(ON), timeoutMs: 20 };
  await assert.rejects(
    R.scoreWithService(settings, 'q', ['a'], async () => ({ ok: false, status: 500 })),
    /HTTP 500/,
  );
  await assert.rejects(
    R.scoreWithService(settings, 'q', ['a', 'b'], async () => ({
      ok: true,
      json: async () => ({ results: [{ index: 0, relevance_score: 1 }] }),
    })),
    /only part/,
  );
  const hang = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  await assert.rejects(R.scoreWithService(settings, 'q', ['a'], hang), /aborted/);
});
