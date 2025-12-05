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
 * 
 * @param {object} questionSpec - Specification for the question (topic, difficulty, etc.)
 * @param {string} context - Lesson/module context
 * @param {string} userId - User ID for tracking
 * @param {string} courseId - Course ID for tracking
 * @returns {Promise<{question: object, confidence: number, reasoning: string}>}
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
 * Used for questions generated without confidence rating.
 * 
 * @param {object} question - Quiz question object
 * @param {string} context - Lesson context
 * @param {string} userId - User ID
 * @param {string} courseId - Course ID
 * @returns {Promise<{question: object, confidence: number, needsValidation: boolean}>}
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
}`
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
 * Batch validate and repair multiple low-confidence questions in a single pass.
 * This is called after entire course generation to fix all flagged questions at once.
 * 
 * @param {Array<{question: object, context: string, lessonId: string, type: string}>} questions - Questions to validate
 * @param {string} userId - User ID
 * @param {string} courseId - Course ID
 * @returns {Promise<{validated: Array, stats: object}>}
 */
export async function batchValidateQuestions(questions, userId, courseId) {
  if (!questions || questions.length === 0) {
    return { validated: [], stats: { total: 0, fixed: 0, unchanged: 0, failed: 0 } };
  }

  console.log(`[batchValidateQuestions] Starting batch validation of ${questions.length} questions`);
  
  const stats = {
    total: questions.length,
    fixed: 0,
    unchanged: 0,
    failed: 0
  };

  // Process in batches of 10 to avoid token limits
  const BATCH_SIZE = 10;
  const validated = [];
  
  for (let i = 0; i < questions.length; i += BATCH_SIZE) {
    const batch = questions.slice(i, i + BATCH_SIZE);
    console.log(`[batchValidateQuestions] Processing batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(questions.length / BATCH_SIZE)}`);
    
    try {
      const batchResult = await validateQuestionBatch(batch, userId, courseId);
      
      for (let j = 0; j < batch.length; j++) {
        const original = batch[j];
        const result = batchResult.results[j];
        
        if (!result) {
          stats.failed++;
          validated.push({
            ...original,
            question: { ...original.question, _validationFailed: true }
          });
          continue;
        }
        
        if (result.status === 'fixed') {
          stats.fixed++;
          validated.push({
            ...original,
            question: result.question
          });
        } else if (result.status === 'verified') {
          stats.unchanged++;
          validated.push({
            ...original,
            question: { ...original.question, _validated: true, _confidence: 1.0 }
          });
        } else {
          stats.failed++;
          validated.push({
            ...original,
            question: { ...original.question, _validationIssue: result.issue }
          });
        }
      }
    } catch (error) {
      console.error(`[batchValidateQuestions] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed:`, error.message);
      // Mark all in batch as failed
      for (const q of batch) {
        stats.failed++;
        validated.push({
          ...q,
          question: { ...q.question, _validationError: error.message }
        });
      }
    }
  }

  console.log(`[batchValidateQuestions] Complete. Stats: ${JSON.stringify(stats)}`);
  return { validated, stats };
}

/**
 * Validate a batch of questions in a single LLM call.
 * 
 * @param {Array} batch - Array of question objects with context
 * @param {string} userId - User ID
 * @param {string} courseId - Course ID
 * @returns {Promise<{results: Array}>}
 */
async function validateQuestionBatch(batch, userId, courseId) {
  const letters = ['A', 'B', 'C', 'D'];
  
  // Format questions for the prompt
  const questionsForPrompt = batch.map((item, idx) => {
    const q = item.question;
    const optionsText = q.options.map((opt, i) => `${letters[i]}. ${opt}`).join('\n');
    const correctLetter = letters[q.correct_index];
    
    return `
---
QUESTION ${idx + 1} (from lesson: ${item.lessonId || 'unknown'}, type: ${item.type || 'quiz'})
Context snippet: ${(item.context || '').slice(0, 500)}...

Question: ${q.question}

Options:
${optionsText}

Marked correct: ${correctLetter}

Issues flagged: ${q._issues?.join(', ') || 'Low confidence rating'}
Confidence: ${q._confidence || 'unknown'}
---`;
  }).join('\n');

  const messages = [
    {
      role: 'system',
      content: `You are an expert educator validating a batch of quiz questions that were flagged as potentially inaccurate.

For EACH question, you must:
1. Independently solve the question to verify the correct answer
2. Check if all distractors are clearly wrong
3. Verify explanations are accurate
4. Fix any issues found

Return JSON:
{
  "results": [
    {
      "question_index": 0,
      "status": "verified" | "fixed" | "unresolvable",
      "analysis": "Brief analysis of the question",
      "original_answer_correct": true | false,
      "question": {
        "question": "Student-facing stem (only include if fixed)",
        "options": ["A", "B", "C", "D"],
        "correct_index": 0,
        "explanation": ["Expl A", "Expl B", "Expl C", "Expl D"]
      },
      "changes_made": ["List of changes if fixed"],
      "issue": "Description if unresolvable"
    }
  ]
}

IMPORTANT:
- If the original answer is correct and explanations are good, set status="verified" and omit the question object
- If you need to fix the answer or explanations, set status="fixed" and include the complete corrected question object
- If the question is fundamentally flawed and cannot be fixed, set status="unresolvable" with an issue description`
    },
    {
      role: 'user',
      content: `Please validate and fix if necessary these ${batch.length} flagged questions:

${questionsForPrompt}

For each question, verify the answer independently and fix any issues.`
    }
  ];

  const { content } = await grokExecutor({
    model: BATCH_VALIDATION_MODEL,
    temperature: 0,
    maxTokens: 8192,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 180000, // 3 minutes for batch
    reasoning: 'high',
    userId,
    source: 'batch_question_validation',
    courseId,
  });

  const raw = coerceModelText(content);
  const parsed = parseJsonObject(raw, 'batch_question_validation');

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error('Invalid batch validation response');
  }

  return { results: parsed.results };
}

/**
 * Batch validate practice problems.
 * Similar to quiz questions but checks rubrics and solutions.
 * 
 * @param {Array} problems - Practice problems to validate
 * @param {string} userId - User ID
 * @param {string} courseId - Course ID
 * @returns {Promise<{validated: Array, stats: object}>}
 */
export async function batchValidatePracticeProblems(problems, userId, courseId) {
  if (!problems || problems.length === 0) {
    return { validated: [], stats: { total: 0, fixed: 0, unchanged: 0, failed: 0 } };
  }

  console.log(`[batchValidatePracticeProblems] Starting batch validation of ${problems.length} problems`);
  
  const stats = {
    total: problems.length,
    fixed: 0,
    unchanged: 0,
    failed: 0
  };

  // Process in batches of 5 (practice problems are larger)
  const BATCH_SIZE = 5;
  const validated = [];
  
  for (let i = 0; i < problems.length; i += BATCH_SIZE) {
    const batch = problems.slice(i, i + BATCH_SIZE);
    
    try {
      const batchResult = await validatePracticeProblemBatch(batch, userId, courseId);
      
      for (let j = 0; j < batch.length; j++) {
        const original = batch[j];
        const result = batchResult.results[j];
        
        if (!result) {
          stats.failed++;
          validated.push({
            ...original,
            problem: { ...original.problem, _validationFailed: true }
          });
          continue;
        }
        
        if (result.status === 'fixed') {
          stats.fixed++;
          validated.push({
            ...original,
            problem: result.problem
          });
        } else if (result.status === 'verified') {
          stats.unchanged++;
          validated.push({
            ...original,
            problem: { ...original.problem, _validated: true }
          });
        } else {
          stats.failed++;
          validated.push({
            ...original,
            problem: { ...original.problem, _validationIssue: result.issue }
          });
        }
      }
    } catch (error) {
      console.error(`[batchValidatePracticeProblems] Batch failed:`, error.message);
      for (const p of batch) {
        stats.failed++;
        validated.push({
          ...p,
          problem: { ...p.problem, _validationError: error.message }
        });
      }
    }
  }

  console.log(`[batchValidatePracticeProblems] Complete. Stats: ${JSON.stringify(stats)}`);
  return { validated, stats };
}

/**
 * Validate a batch of practice problems.
 */
async function validatePracticeProblemBatch(batch, userId, courseId) {
  const problemsForPrompt = batch.map((item, idx) => {
    const p = item.problem;
    return `
---
PROBLEM ${idx + 1} (from lesson: ${item.lessonId || 'unknown'})
Context: ${(item.context || '').slice(0, 400)}...

Question: ${p.question}

Sample Answer:
${JSON.stringify(p.sample_answer, null, 2)}

Rubric:
${JSON.stringify(p.rubric, null, 2)}

Confidence: ${p._confidence || 'unknown'}
---`;
  }).join('\n');

  const messages = [
    {
      role: 'system',
      content: `You are an expert educator validating practice problems with their solutions and rubrics.

For EACH problem:
1. Independently solve the problem
2. Verify the sample answer is correct
3. Check the rubric is fair and complete
4. Fix any issues

Return JSON:
{
  "results": [
    {
      "problem_index": 0,
      "status": "verified" | "fixed" | "unresolvable",
      "my_solution": "Brief solution for verification",
      "sample_answer_correct": true | false,
      "rubric_issues": ["Any rubric issues"],
      "problem": {
        "question": "...",
        "rubric": {...},
        "sample_answer": {...},
        "estimated_minutes": 15,
        "difficulty": "Hard",
        "topic_tags": []
      },
      "changes_made": ["List of changes"],
      "issue": "If unresolvable"
    }
  ]
}`
    },
    {
      role: 'user',
      content: `Validate these ${batch.length} practice problems:

${problemsForPrompt}

Solve each independently and verify the solutions.`
    }
  ];

  const { content } = await grokExecutor({
    model: BATCH_VALIDATION_MODEL,
    temperature: 0,
    maxTokens: 12000,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 240000, // 4 minutes for practice problem batch
    reasoning: 'high',
    userId,
    source: 'batch_practice_validation',
    courseId,
  });

  const raw = coerceModelText(content);
  const parsed = parseJsonObject(raw, 'batch_practice_validation');

  if (!parsed || !Array.isArray(parsed.results)) {
    throw new Error('Invalid batch validation response');
  }

  return { results: parsed.results };
}

/**
 * Collects low-confidence questions from generated content for batch validation.
 * 
 * @param {Array} nodes - Course nodes with generated content
 * @returns {Array} - Questions needing validation with context
 */
export function collectLowConfidenceQuestions(nodes) {
  const lowConfidence = [];
  
  for (const node of nodes) {
    const content = node.content_payload || {};
    const lessonId = node.id;
    const context = content.reading || '';
    
    // Collect quiz questions
    if (Array.isArray(content.quiz)) {
      for (const q of content.quiz) {
        if ((q._confidence && q._confidence < CONFIDENCE_THRESHOLD) || q._needsValidation) {
          lowConfidence.push({
            question: q,
            context,
            lessonId,
            type: 'quiz'
          });
        }
      }
    }
    
    // Collect practice problems
    if (Array.isArray(content.practice_problems)) {
      for (const p of content.practice_problems) {
        if ((p._confidence && p._confidence < CONFIDENCE_THRESHOLD) || p._needsValidation) {
          lowConfidence.push({
            problem: p,
            context,
            lessonId,
            type: 'practice_problem'
          });
        }
      }
    }
  }
  
  return lowConfidence;
}

export { CONFIDENCE_THRESHOLD };
