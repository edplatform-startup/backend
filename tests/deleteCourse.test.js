import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';

test('DELETE /courses', async (t) => {
  t.afterEach(() => clearSupabaseClient());

  await t.test('requires userId and courseId', async () => {
    const res1 = await request(app).delete('/courses').query({});
    assert.equal(res1.status, 400);

    const res2 = await request(app).delete('/courses').query({ userId: '22222222-2222-2222-2222-222222222222' });
    assert.equal(res2.status, 400);
  });

  await t.test('validates UUID format', async () => {
    const res = await request(app).delete('/courses').query({ userId: 'invalid', courseId: '11111111-1111-1111-1111-111111111111' });
    assert.equal(res.status, 400);
  });

  await t.test('returns 404 if course not found or does not belong to user', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [{ data: null, error: { code: 'PGRST116' } }],
      })
    );

    const res = await request(app)
      .delete('/courses')
      .query({ userId: '22222222-2222-2222-2222-222222222222', courseId: '11111111-1111-1111-1111-111111111111' });

    assert.equal(res.status, 404);
    assert.match(res.body.error, /not found/i);
  });

  await t.test('deletes course successfully', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [{ data: { id: '11111111-1111-1111-1111-111111111111' }, error: null }],
        deleteResponses: [{ data: null, error: null }],
        storageListResponses: [{ data: [{ name: 'file1.pdf' }], error: null }],
        storageRemoveResponses: [{ data: [{}], error: null }],
      })
    );

    const res = await request(app)
      .delete('/courses')
      .query({ userId: '22222222-2222-2222-2222-222222222222', courseId: '11111111-1111-1111-1111-111111111111' });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.courseId, '11111111-1111-1111-1111-111111111111');
    assert.equal(res.body.storageFilesDeleted, 1);
  });
});
