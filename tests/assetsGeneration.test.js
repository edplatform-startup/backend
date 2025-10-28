import test from 'node:test';
import assert from 'node:assert/strict';
import {
  setCourseStructureGenerator,
  clearCourseStructureGenerator,
  generateCourseStructureWithAssets,
} from '../src/services/courseGenerator.js';
import { setOpenRouterChatExecutor, clearOpenRouterChatExecutor } from '../src/services/grokClient.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';

const basePayload = {
  topics: ['Graphs'],
  className: 'Intro to CS',
  startDate: '2025-01-01T00:00:00.000Z',
  endDate: '2025-02-01T00:00:00.000Z',
  syllabusText: '',
  syllabusFiles: [],
  examStructureText: '3 MCQs 2 FRQs',
  examStructureFiles: [],
  topicFamiliarity: [],
  attachments: [],
};

const mockStructure = {
  'Module/Graphs': [
    { Format: 'video', content: 'Basics of graphs' },
    { Format: 'project', content: 'Build a small graph library' },
    { Format: 'mini quiz', content: 'Check understanding' },
  ],
};

test('per-asset generation: ignores unsupported formats and attaches ids', async (t) => {
  t.afterEach(() => {
    clearCourseStructureGenerator();
    clearSupabaseClient();
    clearOpenRouterChatExecutor();
  });

  setCourseStructureGenerator(() => ({
    model: 'x-ai/grok-4-fast',
    raw: JSON.stringify(mockStructure),
    courseStructure: JSON.parse(JSON.stringify(mockStructure)),
  }));

  const inserts = [];
  const stub = createSupabaseStub({
      insertResponses: [
        // video
        { data: { id: 'vid-1' }, error: null, onInsert: (p) => inserts.push(['video', p]) },
        // mini quiz
        { data: { id: 'quiz-1' }, error: null, onInsert: (p) => inserts.push(['quiz', p]) },
        // course row
        { data: { id: 'course-1' }, error: null, onInsert: (p) => inserts.push(['course', p]) },
      ],
    });
  setSupabaseClient(stub);

  // Provide fake API key for tests
  process.env.OPENROUTER_API_KEY = 'test-key';
  // Stub model JSON responses
  setOpenRouterChatExecutor(async ({ messages }) => {
    const user = messages?.find((m) => m.role === 'user')?.content || '';
    let parsed;
    if (typeof user === 'string' && user.includes('"videos"')) {
      parsed = { videos: [{ title: 'Graph Intro', outline: ['a','b'], watch_time_minutes: 8, key_points: ['x'] }] };
    } else if (typeof user === 'string' && user.includes('"questions"')) {
      parsed = { questions: [{ question: 'Q1', options: ['A','B','C','D'], answer: 'A', explanation: 'why' }] };
    } else {
      parsed = { ok: true };
    }
    return { content: JSON.stringify(parsed), message: { parsed } };
  });

  const userId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const courseId = '11111111-2222-3333-4444-555555555555';

  const result = await generateCourseStructureWithAssets({
    ...basePayload,
    userId,
    courseId,
    supabase: stub,
  });

  const structure = result.courseStructure;
  const assets = structure['Module/Graphs'];
  assert.equal(assets.length, 2, 'unsupported project should be dropped');
  assert.ok(assets[0].id && assets[1].id, 'supported assets should have ids');

  // expect two content inserts (course row is saved by the route, not here)
  assert.equal(inserts.length, 2);
});
