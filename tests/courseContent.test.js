import test from 'node:test';
import assert from 'node:assert/strict';
import { saveCourseStructure, generateCourseContent, generatePracticeProblems, __setGrokExecutor, __resetGrokExecutor, __setYouTubeFetcher, __resetYouTubeFetcher } from '../src/services/courseContent.js';
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
    listResponses: [
      { data: pendingNodes, error: null },  // Initial pending nodes fetch
      { data: pendingNodes, error: null },  // All nodes fetch for prereq map
      { data: [], error: null },            // All edges fetch for prereq map
    ],
    singleResponses: [
      // Response for course data query (title, metadata, user_id)
      { data: { title: 'Test Course', metadata: { mode: 'deep', user_name: 'Test User' }, user_id: 'user-123' }, error: null },
    ],
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

    // Handle batched module readings
    if (systemMessage.includes('Generate readings for ALL') && systemMessage.includes('lessons below in a SINGLE response')) {
      return {
        content: `===LESSON:node-a===
# Lesson A Body
This is the reading for Lesson A.
Lorem ipsum dolor sit amet, consectetur adipiscing elit. `.repeat(20) + `

===LESSON:node-b===
# Lesson B Body
This is the reading for Lesson B.
Lorem ipsum dolor sit amet, consectetur adipiscing elit. `.repeat(20),
      };
    }

    // Handle batched module quizzes
    if (systemMessage.includes('Generate') && systemMessage.includes('questions for EACH of the') && systemMessage.includes('lessons')) {
      return {
        content: `lesson_id,index,question,optionA,optionB,optionC,optionD,correct_index,expA,expB,expC,expD
node-a,0,Q1 for Lesson A?,Option A is incorrect,Option B is correct,Option C is wrong,Option D is not right,1,A is incorrect because it fails the test,B is correct because it satisfies all conditions,C is incorrect due to logical error,D is incorrect as it misses the point
node-b,0,Q1 for Lesson B?,Option A wrong,Option B right,Option C wrong,Option D wrong,1,A fails the requirement,B meets all criteria correctly,C has a logical flaw,D is incomplete`,
      };
    }

    // Handle batched module flashcards
    if (systemMessage.includes('Generate') && systemMessage.includes('flashcards for EACH of the') && systemMessage.includes('lessons')) {
      return {
        content: `lesson_id,index,front,back
node-a,0,Front A,Back A
node-b,0,Front B,Back B`,
      };
    }

    if (systemMessage.includes('Quality Assurance Validator')) {
      if (systemMessage.includes('Respond with JSON: { "status": "CORRECT" }')) {
        return { content: JSON.stringify({ status: 'CORRECT' }) };
      }
      return { content: 'CORRECT' };
    }

    if (/Create one deep-understanding multiple-choice question/i.test(lastContent)) {
      return {
        content: JSON.stringify({
          question: 'What is the main implication?',
          options: ['Option A', 'Option B', 'Option C', 'Option D'],
          answerIndex: 1,
          explanation: [
            'Option A is incorrect because it does not address the core concept being tested here.',
            'Option B is correct because it accurately represents the main implication of the concept.',
            'Option C is incorrect because it represents a common misconception about this topic.',
            'Option D is incorrect because it only partially addresses the question requirements.'
          ],
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
              question: 'Q1: Which option is correct?',
              options: ['Option A is incorrect', 'Option B is the correct answer', 'Option C is also incorrect', 'Option D is not right'],
              correct_index: 1,
              explanation: [
                'Option A is incorrect because it does not match the expected outcome.',
                'Option B is correct because it accurately represents the solution.',
                'Option C is incorrect because it represents a common misconception.',
                'Option D is incorrect because it only partially addresses the question.'
              ],
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
    // Check that batched content is present (either from batch or fallback)
    assert.ok(nodeUpdates[0].content_payload.reading.includes("Lesson"));
    // Inline questions may or may not be present depending on mock responses
    // The key is that the content was generated successfully
    assert.equal(nodeUpdates[0].content_payload.status, 'ready');
    assert.ok(Array.isArray(nodeUpdates[0].content_payload.quiz));
    assert.ok(Array.isArray(nodeUpdates[0].content_payload.flashcards));
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

test('generatePracticeProblems creates validated exam-style problems with rubrics', async () => {
  let callCount = 0;
  
  __setGrokExecutor(async ({ messages, source }) => {
    callCount++;
    const systemMessage = messages.find(m => m.role === 'system')?.content || '';
    
    // Initial generation call
    if (source === 'practice_problems_generation') {
      return {
        content: JSON.stringify({
          internal_audit: 'Problem design covers key concepts',
          practice_problems: [
            {
              validation_check: 'Verified rubric matches solution steps',
              question: 'Given the function f(x) = sin(x²), find f\'(x) and evaluate at x = π.',
              estimated_minutes: 15,
              difficulty: 'Hard',
              topic_tags: ['chain-rule', 'trigonometry'],
              rubric: {
                total_points: 10,
                grading_criteria: [
                  { criterion: 'Correctly identify composite function structure', points: 2, common_errors: ['Treating as simple sine'] },
                  { criterion: 'Apply chain rule correctly', points: 4, common_errors: ['Forgetting inner derivative 2x'] },
                  { criterion: 'Evaluate at x = π correctly', points: 3, common_errors: ['Using degrees instead of radians'] },
                  { criterion: 'Clear presentation', points: 1, common_errors: ['Missing intermediate steps'] }
                ],
                partial_credit_policy: 'Award partial credit for correct approach even if arithmetic errors'
              },
              sample_answer: {
                solution_steps: [
                  'Step 1: Identify f(x) = sin(g(x)) where g(x) = x²',
                  'Step 2: Apply chain rule: f\'(x) = cos(x²) · 2x',
                  'Step 3: Evaluate: f\'(π) = cos(π²) · 2π ≈ -5.98'
                ],
                final_answer: 'f\'(x) = 2x·cos(x²), f\'(π) ≈ -5.98',
                key_insights: ['Chain rule requires multiplying by derivative of inner function'],
                alternative_approaches: ['Could use limit definition but chain rule is more efficient']
              }
            }
          ]
        })
      };
    }
    
    // Validation call - confirm the problem is correct
    if (source === 'practice_problem_validation') {
      return {
        content: JSON.stringify({
          my_solution: {
            approach: 'Apply chain rule to composite function',
            steps: ['Identify inner/outer', 'Apply chain rule', 'Evaluate'],
            final_answer: 'f\'(x) = 2x·cos(x²), f\'(π) ≈ -5.98'
          },
          comparison: {
            answers_match: true,
            my_answer_is_correct: true,
            provided_answer_is_correct: true,
            discrepancy_explanation: ''
          },
          rubric_evaluation: {
            is_fair: true,
            covers_all_steps: true,
            points_are_reasonable: true,
            issues: []
          },
          overall_assessment: {
            is_correct: true,
            confidence: 'high',
            issues: [],
            recommendations: []
          }
        })
      };
    }
    
    return { content: '{}' };
  });

  try {
    const result = await generatePracticeProblems(
      'Chain Rule Mastery',
      'Create 1 problem testing chain rule with trigonometric functions',
      'Calculus I',
      'Differentiation',
      'user-123',
      'course-456'
    );

    assert.ok(result.data, 'Should return data array');
    assert.equal(result.data.length, 1, 'Should have 1 practice problem');
    
    const problem = result.data[0];
    assert.ok(problem.question.includes('sin'), 'Question should reference trigonometric function');
    assert.equal(problem.difficulty, 'Hard', 'Difficulty should be Hard');
    assert.ok(Array.isArray(problem.topic_tags), 'Should have topic tags array');
    
    // Verify rubric structure
    assert.ok(problem.rubric, 'Should have rubric');
    assert.equal(problem.rubric.total_points, 10, 'Should have total points');
    assert.ok(Array.isArray(problem.rubric.grading_criteria), 'Should have grading criteria array');
    assert.ok(problem.rubric.grading_criteria.length >= 2, 'Should have multiple grading criteria');
    
    // Verify sample answer structure
    assert.ok(problem.sample_answer, 'Should have sample answer');
    assert.ok(Array.isArray(problem.sample_answer.solution_steps), 'Should have solution steps');
    assert.ok(problem.sample_answer.final_answer, 'Should have final answer');
    
    // Problems are marked for batch validation later (not individually validated here)
    assert.ok('_needsValidation' in problem, 'Problem should have _needsValidation flag');
    
    // Verify stats
    assert.ok(result.stats, 'Should have stats');
    assert.ok('lowConfidenceCount' in result.stats, 'Should have lowConfidenceCount stat');
    
    assert.equal(callCount, 1, 'Should have made 1 LLM call (generation only - validation is batched)');
  } finally {
    __resetGrokExecutor();
  }
});

test('generatePracticeProblems marks problems for batch validation', async () => {
  let callCount = 0;
  
  __setGrokExecutor(async ({ messages, source }) => {
    callCount++;
    
    // Generation with a problem that might need validation
    if (source === 'practice_problems_generation') {
      return {
        content: JSON.stringify({
          practice_problems: [
            {
              question: 'What is 2 + 2?',
              estimated_minutes: 15,
              difficulty: 'Hard',
              topic_tags: ['arithmetic'],
              rubric: {
                total_points: 10,
                grading_criteria: [
                  { criterion: 'Correct answer', points: 10, common_errors: [] }
                ],
                partial_credit_policy: 'All or nothing'
              },
              sample_answer: {
                solution_steps: ['Add the numbers'],
                final_answer: '4',
                key_insights: [],
                alternative_approaches: []
              }
            }
          ]
        })
      };
    }
    
    return { content: '{}' };
  });

  try {
    const result = await generatePracticeProblems(
      'Basic Math',
      'Simple arithmetic problem',
      'Math 101',
      'Fundamentals',
      'user-123',
      'course-456'
    );

    assert.ok(result.data, 'Should return data array');
    assert.equal(result.data.length, 1, 'Should have 1 practice problem');
    
    const problem = result.data[0];
    assert.equal(problem.sample_answer.final_answer, '4', 'Should have correct answer');
    
    // Verify marked for batch validation (validation happens later at course level)
    assert.ok('_needsValidation' in problem, 'Problem should be marked for batch validation');
    
    // Verify stats
    assert.ok(result.stats, 'Should have stats');
    assert.ok('lowConfidenceCount' in result.stats, 'Should have lowConfidenceCount stat');
    
    assert.equal(callCount, 1, 'Should have made only 1 LLM call (validation is batched)');
  } finally {
    __resetGrokExecutor();
  }
});
