// tests/xmlUtils.test.js

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseXmlReadings,
  parseXmlQuizzes,
  parseXmlFlashcards,
  parseXmlTopics,
  parseXmlInlineQuestions
} from '../src/utils/xmlUtils.js';

describe('XML Utilities', () => {
  describe('parseXmlReadings', () => {
    it('parses multiple lessons from XML', () => {
      const xml = `<LESSON id="lesson-1">
# Introduction
This is the first lesson content with **bold** and *italic*.

## Section 1
More content here with LaTeX: \\(x^2 + y^2 = z^2\\)
</LESSON>
<LESSON id="lesson-2">
# Second Lesson
This is the second lesson.

$$
E = mc^2
$$
</LESSON>`;

      const result = parseXmlReadings(xml);
      
      assert.strictEqual(result.size, 2);
      assert.ok(result.get('lesson-1').includes('Introduction'));
      assert.ok(result.get('lesson-1').includes('\\(x^2 + y^2 = z^2\\)'));
      assert.ok(result.get('lesson-2').includes('Second Lesson'));
    });

    it('handles single lesson', () => {
      const xml = `<LESSON id="only-lesson">
# Only Content
This is the only lesson.
</LESSON>`;

      const result = parseXmlReadings(xml);
      assert.strictEqual(result.size, 1);
      assert.ok(result.get('only-lesson').includes('Only Content'));
    });

    it('handles empty input', () => {
      const result = parseXmlReadings('');
      assert.strictEqual(result.size, 0);
    });

    it('handles null input', () => {
      const result = parseXmlReadings(null);
      assert.strictEqual(result.size, 0);
    });

    it('preserves LaTeX content', () => {
      const xml = `<LESSON id="math-lesson">
The quadratic formula is: \\(x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}\\)
</LESSON>`;

      const result = parseXmlReadings(xml);
      assert.ok(result.get('math-lesson').includes('\\frac{-b'));
      assert.ok(result.get('math-lesson').includes('\\sqrt'));
    });
  });

  describe('parseXmlQuizzes', () => {
    it('parses quiz questions with correct structure', () => {
      const xml = `<QUIZ lesson_id="lesson-1">
<QUESTION correct="1" confidence="0.9">
<TEXT>What is 2+2?</TEXT>
<OPTION_A>3</OPTION_A>
<OPTION_B>4</OPTION_B>
<OPTION_C>5</OPTION_C>
<OPTION_D>6</OPTION_D>
<EXPLAIN_A>Incorrect: 2+2 does not equal 3</EXPLAIN_A>
<EXPLAIN_B>Correct: 2+2 equals 4 by basic arithmetic</EXPLAIN_B>
<EXPLAIN_C>Incorrect: 2+2 does not equal 5</EXPLAIN_C>
<EXPLAIN_D>Incorrect: 2+2 does not equal 6</EXPLAIN_D>
</QUESTION>
<QUESTION correct="2" confidence="0.85">
<TEXT>What is the capital of France?</TEXT>
<OPTION_A>London</OPTION_A>
<OPTION_B>Berlin</OPTION_B>
<OPTION_C>Paris</OPTION_C>
<OPTION_D>Madrid</OPTION_D>
<EXPLAIN_A>Incorrect: London is the capital of the UK</EXPLAIN_A>
<EXPLAIN_B>Incorrect: Berlin is the capital of Germany</EXPLAIN_B>
<EXPLAIN_C>Correct: Paris is the capital of France</EXPLAIN_C>
<EXPLAIN_D>Incorrect: Madrid is the capital of Spain</EXPLAIN_D>
</QUESTION>
</QUIZ>`;

      const result = parseXmlQuizzes(xml);
      
      assert.strictEqual(result.size, 1);
      const questions = result.get('lesson-1');
      assert.strictEqual(questions.length, 2);
      
      // First question
      assert.strictEqual(questions[0].question, 'What is 2+2?');
      assert.deepStrictEqual(questions[0].options, ['3', '4', '5', '6']);
      assert.strictEqual(questions[0].correct_index, 1);
      assert.strictEqual(questions[0]._confidence, 0.9);
      assert.strictEqual(questions[0].explanation.length, 4);
      
      // Second question
      assert.strictEqual(questions[1].question, 'What is the capital of France?');
      assert.strictEqual(questions[1].correct_index, 2);
    });

    it('parses multiple lessons quizzes', () => {
      const xml = `<QUIZ lesson_id="lesson-1">
<QUESTION correct="0" confidence="0.8">
<TEXT>Question 1</TEXT>
<OPTION_A>A</OPTION_A>
<OPTION_B>B</OPTION_B>
<OPTION_C>C</OPTION_C>
<OPTION_D>D</OPTION_D>
<EXPLAIN_A>Correct</EXPLAIN_A>
<EXPLAIN_B>Wrong</EXPLAIN_B>
<EXPLAIN_C>Wrong</EXPLAIN_C>
<EXPLAIN_D>Wrong</EXPLAIN_D>
</QUESTION>
</QUIZ>
<QUIZ lesson_id="lesson-2">
<QUESTION correct="3" confidence="0.95">
<TEXT>Question 2</TEXT>
<OPTION_A>A</OPTION_A>
<OPTION_B>B</OPTION_B>
<OPTION_C>C</OPTION_C>
<OPTION_D>D</OPTION_D>
<EXPLAIN_A>Wrong</EXPLAIN_A>
<EXPLAIN_B>Wrong</EXPLAIN_B>
<EXPLAIN_C>Wrong</EXPLAIN_C>
<EXPLAIN_D>Correct</EXPLAIN_D>
</QUESTION>
</QUIZ>`;

      const result = parseXmlQuizzes(xml);
      
      assert.strictEqual(result.size, 2);
      assert.strictEqual(result.get('lesson-1').length, 1);
      assert.strictEqual(result.get('lesson-2').length, 1);
      assert.strictEqual(result.get('lesson-2')[0].correct_index, 3);
    });

    it('handles empty input', () => {
      const result = parseXmlQuizzes('');
      assert.strictEqual(result.size, 0);
    });

    it('preserves LaTeX in questions', () => {
      const xml = `<QUIZ lesson_id="math">
<QUESTION correct="0" confidence="0.9">
<TEXT>What is \\(\\frac{d}{dx}(x^2)\\)?</TEXT>
<OPTION_A>\\(2x\\)</OPTION_A>
<OPTION_B>\\(x\\)</OPTION_B>
<OPTION_C>\\(x^2\\)</OPTION_C>
<OPTION_D>\\(2\\)</OPTION_D>
<EXPLAIN_A>Correct: The derivative of \\(x^2\\) is \\(2x\\)</EXPLAIN_A>
<EXPLAIN_B>Wrong</EXPLAIN_B>
<EXPLAIN_C>Wrong</EXPLAIN_C>
<EXPLAIN_D>Wrong</EXPLAIN_D>
</QUESTION>
</QUIZ>`;

      const result = parseXmlQuizzes(xml);
      const q = result.get('math')[0];
      
      assert.ok(q.question.includes('\\frac{d}{dx}'));
      assert.ok(q.options[0].includes('2x'));
    });
  });

  describe('parseXmlFlashcards', () => {
    it('parses flashcards with correct structure', () => {
      const xml = `<FLASHCARDS lesson_id="lesson-1">
<CARD>
<FRONT>What is the derivative of x^2?</FRONT>
<BACK>The derivative is 2x, obtained using the power rule.</BACK>
</CARD>
<CARD>
<FRONT>What is Newton's First Law?</FRONT>
<BACK>An object at rest stays at rest, and an object in motion stays in motion unless acted upon by an external force.</BACK>
</CARD>
</FLASHCARDS>`;

      const result = parseXmlFlashcards(xml);
      
      assert.strictEqual(result.size, 1);
      const cards = result.get('lesson-1');
      assert.strictEqual(cards.length, 2);
      assert.strictEqual(cards[0].front, 'What is the derivative of x^2?');
      assert.ok(cards[0].back.includes('2x'));
    });

    it('parses multiple lessons flashcards', () => {
      const xml = `<FLASHCARDS lesson_id="lesson-1">
<CARD>
<FRONT>Q1</FRONT>
<BACK>A1</BACK>
</CARD>
</FLASHCARDS>
<FLASHCARDS lesson_id="lesson-2">
<CARD>
<FRONT>Q2</FRONT>
<BACK>A2</BACK>
</CARD>
<CARD>
<FRONT>Q3</FRONT>
<BACK>A3</BACK>
</CARD>
</FLASHCARDS>`;

      const result = parseXmlFlashcards(xml);
      
      assert.strictEqual(result.size, 2);
      assert.strictEqual(result.get('lesson-1').length, 1);
      assert.strictEqual(result.get('lesson-2').length, 2);
    });

    it('handles empty input', () => {
      const result = parseXmlFlashcards('');
      assert.strictEqual(result.size, 0);
    });
  });

  describe('parseXmlTopics', () => {
    it('parses topics with subtopics', () => {
      const xml = `<TOPICS>
<TOPIC title="Limits and Continuity" skeleton_ref="Week 1">
<SUBTOPIC title="Epsilon-Delta Definition" bloom="Understand" yield="High">
Syllabus explicitly mentions proofs for limits. This is a fundamental concept tested on exams.
</SUBTOPIC>
<SUBTOPIC title="Limit Laws" bloom="Apply" yield="Medium">
Students must be able to apply limit laws to compute complex limits.
</SUBTOPIC>
</TOPIC>
<TOPIC title="Derivatives" skeleton_ref="Week 2">
<SUBTOPIC title="Definition of Derivative" bloom="Remember" yield="High">
Core concept for all of calculus.
</SUBTOPIC>
</TOPIC>
</TOPICS>`;

      const result = parseXmlTopics(xml);
      
      assert.strictEqual(result.overviewTopics.length, 2);
      
      const firstTopic = result.overviewTopics[0];
      assert.strictEqual(firstTopic.title, 'Limits and Continuity');
      assert.strictEqual(firstTopic.original_skeleton_ref, 'Week 1');
      assert.strictEqual(firstTopic.subtopics.length, 2);
      
      const firstSubtopic = firstTopic.subtopics[0];
      assert.strictEqual(firstSubtopic.title, 'Epsilon-Delta Definition');
      assert.strictEqual(firstSubtopic.bloom_level, 'Understand');
      assert.strictEqual(firstSubtopic.yield, 'High');
      assert.ok(firstSubtopic.exam_relevance_reasoning.includes('proofs'));
    });

    it('handles empty input', () => {
      const result = parseXmlTopics('');
      assert.strictEqual(result.overviewTopics.length, 0);
    });

    it('handles missing TOPICS wrapper', () => {
      const xml = `<TOPIC title="Test">
<SUBTOPIC title="Sub" bloom="Apply" yield="Low">Reason</SUBTOPIC>
</TOPIC>`;

      const result = parseXmlTopics(xml);
      assert.strictEqual(result.overviewTopics.length, 0);
    });
  });

  describe('parseXmlInlineQuestions', () => {
    it('parses inline questions with chunk indices', () => {
      const xml = `<INLINE_QUESTIONS lesson_id="lesson-1">
<QUESTION chunk="0" correct="1" confidence="0.85">
<TEXT>What concept was just explained?</TEXT>
<OPTION_A>Concept A</OPTION_A>
<OPTION_B>Concept B</OPTION_B>
<OPTION_C>Concept C</OPTION_C>
<OPTION_D>Concept D</OPTION_D>
<EXPLAIN_A>Wrong explanation</EXPLAIN_A>
<EXPLAIN_B>Correct: This was the main topic</EXPLAIN_B>
<EXPLAIN_C>Wrong explanation</EXPLAIN_C>
<EXPLAIN_D>Wrong explanation</EXPLAIN_D>
</QUESTION>
<QUESTION chunk="2" correct="0" confidence="0.9">
<TEXT>Second question</TEXT>
<OPTION_A>Right</OPTION_A>
<OPTION_B>Wrong</OPTION_B>
<OPTION_C>Wrong</OPTION_C>
<OPTION_D>Wrong</OPTION_D>
<EXPLAIN_A>Correct</EXPLAIN_A>
<EXPLAIN_B>Wrong</EXPLAIN_B>
<EXPLAIN_C>Wrong</EXPLAIN_C>
<EXPLAIN_D>Wrong</EXPLAIN_D>
</QUESTION>
</INLINE_QUESTIONS>`;

      const result = parseXmlInlineQuestions(xml);
      
      assert.strictEqual(result.size, 1);
      const questions = result.get('lesson-1');
      assert.strictEqual(questions.length, 2);
      
      assert.strictEqual(questions[0].chunkIndex, 0);
      assert.strictEqual(questions[0].answerIndex, 1);
      assert.strictEqual(questions[0].confidence, 0.85);
      
      assert.strictEqual(questions[1].chunkIndex, 2);
      assert.strictEqual(questions[1].answerIndex, 0);
    });

    it('handles empty input', () => {
      const result = parseXmlInlineQuestions('');
      assert.strictEqual(result.size, 0);
    });
  });
});
