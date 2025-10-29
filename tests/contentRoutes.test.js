import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';

const baseHeaders = { Accept: 'application/json' };

test('content and course data routes', async (t) => {
  t.afterEach(() => clearSupabaseClient());

  await t.test('GET /courses/ids returns ids for user', async () => {
    setSupabaseClient(
      createSupabaseStub({
        listResponses: [{ data: [{ id: 'c1' }, { id: 'c2' }], error: null }],
      })
    );

    const res = await request(app)
      .get('/courses/ids')
      .query({ userId: '22222222-2222-2222-2222-222222222222' })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.courseIds, ['c1', 'c2']);
  });

  await t.test('GET /courses/data returns course_data for user+course', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [{ data: { id: 'c1', user_id: 'u1', course_data: { A: [] } }, error: null }],
      })
    );

    const res = await request(app)
      .get('/courses/data')
      .query({ userId: '22222222-2222-2222-2222-222222222222', courseId: '11111111-1111-1111-1111-111111111111' })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.ok(res.body.course_data);
  });

  await t.test('GET /content returns data by format and id', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [{ data: { id: 'x1', data: { question: 'Q', answer: 'A', explanation: 'E' } }, error: null }],
      })
    );

    const res = await request(app)
      .get('/content')
      .query({ format: 'flashcards', id: '11111111-1111-1111-1111-111111111111', userId: '22222222-2222-2222-2222-222222222222' })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data, { question: 'Q', answer: 'A', explanation: 'E' });
  });
});
