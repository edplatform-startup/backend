import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import app from '../src/app.js';
import { setOpenRouterChatExecutor, clearOpenRouterChatExecutor } from '../src/services/grokClient.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub, TEST_AUTH_TOKEN } from './helpers/supabaseStub.js';

const authHeaders = { Authorization: `Bearer ${TEST_AUTH_TOKEN}` };

test('POST /chat rejects requests without auth', async () => {
  const res = await request(app).post('/chat').send({});
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Authorization header is required/);
});

test('POST /chat rejects missing fields', async () => {
  setSupabaseClient(createSupabaseStub({}));
  const res1 = await request(app).post('/chat').send({}).set(authHeaders);
  assert.equal(res1.statusCode, 400);

  const res2 = await request(app).post('/chat').send({ system: 's' }).set(authHeaders);
  assert.equal(res2.statusCode, 400);
  clearSupabaseClient();
});

test('POST /chat returns model and content, passes options through', async () => {
  setSupabaseClient(createSupabaseStub({}));
  let capturedOptions = null;
  setOpenRouterChatExecutor(async (options) => {
    capturedOptions = options;
    return { content: 'Hello world' };
  });

  const body = {
    system: 'You are helpful.',
    user: 'Say hello',
    userId: '22222222-2222-2222-2222-222222222222',
    context: { foo: 'bar' },
    useWebSearch: true,
    responseFormat: 'text',
    temperature: 0.2,
    maxTokens: 128,
  };

  const res = await request(app).post('/chat').send(body).set(authHeaders);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.model, 'x-ai/grok-4.1-fast');
  assert.equal(res.body.content, 'Hello world');

  // Validate payload assembly
  assert.ok(capturedOptions);
  assert.equal(capturedOptions.model, 'x-ai/grok-4.1-fast');
  assert.equal(capturedOptions.temperature, 0.2);
  assert.equal(capturedOptions.maxTokens, 128);
  assert.ok(Array.isArray(capturedOptions.messages));
  // messages: [system, optional context (system), user]
  assert.equal(capturedOptions.messages[0].role, 'system');
  assert.match(capturedOptions.messages[0].content, /You are helpful/);
  assert.equal(capturedOptions.messages[1].role, 'system');
  assert.match(capturedOptions.messages[1].content, /Context:/);
  assert.equal(capturedOptions.messages[2].role, 'user');
  assert.match(capturedOptions.messages[2].content, /Say hello/);

  // tools included when useWebSearch=true
  assert.ok(Array.isArray(capturedOptions.tools));
  assert.ok(capturedOptions.tools.length >= 1);
  // Default reasoning should be 'medium' when not specified
  assert.equal(capturedOptions.reasoning, 'medium');

  clearOpenRouterChatExecutor();
  clearSupabaseClient();
});

test('POST /chat allows overriding reasoning', async () => {
  setSupabaseClient(createSupabaseStub({}));
  let capturedOptions = null;
  setOpenRouterChatExecutor(async (options) => {
    capturedOptions = options;
    return { content: 'Override' };
  });

  const body = {
    system: 'You are helpful.',
    user: 'Say hi',
    userId: '22222222-2222-2222-2222-222222222222',
    reasoning: 'high',
  };

  const res = await request(app).post('/chat').send(body).set(authHeaders);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.content, 'Override');
  assert.equal(capturedOptions.reasoning, 'high');

  clearOpenRouterChatExecutor();
  clearSupabaseClient();
});
