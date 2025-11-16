import test from 'node:test';
import assert from 'node:assert/strict';
import {
  designLessons,
  generateAssessments,
  generateCourseV2,
  __courseV2Internals,
  __setCourseV2LLMCaller,
  __resetCourseV2LLMCaller,
} from '../src/services/courseV2.js';
import { CoursePackageSchema } from '../src/schemas/courseV2.js';

const { validateModuleCoverage, buildFallbackModulePlanFromTopics } = __courseV2Internals;

function createSyllabus(nodeCount = 12) {
  const nodes = Array.from({ length: nodeCount }, (_, index) => ({
    id: `node-${index + 1}`,
    title: `Topic ${index + 1}`,
    summary: `Summary ${index + 1}`,
    refs: [],
  }));
  return {
    outcomes: ['Outcome 1', 'Outcome 2', 'Outcome 3'],
    topic_graph: {
      nodes,
      edges: [],
    },
    sources: [{ title: 'Primary Source', url: 'https://example.com/source' }],
  };
}

function buildModulePlan(moduleCount, syllabus) {
  const nodes = syllabus.topic_graph.nodes;
  return {
    modules: Array.from({ length: moduleCount }, (_, index) => ({
      id: `module-${index + 1}`,
      title: `Module ${index + 1}`,
      dependsOn: [],
      outcomes: [`Outcome ${index + 1}`],
      hours_estimate: 10,
      covers_nodes: [nodes[index % nodes.length].id],
    })),
  };
}

test('validateModuleCoverage accepts plans with four modules', () => {
  const syllabus = createSyllabus();
  const plan = buildModulePlan(4, syllabus);
  assert.doesNotThrow(() => validateModuleCoverage(plan, syllabus));
});

test('validateModuleCoverage only warns for out-of-range counts', () => {
  const syllabus = createSyllabus();
  const plan = buildModulePlan(11, syllabus);
  const originalWarn = console.warn;
  let warningCount = 0;
  console.warn = () => {
    warningCount += 1;
  };
  try {
    validateModuleCoverage(plan, syllabus);
    assert.equal(warningCount, 1);
  } finally {
    console.warn = originalWarn;
  }
});

test('validateModuleCoverage still throws when there are zero modules', () => {
  const syllabus = createSyllabus();
  assert.throws(() => validateModuleCoverage({ modules: [] }, syllabus), {
    message: /at least one module/i,
  });
});

test('buildFallbackModulePlanFromTopics produces deterministic coverage', () => {
  const syllabus = createSyllabus(9);
  const plan = buildFallbackModulePlanFromTopics(syllabus.topic_graph.nodes);
  assert.ok(plan.modules.length >= 4 && plan.modules.length <= 10);
  const covered = new Set(plan.modules.flatMap((module) => module.covers_nodes));
  assert.equal(covered.size, syllabus.topic_graph.nodes.length);
  for (const module of plan.modules) {
    assert.ok(Array.isArray(module.outcomes) && module.outcomes.length > 0);
    assert.ok(Number.isInteger(module.hours_estimate) && module.hours_estimate > 0);
  }
});

test('designLessons falls back when JSON contains bare URLs', async (t) => {
  const syllabus = createSyllabus();
  const modules = buildModulePlan(4, syllabus);
  const brokenContent = '{ "lessons": [ { "id": "l1", "moduleId": "module-1", "title": "Bad", "objectives": ["o"], "duration_min": 45, "reading": [ { "title": "Doc", "url": https://broken.example/bad } ], "activities": [] } ] }';
  __setCourseV2LLMCaller(async () => ({ result: { content: brokenContent } }));
  t.after(() => __resetCourseV2LLMCaller());

  const lessonsPlan = await designLessons(modules, syllabus);
  assert.ok(lessonsPlan.lessons.length >= 6, 'fallback ensured minimum lesson count');
  for (const module of modules.modules) {
    const perModule = lessonsPlan.lessons.filter((lesson) => lesson.moduleId === module.id);
    assert.ok(perModule.length >= 2 && perModule.length <= 4);
  }
});

test('designLessons falls back when aggregated lessons stay under schema minimum', async (t) => {
  const syllabus = createSyllabus();
  const modules = buildModulePlan(3, syllabus);
  const singleLessonFor = (moduleId, index) => ({
    id: `${moduleId}-lesson-${index + 1}`,
    moduleId,
    title: `Lesson ${index + 1}`,
    objectives: ['Objective'],
    duration_min: 45,
    reading: [{ title: 'Ref', url: 'https://example.com/ref' }],
    activities: [],
    bridge_from: [],
    bridge_to: [],
    cross_refs: [],
  });
  const responses = modules.modules.map((module, index) => JSON.stringify([singleLessonFor(module.id, index)]));
  responses.push('[]');
  let callIndex = 0;
  __setCourseV2LLMCaller(async () => ({ result: { content: responses[callIndex++] ?? '[]' } }));
  t.after(() => __resetCourseV2LLMCaller());

  const lessonsPlan = await designLessons(modules, syllabus);
  assert.ok(lessonsPlan.lessons.length >= 6);
  for (const module of modules.modules) {
    const perModule = lessonsPlan.lessons.filter((lesson) => lesson.moduleId === module.id);
    assert.ok(perModule.length >= 2 && perModule.length <= 4);
  }
});

test('designLessons only falls back for the module that fails twice', async (t) => {
  const syllabus = createSyllabus();
  const modules = buildModulePlan(4, syllabus);
  const buildLessons = (moduleId) => JSON.stringify([
    {
      id: `${moduleId}-custom-1`,
      moduleId,
      title: `${moduleId} Lesson 1`,
      objectives: ['Objective A'],
      duration_min: 45,
      reading: [{ title: 'Ref', url: 'https://example.com/ref' }],
      activities: [],
      bridge_from: [],
      bridge_to: [],
      cross_refs: [],
    },
    {
      id: `${moduleId}-custom-2`,
      moduleId,
      title: `${moduleId} Lesson 2`,
      objectives: ['Objective B'],
      duration_min: 50,
      reading: [{ title: 'Ref', url: 'https://example.com/ref2' }],
      activities: [],
      bridge_from: [],
      bridge_to: [],
      cross_refs: [],
    },
  ]);

  const responses = [
    { content: buildLessons('module-1') },
    { content: '' },
    { content: '[]' },
    { content: '{}' },
    { content: buildLessons('module-3') },
    { content: buildLessons('module-4') },
  ];

  __setCourseV2LLMCaller(async () => ({ result: responses.shift() || { content: '[]' } }));
  t.after(() => __resetCourseV2LLMCaller());

  const lessonsPlan = await designLessons(modules, syllabus);
  const module1Lessons = lessonsPlan.lessons.filter((lesson) => lesson.moduleId === 'module-1');
  assert.equal(module1Lessons.length, 2);
  assert.deepEqual(
    module1Lessons.map((lesson) => lesson.id).sort(),
    ['module-1-custom-1', 'module-1-custom-2']
  );

  const module2Lessons = lessonsPlan.lessons.filter((lesson) => lesson.moduleId === 'module-2');
  assert.ok(module2Lessons.length >= 2 && module2Lessons.length <= 4);
  assert.ok(module2Lessons.every((lesson) => lesson.id.startsWith('module-2-fallback')));
});

test('generateCourseV2 returns a valid course when lesson JSON is broken', async (t) => {
  const syllabusPayload = createSyllabus();
  const modulePlan = buildModulePlan(4, syllabusPayload);
  const fallbackLessonId = 'module-1-fallback-lesson-1';
  const assessmentsPayload = {
    weekly_quizzes: [
      {
        moduleId: modulePlan.modules[0].id,
        items: Array.from({ length: 3 }, (_, idx) => ({
          type: 'mcq',
          question: `Check ${idx + 1}`,
          options: ['A', 'B', 'C'],
          answerIndex: 0,
          anchors: [fallbackLessonId],
        })),
      },
      {
        moduleId: modulePlan.modules[1].id,
        items: Array.from({ length: 3 }, (_, idx) => ({
          type: 'mcq',
          question: `Check ${idx + 1}`,
          options: ['A', 'B', 'C'],
          answerIndex: 0,
          anchors: [fallbackLessonId],
        })),
      },
    ],
    project: {
      title: 'Capstone',
      brief: 'Apply everything.',
      milestones: ['Draft', 'Submit'],
      rubric: 'Clarity and depth.',
    },
    exam_blueprint: {
      sections: [
        { title: 'Concepts', weight_pct: 60, outcomes: [syllabusPayload.outcomes[0]] },
        { title: 'Application', weight_pct: 40, outcomes: [syllabusPayload.outcomes[1]] },
      ],
    },
  };

  const brokenLessonContent = '{ "lessons": [ { "id": "bad", "moduleId": "module-1", "title": "Bad", "objectives": ["o"], "duration_min": 45, "reading": [ { "title": "Doc", "url": https://broken.example/bad } ] } ] }';
  // Updated response sequence: syllabus, module plan (single call now), lessons per module (4), retry for broken lessons per module (4), assessments
  const responses = [
    { content: JSON.stringify(syllabusPayload) },
    { content: JSON.stringify(modulePlan) },
    { content: brokenLessonContent },
    { content: brokenLessonContent },
    { content: brokenLessonContent },
    { content: brokenLessonContent },
    { content: brokenLessonContent },
    { content: brokenLessonContent },
    { content: brokenLessonContent },
    { content: brokenLessonContent },
    { content: JSON.stringify(assessmentsPayload) },
  ];

  __setCourseV2LLMCaller(async () => ({ result: responses.shift() || { content: '{}' } }));
  t.after(() => __resetCourseV2LLMCaller());

  const course = await generateCourseV2({ courseSelection: { college: 'Test U', title: 'Fallback 101' } });
  assert.ok(course.lessons.lessons.length >= 6);
  CoursePackageSchema.parse(course);
});

test('generateAssessments attempts repair before using deterministic assessments', async (t) => {
  const syllabus = createSyllabus();
  const modules = buildModulePlan(4, syllabus);
  const lessons = {
    lessons: modules.modules.flatMap((module) => [
      {
        id: `${module.id}-lesson-1`,
        moduleId: module.id,
        title: `${module.title} Lesson 1`,
        objectives: ['Obj'],
        duration_min: 45,
        reading: [],
        activities: [],
        bridge_from: [],
        bridge_to: [],
        cross_refs: [],
      },
      {
        id: `${module.id}-lesson-2`,
        moduleId: module.id,
        title: `${module.title} Lesson 2`,
        objectives: ['Obj'],
        duration_min: 50,
        reading: [],
        activities: [],
        bridge_from: [],
        bridge_to: [],
        cross_refs: [],
      },
    ]),
  };

  const lessonAnchors = lessons.lessons.map((lesson) => lesson.id);
  const validAssessments = {
    weekly_quizzes: modules.modules.slice(0, 2).map((module) => ({
      moduleId: module.id,
      items: Array.from({ length: 3 }, (_, idx) => ({
        type: 'mcq',
        question: `${module.title} check ${idx + 1}`,
        options: ['A', 'B', 'C'],
        answerIndex: 0,
        anchors: [lessonAnchors[idx]],
      })),
    })),
    project: {
      title: 'Capstone',
      brief: 'Apply everything.',
      milestones: ['Draft', 'Submit'],
      rubric: 'Clarity and depth.',
    },
    exam_blueprint: {
      sections: [
        { title: 'Concepts', weight_pct: 60, outcomes: [syllabus.outcomes[0]] },
        { title: 'Application', weight_pct: 40, outcomes: [syllabus.outcomes[1]] },
      ],
    },
  };

  const responses = [
    { content: 'not json' },
    { content: JSON.stringify({ weekly_quizzes: [] }) },
    { content: JSON.stringify(validAssessments) },
  ];
  const callStages = [];

  __setCourseV2LLMCaller(async (options) => {
    callStages.push(options?.stage ?? 'unknown');
    return { result: responses.shift() || { content: '{}' } };
  });
  t.after(() => __resetCourseV2LLMCaller());

  const assessments = await generateAssessments(modules, lessons, syllabus);
  
  // Verify that repair was attempted (2 calls to ASSESSOR: initial + 1 repair before fallback)
  assert.equal(callStages.filter(s => s === 'ASSESSOR').length, 2, 'expected 2 ASSESSOR calls: initial + 1 repair attempt');
  
  // Final result should be valid assessments (from fallback)
  assert.ok(assessments.weekly_quizzes.length >= 2, 'has at least 2 weekly quizzes');
  assert.ok(assessments.project, 'has project');
  assert.ok(assessments.exam_blueprint, 'has exam_blueprint');
});
