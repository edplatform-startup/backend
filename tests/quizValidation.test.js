import test, { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __mergeValidatedArray as mergeValidatedArray } from '../src/services/courseContent.js';

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
