import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';
import { setCourseBuilder, clearCourseBuilder } from '../src/services/courseBuilder.js';
import { __setSyllabusSynthesizer, __clearSyllabusSynthesizer } from '../src/services/courseV2.js';

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
    clearCourseBuilder();
    __clearSyllabusSynthesizer();
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
      .query({ userId: sampleCourseRow.user_id })
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
      .query({ userId: sampleCourseRow.user_id, courseId: sampleCourseRow.id })
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
      .query({ userId: sampleCourseRow.user_id, courseId: sampleCourseRow.id })
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
      .query({ userId: sampleCourseRow.user_id, courseId: sampleCourseRow.id })
      .set(baseHeaders);

    assert.equal(res.status, 500);
    assert.equal(res.body.error, 'Failed to fetch course');
    assert.equal(res.body.details, 'boom');
  });

  await t.test('prevents invalid file metadata on creation', async () => {
    const res = await request(app)
      .post('/courses/topics')
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        syllabusFiles: [{ name: '' }],
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /must include a non-empty "name"/);
  });

  await t.test('generates study topics via syllabus graph', async () => {
    let synthOptions;
    __setSyllabusSynthesizer(async (options) => {
      synthOptions = options;
      return {
        outcomes: ['Outcome 1', 'Outcome 2', 'Outcome 3'],
        topic_graph: {
          nodes: [
            { id: 'n1', title: 'Asymptotic Analysis' },
            { id: 'n2', title: 'Midterm Exam Review' },
            { id: 'n3', title: 'Divide and Conquer Strategies' },
            { id: 'n4', title: 'Asymptotic Analysis' },
          ],
          edges: [],
        },
        sources: [{ title: 'Official syllabus', url: 'https://example.edu/syllabus' }],
      };
    });

    const reqBody = {
      userId: sampleCourseRow.user_id,
      finishByDate: sampleCourseRow.finish_by_date,
      courseSelection: {
        code: ' CSE142 ',
        title: ' Foundations of CS ',
        college: ' UW ',
      },
      syllabusText: sampleCourseRow.syllabus_text,
      syllabusFiles: sampleCourseRow.syllabus_files,
      examFormatDetails: sampleCourseRow.exam_format_details,
      examFiles: sampleCourseRow.exam_files,
    };

    const res = await request(app)
      .post('/courses/topics')
      .set('Content-Type', 'application/json')
      .send(reqBody);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.deepEqual(res.body.topics, ['Asymptotic Analysis', 'Divide and Conquer Strategies']);
    assert.equal(res.body.model, 'courseV2/syllabus');
    assert.equal(res.body.rawTopicsText, 'Asymptotic Analysis, Divide and Conquer Strategies');
    assert.ok(Array.isArray(synthOptions.attachments) && synthOptions.attachments.length >= 2);
    assert.equal(synthOptions.university, 'UW');
    assert.equal(synthOptions.courseName, 'Foundations of CS');
  });

  await t.test('requires topics before generating a course package', async () => {
    const res = await request(app)
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        courseSelection: sampleCourseRow.course_selection,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /topics must contain at least one topic/);
  });

  await t.test('persists placeholder and updates course data with assets', async () => {
    const insertPayloads = [];
    const updatePayloads = [];
    let builderOptions;

    setCourseBuilder(async (options) => {
      builderOptions = options;
      return {
        course: { syllabus: { outcomes: [] } },
        assets: { summary: 'asset-bundle' },
      };
    });

    setSupabaseClient(
      createSupabaseStub({
        insertResponses: [{
          data: { id: 'new-course' },
          error: null,
          onInsert: (payload) => insertPayloads.push(payload),
        }],
        updateResponses: [{
          data: { id: 'new-course' },
          error: null,
          onUpdate: (payload) => updatePayloads.push(payload),
        }],
      })
    );

    const res = await request(app)
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        topics: ['Topic A', 'Topic B'],
        topicFamiliarity: { 'Topic B': 'expert' },
        className: 'Custom Prep',
        syllabusText: sampleCourseRow.syllabus_text,
        examFormatDetails: sampleCourseRow.exam_format_details,
      });

    assert.equal(res.status, 201);
    assert.match(res.body.courseId, /^[0-9a-f-]{36}$/i);

    assert.equal(insertPayloads.length, 1);
    const placeholder = insertPayloads[0][0];
    assert.equal(placeholder.title, 'Custom Prep');
    assert.deepEqual(placeholder.topics, ['Topic A', 'Topic B']);
    assert.deepEqual(placeholder.topic_familiarity, [{ topic: 'Topic B', familiarity: 'expert' }]);
    assert.equal(res.body.courseId, placeholder.id);

    assert.ok(builderOptions);
    assert.deepEqual(builderOptions.topics, ['Topic A', 'Topic B']);
    assert.deepEqual(builderOptions.topicFamiliarity, [{ topic: 'Topic B', familiarity: 'expert' }]);
    assert.equal(builderOptions.className, 'Custom Prep');
    assert.equal(builderOptions.userId, sampleCourseRow.user_id);
    assert.equal(builderOptions.courseId, placeholder.id);

    assert.equal(updatePayloads.length, 1);
    const updateBody = updatePayloads[0];
    assert.ok(updateBody.course_data);
    assert.equal(updateBody.course_data.version, '2.0');
    assert.deepEqual(updateBody.course_data.assets, { summary: 'asset-bundle' });
  });
});
