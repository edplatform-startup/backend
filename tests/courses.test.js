import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import app from '../src/app.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub, TEST_AUTH_TOKEN } from './helpers/supabaseStub.js';
import {
  __setSyllabusSynthesizer,
  __clearSyllabusSynthesizer,
  __setCourseV2LLMCaller,
  __resetCourseV2LLMCaller,
} from '../src/services/courseV2.js';
import {
  __setSaveCourseStructureOverride,
  __resetSaveCourseStructureOverride,
  __setGenerateCourseContentOverride,
  __resetGenerateCourseContentOverride,
} from '../src/services/courseContent.js';
import { __setLLMCaller } from '../src/services/courseGenerator.js';
import { callStageLLM } from '../src/services/llmCall.js';

const baseHeaders = { 
  Accept: 'application/json',
  Authorization: `Bearer ${TEST_AUTH_TOKEN}`
};

const sampleCourseSelection = { code: 'CSE142', title: 'Foundations of CS' };
const sampleFinishByDate = '2025-12-01T00:00:00.000Z';
const sampleSyllabusFiles = [{ name: 'syllabus.pdf', url: 'https://example.com/syll.pdf' }];
const sampleExamFiles = [{ name: 'exam.pdf', url: 'https://example.com/exam.pdf' }];
const sampleExamDetails = 'Two midterms and a final';

const sampleCourseRow = {
  id: '11111111-1111-1111-1111-111111111111',
  user_id: '22222222-2222-2222-2222-222222222222',
  title: sampleCourseSelection.title,
  status: 'ready',
  created_at: '2025-10-17T12:34:56.789Z',
  syllabus_text: 'Syllabus content',
  exam_details: sampleExamDetails,
};

test('courses route validations and behaviors', async (t) => {
  t.afterEach(() => {
    clearSupabaseClient();
    __clearSyllabusSynthesizer();
    __resetCourseV2LLMCaller();
    __resetSaveCourseStructureOverride();
    __resetGenerateCourseContentOverride();
    __setLLMCaller(callStageLLM);
  });

  await t.test('rejects requests without Authorization header', async () => {
    const res = await request(app).get('/courses').set({ Accept: 'application/json' });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Authorization header is required/);
  });

  await t.test('rejects requests with invalid token', async () => {
    setSupabaseClient(createSupabaseStub({}));
    const res = await request(app)
      .get('/courses')
      .set({ Accept: 'application/json', Authorization: 'Bearer invalid' });
    assert.equal(res.status, 401);
    assert.match(res.body.error, /Invalid or expired token/);
  });

  await t.test('rejects missing query parameters', async () => {
    setSupabaseClient(createSupabaseStub({}));
    const res = await request(app).get('/courses').set(baseHeaders);
    assert.equal(res.status, 400);
    assert.match(res.body.error, /Missing required query parameters/);
  });

  await t.test('rejects invalid userId format', async () => {
    setSupabaseClient(createSupabaseStub({}));
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
    assert.deepEqual(res.body.course, { ...sampleCourseRow, total_estimated_hours: 0 });
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

  await t.test('generates hierarchical topics with overview + subtopics', async () => {
    let synthOptions;
    let llmOptions;
    __setSyllabusSynthesizer(async (options) => {
      synthOptions = options;
      return {
        course_structure_type: 'Week-based',
        skeleton: [
          {
            sequence_order: 1,
            title: 'Week 1: Algorithm Foundations',
            raw_concepts: ['Asymptotic Analysis', 'Complexity classes'],
            is_exam_review: false,
          },
          {
            sequence_order: 2,
            title: 'Week 2: Divide and Conquer',
            raw_concepts: ['Recurrences', 'Merge sort'],
            is_exam_review: false,
          },
          {
            sequence_order: 3,
            title: 'Week 3: Dynamic Programming',
            raw_concepts: ['Optimal substructure', 'Memoization'],
            is_exam_review: false,
          },
        ],
      };
    });

    __setCourseV2LLMCaller(async (options) => {
      llmOptions = options;
      return {
        model: 'mock-hier-topics',
        result: {
          content: JSON.stringify({
            overviewTopics: [
              {
                id: 'overview_1',
                title: 'Algorithm Foundations',
                original_skeleton_ref: 'Week 1: Algorithm Foundations',
                subtopics: Array.from({ length: 4 }, (_, idx) => ({
                  id: `overview_1_sub_${idx + 1}`,
                  overviewId: 'overview_1',
                  title: `Foundation Concept ${idx + 1}`,
                  bloom_level: idx % 2 === 0 ? 'Understand' : 'Analyze',
                  estimated_study_time_minutes: 45 + idx,
                  importance_score: 8,
                  exam_relevance_reasoning: 'Core CS pillar.',
                  yield: idx % 2 === 0 ? 'High' : 'Medium',
                })),
              },
            ],
          }),
        },
      };
    });

    const reqBody = {
      userId: sampleCourseRow.user_id,
      finishByDate: sampleFinishByDate,
      courseSelection: {
        code: ' CSE142 ',
        title: ' Foundations of CS ',
        college: ' UW ',
      },
      syllabusText: sampleCourseRow.syllabus_text,
      syllabusFiles: sampleSyllabusFiles,
      examFormatDetails: sampleExamDetails,
      examFiles: sampleExamFiles,
    };

    const res = await request(app)
      .post('/courses/topics')
      .set('Content-Type', 'application/json')
      .send(reqBody);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.ok(Array.isArray(res.body.overviewTopics));
    assert.equal(res.body.overviewTopics.length, 1);
    assert.equal(res.body.overviewTopics[0].subtopics.length, 4);
    assert.equal(res.body.overviewTopics[0].original_skeleton_ref, 'Week 1: Algorithm Foundations');
    assert.ok(res.body.overviewTopics[0].subtopics[0].bloom_level);
    assert.equal(res.body.model, 'mock-hier-topics');
    assert.ok(Array.isArray(synthOptions.attachments) && synthOptions.attachments.length >= 2);
    assert.equal(synthOptions.university, 'UW');
    assert.equal(synthOptions.courseName, 'Foundations of CS');
    assert.ok(llmOptions);
    assert.equal(llmOptions.stage, 'TOPICS');
    assert.equal(llmOptions.allowWeb, false);
  });

  await t.test('ensures dense coverage includes 30+ subtopics when LLM supplies them', async () => {
    __setSyllabusSynthesizer(async () => ({
      course_structure_type: 'Module-based',
      skeleton: Array.from({ length: 8 }, (_, idx) => ({
        sequence_order: idx + 1,
        title: `Module ${idx + 1}`,
        raw_concepts: [`Concept ${idx + 1}.1`, `Concept ${idx + 1}.2`],
        is_exam_review: idx === 7,
      })),
    }));

    __setCourseV2LLMCaller(async () => ({
      model: 'mock-hier-topics-dense',
      result: {
        content: JSON.stringify({
          overviewTopics: Array.from({ length: 8 }, (_, oIdx) => ({
            id: `ov_${oIdx + 1}`,
            title: `Overview ${oIdx + 1}`,
            original_skeleton_ref: `Module ${oIdx + 1}`,
            subtopics: Array.from({ length: 4 }, (_, sIdx) => ({
              id: `ov_${oIdx + 1}_sub_${sIdx + 1}`,
              overviewId: `ov_${oIdx + 1}`,
              title: `Subtopic ${oIdx + 1}.${sIdx + 1}`,
              bloom_level: 'Apply',
              estimated_study_time_minutes: 30,
              importance_score: 7,
              exam_relevance_reasoning: 'Maps to syllabus concept.',
              yield: 'High',
            })),
          })),
        }),
      },
    }));

    const res = await request(app)
      .post('/courses/topics')
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        courseSelection: sampleCourseSelection,
      });

    assert.equal(res.status, 200);
    const totalSubtopics = res.body.overviewTopics.flatMap((ot) => ot.subtopics || []).length;
    assert.ok(totalSubtopics >= 32);
  });

  await t.test('POST /courses requires userId', async () => {
    const res = await request(app)
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send({ grok_draft: { anything: true } });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /userId/);
  });

  await t.test('POST /courses persists the lesson graph and runs worker', async () => {
    const architectStub = async () => ({
      result: {
        content: JSON.stringify({
          lessons: [
            {
              slug_id: 'node-a',
              title: 'Node A',
              module_group: 'Week 1',
              estimated_minutes: 30,
              bloom_level: 'Understand',
              intrinsic_exam_value: 5,
              architectural_reasoning: 'Test node',
              content_plans: {
                reading: 'Plan reading',
                quiz: 'Plan quiz',
                flashcards: 'Plan flashcards',
                video: ['sample video search'],
              },
              dependencies: [],
              original_source_ids: ['st1'],
            },
            {
              slug_id: 'node-b',
              title: 'Node B',
              module_group: 'Week 1',
              estimated_minutes: 35,
              bloom_level: 'Apply',
              intrinsic_exam_value: 7,
              architectural_reasoning: 'Depends on node A',
              content_plans: {
                reading: 'Plan reading 2',
                quiz: 'Plan quiz 2',
                flashcards: 'Plan flashcards 2',
                video: ['second video'],
              },
              dependencies: ['node-a'],
              original_source_ids: ['st2'],
            },
          ],
        }),
      },
    });
    __setLLMCaller(architectStub);

    let persisted;
    __setSaveCourseStructureOverride(async (courseId, userId, graph) => {
      persisted = { courseId, userId, graph };
      return { nodeCount: graph.finalNodes.length, edgeCount: graph.finalEdges.length };
    });

    let workerCourseId;
    __setGenerateCourseContentOverride(async (courseId) => {
      workerCourseId = courseId;
      return { processed: 2, failed: 0, status: 'ready' };
    });

    setSupabaseClient(
      createSupabaseStub({
        insertResponses: [{ data: { id: 'new-course' }, error: null }],
      })
    );

    const res = await request(app)
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        grok_draft: { stub: true },
        user_confidence_map: { st1: 0.8 },
      });

    assert.equal(res.status, 201);
    assert.equal(res.body.success, true);
    assert.equal(res.body.worker.status, 'ready');
    assert.ok(res.body.course_structure.nodes.length);
    assert.equal(persisted.userId, sampleCourseRow.user_id);
    assert.equal(workerCourseId, res.body.courseId);
  });

  await t.test('POST /courses accepts seconds_to_complete', async () => {
    const architectStub = async () => ({
      result: {
        content: JSON.stringify({
          lessons: [],
        }),
      },
    });
    __setLLMCaller(architectStub);

    __setSaveCourseStructureOverride(async () => ({ nodeCount: 0, edgeCount: 0 }));
    __setGenerateCourseContentOverride(async () => ({ processed: 0, failed: 0, status: 'ready' }));

    let insertedPayload;
    setSupabaseClient(
      createSupabaseStub({
        insertResponses: [{
          data: { id: 'new-course-with-seconds' },
          error: null,
          onInsert: (payload) => { insertedPayload = payload; }
        }],
      })
    );

    const res = await request(app)
      .post('/courses')
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        grok_draft: { stub: true },
        seconds_to_complete: 3600,
      });

    assert.equal(res.status, 201);
    assert.equal(insertedPayload.seconds_to_complete, 3600);
  });

  await t.test('PATCH /courses/:courseId/settings updates seconds_to_complete', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [{ data: { id: sampleCourseRow.id }, error: null }], // For verification
        updateResponses: [{
          data: { id: sampleCourseRow.id, seconds_to_complete: 7200, updated_at: new Date().toISOString() },
          error: null
        }],
      })
    );

    const res = await request(app)
      .patch(`/courses/${sampleCourseRow.id}/settings`)
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        seconds_to_complete: 7200,
      });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.settings.seconds_to_complete, 7200);
  });

  await t.test('PATCH /courses/:courseId/settings validates input', async () => {
    const res = await request(app)
      .patch(`/courses/${sampleCourseRow.id}/settings`)
      .set('Content-Type', 'application/json')
      .send({
        userId: sampleCourseRow.user_id,
        seconds_to_complete: -100,
      });

    assert.equal(res.status, 400);
    assert.match(res.body.error, /seconds_to_complete must be a non-negative number/);
  });

  await t.test('GET /courses/:id/plan uses seconds_to_complete from DB', async () => {
    const courseId = 'course-plan-1';
    const userId = 'user-plan-1';

    setSupabaseClient(
      createSupabaseStub({
        listResponses: [
          { data: [{ id: 'node1', estimated_minutes: 30, content_payload: {} }], error: null }, // nodes
          { data: [], error: null }, // edges
          { data: [], error: null }, // user state
        ],
        singleResponses: [
          { data: null, error: null }, // consumed by nodes call
          { data: null, error: null }, // consumed by edges call
          { data: null, error: null }, // consumed by user state call
          { data: { seconds_to_complete: 3600 }, error: null }, // course info
        ],
      })
    );

    const res = await request(app)
      .get(`/courses/${courseId}/plan`)
      .query({ userId })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.equal(res.body.mode, 'Deep Study'); // 60 mins available, 30 mins needed -> Deep Study
  });

  await t.test('GET /courses/:id/plan errors if seconds_to_complete is missing', async () => {
    const courseId = 'course-plan-2';
    const userId = 'user-plan-2';

    setSupabaseClient(
      createSupabaseStub({
        listResponses: [
          { data: [], error: null }, // nodes
          { data: [], error: null }, // edges
          { data: [], error: null }, // user state
        ],
        singleResponses: [
          { data: null, error: null }, // consumed by nodes call
          { data: null, error: null }, // consumed by edges call
          { data: null, error: null }, // consumed by user state call
          { data: { seconds_to_complete: null }, error: null }, // course info
        ],
      })
    );

    const res = await request(app)
      .get(`/courses/${courseId}/plan`)
      .query({ userId })
      .set(baseHeaders);

    assert.equal(res.status, 500);
    assert.match(res.body.details, /Course time limit \(seconds_to_complete\) is not set/);
  });

  await t.test('PATCH /courses/:id/questions requires userId', async () => {
    const res = await request(app)
      .patch('/courses/course-1/questions')
      .send({ updates: [{ id: 'q1', status: 'correct' }] })
      .set(baseHeaders);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /userId is required/);
  });

  await t.test('PATCH /courses/:id/questions requires updates array', async () => {
    const res = await request(app)
      .patch('/courses/course-1/questions')
      .send({ userId: 'user-1' })
      .set(baseHeaders);

    assert.equal(res.status, 400);
    assert.match(res.body.error, /updates array is required/);
  });

  await t.test('PATCH /courses/:id/questions returns 403 if course access denied', async () => {
    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [
          { data: null, error: null }, // course access check returns null
        ],
      })
    );

    const res = await request(app)
      .patch('/courses/course-1/questions')
      .send({ userId: 'user-1', updates: [{ id: 'q1', status: 'correct' }] })
      .set(baseHeaders);

    assert.equal(res.status, 403);
    assert.match(res.body.error, /Access denied/);
  });

  await t.test('PATCH /courses/:id/questions successfully updates questions', async () => {
    const courseId = 'course-patch-1';
    const userId = 'user-patch-1';
    const questionId = 'question-1';

    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [
          { data: { id: courseId }, error: null }, // course access check
        ],
        updateResponses: [
          { data: [{ id: questionId, status: 'correct', updated_at: '2025-01-01T00:00:00.000Z' }], error: null },
        ],
      })
    );

    const res = await request(app)
      .patch(`/courses/${courseId}/questions`)
      .send({ userId, updates: [{ id: questionId, status: 'correct' }] })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.updated, 1);
    assert.equal(res.body.results.length, 1);
    assert.equal(res.body.results[0].id, questionId);
    assert.equal(res.body.errors.length, 0);
  });

  await t.test('PATCH /courses/:id/questions reports error when question not found', async () => {
    const courseId = 'course-patch-2';
    const userId = 'user-patch-2';
    const questionId = 'nonexistent-question';

    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [
          { data: { id: courseId }, error: null }, // course access check
        ],
        updateResponses: [
          { data: [], error: null }, // empty array = no rows matched
        ],
      })
    );

    const res = await request(app)
      .patch(`/courses/${courseId}/questions`)
      .send({ userId, updates: [{ id: questionId, status: 'correct' }] })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.updated, 0);
    assert.equal(res.body.results.length, 0);
    assert.equal(res.body.errors.length, 1);
    assert.equal(res.body.errors[0].id, questionId);
    assert.match(res.body.errors[0].error, /Question not found or access denied/);
  });

  await t.test('PATCH /courses/:id/questions reports error for missing id or status', async () => {
    const courseId = 'course-patch-3';
    const userId = 'user-patch-3';

    setSupabaseClient(
      createSupabaseStub({
        singleResponses: [
          { data: { id: courseId }, error: null }, // course access check
        ],
      })
    );

    const res = await request(app)
      .patch(`/courses/${courseId}/questions`)
      .send({ userId, updates: [{ id: 'q1' }, { status: 'correct' }] })
      .set(baseHeaders);

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.updated, 0);
    assert.equal(res.body.errors.length, 2);
    assert.match(res.body.errors[0].error, /Missing id or status/);
    assert.match(res.body.errors[1].error, /Missing id or status/);
  });
});
