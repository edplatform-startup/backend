import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateHierarchicalTopics,
  __setCourseV2LLMCaller,
  __resetCourseV2LLMCaller,
  __setSyllabusSynthesizer,
  __clearSyllabusSynthesizer,
  __setRagSessionCreator,
  __clearRagSessionCreator,
  __setRagContextRetriever,
  __clearRagContextRetriever,
} from '../src/services/courseV2.js';

test.afterEach(() => {
  __resetCourseV2LLMCaller();
  __clearSyllabusSynthesizer();
  __clearRagSessionCreator();
  __clearRagContextRetriever();
});

test('generateHierarchicalTopics: creates RAG session and injects context into prompt', async () => {
  const capturedMessages = [];
  let ragSessionCreated = false;
  let ragContextRetrieved = false;
  const testSessionId = 'test-rag-session-123';
  const testRagContext = '[SYLLABUS]\nChapter 1: Introduction to Calculus. Limits and continuity.\n---\n[EXAM]\nExam covers derivatives and integrals. 60% multiple choice.';

  // Mock syllabus synthesizer to return a simple skeleton
  __setSyllabusSynthesizer(() => ({
    course_structure_type: 'Module-based',
    skeleton: [
      { sequence_order: 1, title: 'Limits', raw_concepts: ['epsilon-delta'], is_exam_review: false },
      { sequence_order: 2, title: 'Derivatives', raw_concepts: ['chain rule'], is_exam_review: false },
    ],
  }));

  // Mock RAG session creator
  __setRagSessionCreator((opts) => {
    ragSessionCreated = true;
    assert.equal(opts.userId, 'user-123');
    assert.ok(opts.syllabusText.includes('Week 1'));
    assert.ok(opts.examText.includes('multiple choice'));
    return { sessionId: testSessionId, counts: { syllabus: 2, exam: 1 } };
  });

  // Mock RAG context retriever
  __setRagContextRetriever((opts) => {
    ragContextRetrieved = true;
    assert.equal(opts.sessionId, testSessionId);
    assert.ok(opts.queryText.includes('Calculus')); // Course title
    assert.ok(opts.queryText.includes('Limits')); // Skeleton heading
    return testRagContext;
  });

  // Mock LLM caller to capture prompts
  __setCourseV2LLMCaller(async ({ messages }) => {
    capturedMessages.push(...messages);
    return {
      result: {
        content: JSON.stringify({
          overviewTopics: [
            {
              id: 'topic-1',
              title: 'Limits',
              original_skeleton_ref: 'Limits',
              subtopics: [
                {
                  id: 'sub-1',
                  overviewId: 'topic-1',
                  title: 'Epsilon-Delta Definition',
                  bloom_level: 'Understand',
                  estimated_study_time_minutes: 45,
                  importance_score: 9,
                  exam_relevance_reasoning: 'Per syllabus chapter 1.',
                  yield: 'High',
                },
              ],
            },
          ],
        }),
      },
      model: 'test-model',
    };
  });

  const result = await generateHierarchicalTopics(
    {
      courseTitle: 'Calculus 101',
      syllabusText: 'Week 1: Limits. Week 2: Derivatives.',
      examFormatDetails: '60% multiple choice, 40% free response',
      mode: 'deep',
    },
    'user-123'
  );

  // Assert RAG was used
  assert.ok(ragSessionCreated, 'RAG session should have been created');
  assert.ok(ragContextRetrieved, 'RAG context should have been retrieved');

  // Assert rag_session_id is returned
  assert.equal(result.rag_session_id, testSessionId);

  // Assert prompt contains RAG context
  const userMessage = capturedMessages.find((m) => m.role === 'user');
  assert.ok(userMessage, 'User message should exist');
  assert.ok(
    userMessage.content.includes('Authoritative Excerpts'),
    'Prompt should contain authoritative excerpts heading'
  );
  assert.ok(
    userMessage.content.includes('[SYLLABUS]'),
    'Prompt should contain syllabus excerpt'
  );
  assert.ok(
    userMessage.content.includes('[EXAM]'),
    'Prompt should contain exam excerpt'
  );
  assert.ok(
    userMessage.content.includes('Chapter 1: Introduction to Calculus'),
    'Prompt should contain actual syllabus content'
  );
  assert.ok(
    userMessage.content.includes('60% multiple choice'),
    'Prompt should contain actual exam content'
  );

  // Assert system prompt instructs grounding
  const systemMessage = capturedMessages.find((m) => m.role === 'system');
  assert.ok(systemMessage, 'System message should exist');
  assert.ok(
    systemMessage.content.includes('GROUNDING'),
    'System prompt should contain grounding instruction'
  );
  assert.ok(
    systemMessage.content.includes('authoritative excerpts'),
    'System prompt should reference authoritative excerpts'
  );

  // Assert result structure
  assert.ok(result.overviewTopics.length > 0);
  assert.equal(result.model, 'test-model');
});

test('generateHierarchicalTopics: continues without RAG if session creation fails', async () => {
  __setSyllabusSynthesizer(() => ({
    course_structure_type: 'Module-based',
    skeleton: [
      { sequence_order: 1, title: 'Topic A', raw_concepts: ['concept1'], is_exam_review: false },
      { sequence_order: 2, title: 'Topic B', raw_concepts: ['concept2'], is_exam_review: false },
    ],
  }));

  // Mock RAG to fail
  __setRagSessionCreator(() => {
    throw new Error('Embeddings service unavailable');
  });

  __setCourseV2LLMCaller(async () => ({
    result: {
      content: JSON.stringify({
        overviewTopics: [
          {
            id: 'topic-1',
            title: 'Topic A',
            original_skeleton_ref: 'Topic A',
            subtopics: [
              {
                id: 'sub-1',
                overviewId: 'topic-1',
                title: 'Concept 1',
                bloom_level: 'Understand',
                estimated_study_time_minutes: 30,
                importance_score: 7,
                exam_relevance_reasoning: 'Standard topic.',
                yield: 'Medium',
              },
            ],
          },
        ],
      }),
    },
    model: 'fallback-model',
  }));

  const result = await generateHierarchicalTopics(
    {
      courseTitle: 'Test Course',
      syllabusText: 'Some syllabus content.',
    },
    'user-456'
  );

  // Should succeed without rag_session_id
  assert.ok(result.overviewTopics.length > 0);
  assert.equal(result.rag_session_id, null);
});

test('generateHierarchicalTopics: no RAG when no syllabus/exam text provided', async () => {
  let ragCalled = false;

  __setSyllabusSynthesizer(() => ({
    course_structure_type: 'Topic-based',
    skeleton: [
      { sequence_order: 1, title: 'Unit 1', raw_concepts: [], is_exam_review: false },
      { sequence_order: 2, title: 'Unit 2', raw_concepts: [], is_exam_review: false },
    ],
  }));

  __setRagSessionCreator(() => {
    ragCalled = true;
    return { sessionId: 'should-not-be-called', counts: { syllabus: 0, exam: 0 } };
  });

  __setCourseV2LLMCaller(async () => ({
    result: {
      content: JSON.stringify({
        overviewTopics: [
          {
            id: 't1',
            title: 'Unit 1',
            original_skeleton_ref: 'Unit 1',
            subtopics: [
              {
                id: 's1',
                overviewId: 't1',
                title: 'Subtopic 1',
                bloom_level: 'Remember',
                estimated_study_time_minutes: 20,
                importance_score: 5,
                exam_relevance_reasoning: 'Basic topic.',
                yield: 'Low',
              },
            ],
          },
        ],
      }),
    },
    model: 'test',
  }));

  const result = await generateHierarchicalTopics(
    {
      courseTitle: 'Minimal Course',
      // No syllabusText or examFormatDetails
    },
    'user-789'
  );

  assert.ok(!ragCalled, 'RAG should not be called when no syllabus/exam text');
  assert.equal(result.rag_session_id, null);
});
