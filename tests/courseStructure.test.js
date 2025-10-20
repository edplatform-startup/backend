import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import {
  setCourseStructureGenerator,
  clearCourseStructureGenerator,
} from '../src/services/courseGenerator.js';

const baseHeaders = { Accept: 'application/json' };

const validBody = {
  topics: ['Foundations', 'Algorithms'],
  className: 'CS101 Final',
  startDate: '2025-01-01T00:00:00.000Z',
  endDate: '2025-02-01T00:00:00.000Z',
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

  await t.test('returns course structure when generation succeeds', async () => {
    let receivedPayload = null;
    setCourseStructureGenerator((payload) => {
      receivedPayload = payload;
      return {
        model: 'openai/gpt-5',
        raw: JSON.stringify(mockStructure),
        courseStructure: mockStructure,
      };
    });

    const res = await request(app)
      .post('/course-structure')
      .set('Content-Type', 'application/json')
      .set(baseHeaders)
      .send(validBody);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.model, 'openai/gpt-5');
    assert.deepEqual(res.body.courseStructure, mockStructure);
    assert.ok(receivedPayload, 'expected generator payload');
    assert.deepEqual(receivedPayload.topics, validBody.topics);
    assert.equal(receivedPayload.attachments.length, 2);
    assert.match(receivedPayload.attachments[0].name, /syllabus/);
    assert.match(receivedPayload.attachments[1].name, /exam-structure/);
  });
});
