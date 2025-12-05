/**
 * Question Validation Service
 * 
 * Handles confidence-rated question generation and batch validation/repair.
 * Flow:
 * 1. During generation, worker model rates confidence for each question (0-1)
 * 2. Low-confidence questions are collected after course generation
 * 3. Batch validation pass repairs all low-confidence questions at once
 */

import { executeOpenRouterChat } from './grokClient.js';
import { tryParseJson } from '../utils/jsonUtils.js';

const CONFIDENCE_THRESHOLD = 0.7; // Questions below this are flagged for validation
const BATCH_VALIDATION_MODEL = 'x-ai/grok-4.1-fast';

let grokExecutor = executeOpenRouterChat;

export function __setGrokExecutor(fn) {
  grokExecutor = typeof fn === 'function' ? fn : executeOpenRouterChat;
}

export function __resetGrokExecutor() {
  grokExecutor = executeOpenRouterChat;
}

/**
 * Coerce model content to string
 */
function coerceModelText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim();
  }
  return '';
}

/**
 * Parse JSON from model output
 */
function parseJsonObject(raw, label) {
  if (!raw) return null;
  try {
    return tryParseJson(raw, label);
  } catch (error) {
    throw new Error(`Failed to parse JSON for ${label}: ${error.message}`);
  }
}

/**
 * Generates a quiz question with internal confidence rating.
 * The model uses chain-of-thought to self-assess accuracy.
 */
export async function generateQuestionWithConfidence(questionSpec, context, userId, courseId) {
  const messages = [
    {
      role: 'system',
      content: `You are an expert educator generating a quiz question. 
Generate the question AND rate your confidence in its accuracy.

Return JSON:
{
  "internal_reasoning": {
    "topic_understanding": "How well do I understand this topic? Any uncertainty?",
    "answer_verification": "Am I 100% certain this is the correct answer? Did I verify?",
    "distractor_quality": "Are the wrong options plausible but definitely incorrect?",
    "ambiguity_check": "Could any reasonable interpretation make another option correct?",
    "confidence_factors": ["List factors affecting confidence"],
    "final_confidence": 0.0-1.0
  },
  "question": {
    "question": "Student-facing stem",
    "options": ["A", "B", "C", "D"],
    "correct_index": 0,
    "explanation": ["Expl for A", "Expl for B", "Expl for C", "Expl for D"]
  }
}

CONFIDENCE RATING GUIDELINES:
- 1.0: Textbook-verified fact, no ambiguity, 100% certain
- 0.9: Very confident, standard knowledge
- 0.8: Confident, common understanding
- 0.7: Moderately confident, minor uncertainty
- 0.6: Some uncertainty, should verify
- 0.5 or below: Significant uncertainty, needs review

Be HONEST about your confidence. If you're unsure, rate lower.`
    },
    {
      role: 'user',
      content: `Generate a question for:
Topic: ${questionSpec.topic || 'General'}
Difficulty: ${questionSpec.difficulty || 'Medium'}
Type: ${questionSpec.type || 'conceptual'}

Context:
${context.slice(0, 2000)}

Remember to honestly assess your confidence in the answer's correctness.`
    }
  ];

  try {
    const { content } = await grokExecutor({
      model: BATCH_VALIDATION_MODEL,
      temperature: 0.3,
      maxTokens: 2048,
      messages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 60000,
      reasoning: 'high',
      userId,
      source: 'question_with_confidence',
      courseId,
    });

    const raw = coerceModelText(content);
    const parsed = parseJsonObject(raw, 'question_with_confidence');

    if (!parsed || !parsed.question) {
      throw new Error('Invalid question generation response');
    }

    const confidence = parsed.internal_reasoning?.final_confidence ?? 0.5;
    
    return {
      question: parsed.question,
      confidence: Math.max(0, Math.min(1, confidence)),
      reasoning: parsed.internal_reasoning,
      needsValidation: confidence < CONFIDENCE_THRESHOLD
    };
  } catch (error) {
    console.error('[generateQuestionWithConfidence] Error:', error.message);
    throw error;
  }
}

/**
 * Adds confidence rating to an existing quiz question via self-assessment.
 */
export async function rateQuestionConfidence(question, context, userId, courseId) {
  const letters = ['A', 'B', 'C', 'D'];
  const optionsText = question.options.map((opt, i) => `${letters[i]}. ${opt}`).join('\n');
  const correctLetter = letters[question.correct_index];

  const messages = [
    {
      role: 'system',
      content: `You are an expert fact-checker assessing a quiz question's accuracy.
Analyze the question and rate your confidence that:
1. The marked correct answer is actually correct
2. All incorrect options are definitely wrong
3. The question is unambiguous

Return JSON:
{
  "analysis": {
    "correct_answer_check": "Is ${correctLetter} definitely correct? Why?",
    "distractor_check": "Are all other options definitely wrong?",
    "ambiguity_check": "Any ambiguity that could cause confusion?",
    "factual_verification": "Is this factually accurate based on my knowledge?",
    "concerns": ["List any concerns"]
  },
  "confidence": 0.0-1.0,
  "issues": ["List specific issues if confidence < 0.8"]
}
`
    },
    {
      role: 'user',
      content: `Context:
${context.slice(0, 1500)}

Question: ${question.question}

Options:
${optionsText}

Marked correct answer: ${correctLetter}

Assess the accuracy of this question.`
    }
  ];

  try {
    const { content } = await grokExecutor({
      model: BATCH_VALIDATION_MODEL,
      temperature: 0,
      maxTokens: 1024,
      messages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 30000,
      reasoning: 'high',
      userId,
      source: 'rate_question_confidence',
      courseId,
    });

    const raw = coerceModelText(content);
    const parsed = parseJsonObject(raw, 'rate_question_confidence');

    const confidence = parsed?.confidence ?? 0.5;
    
    return {
      question: {
        ...question,
        _confidence: confidence,
        _confidenceAnalysis: parsed?.analysis,
        _issues: parsed?.issues || []
      },
      confidence,
      needsValidation: confidence < CONFIDENCE_THRESHOLD,
      issues: parsed?.issues || []
    };
  } catch (error) {
    console.error('[rateQuestionConfidence] Error:', error.message);
    // On error, flag for validation to be safe
    return {
      question: { ...question, _confidence: 0.5, _confidenceError: error.message },
      confidence: 0.5,
      needsValidation: true,
      issues: ['Confidence rating failed: ' + error.message]
    };
  }
}

/**
 * Validates all generated content for the entire course in a single batch.
 * 
 * @param {Array} allGeneratedContent - Array of lesson objects with payload
 * @param {string} userId
 * @param {string} courseId
 * @returns {Promise<Array>} - The updated content array
 */
export async function validateCourseContent(allGeneratedContent, userId, courseId) {
  console.log(`[validateCourseContent] Starting single-shot batch validation for ${allGeneratedContent.length} lessons`);

  // 1. Collect all items needing validation
  const itemsToValidate = [];
  const itemMap = new Map(); // Map ID -> { lessonIndex, type, itemIndex, originalItem }

  allGeneratedContent.forEach((lesson, lessonIdx) => {
    const { nodeId, payload } = lesson;
    
    // Quizzes
    if (payload.quiz && Array.isArray(payload.quiz)) {
      payload.quiz.forEach((q, qIdx) => {
        const id = `quiz_${nodeId}_${qIdx}`;
        itemsToValidate.push({
          id,
          type: 'quiz',
          question: q.question,
          options: q.options,
          explanation: q.explanation,
          correct_index: q.correct_index,
          context: `Lesson: ${lesson.payload?.title || nodeId}`
        });
        itemMap.set(id, { lessonIdx, type: 'quiz', itemIndex: qIdx, original: q });
      });
    }

    // Practice Problems
    if (payload.practice_problems && Array.isArray(payload.practice_problems)) {
      payload.practice_problems.forEach((p, pIdx) => {
        const id = `practice_${nodeId}_${pIdx}`;
        itemsToValidate.push({
          id,
          type: 'practice_problem',
          question: p.question,
          rubric: p.rubric,
          sample_answer: p.sample_answer,
          context: `Lesson: ${lesson.payload?.title || nodeId}`
        });
        itemMap.set(id, { lessonIdx, type: 'practice_problems', itemIndex: pIdx, original: p });
      });
    }
  });

  if (itemsToValidate.length === 0) {
    console.log('[validateCourseContent] No items to validate.');
    return allGeneratedContent;
  }

  console.log(`[validateCourseContent] Validating ${itemsToValidate.length} items.`);

  // 2. Construct Prompt
  const promptItems = itemsToValidate.map(item => {
    if (item.type === 'quiz') {
      return `ID: ${item.id}
Type: Quiz
Context: ${item.context}
Question: ${item.question}
Options: ${JSON.stringify(item.options)}
Correct Index: ${item.correct_index}
Explanation: ${JSON.stringify(item.explanation)}`;
    } else {
      return `ID: ${item.id}
Type: Practice Problem
Context: ${item.context}
Question: ${item.question}
Rubric: ${JSON.stringify(item.rubric)}
Sample Answer: ${JSON.stringify(item.sample_answer)}`;
    }
  }).join('\n\n---\n\n');

  const systemPrompt = `You are the Chief Academic Officer validating an entire course.
Your goal is to validate and REPAIR every single item provided.

For each item:
1. Verify correctness (answer, explanation, rubric).
2. Fix any factual errors, ambiguities, or formatting issues.
3. Ensure explanations are complete (4 items for quizzes).
4. Ensure rubrics are fair.

Output a JSON object with a "results" dictionary mapping ID to the VALIDATED object.
Format:
{
  "results": {
    "quiz_123_0": { "status": "valid", "data": null },
    "quiz_123_1": { "status": "fixed", "data": { ...full fixed object... } },
    "practice_abc_0": { "status": "discard", "reason": "Unsalvageable" }
  }
}

CRITICAL:
- If an item is valid, set "status": "valid" and "data": null (we will keep original).
- If an item needs fixing, set "status": "fixed" and provide the FULL fixed "data" object.
- If an item is unsalvageable, set "status": "discard".
- Return results for ALL IDs provided.`;

  const userPrompt = `Validate these ${itemsToValidate.length} items:\n\n${promptItems}`;

  try {
    const { content } = await grokExecutor({
      model: BATCH_VALIDATION_MODEL,
      temperature: 0.1,
      maxTokens: 32000, // Large output token limit
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 300000, // 5 minutes
      reasoning: 'high',
      userId,
      source: 'course_batch_validation',
      courseId,
    });

    const raw = coerceModelText(content);
    const parsed = parseJsonObject(raw, 'course_batch_validation');
    const results = parsed?.results || {};

    // 3. Apply updates
    let discardedCount = 0;
    let fixedCount = 0;
    let validCount = 0;

    // We need to be careful about mutating the original objects in place or replacing them.
    // Since we have a map to the indices, we can update the arrays in allGeneratedContent.
    
    // First, mark items for deletion or update
    const updates = []; // { lessonIdx, type, itemIndex, action: 'update'|'delete', data? }

    for (const item of itemsToValidate) {
      const result = results[item.id];
      const mapInfo = itemMap.get(item.id);
      
      if (!result) {
        console.warn(`[validateCourseContent] No result for ${item.id}, assuming valid.`);
        validCount++;
        continue;
      }

      if (result.status === 'discard') {
        updates.push({ ...mapInfo, action: 'delete' });
        discardedCount++;
      } else if (result.status === 'fixed' && result.data) {
        updates.push({ ...mapInfo, action: 'update', data: result.data });
        fixedCount++;
      } else {
        validCount++;
      }
    }

    // Apply updates in reverse order of index to avoid shifting issues when deleting?
    // Actually, we should group by lesson and type, then rebuild the arrays.
    
    // Group updates by lesson and type
    const updatesByLesson = new Map(); // lessonIdx -> { quiz: Map<index, action>, practice: Map<index, action> }
    
    updates.forEach(u => {
      if (!updatesByLesson.has(u.lessonIdx)) {
        updatesByLesson.set(u.lessonIdx, { quiz: new Map(), practice: new Map() });
      }
      const group = updatesByLesson.get(u.lessonIdx);
      if (u.type === 'quiz') group.quiz.set(u.itemIndex, u);
      else group.practice.set(u.itemIndex, u);
    });

    // Rebuild arrays
    allGeneratedContent.forEach((lesson, idx) => {
      const group = updatesByLesson.get(idx);
      if (!group) return;

      if (group.quiz.size > 0 && lesson.payload.quiz) {
        const newQuiz = [];
        lesson.payload.quiz.forEach((q, qIdx) => {
          const update = group.quiz.get(qIdx);
          if (!update) {
            newQuiz.push(q); // Keep original
          } else if (update.action === 'update') {
            newQuiz.push(update.data); // Replace
          }
          // If delete, do nothing (don't push)
        });
        lesson.payload.quiz = newQuiz;
        lesson.quizzes = newQuiz; // Update the top-level alias too
      }

      if (group.practice.size > 0 && lesson.payload.practice_problems) {
        const newPractice = [];
        lesson.payload.practice_problems.forEach((p, pIdx) => {
          const update = group.practice.get(pIdx);
          if (!update) {
            newPractice.push(p);
          } else if (update.action === 'update') {
            newPractice.push(update.data);
          }
        });
        lesson.payload.practice_problems = newPractice;
        lesson.practiceProblems = newPractice;
      }
    });

    console.log(`[validateCourseContent] Validation complete. Valid: ${validCount}, Fixed: ${fixedCount}, Discarded: ${discardedCount}`);
    
  } catch (error) {
    console.error('[validateCourseContent] Critical failure in batch validation:', error);
    // In case of critical failure, we return original content but warn
    // User requirement: "There should never be a scenario where a low-confidence item is put into the database without validation."
    // If validation fails entirely, we should probably throw or discard everything that was low confidence?
    // But we don't have confidence scores for everything.
    // Let's throw to prevent saving unvalidated content.
    throw new Error(`Course validation failed: ${error.message}`);
  }

  return allGeneratedContent;
}

export { CONFIDENCE_THRESHOLD };
