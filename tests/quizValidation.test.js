import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { 
  __mergeValidatedArray as mergeValidatedArray,
  __validateExplanations as validateExplanations,
  __checkRationaleConsistency as checkRationaleConsistency,
  __MIN_EXPLANATION_LENGTH as MIN_EXPLANATION_LENGTH
} from '../src/services/courseContent.js';

describe('mergeValidatedArray', () => {
  it('should return validated array when it has same length as original', () => {
    const original = [
      { question: 'Q1', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
      { question: 'Q2', options: ['A', 'B', 'C', 'D'], correct_index: 1 },
    ];
    const validated = [
      { question: 'Q1 Fixed', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
      { question: 'Q2 Fixed', options: ['A', 'B', 'C', 'D'], correct_index: 1 },
    ];

    const result = mergeValidatedArray(original, validated, 'quiz');
    assert.deepEqual(result, validated);
  });

  it('should return validated array when it has more items than original', () => {
    const original = [
      { question: 'Q1', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
    ];
    const validated = [
      { question: 'Q1', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
      { question: 'Q2', options: ['A', 'B', 'C', 'D'], correct_index: 1 },
    ];

    const result = mergeValidatedArray(original, validated, 'quiz');
    assert.deepEqual(result, validated);
  });

  it('should merge partial fixes with original array when validator returns fewer items', () => {
    const original = [
      { question: 'What is 2+2?', options: ['3', '4', '5', '6'], correct_index: 1 },
      { question: 'What is 3+3?', options: ['5', '6', '7', '8'], correct_index: 1 },
      { question: 'What is 4+4?', options: ['7', '8', '9', '10'], correct_index: 1 },
    ];
    // Validator only returns the fixed version of Q2
    const validated = [
      { question: 'What is 3+3?', options: ['5', '6', '7', '8'], correct_index: 1, explanation: ['Fixed explanation'] },
    ];

    const result = mergeValidatedArray(original, validated, 'quiz');
    
    // Should have all 3 questions
    assert.equal(result.length, 3);
    // First and third should be from original
    assert.deepEqual(result[0], original[0]);
    assert.deepEqual(result[2], original[2]);
    // Second should be the fixed version
    assert.deepEqual(result[1], validated[0]);
  });

  it('should return original when validated array is empty', () => {
    const original = [
      { question: 'Q1', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
      { question: 'Q2', options: ['A', 'B', 'C', 'D'], correct_index: 1 },
    ];
    const validated = [];

    const result = mergeValidatedArray(original, validated, 'quiz');
    assert.deepEqual(result, original);
  });

  it('should handle flashcards using front as match key', () => {
    const original = [
      { front: 'Term 1', back: 'Definition 1' },
      { front: 'Term 2', back: 'Definition 2' },
      { front: 'Term 3', back: 'Definition 3' },
    ];
    // Validator only returns fixed Term 2
    const validated = [
      { front: 'Term 2', back: 'Fixed Definition 2' },
    ];

    const result = mergeValidatedArray(original, validated, 'flashcards');
    
    assert.equal(result.length, 3);
    assert.deepEqual(result[0], original[0]);
    assert.deepEqual(result[1], validated[0]);
    assert.deepEqual(result[2], original[2]);
  });

  it('should handle case-insensitive matching', () => {
    const original = [
      { question: 'What is 2+2?', options: ['A', 'B', 'C', 'D'], correct_index: 1 },
    ];
    const validated = [
      { question: 'what is 2+2?', options: ['A', 'B', 'C', 'D'], correct_index: 1, explanation: ['Fixed'] },
    ];

    const result = mergeValidatedArray(original, validated, 'quiz');
    
    assert.equal(result.length, 1);
    // Should use the validated version
    assert.deepEqual(result[0], validated[0]);
  });

  it('should return original if inputs are not arrays', () => {
    const original = [{ question: 'Q1' }];
    
    const result1 = mergeValidatedArray(original, null, 'quiz');
    assert.deepEqual(result1, original);
    
    const result2 = mergeValidatedArray(original, { status: 'CORRECT' }, 'quiz');
    assert.deepEqual(result2, original);
  });

  it('should preserve all original items when no matches found in validated', () => {
    const original = [
      { question: 'Q1', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
      { question: 'Q2', options: ['A', 'B', 'C', 'D'], correct_index: 1 },
      { question: 'Q3', options: ['A', 'B', 'C', 'D'], correct_index: 2 },
    ];
    // Validator returns a completely different question (no match)
    const validated = [
      { question: 'Completely different question', options: ['A', 'B', 'C', 'D'], correct_index: 0 },
    ];

    const result = mergeValidatedArray(original, validated, 'quiz');
    
    // All original items should be preserved since no match was found
    assert.equal(result.length, 3);
    assert.deepEqual(result, original);
  });
});

describe('validateExplanations', () => {
  it('should accept valid explanations with 4 substantive strings', () => {
    const explanations = [
      'This is a substantive explanation for option A that explains why it is correct.',
      'This is a substantive explanation for option B that explains the misconception.',
      'This is a substantive explanation for option C that explains why it is wrong.',
      'This is a substantive explanation for option D that clarifies the error.',
    ];
    const result = validateExplanations(explanations, 4);
    assert.strictEqual(result.valid, true);
  });

  it('should reject non-array explanations', () => {
    const result = validateExplanations('just a string', 4);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /must be an array/i);
  });

  it('should reject explanations with wrong count', () => {
    const result = validateExplanations(['exp1', 'exp2', 'exp3'], 4);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /must have 4 entries/i);
  });

  it('should reject explanations that are too short', () => {
    const explanations = [
      'This is a substantive explanation for option A.',
      'Short', // Too short
      'This is a substantive explanation for option C.',
      'This is a substantive explanation for option D.',
    ];
    const result = validateExplanations(explanations, 4);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /too short/i);
  });

  it('should reject placeholder text', () => {
    const explanations = [
      'This is a substantive explanation for option A.',
      'Answer rationale not provided.',
      'This is a substantive explanation for option C.',
      'This is a substantive explanation for option D.',
    ];
    const result = validateExplanations(explanations, 4);
    assert.strictEqual(result.valid, false);
    assert.match(result.error, /placeholder/i);
  });

  it('should reject empty strings', () => {
    const explanations = [
      'This is a substantive explanation for option A.',
      '',
      'This is a substantive explanation for option C.',
      'This is a substantive explanation for option D.',
    ];
    const result = validateExplanations(explanations, 4);
    assert.strictEqual(result.valid, false);
  });
});

describe('checkRationaleConsistency', () => {
  it('should pass for consistent rationales', () => {
    const item = {
      question: 'What is 2+2?',
      options: ['3', '4', '5', '6'],
      correct_index: 1,
      explanation: [
        'Incorrect because 3 is one less than the correct answer.',
        'Correct because 2+2 equals 4 by basic addition.',
        'Incorrect because 5 is one more than the correct answer.',
        'Incorrect because 6 would require adding 3+3.',
      ]
    };
    const result = checkRationaleConsistency(item);
    assert.strictEqual(result.valid, true);
    assert.deepEqual(result.warnings, []);
  });

  it('should warn if correct answer explanation sounds negative', () => {
    const item = {
      question: 'What is 2+2?',
      options: ['3', '4', '5', '6'],
      correct_index: 1,
      explanation: [
        'Incorrect because 3 is wrong.',
        'This is incorrect and should not be selected.',  // Wrong language for correct answer
        'Incorrect because 5 is wrong.',
        'Incorrect because 6 is wrong.',
      ]
    };
    const result = checkRationaleConsistency(item);
    assert.strictEqual(result.valid, false);
    assert.ok(result.warnings.length > 0);
  });

  it('should warn if incorrect answer explanation sounds positive', () => {
    const item = {
      question: 'What is 2+2?',
      options: ['3', '4', '5', '6'],
      correct_index: 1,
      explanation: [
        'This is correct because 3 is a valid number.', // Wrong - sounds positive
        'Correct because 2+2 equals 4.',
        'Incorrect because 5 is too high.',
        'Incorrect because 6 is too high.',
      ]
    };
    const result = checkRationaleConsistency(item);
    assert.strictEqual(result.valid, false);
    assert.ok(result.warnings.some(w => w.includes('positive language')));
  });
});

// Note: verifySelfConsistency and reconcileAnswerDiscrepancy require LLM calls
// and are tested via integration tests in ragIntegration.test.js
// These describe blocks document the expected behavior for manual testing

describe('Self-Consistency Verification (documentation)', () => {
  it('should document verifySelfConsistency expected behavior', () => {
    // verifySelfConsistency(question, context, userId, courseId) returns:
    // {
    //   consistent: boolean,        - true if model solved to same answer
    //   modelAnswer: number,        - index of model's answer (0-3)
    //   originalAnswer: number,     - original correct_index
    //   confidence: string,         - 'high' | 'medium' | 'low' | 'unknown' | 'error'
    //   reasoning: string,          - model's step-by-step reasoning
    //   modelExplanation: string    - model's explanation for its answer
    // }
    
    // Expected behavior:
    // - Uses temperature=0 for deterministic verification
    // - Re-asks model to solve question WITHOUT seeing original answer
    // - Compares model's answer to original correct_index
    // - On discrepancy, triggers reconcileAnswerDiscrepancy
    assert.ok(true, 'Documentation test');
  });

  it('should document reconcileAnswerDiscrepancy expected behavior', () => {
    // reconcileAnswerDiscrepancy(question, consistencyResult, context, userId, courseId) returns:
    // - Fixed question object with correct_index possibly changed, or
    // - null if reconciliation failed
    //
    // Fixed question includes:
    // - _reconciled: true
    // - _originalAnswer: original correct_index before change
    // - _reconciliationCertainty: 'definite' | 'probable' | 'uncertain'
    
    // Expected behavior:
    // - Uses a third LLM call to arbitrate between original and model's answers
    // - Returns fixed question if reconciliation succeeds
    // - Returns null if reconciliation fails
    assert.ok(true, 'Documentation test');
  });

  it('should document stats tracked by validateQuizQuestionsIndividually', () => {
    // Stats now include:
    // - selfConsistencyChecked: number of questions verified
    // - selfConsistencyPassed: questions where model solved to same answer
    // - selfConsistencyReconciled: questions where discrepancy was fixed
    // - selfConsistencyFailed: questions flagged for review
    //
    // Question flags added:
    // - _selfConsistencyVerified: true if passed self-consistency
    // - _selfConsistencyReconciled: true if answer was changed via reconciliation
    // - _selfConsistencyFailed: true if discrepancy could not be resolved
    // - _consistencyWarning: string describing the discrepancy
    // - _selfConsistencyError: error message if check failed
    assert.ok(true, 'Documentation test');
  });
});
