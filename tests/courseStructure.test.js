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
    // Provide fake API key and stub per-asset model calls
    process.env.OPENROUTER_API_KEY = 'test-key';
    setOpenRouterChatExecutor(async ({ messages }) => {
      const user = messages?.find((m) => m.role === 'user')?.content || '';
      let parsed;
      if (typeof user === 'string' && user.includes('"videos"')) {
        parsed = { videos: [{ title: 'CS101 Intro', outline: ['a'], watch_time_minutes: 7, key_points: ['k'] }] };
      } else if (typeof user === 'string' && user.includes('"sections"')) {
        parsed = { article: { title: 'Readings', sections: [{ heading: 'h', summary: 's' }] } };
      } else {
        parsed = { ok: true };
      }
      return { content: JSON.stringify(parsed), message: { parsed } };
    });
    setSupabaseClient(
      createSupabaseStub({
        insertResponses: [
          // video_items insert
          {
            data: { id: 'aaaaaaaa-0000-0000-0000-000000000001' },
            error: null,
            onInsert: (payload) => insertedPayloads.push(payload),
          },
          // reading_articles insert
          {
            data: { id: 'aaaaaaaa-0000-0000-0000-000000000002' },
            error: null,
            onInsert: (payload) => insertedPayloads.push(payload),
          },
          // courses insert
          {
            data: { id: '44444444-4444-4444-4444-444444444444' },
            error: null,
            onInsert: (payload) => insertedPayloads.push(payload),
          },
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

    // Expect 3 inserts: two content rows + one course row
    assert.equal(insertedPayloads.length, 3);

    // First two inserts are content tables with module_key/content_prompt/data
    for (let i = 0; i < 2; i++) {
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

    // Last insert is the course record
    const courseInsert = insertedPayloads[2];
    assert.ok(Array.isArray(courseInsert));
    const courseRow = courseInsert[0];
    assert.equal(courseRow.user_id, validBody.userId);
    assert.ok(typeof courseRow.id === 'string' && courseRow.id.length > 0);
    assert.ok(typeof courseRow.created_at === 'string');
    // Augmented course_data should now include ids on assets
    const augmented = courseRow.course_data;
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
