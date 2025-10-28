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

  await t.test('returns course structure when generation succeeds', async () => {
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
    setSupabaseClient(
      createSupabaseStub({
        insertResponses: [
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

    assert.equal(insertedPayloads.length, 1);
    const insertedBatch = insertedPayloads[0];
    assert.ok(Array.isArray(insertedBatch));
    assert.equal(insertedBatch.length, 1);
    const record = insertedBatch[0];
    assert.equal(record.user_id, validBody.userId);
    assert.equal(record.user_id, validBody.userId);
    assert.deepEqual(record.course_data, mockStructure);
    assert.ok(typeof record.id === 'string' && record.id.length > 0);
    assert.ok(typeof record.created_at === 'string');
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
