import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';
import { setCourseV2Generator, clearCourseV2Generator } from '../src/services/courseV2.js';

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
    clearCourseV2Generator();
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
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        syllabusFiles: [{ name: '' }],
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /must include a non-empty "name"/);
  });

  await t.test('returns generated course package without persistence', async () => {
    let capturedSelection;
    let capturedPrefs;

    setCourseV2Generator((selection, prefs) => {
      capturedSelection = selection;
      capturedPrefs = prefs;
      return createSampleCoursePackage();
    });

    const reqBody = {
      userId: sampleCourseRow.user_id,
      finishByDate: sampleCourseRow.finish_by_date,
      courseSelection: {
        code: '  CSE142 ',
        title: '  Foundations of CS  ',
        college: ' University of Washington ',
      },
      syllabusText: sampleCourseRow.syllabus_text,
      syllabusFiles: sampleCourseRow.syllabus_files,
      examFormatDetails: sampleCourseRow.exam_format_details,
      examFiles: sampleCourseRow.exam_files,
      userPrefs: { readingSpeed: 260 },
    };

    const res = await request(app)
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send(reqBody);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.rawTopicsText, 'Topic A, Topic B, Topic C, Topic D');
    assert.deepEqual(res.body.topics, ['Topic A', 'Topic B', 'Topic C', 'Topic D']);
    assert.equal(res.body.model, 'course-v2');
    assert.ok(!('course' in res.body));
    assert.deepEqual(capturedSelection, {
      code: 'CSE142',
      title: 'Foundations of CS',
      college: 'University of Washington',
    });
    assert.deepEqual(capturedPrefs, reqBody.userPrefs);
  });
});

function createSampleCoursePackage() {
  return {
    syllabus: {
      outcomes: ['Outcome 1', 'Outcome 2', 'Outcome 3'],
      topic_graph: {
        nodes: [
          { id: 'n1', title: 'Topic A', summary: 'Summary A', refs: ['https://example.com/a'] },
          { id: 'n2', title: 'Topic B', summary: 'Summary B', refs: ['https://example.com/b'] },
          { id: 'n3', title: 'Topic C', summary: 'Summary C', refs: ['https://example.com/c'] },
          { id: 'n4', title: 'Topic D', summary: 'Summary D', refs: ['https://example.com/d'] },
        ],
        edges: [],
      },
      sources: [{ url: 'https://example.com/source', title: 'Source 1' }],
    },
    modules: {
      modules: [
        { id: 'module-1', title: 'Module 1', dependsOn: [], outcomes: ['Outcome 1'], hours_estimate: 5, covers_nodes: ['n1'] },
        { id: 'module-2', title: 'Module 2', dependsOn: ['module-1'], outcomes: ['Outcome 2'], hours_estimate: 5, covers_nodes: ['n2'] },
        { id: 'module-3', title: 'Module 3', dependsOn: ['module-2'], outcomes: ['Outcome 3'], hours_estimate: 5, covers_nodes: ['n3'] },
        { id: 'module-4', title: 'Module 4', dependsOn: ['module-3'], outcomes: ['Outcome 1'], hours_estimate: 5, covers_nodes: ['n4'] },
      ],
    },
    lessons: {
      lessons: [
        createLesson('lesson-1', 'module-1', 'https://example.com/r1'),
        createLesson('lesson-2', 'module-1', 'https://example.com/r2', 'problem_set'),
        createLesson('lesson-3', 'module-2', 'https://example.com/r3'),
        createLesson('lesson-4', 'module-2', 'https://example.com/r4', 'discussion'),
        createLesson('lesson-5', 'module-3', 'https://example.com/r5'),
        createLesson('lesson-6', 'module-3', 'https://example.com/r6', 'project_work'),
        createLesson('lesson-7', 'module-4', 'https://example.com/r7'),
        createLesson('lesson-8', 'module-4', 'https://example.com/r8', 'problem_set'),
      ],
    },
    assessments: {
      weekly_quizzes: [
        {
          moduleId: 'module-1',
          items: createQuizItems(['lesson-1', 'lesson-2', 'lesson-3']),
        },
        {
          moduleId: 'module-2',
          items: createQuizItems(['lesson-4', 'lesson-5', 'lesson-6']),
        },
      ],
      project: {
        title: 'Capstone Project',
        brief: 'Build something impressive.',
        milestones: ['Proposal', 'Implementation'],
        rubric: 'Assessed on creativity and completeness.',
      },
      exam_blueprint: {
        sections: [
          { title: 'Section 1', weight_pct: 50, outcomes: ['Outcome 1'] },
          { title: 'Section 2', weight_pct: 50, outcomes: ['Outcome 2'] },
        ],
      },
    },
    study_time_min: {
      reading: 96,
      video: 0,
      practice: 133,
      total: 229,
    },
  };
}

function createLesson(id, moduleId, readingUrl, activityType = 'guided_example') {
  return {
    id,
    moduleId,
    title: `Lesson for ${moduleId}`,
    objectives: ['Understand the concept'],
    duration_min: 45,
    reading: [{ title: `Reading for ${id}`, url: readingUrl, est_min: 12 }],
    activities: [{ type: activityType, goal: 'Apply the concept' }],
    bridge_from: [],
    bridge_to: [],
    cross_refs: [],
  };
}

function createQuizItems(anchorLessons) {
  return anchorLessons.map((anchor, index) => ({
    type: 'mcq',
    question: `Question ${index + 1}`,
    options: ['Option A', 'Option B', 'Option C'],
    answerIndex: 0,
    explanation: 'Option A is correct.',
    anchors: [anchor],
  }));
}
