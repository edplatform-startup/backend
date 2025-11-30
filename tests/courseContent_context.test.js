import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCourseContent, __setGrokExecutor, __resetGrokExecutor } from '../src/services/courseContent.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';

test('generateCourseContent injects prerequisite context into prompts', async () => {
  const courseId = 'course-context-test';
  const nodes = [
    {
      id: 'node-parent',
      title: 'Introduction to Algebra',
      content_payload: { status: 'ready' }, // Already done
    },
    {
      id: 'node-child',
      title: 'Quadratic Equations',
      content_payload: {
        status: 'pending',
        generation_plans: {
          reading: 'Explain quadratics.',
          quiz: 'Test quadratics.',
        },
      },
    },
  ];

  const edges = [
    { parent_id: 'node-parent', child_id: 'node-child' },
  ];

  const stub = createSupabaseStub({
    listResponses: [
      { data: [nodes[1]], error: null }, // 1. pendingNodes
      { data: [], error: null },         // 2. courseData (unused list)
      { data: nodes, error: null },      // 3. allNodes
      { data: edges, error: null },      // 4. allEdges
    ],
    singleResponses: [
       { data: null, error: null },                 // 1. pendingNodes (unused single)
       { data: { title: 'Math Course' }, error: null }, // 2. courseData
       { data: null, error: null },                 // 3. allNodes (unused single)
       { data: null, error: null },                 // 4. allEdges (unused single)
    ],
    updateResponses: [
      { data: { id: 'node-child' }, error: null },
      { data: { id: courseId }, error: null },
    ],
  });
  setSupabaseClient(stub);

  let capturedMessages = [];

  __setGrokExecutor(async ({ messages }) => {
    capturedMessages.push(messages);
    
    // Return dummy content to satisfy the worker
    const lastMessage = messages[messages.length - 1].content;
    
    if (/quiz/i.test(lastMessage)) {
      return {
        content: JSON.stringify({
          quiz: [
            {
              question: 'Q1',
              options: ['A', 'B', 'C', 'D'],
              correct_index: 0,
              explanation: 'Exp',
              validation_check: 'Check'
            }
          ]
        })
      };
    }

    return {
      content: JSON.stringify({
        final_content: { markdown: '# Content' }
      })
    };
  });

  try {
    await generateCourseContent(courseId, { concurrency: 1 });

    // Verify that messages contained the context
    const readingPrompt = capturedMessages.find(msgs => msgs[0].content.includes('reading lesson'));
    
    if (!readingPrompt) {
      console.log('Captured Messages:', JSON.stringify(capturedMessages, null, 2));
    }
    assert.ok(readingPrompt, 'Should have generated a reading prompt');
    
    const readingSystemMsg = readingPrompt.find(m => m.role === 'system').content;
    if (!readingSystemMsg.includes('Context: The student has completed lessons on [Introduction to Algebra]')) {
       console.log('Reading System Msg:', readingSystemMsg);
    }
    assert.ok(readingSystemMsg.includes('Context: The student has completed lessons on [Introduction to Algebra]'), 
      'Reading prompt should include prerequisite context');

    const quizPrompt = capturedMessages.find(msgs => msgs[0].content.includes('graduate-level quiz'));
    assert.ok(quizPrompt, 'Should have generated a quiz prompt');
    
    const quizSystemMsg = quizPrompt.find(m => m.role === 'system').content;
    assert.ok(quizSystemMsg.includes('Context: The student has completed lessons on [Introduction to Algebra]'), 
      'Quiz prompt should include prerequisite context');

  } finally {
    __resetGrokExecutor();
    clearSupabaseClient();
  }
});
