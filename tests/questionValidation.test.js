import test, { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateQuestionWithConfidence,
  rateQuestionConfidence,
  batchValidateQuestions,
  batchValidatePracticeProblems,
  collectLowConfidenceQuestions,
  CONFIDENCE_THRESHOLD,
  __setGrokExecutor,
  __resetGrokExecutor
} from '../src/services/questionValidation.js';

// Mock grok executor
let mockGrokCalls = [];
let mockGrokResponses = [];

function createMockGrokExecutor() {
  return async (opts) => {
    mockGrokCalls.push(opts);
    const response = mockGrokResponses.shift();
    if (response instanceof Error) throw response;
    return { content: JSON.stringify(response) };
  };
}

describe('Question Validation Service', () => {
  beforeEach(() => {
    mockGrokCalls = [];
    mockGrokResponses = [];
  });

  afterEach(() => {
    __resetGrokExecutor();
  });

  describe('CONFIDENCE_THRESHOLD', () => {
    it('should be 0.7', () => {
      assert.equal(CONFIDENCE_THRESHOLD, 0.7);
    });
  });

  describe('generateQuestionWithConfidence', () => {
    it('should return question with confidence score', async () => {
      mockGrokResponses = [{
        internal_reasoning: {
          topic_understanding: 'Clear understanding',
          answer_verification: 'Verified correct',
          distractor_quality: 'Good distractors',
          ambiguity_check: 'No ambiguity',
          confidence_factors: ['Textbook fact'],
          final_confidence: 0.95
        },
        question: {
          question: 'What is 2+2?',
          options: ['3', '4', '5', '6'],
          correct_index: 1,
          explanation: ['Wrong', 'Correct', 'Wrong', 'Wrong']
        }
      }];
      __setGrokExecutor(createMockGrokExecutor());

      const result = await generateQuestionWithConfidence(
        { topic: 'Math', difficulty: 'Easy' },
        'Basic arithmetic',
        'user123',
        'course456'
      );

      assert.equal(result.confidence, 0.95);
      assert.equal(result.needsValidation, false);
      assert.equal(result.question.question, 'What is 2+2?');
    });

    it('should flag low-confidence questions for validation', async () => {
      mockGrokResponses = [{
        internal_reasoning: {
          topic_understanding: 'Some uncertainty',
          final_confidence: 0.5
        },
        question: {
          question: 'Uncertain question?',
          options: ['A', 'B', 'C', 'D'],
          correct_index: 0,
          explanation: ['Expl A', 'Expl B', 'Expl C', 'Expl D']
        }
      }];
      __setGrokExecutor(createMockGrokExecutor());

      const result = await generateQuestionWithConfidence(
        { topic: 'Complex', difficulty: 'Hard' },
        'Uncertain topic',
        'user123',
        'course456'
      );

      assert.equal(result.confidence, 0.5);
      assert.equal(result.needsValidation, true);
    });
  });

  describe('rateQuestionConfidence', () => {
    it('should rate existing question confidence', async () => {
      mockGrokResponses = [{
        analysis: {
          correct_answer_check: 'Answer is correct',
          distractor_check: 'All wrong',
          ambiguity_check: 'Clear',
          factual_verification: 'Verified'
        },
        confidence: 0.9,
        issues: []
      }];
      __setGrokExecutor(createMockGrokExecutor());

      const question = {
        question: 'What is 2+2?',
        options: ['3', '4', '5', '6'],
        correct_index: 1,
        explanation: ['Wrong', 'Correct', 'Wrong', 'Wrong']
      };

      const result = await rateQuestionConfidence(question, 'Math context', 'user123', 'course456');

      assert.equal(result.confidence, 0.9);
      assert.equal(result.needsValidation, false);
      assert.deepEqual(result.issues, []);
    });

    it('should flag questions with issues for validation', async () => {
      mockGrokResponses = [{
        analysis: {
          correct_answer_check: 'Uncertain about answer',
          distractor_check: 'Option C might also be valid',
          ambiguity_check: 'Ambiguous wording',
          factual_verification: 'Cannot verify'
        },
        confidence: 0.4,
        issues: ['Ambiguous wording', 'Multiple valid answers possible']
      }];
      __setGrokExecutor(createMockGrokExecutor());

      const question = {
        question: 'Ambiguous question?',
        options: ['A', 'B', 'C', 'D'],
        correct_index: 0,
        explanation: ['A', 'B', 'C', 'D']
      };

      const result = await rateQuestionConfidence(question, 'Uncertain context', 'user123', 'course456');

      assert.equal(result.confidence, 0.4);
      assert.equal(result.needsValidation, true);
      assert.equal(result.issues.length, 2);
    });
  });

  describe('batchValidateQuestions', () => {
    it('should return empty result for empty input', async () => {
      const result = await batchValidateQuestions([], 'user123', 'course456');

      assert.deepEqual(result.validated, []);
      assert.deepEqual(result.stats, { total: 0, fixed: 0, unchanged: 0, failed: 0 });
    });

    it('should validate and fix questions in batches', async () => {
      mockGrokResponses = [{
        results: [
          {
            question_index: 0,
            status: 'verified',
            analysis: 'Question is correct',
            original_answer_correct: true
          },
          {
            question_index: 1,
            status: 'fixed',
            analysis: 'Fixed incorrect answer',
            original_answer_correct: false,
            question: {
              question: 'Fixed question',
              options: ['A', 'B', 'C', 'D'],
              correct_index: 2,
              explanation: ['Wrong', 'Wrong', 'Correct', 'Wrong']
            },
            changes_made: ['Changed correct_index from 0 to 2']
          }
        ]
      }];
      __setGrokExecutor(createMockGrokExecutor());

      const questions = [
        {
          question: { question: 'Q1', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
          context: 'Context 1',
          lessonId: 'lesson1',
          type: 'quiz'
        },
        {
          question: { question: 'Q2', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
          context: 'Context 2',
          lessonId: 'lesson2',
          type: 'quiz'
        }
      ];

      const result = await batchValidateQuestions(questions, 'user123', 'course456');

      assert.equal(result.stats.total, 2);
      assert.equal(result.stats.unchanged, 1);
      assert.equal(result.stats.fixed, 1);
      assert.equal(result.validated.length, 2);
      assert.equal(result.validated[0].question._validated, true);
      assert.equal(result.validated[1].question.correct_index, 2);
    });
  });

  describe('collectLowConfidenceQuestions', () => {
    it('should collect questions marked for validation', () => {
      const nodes = [
        {
          id: 'lesson1',
          content_payload: {
            reading: 'Lesson content...',
            quiz: [
              { question: 'Q1', _confidence: 0.9, _needsValidation: false },
              { question: 'Q2', _confidence: 0.5, _needsValidation: true },
              { question: 'Q3', _confidence: 0.6, _needsValidation: true }
            ],
            practice_problems: [
              { question: 'P1', _confidence: 0.4, _needsValidation: true }
            ]
          }
        },
        {
          id: 'lesson2',
          content_payload: {
            reading: 'More content...',
            quiz: [
              { question: 'Q4', _confidence: 0.95, _needsValidation: false }
            ]
          }
        }
      ];

      const lowConfidence = collectLowConfidenceQuestions(nodes);

      assert.equal(lowConfidence.length, 3);
      assert.equal(lowConfidence.filter(i => i.type === 'quiz').length, 2);
      assert.equal(lowConfidence.filter(i => i.type === 'practice_problem').length, 1);
      assert.ok(lowConfidence.every(i => i.lessonId && i.context));
    });

    it('should return empty array for nodes with no low-confidence items', () => {
      const nodes = [
        {
          id: 'lesson1',
          content_payload: {
            quiz: [
              { question: 'Q1', _confidence: 0.9 },
              { question: 'Q2', _confidence: 0.85 }
            ]
          }
        }
      ];

      const lowConfidence = collectLowConfidenceQuestions(nodes);

      assert.equal(lowConfidence.length, 0);
    });
  });
});
