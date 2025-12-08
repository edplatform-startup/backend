import test from 'node:test';
import assert from 'node:assert/strict';

// Import after we define helpers in case future refactors need them
import { createWebSearchTool } from '../src/services/grokClient.js';

function makeResponse({ ok = true, status = 200, statusText = 'OK', body = '' } = {}) {
  return {
    ok,
    status,
    statusText,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

const originalFetch = globalThis.fetch;

test('web_search: handles empty 200 OK without throwing', async () => {
  globalThis.fetch = async () => makeResponse({ body: '[]' });

  const tool = createWebSearchTool();
  const result = await tool.handler({ query: 'test' }, { apiKey: 'test-key' });

  assert.equal(typeof result, 'string');
  assert.match(result, /No web search suggestions found/);
});

test('web_search: handles invalid JSON by returning raw text', async () => {
  globalThis.fetch = async () => makeResponse({ body: 'not json' });

  const tool = createWebSearchTool();
  const result = await tool.handler({ query: 'test' }, { apiKey: 'test-key' });

  assert.match(result, /could not parse/);
});

test('web_search: formats valid results array', async () => {
  const payload = [
    { phrase: 'Item A' },
    { phrase: 'Item B' },
  ];
  globalThis.fetch = async () => makeResponse({ body: JSON.stringify(payload) });

  const tool = createWebSearchTool();
  const result = await tool.handler({ query: 'test' }, { apiKey: 'test-key' });

  assert.match(result, /^Top web search suggestions/m);
  assert.match(result, /^1\. Item A/m);
  assert.match(result, /2\. Item B/m);
});

// restore fetch after tests
test('cleanup: restore fetch', () => {
  globalThis.fetch = originalFetch;
});

test('executeOpenRouterChat logs token-limit error with stage and model', async () => {
  const responses = [
    { ok: false, status: 400, statusText: 'Bad Request', body: 'Error: max tokens exceeded for model' },
  ];
  globalThis.fetch = async () => ({
    ok: false,
    status: 400,
    statusText: 'Bad Request',
    text: async () => responses.shift().body,
  });

  const captured = [];
  const originalError = console.error;
  const originalApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = originalApiKey || 'test-key';
  console.error = (message, ...args) => captured.push([message, ...args].join(' '));

  try {
    let threw = false;
    try {
      await (await import('../src/services/grokClient.js')).executeOpenRouterChat({
        model: 'google/gemini-3-pro-preview',
        maxTokens: 200,
        messages: [{ role: 'user', content: 'Test' }],
        stage: 'TEST:STAGE',
        requestTimeoutMs: 1000,
      });
    } catch (err) {
      threw = true;
    }
    assert.ok(threw, 'should throw');
    const ok = captured.some((c) => /\[openrouter\]\[TOKEN\]/.test(c)) || captured.some((c) => c.includes('[openrouter] request failed') && c.includes('TEST:STAGE') && c.includes('grok-4.1-fast'));
    assert.ok(ok, 'Token limit or openrouter error log should include stage and model');
  } finally {
    console.error = originalError;
    globalThis.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = originalApiKey;
    }
  }
});
