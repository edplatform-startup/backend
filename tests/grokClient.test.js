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
