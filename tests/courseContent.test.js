import test from 'node:test';
import assert from 'node:assert/strict';
import { saveCourseStructure, generateCourseContent, __setGrokExecutor, __resetGrokExecutor, __setYouTubeFetcher, __resetYouTubeFetcher } from '../src/services/courseContent.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';

function buildGraphFixtures() {
  return {
    finalNodes: [
      {
        id: 'node-1',
        title: 'Atomic Lesson',
        bloom_level: 'Understand',
        intrinsic_exam_value: 6,
        estimated_minutes: 30,
        content_payload: {
          generation_plans: {
            reading: 'Use a bridge analogy.',
            quiz: 'Probe conceptual traps.',
            flashcards: 'Focus on definitions.',
          },
          metadata: { original_source_ids: ['src-1'] },
        },
        metadata: { original_source_ids: ['src-1'] },
        confidence_score: 0.65,
      },
    ],
    finalEdges: [
      { parent_id: 'node-root', child_id: 'node-1' },
    ],
  };
}

test('saveCourseStructure stores nodes, edges, and user state with pending status', async () => {
  const nodePayloads = [];
  const edgePayloads = [];
  const statePayloads = [];
  const stub = createSupabaseStub({
    insertResponses: [
      { data: { id: 'node-1' }, error: null, onInsert: (payload) => nodePayloads.push(payload) },
      { data: null, error: null, onInsert: (payload) => edgePayloads.push(payload) },
      { data: null, error: null, onInsert: (payload) => statePayloads.push(payload) },
    ],
  });
  setSupabaseClient(stub);

  const graph = buildGraphFixtures();
  await saveCourseStructure('course-1', 'user-1', graph);

  assert.equal(nodePayloads.length, 1);
  const insertedNode = nodePayloads[0][0];
  assert.equal(insertedNode.course_id, 'course-1');
  assert.equal(insertedNode.user_id, 'user-1');
  assert.equal(insertedNode.content_payload.status, 'pending');
  assert.ok(insertedNode.content_payload.generation_plans.reading);
  assert.ok(insertedNode.content_payload.generation_plans.reading);

  assert.equal(edgePayloads.length, 1);
  assert.deepEqual(edgePayloads[0], [{ course_id: 'course-1', parent_id: 'node-root', child_id: 'node-1' }]);

  assert.equal(statePayloads.length, 1);
  assert.deepEqual(statePayloads[0], [
    {
      course_id: 'course-1',
      node_id: 'node-1',
      user_id: 'user-1',
      confidence_score: 0.65,
      familiarity_score: 0.65,
    },
  ]);

  clearSupabaseClient();
});

test('generateCourseContent fills node payloads and marks course ready', async () => {
  const pendingNodes = [
    {
      id: 'node-a',
      title: 'Lesson A',
      content_payload: {
        status: 'pending',
        generation_plans: {
          reading: 'Explain concept A with concrete examples.',
          quiz: 'Ask about pitfalls.',
          flashcards: 'Key formulas only.',
          video: ['concept a lecture'],
        },
        metadata: { original_source_ids: ['sa'] },
      },
      metadata: { original_source_ids: ['sa'] },
    },
    {
      id: 'node-b',
      title: 'Lesson B',
      content_payload: {
        status: 'pending',
        generation_plans: {
          reading: 'Connect lesson B to real-world.',
          quiz: 'Edge cases only.',
          flashcards: 'Mnemonics.',
          video: ['concept b lecture'],
        },
        metadata: { original_source_ids: ['sb'] },
      },
      metadata: { original_source_ids: ['sb'] },
    },
  ];

  const nodeUpdates = [];
  const courseUpdates = [];
  const stub = createSupabaseStub({
    listResponses: [{ data: pendingNodes, error: null }],
    updateResponses: [
      { data: { id: 'node-a' }, error: null, onUpdate: (payload) => nodeUpdates.push(payload) },
      { data: { id: 'node-b' }, error: null, onUpdate: (payload) => nodeUpdates.push(payload) },
      { data: { id: 'course-xyz' }, error: null, onUpdate: (payload) => courseUpdates.push(payload) },
    ],
  });
  setSupabaseClient(stub);

  __setGrokExecutor(async ({ messages }) => {
    const stringifyContent = (payload) => {
      if (typeof payload === 'string') return payload;
      if (Array.isArray(payload)) {
        return payload
          .map((part) => (typeof part === 'string' ? part : part?.text || ''))
          .join(' ');
      }
      if (payload && typeof payload === 'object' && typeof payload.content === 'string') {
        return payload.content;
      }
      return '';
    };

    const lastMessage = messages[messages.length - 1] || {};
    const lastContent = stringifyContent(lastMessage.content);
    const systemMessage = messages.find(m => m.role === 'system')?.content || '';

    if (systemMessage.includes('Quality Assurance Validator')) {
      if (systemMessage.includes('Respond with JSON: { "status": "CORRECT" }')) {
        return { content: JSON.stringify({ status: 'CORRECT' }) };
      }
      return { content: 'CORRECT' };
    }

    if (/practice_exam/i.test(lastContent)) {
      return {
        content: JSON.stringify({
          internal_audit: 'ensured free-response coverage',
          practice_exam: [
            {
              validation_check: 'One coherent rubric ties to answer key',
              question: 'Solve the practice exam prompt.',
              answer_key: 'Detailed solution.',
              rubric: 'Award points for steps.',
              estimated_minutes: 20,
            },
          ],
        }),
      };
    }

    if (/Create one .*multiple-choice question/i.test(lastContent)) {
      return {
        content: JSON.stringify({
          question: 'What is the main implication?',
          options: ['Option A', 'Option B', 'Option C', 'Option D'],
          answerIndex: 1,
          explanation: 'Option B is correct because...',
        }),
      };
    }

    if (/multiple-choice|quiz/i.test(lastContent)) {
      return {
        content: JSON.stringify({
          internal_audit: 'quiz scratchpad',
          quiz: [
            {
              validation_check: 'Only option B satisfies constraint.',
              question: 'Q1',
              options: ['A', 'B', 'C'],
              correct_index: 1,
              explanation: 'Because B.',
            },
          ],
        }),
      };
    }

    if (/flashcards/i.test(lastContent)) {
      return {
        content: JSON.stringify({
          internal_audit: 'flashcard coverage notes',
          flashcards: [
            {
              step_by_step_thinking: 'Remind about mnemonic',
              front: 'Front',
              back: 'Back',
            },
          ],
        }),
      };
    }

    const mdDoc = "# Lesson Body\nIt's great.\n" + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(20);
    return {
      content: JSON.stringify({
        internal_audit: 'reading scratchpad',
        final_content: {
          markdown: mdDoc,
        },
      }),
    };
  });
  __setYouTubeFetcher(async () => ({ videoId: 'vid123', title: 'Demo', thumbnail: 'thumb' }));

  try {
    const result = await generateCourseContent('course-xyz', { concurrency: 2 });

    assert.equal(result.status, 'ready');
    assert.equal(nodeUpdates.length, 2);
    assert.ok(nodeUpdates[0].content_payload.reading.includes("# Lesson Body\nIt's great."));
    assert.ok(nodeUpdates[0].content_payload.reading.includes("**Check Your Understanding**"));
    assert.equal(nodeUpdates[0].content_payload.status, 'ready');
    assert.ok(Array.isArray(nodeUpdates[0].content_payload.quiz));
    assert.ok(Array.isArray(nodeUpdates[0].content_payload.flashcards));
    assert.equal(nodeUpdates[0].content_payload.practice_exam, null);
    assert.deepEqual(nodeUpdates[0].content_payload.video, [{ videoId: 'vid123', title: 'Demo', thumbnail: 'thumb' }]);
    assert.equal(nodeUpdates[0].content_payload.video_urls, 'https://www.youtube.com/watch?v=vid123');
    assert.ok(Array.isArray(nodeUpdates[0].content_payload.video_logs));
    assert.ok(nodeUpdates[0].content_payload.video_logs.some(l => l.includes('Using custom YouTube fetcher')));

    assert.equal(courseUpdates.length, 1);
    assert.equal(courseUpdates[0].status, 'ready');
  } finally {
    __resetGrokExecutor();
    __resetYouTubeFetcher();
    clearSupabaseClient();
  }
});
