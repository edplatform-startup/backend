import test from 'node:test';
import assert from 'node:assert/strict';

import {
  embedTexts,
  setEmbeddingsExecutor,
  clearEmbeddingsExecutor,
} from '../src/services/embeddingsClient.js';

const originalFetch = globalThis.fetch;
const originalApiKey = process.env.OPENROUTER_API_KEY;

function makeResponse({ ok = true, status = 200, statusText = 'OK', body = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

function mockEmbeddingsResponse(texts) {
  return JSON.stringify({
    data: texts.map((_, i) => ({
      index: i,
      embedding: [0.1 * i, 0.2 * i, 0.3 * i],
    })),
    model: 'openai/text-embedding-3-small',
    usage: { prompt_tokens: 10, total_tokens: 10 },
  });
}

test.beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-api-key';
});

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  clearEmbeddingsExecutor();
  if (originalApiKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = originalApiKey;
  }
});

test('embedTexts: returns empty array for empty input', async () => {
  const result = await embedTexts([]);
  assert.deepEqual(result, []);
});

test('embedTexts: throws if texts is not an array', async () => {
  await assert.rejects(
    () => embedTexts('not an array'),
    { message: 'texts must be an array of strings' }
  );
});

test('embedTexts: calls API with correct payload', async () => {
  let capturedBody = null;
  let capturedHeaders = null;

  globalThis.fetch = async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    capturedHeaders = opts.headers;
    return makeResponse({ body: mockEmbeddingsResponse(['hello', 'world']) });
  };

  await embedTexts(['hello', 'world']);

  assert.equal(capturedBody.model, 'openai/text-embedding-3-small');
  assert.deepEqual(capturedBody.input, ['hello', 'world']);
  assert.equal(capturedHeaders.Authorization, 'Bearer test-api-key');
  assert.equal(capturedHeaders['Content-Type'], 'application/json');
});

test('embedTexts: returns embeddings in correct order', async () => {
  globalThis.fetch = async () => {
    // Return out of order to test sorting
    return makeResponse({
      body: JSON.stringify({
        data: [
          { index: 1, embedding: [0.4, 0.5, 0.6] },
          { index: 0, embedding: [0.1, 0.2, 0.3] },
        ],
      }),
    });
  };

  const result = await embedTexts(['first', 'second']);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], [0.1, 0.2, 0.3]);
  assert.deepEqual(result[1], [0.4, 0.5, 0.6]);
});

test('embedTexts: batches requests', async () => {
  let callCount = 0;
  const batchesReceived = [];

  globalThis.fetch = async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    batchesReceived.push(body.input);
    return makeResponse({ body: mockEmbeddingsResponse(body.input) });
  };

  const texts = Array.from({ length: 150 }, (_, i) => `text ${i}`);
  const result = await embedTexts(texts, { batchSize: 64 });

  assert.equal(callCount, 3); // 64 + 64 + 22
  assert.equal(batchesReceived[0].length, 64);
  assert.equal(batchesReceived[1].length, 64);
  assert.equal(batchesReceived[2].length, 22);
  assert.equal(result.length, 150);
});

test('embedTexts: retries on 429', async () => {
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount++;
    if (callCount === 1) {
      return makeResponse({ ok: false, status: 429, statusText: 'Too Many Requests', body: 'Rate limited' });
    }
    return makeResponse({ body: mockEmbeddingsResponse(['test']) });
  };

  const result = await embedTexts(['test']);

  assert.equal(callCount, 2);
  assert.equal(result.length, 1);
});

test('embedTexts: retries on 5xx', async () => {
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount++;
    if (callCount <= 2) {
      return makeResponse({ ok: false, status: 502, statusText: 'Bad Gateway', body: 'Server error' });
    }
    return makeResponse({ body: mockEmbeddingsResponse(['test']) });
  };

  const result = await embedTexts(['test']);

  assert.equal(callCount, 3);
  assert.equal(result.length, 1);
});

test('embedTexts: throws after max retries', async () => {
  globalThis.fetch = async () => {
    return makeResponse({ ok: false, status: 500, statusText: 'Internal Server Error', body: 'Server error' });
  };

  await assert.rejects(
    () => embedTexts(['test']),
    (err) => err.statusCode === 500
  );
});

test('embedTexts: throws on 4xx (non-429)', async () => {
  globalThis.fetch = async () => {
    return makeResponse({ ok: false, status: 400, statusText: 'Bad Request', body: 'Invalid model' });
  };

  await assert.rejects(
    () => embedTexts(['test']),
    (err) => err.statusCode === 400
  );
});

test('embedTexts: throws on missing API key', async () => {
  delete process.env.OPENROUTER_API_KEY;

  await assert.rejects(
    () => embedTexts(['test']),
    { message: 'Missing OpenRouter API key (set OPENROUTER_API_KEY)' }
  );
});

test('embedTexts: uses custom model', async () => {
  let capturedModel = null;

  globalThis.fetch = async (url, opts) => {
    capturedModel = JSON.parse(opts.body).model;
    return makeResponse({ body: mockEmbeddingsResponse(['test']) });
  };

  await embedTexts(['test'], { model: 'custom/model' });

  assert.equal(capturedModel, 'custom/model');
});

test('embedTexts: custom executor override works', async () => {
  const mockEmbeddings = [[0.5, 0.6, 0.7]];
  setEmbeddingsExecutor(() => mockEmbeddings);

  const result = await embedTexts(['test']);

  assert.deepEqual(result, mockEmbeddings);
});

test('embedTexts: handles invalid JSON response', async () => {
  globalThis.fetch = async () => {
    return makeResponse({ body: 'not json' });
  };

  await assert.rejects(
    () => embedTexts(['test']),
    { message: /invalid JSON/i }
  );
});

test('embedTexts: handles empty response', async () => {
  globalThis.fetch = async () => {
    return makeResponse({ body: '' });
  };

  await assert.rejects(
    () => embedTexts(['test']),
    { message: /empty response/i }
  );
});

test('embedTexts: handles missing data array in response', async () => {
  globalThis.fetch = async () => {
    return makeResponse({ body: JSON.stringify({ model: 'test' }) });
  };

  await assert.rejects(
    () => embedTexts(['test']),
    { message: /missing data array/i }
  );
});
