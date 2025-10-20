import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';

const baseHeaders = {
  Accept: 'application/json',
};

test('GET / returns service metadata', async () => {
  const res = await request(app).get('/').set(baseHeaders);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { name: 'edtech-backend-api', ok: true });
});

