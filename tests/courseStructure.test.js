import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import {
  setCourseStructureGenerator,
  clearCourseStructureGenerator,
} from '../src/services/courseGenerator.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';
import { setOpenRouterChatExecutor, clearOpenRouterChatExecutor } from '../src/services/grokClient.js';

const baseHeaders = { Accept: 'application/json' };

const validBody = {
  topics: ['Foundations', 'Algorithms'],
  className: 'CS101 Final',
  startDate: '2025-01-01T00:00:00.000Z',
  endDate: '2025-02-01T00:00:00.000Z',
  userId: '22222222-2222-2222-2222-222222222222',
  topicFamiliarity: {
    Foundations: 'novice',
    Algorithms: 'intermediate',
  },
  syllabusText: 'Overview of course topics and expectations.',
  syllabusFiles: [
    { name: 'syllabus.pdf', url: 'https://example.com/syllabus.pdf', type: 'application/pdf' },
  ],
  examStructureText: 'Midterms and finals with projects.',
  examStructureFiles: [
    { name: 'exam-guide.pdf', content: 'YmFzZTY0RG9jdW1lbnQ=', type: 'application/pdf' },
  ],
};

const mockStructure = {
  'Module 1/Basics': [
    {
      Format: 'video',
      content: 'Introduce fundamental concepts in under 15 minutes.',
    },
  ],
  'Module 2/Practice': [
    {
      Format: 'reading',
      content: 'Provide curated readings for algorithms preparation.',
    },
  ],
};

test('course structure generation route', async (t) => {
  t.afterEach(() => {
    clearCourseStructureGenerator();
    clearSupabaseClient();
    clearOpenRouterChatExecutor();
  });

  await t.test('rejects missing topics', async () => {
    const res = await request(app)
      .post('/course-structure')
      .set('Content-Type', 'application/json')
      .set(baseHeaders)
      .send({ ...validBody, topics: [] });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /topics must contain at least one topic/);
  });

  await t.test('requires userId', async () => {
    const { userId, ...bodyWithoutUser } = validBody;
    const res = await request(app)
      .post('/course-structure')
      .set('Content-Type', 'application/json')
      .set(baseHeaders)
      .send(bodyWithoutUser);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /userId is required/);
  });

  await t.test('returns course structure when generation succeeds and persists per-asset content', async () => {
    let receivedPayload = null;
    setCourseStructureGenerator((payload) => {
      receivedPayload = payload;
      return {
        model: 'x-ai/grok-4-fast',
        raw: JSON.stringify(mockStructure),
        courseStructure: mockStructure,
      };
    });

    const insertedPayloads = [];
    const updatedPayloads = [];
    // Provide fake API key and stub per-asset model calls
    process.env.OPENROUTER_API_KEY = 'test-key';
    setOpenRouterChatExecutor(async ({ messages }) => {
      const user = messages?.find((m) => m.role === 'user')?.content || '';
      let parsed;
      // Check for video prompt (contains "videos" or "YouTube")
      if (typeof user === 'string' && (user.includes('"videos"') || user.includes('YouTube'))) {
        parsed = { videos: [{ url: 'https://www.youtube.com/watch?v=test123', title: 'CS101 Intro', duration_min: 12, summary: 'Introduction to CS fundamentals' }] };
      } 
      // Check for reading prompt (contains "title", "body")
      else if (typeof user === 'string' && user.includes('"title"') && user.includes('"body"')) {
        parsed = { title: 'Algorithms Overview', body: '# Algorithms\n\nThis article covers fundamental algorithms...' };
      } 
      else {
        parsed = { ok: true };
      }
      return { content: JSON.stringify(parsed), message: { parsed } };
    });
    setSupabaseClient(
      createSupabaseStub({
        insertResponses: [
          // placeholder course insert
          { data: { id: '44444444-4444-4444-4444-444444444444' }, error: null, onInsert: (p) => insertedPayloads.push(p) },
          // video_items insert
          { data: { id: 'aaaaaaaa-0000-0000-0000-000000000001' }, error: null, onInsert: (p) => insertedPayloads.push(p) },
          // reading_articles insert
          { data: { id: 'aaaaaaaa-0000-0000-0000-000000000002' }, error: null, onInsert: (p) => insertedPayloads.push(p) },
        ],
        updateResponses: [
          // final course update with augmented structure
          { data: { id: '44444444-4444-4444-4444-444444444444' }, error: null, onUpdate: (p) => updatedPayloads.push(p) },
        ],
      })
    );

    const res = await request(app)
      .post('/course-structure')
      .set('Content-Type', 'application/json')
      .set(baseHeaders)
      .send(validBody);

    assert.equal(res.status, 201);
    assert.deepEqual(res.body, {
      courseId: '44444444-4444-4444-4444-444444444444',
    });
    assert.ok(receivedPayload, 'expected generator payload');
    assert.deepEqual(receivedPayload.topics, validBody.topics);
    assert.deepEqual(receivedPayload.topicFamiliarity, [
      { topic: 'Foundations', familiarity: 'novice' },
      { topic: 'Algorithms', familiarity: 'intermediate' },
    ]);
    assert.equal(receivedPayload.attachments.length, 2);
    assert.match(receivedPayload.attachments[0].name, /syllabus/);
    assert.match(receivedPayload.attachments[1].name, /exam-structure/);

    // Expect 3 inserts: one placeholder course row + two content rows
    assert.equal(insertedPayloads.length, 3);

    // The last two inserts are content tables with module_key/content_prompt/data
    for (let i = 1; i < 3; i++) {
      const batch = insertedPayloads[i];
      assert.ok(Array.isArray(batch));
      assert.equal(batch.length, 1);
      const row = batch[0];
      assert.equal(row.user_id, validBody.userId);
      assert.ok(typeof row.course_id === 'string');
      assert.ok(typeof row.module_key === 'string');
      assert.ok(typeof row.content_prompt === 'string');
      assert.ok(row.data != null);
    }

    // Expect one update with final course_data
    assert.equal(updatedPayloads.length, 1);
    const updateBatch = updatedPayloads[0];
    assert.ok(updateBatch && typeof updateBatch === 'object');
    const augmented = updateBatch.course_data;
    assert.ok(augmented['Module 1/Basics'][0].id, 'video asset should have id');
    assert.ok(augmented['Module 2/Practice'][0].id, 'reading asset should have id');
  });

  await t.test('rejects topic familiarity entries for unknown topics', async () => {
    const res = await request(app)
      .post('/course-structure')
      .set('Content-Type', 'application/json')
      .set(baseHeaders)
      .send({
        ...validBody,
        topicFamiliarity: { 'Non-existent topic': 'expert' },
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /includes unknown topic/i);
  });
});
