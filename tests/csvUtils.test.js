// tests/csvUtils.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  escapeCSV,
  unescapeCSV,
  parseCSVLine,
  parseCSV,
  quizToCSV,
  csvToQuiz,
  flashcardsToCSV,
  csvToFlashcards,
  lessonsToCSV,
  csvToLessons,
  practiceProblemsToCSV,
  csvToPracticeProblems,
  arrayToCSV,
  csvToArray,
  isCSVAppropriate,
  csvToBatchedQuiz,
  csvToBatchedFlashcards,
  parseBatchedReadings,
  formatLessonPlansForBatch
} from '../src/utils/csvUtils.js';

describe('CSV Utilities', () => {
  describe('escapeCSV', () => {
    it('returns empty string for null/undefined', () => {
      assert.strictEqual(escapeCSV(null), '');
      assert.strictEqual(escapeCSV(undefined), '');
    });

    it('returns plain string if no special chars', () => {
      assert.strictEqual(escapeCSV('hello'), 'hello');
    });

    it('wraps and escapes quotes', () => {
      assert.strictEqual(escapeCSV('say "hello"'), '"say ""hello"""');
    });

    it('wraps strings with commas', () => {
      assert.strictEqual(escapeCSV('a, b, c'), '"a, b, c"');
    });

    it('wraps strings with newlines', () => {
      assert.strictEqual(escapeCSV('line1\nline2'), '"line1\nline2"');
    });
  });

  describe('parseCSVLine', () => {
    it('parses simple line', () => {
      assert.deepStrictEqual(parseCSVLine('a,b,c'), ['a', 'b', 'c']);
    });

    it('handles quoted fields with commas', () => {
      assert.deepStrictEqual(parseCSVLine('a,"b, c",d'), ['a', 'b, c', 'd']);
    });

    it('handles escaped quotes', () => {
      assert.deepStrictEqual(parseCSVLine('a,"say ""hello""",c'), ['a', 'say "hello"', 'c']);
    });
  });

  describe('Quiz CSV conversion', () => {
    const sampleQuiz = [
      {
        question: 'What is 2+2?',
        options: ['3', '4', '5', '6'],
        correct_index: 1,
        explanation: ['Wrong', 'Correct: basic math', 'Wrong', 'Wrong']
      },
      {
        question: 'What is the capital of France?',
        options: ['London', 'Paris', 'Berlin', 'Madrid'],
        correct_index: 1,
        explanation: ['UK capital', 'Correct', 'Germany capital', 'Spain capital']
      }
    ];

    it('converts quiz to CSV and back', () => {
      const csv = quizToCSV(sampleQuiz);
      assert.ok(csv.includes('index,question,optionA,optionB,optionC,optionD,correct_index,expA,expB,expC,expD'));
      assert.ok(csv.includes('What is 2+2?'));
      assert.ok(csv.includes('What is the capital of France?'));

      const parsed = csvToQuiz(csv);
      assert.strictEqual(parsed.length, 2);
      assert.strictEqual(parsed[0].question, 'What is 2+2?');
      assert.deepStrictEqual(parsed[0].options, ['3', '4', '5', '6']);
      assert.strictEqual(parsed[0].correct_index, 1);
      assert.deepStrictEqual(parsed[0].explanation, ['Wrong', 'Correct: basic math', 'Wrong', 'Wrong']);
    });

    it('handles empty quiz array', () => {
      assert.strictEqual(quizToCSV([]), '');
      assert.deepStrictEqual(csvToQuiz(''), []);
    });

    it('handles questions with special characters', () => {
      const quiz = [{
        question: 'What is "quotation" in CSV?',
        options: ['Option A, with comma', 'B', 'C', 'D'],
        correct_index: 0,
        explanation: ['Right', 'Wrong', 'Wrong', 'Wrong']
      }];
      
      const csv = quizToCSV(quiz);
      const parsed = csvToQuiz(csv);
      
      assert.strictEqual(parsed[0].question, 'What is "quotation" in CSV?');
      assert.strictEqual(parsed[0].options[0], 'Option A, with comma');
    });
  });

  describe('Flashcard CSV conversion', () => {
    const sampleFlashcards = [
      { front: 'Question 1', back: 'Answer 1' },
      { front: 'Question 2', back: 'Answer 2' }
    ];

    it('converts flashcards to CSV and back', () => {
      const csv = flashcardsToCSV(sampleFlashcards);
      assert.ok(csv.includes('index,front,back'));
      
      const parsed = csvToFlashcards(csv);
      assert.strictEqual(parsed.length, 2);
      assert.strictEqual(parsed[0].front, 'Question 1');
      assert.strictEqual(parsed[0].back, 'Answer 1');
    });

    it('handles flashcards with special chars', () => {
      const cards = [{ front: 'What is \\(x^2\\)?', back: '2x, the derivative' }];
      const csv = flashcardsToCSV(cards);
      const parsed = csvToFlashcards(csv);
      
      assert.strictEqual(parsed[0].front, 'What is \\(x^2\\)?');
      assert.strictEqual(parsed[0].back, '2x, the derivative');
    });
  });

  describe('Lessons CSV conversion', () => {
    const sampleLessons = [
      {
        slug_id: 'intro-calc',
        title: 'Introduction to Calculus',
        module_group: 'Fundamentals',
        estimated_minutes: 30,
        bloom_level: 'Understand',
        intrinsic_exam_value: 7,
        dependencies: ['prereq-1', 'prereq-2'],
        content_plans: {
          reading: 'Explain limits intuitively',
          video: ['calculus intro', 'limits explained'],
          quiz: 'Test understanding of limits',
          flashcards: 'Key limit definitions'
        }
      }
    ];

    it('converts lessons to CSV and back', () => {
      const csv = lessonsToCSV(sampleLessons);
      assert.ok(csv.includes('slug_id,title,module_group'));
      assert.ok(csv.includes('intro-calc'));
      
      const parsed = csvToLessons(csv);
      assert.strictEqual(parsed.length, 1);
      assert.strictEqual(parsed[0].slug_id, 'intro-calc');
      assert.strictEqual(parsed[0].title, 'Introduction to Calculus');
      assert.deepStrictEqual(parsed[0].dependencies, ['prereq-1', 'prereq-2']);
      assert.deepStrictEqual(parsed[0].content_plans.video, ['calculus intro', 'limits explained']);
    });
  });

  describe('isCSVAppropriate', () => {
    it('returns false for non-arrays', () => {
      assert.strictEqual(isCSVAppropriate(null), false);
      assert.strictEqual(isCSVAppropriate('string'), false);
      assert.strictEqual(isCSVAppropriate({}), false);
    });

    it('returns false for empty arrays', () => {
      assert.strictEqual(isCSVAppropriate([]), false);
    });

    it('returns true for simple object arrays', () => {
      assert.strictEqual(isCSVAppropriate([{ a: 1, b: 2 }]), true);
    });

    it('returns false for deeply nested structures', () => {
      const complex = [{
        a: 1,
        b: { nested: 1 },
        c: { nested: 2 },
        d: { nested: 3 }
      }];
      assert.strictEqual(isCSVAppropriate(complex), false);
    });
  });

  describe('Batched Quiz CSV', () => {
    it('parses batched quiz CSV with lesson_id column', () => {
      const csv = `lesson_id,index,question,optionA,optionB,optionC,optionD,correct_index,expA,expB,expC,expD
lesson-1,0,What is 2+2?,3,4,5,6,1,Wrong,Correct,Wrong,Wrong
lesson-1,1,What is 3+3?,5,6,7,8,1,Wrong,Correct,Wrong,Wrong
lesson-2,0,What is 1+1?,1,2,3,4,1,Wrong,Correct,Wrong,Wrong`;

      const result = csvToBatchedQuiz(csv);
      
      assert.strictEqual(result.size, 2);
      assert.strictEqual(result.get('lesson-1').length, 2);
      assert.strictEqual(result.get('lesson-2').length, 1);
      assert.strictEqual(result.get('lesson-1')[0].question, 'What is 2+2?');
      assert.strictEqual(result.get('lesson-2')[0].correct_index, 1);
    });

    it('handles empty CSV', () => {
      const result = csvToBatchedQuiz('');
      assert.strictEqual(result.size, 0);
    });
  });

  describe('Batched Flashcards CSV', () => {
    it('parses batched flashcards CSV with lesson_id column', () => {
      const csv = `lesson_id,index,front,back
lesson-1,0,What is X?,Answer X
lesson-1,1,What is Y?,Answer Y
lesson-2,0,What is Z?,Answer Z`;

      const result = csvToBatchedFlashcards(csv);
      
      assert.strictEqual(result.size, 2);
      assert.strictEqual(result.get('lesson-1').length, 2);
      assert.strictEqual(result.get('lesson-2').length, 1);
      assert.strictEqual(result.get('lesson-1')[0].front, 'What is X?');
      assert.strictEqual(result.get('lesson-2')[0].back, 'Answer Z');
    });
  });

  describe('Batched Readings Parser', () => {
    it('parses delimited readings with lesson headers', () => {
      const text = `===LESSON:lesson-1===
# Introduction
This is the first lesson content.

## Section 1
More content here.

===LESSON:lesson-2===
# Second Lesson
This is the second lesson.`;

      const result = parseBatchedReadings(text);
      
      assert.strictEqual(result.size, 2);
      assert.ok(result.get('lesson-1').includes('Introduction'));
      assert.ok(result.get('lesson-2').includes('Second Lesson'));
    });

    it('handles empty input', () => {
      const result = parseBatchedReadings('');
      assert.strictEqual(result.size, 0);
    });

    it('handles single lesson', () => {
      const text = `===LESSON:only-lesson===
# Only Content
This is the only lesson.`;

      const result = parseBatchedReadings(text);
      assert.strictEqual(result.size, 1);
      assert.ok(result.get('only-lesson').includes('Only Content'));
    });
  });
});
