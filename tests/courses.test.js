import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';
import {
  setStudyTopicsGenerator,
  clearStudyTopicsGenerator,
} from '../src/services/grokClient.js';

const baseHeaders = { Accept: 'application/json' };

const courseData = {
  recommended_topics: ['Topic A', 'Topic B', 'Topic C'],
  raw_topics_text: 'Topic A, Topic B, Topic C',
  generated_at: '2025-10-17T12:34:56.789Z',
  model: 'openrouter/grok-4-fast',
  input_snapshot: {
    finish_by_date: '2025-12-01T00:00:00.000Z',
    course_selection: { code: 'CSE142', title: 'Foundations of CS' },
    time_remaining_days: 45,
  },
};

const sampleCourseRow = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  user_uuid: '22222222-2222-2222-2222-222222222222',
  course_data: courseData,
  course_json: courseData,
  created_at: '2025-10-17T12:34:56.789Z',
  finish_by_date: '2025-12-01T00:00:00.000Z',
  course_selection: { code: 'CSE142', title: 'Foundations of CS' },
  syllabus_text: 'Syllabus content',
  syllabus_files: [{ name: 'syllabus.pdf', url: 'https://example.com/syll.pdf' }],
  exam_format_details: 'Two midterms and a final',
  exam_files: [{ name: 'exam.pdf', url: 'https://example.com/exam.pdf' }],
};

test('courses route validations and behaviors', async (t) => {
  t.afterEach(() => {
    clearSupabaseClient();
    clearStudyTopicsGenerator();
  });

  await t.test('rejects missing query parameters', async () => {
    const res = await request(app).get('/courses').set(baseHeaders);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Missing required query parameters/);
  });

  await t.test('rejects invalid userId format', async () => {
    const res = await request(app).get('/courses').query({ userId: 'not-a-uuid' }).set(baseHeaders);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Invalid userId format/);
  });

  await t.test('lists user courses', async () => {
    const courses = [
      sampleCourseRow,
      { ...sampleCourseRow, id: '33333333-3333-3333-3333-333333333333' },
    ];

    setSupabaseClient(
      createSupabaseStub({
        listResponses: [{ data: courses, error: null }],
      })
    );

    const res = await request(app)
      .get('/courses')
      .query({ userId: sampleCourseRow.user_uuid })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.count, 2);
    assert.deepEqual(res.body.courses[0], sampleCourseRow);
  });

  await t.test('fetches single course for user', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [{ data: sampleCourseRow, error: null }],
      })
    );

    const res = await request(app)
      .get('/courses')
      .query({ userId: sampleCourseRow.user_uuid, courseId: sampleCourseRow.id })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.course, sampleCourseRow);
  });

  await t.test('returns 404 when course not found', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [{ data: null, error: { code: 'PGRST116' } }],
      })
    );

    const res = await request(app)
      .get('/courses')
      .query({ userId: sampleCourseRow.user_uuid, courseId: sampleCourseRow.id })
      .set(baseHeaders);

    assert.equal(res.status, 404);
    assert.match(res.body.error, /Course not found/);
  });

  await t.test('returns 500 when Supabase errors', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [{ data: null, error: { code: 'XX', message: 'boom' } }],
      })
    );

    const res = await request(app)
      .get('/courses')
      .query({ userId: sampleCourseRow.user_uuid, courseId: sampleCourseRow.id })
      .set(baseHeaders);

    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Failed to fetch course');
    assert.equal(res.body.details, 'boom');
  });

  await t.test('prevents invalid file metadata on creation', async () => {
    const res = await request(app)
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_uuid,
        syllabusFiles: [{ name: '' }],
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /must include a non-empty "name"/);
  });

  await t.test('returns generated topics list without persistence', async () => {
    setStudyTopicsGenerator(() => 'Topic A, Topic B, Topic C');

    const reqBody = {
      userId: sampleCourseRow.user_uuid,
      finishByDate: sampleCourseRow.finish_by_date,
      courseSelection: sampleCourseRow.course_selection,
      syllabusText: sampleCourseRow.syllabus_text,
      syllabusFiles: sampleCourseRow.syllabus_files,
      examFormatDetails: sampleCourseRow.exam_format_details,
      examFiles: sampleCourseRow.exam_files,
    };

    const res = await request(app)
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send(reqBody);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.topics, ['Topic A', 'Topic B', 'Topic C']);
    assert.equal(res.body.rawTopicsText, 'Topic A, Topic B, Topic C');
    assert.equal(res.body.model, 'x-ai/grok-4-fast');
  });
});
