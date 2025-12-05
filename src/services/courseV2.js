// src/services/courseV2.js

import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { getCostTotals } from './grokClient.js';
import { plannerSyllabus } from './prompts/courseV2Prompts.js';
import { CourseSkeletonSchema, TopicMapSchema, RawTopicMapSchema } from '../schemas/courseV2.js';
import { createRagSession, retrieveContext } from '../rag/index.js';

// RAG configuration
const RAG_TOP_K = parseInt(process.env.RAG_TOP_K, 10) || 5;
const RAG_MAX_CONTEXT_CHARS = parseInt(process.env.RAG_MAX_CONTEXT_CHARS, 10) || 4000;

const BLOOM_CANONICAL = new Map([
  ['remember', 'Remember'],
  ['understand', 'Understand'],
  ['apply', 'Apply'],
  ['analyze', 'Analyze'],
  ['evaluate', 'Evaluate'],
]);

const YIELD_CANONICAL = new Map([
  ['high', 'High'],
  ['medium', 'Medium'],
  ['low', 'Low'],
]);

const DEFAULT_STUDY_MINUTES = 45;
const MIN_STUDY_MINUTES = 15;
const MAX_STUDY_MINUTES = 240;

function captureUsageTotals() {
  try {
    return getCostTotals();
  } catch {
    return null;
  }
}

function logStageUsage(label, startTotals) {
  if (!startTotals) return;
  try {
    const endTotals = getCostTotals();
    if (!endTotals) return;
    const delta = {
      prompt: endTotals.prompt - startTotals.prompt,
      completion: endTotals.completion - startTotals.completion,
      total: endTotals.total - startTotals.total,
      usd: Number((endTotals.usd - startTotals.usd).toFixed(6)),
      calls: endTotals.calls - startTotals.calls,
    };
    console.log(`[courseV2][${label}] usage:`, delta);
  } catch {
    /* ignore */
  }
}

function logTopicsUsage(startTotals) {
  if (!startTotals) return;
  try {
    const endTotals = getCostTotals();
    if (!endTotals) return;
    const delta = {
      prompt: endTotals.prompt - startTotals.prompt,
      completion: endTotals.completion - startTotals.completion,
      total: endTotals.total - startTotals.total,
      usd: Number((endTotals.usd - startTotals.usd).toFixed(6)),
      calls: endTotals.calls - startTotals.calls,
    };
    console.log('[topicsV2] usage:', delta);
  } catch {
    /* ignore */
  }
}

let courseV2LLMCaller = callStageLLM;
let customSyllabusSynthesizer = null;

export function __setSyllabusSynthesizer(fn) {
  customSyllabusSynthesizer = typeof fn === 'function' ? fn : null;
}

export function __clearSyllabusSynthesizer() {
  customSyllabusSynthesizer = null;
}

export function __setCourseV2LLMCaller(fn) {
  courseV2LLMCaller = typeof fn === 'function' ? fn : callStageLLM;
}

export function __resetCourseV2LLMCaller() {
  courseV2LLMCaller = callStageLLM;
}

// RAG session creator override for testing
let customRagSessionCreator = null;
let customRagContextRetriever = null;

export function __setRagSessionCreator(fn) {
  customRagSessionCreator = typeof fn === 'function' ? fn : null;
}

export function __clearRagSessionCreator() {
  customRagSessionCreator = null;
}

export function __setRagContextRetriever(fn) {
  customRagContextRetriever = typeof fn === 'function' ? fn : null;
}

export function __clearRagContextRetriever() {
  customRagContextRetriever = null;
}

async function createRagSessionWrapper(opts) {
  return customRagSessionCreator ? customRagSessionCreator(opts) : createRagSession(opts);
}

async function retrieveContextWrapper(opts) {
  return customRagContextRetriever ? customRagContextRetriever(opts) : retrieveContext(opts);
}

function tryParseJson(content) {
  if (content == null) return null;

  if (typeof content === 'string') {
    const stripped = content
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();

    if (!stripped) return null;

    try {
      return JSON.parse(stripped);
    } catch (error) {
      console.error('[courseV2] Failed to parse JSON:', error);
      const firstBrace = Math.min(
        ...['{', '[']
          .map((token) => {
            const idx = stripped.indexOf(token);
            return idx === -1 ? Number.POSITIVE_INFINITY : idx;
          })
          .filter((idx) => Number.isFinite(idx)),
      );
      const lastBrace = Math.max(
        ...['}', ']']
          .map((token) => stripped.lastIndexOf(token))
          .filter((idx) => idx >= 0),
      );
      if (Number.isFinite(firstBrace) && lastBrace >= firstBrace) {
        const core = stripped.slice(firstBrace, lastBrace + 1);
        try {
          return JSON.parse(core);
        } catch (secondaryError) {
          console.error('[courseV2] Core JSON parse failed:', secondaryError);
          try {
            const fixed = core.replace(/,\s*(?=[}\]])/g, '');
            return JSON.parse(fixed);
          } catch (tertiaryError) {
            console.error('[courseV2] JSON parse failed after trailing comma fix:', tertiaryError);
          }
        }
      }
      return null;
    }
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
    return tryParseJson(text);
  }

  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return tryParseJson(content.text);
  }

  return null;
}

function stringifyForPrompt(value) {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return String(value);
  }
}

function ensureSkeletonMinimums(skeleton) {
  const type = typeof skeleton?.course_structure_type === 'string' ? skeleton.course_structure_type.trim() : '';
  if (!type) {
    throw new Error('Course skeleton must include course_structure_type.');
  }
  const units = Array.isArray(skeleton?.skeleton) ? skeleton.skeleton : [];
  if (units.length < 2) {
    throw new Error('Course skeleton must include at least 2 sequential units.');
  }
}

function coerceTopicString(value, defaultValue = '') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
    return defaultValue;
  }
  if (value == null) return defaultValue;
  return String(value);
}

function coerceEnumValue(value, canonicalMap, fallback) {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (canonicalMap.has(normalized)) {
      return canonicalMap.get(normalized);
    }
  }
  return fallback;
}

function coerceStudyMinutes(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const rounded = Math.round(numeric);
    if (rounded >= MIN_STUDY_MINUTES && rounded <= MAX_STUDY_MINUTES) {
      return rounded;
    }
    if (rounded < MIN_STUDY_MINUTES) return MIN_STUDY_MINUTES;
    return MAX_STUDY_MINUTES;
  }
  return DEFAULT_STUDY_MINUTES;
}

function coerceImportance(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const clamped = Math.min(10, Math.max(1, Math.round(numeric)));
    return clamped;
  }
  return 7;
}

function coerceReasoning(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return 'Exam relevance not specified. Focus on past papers to validate.';
}

// Compute study time based on yield and bloom level
function computeStudyMinutes(yieldScore, bloomLevel) {
  // Base time by yield: High=60, Medium=45, Low=30
  const yieldBase = { High: 60, Medium: 45, Low: 30 };
  // Bloom level multiplier: higher cognitive = more time
  const bloomMultiplier = {
    Remember: 0.7,
    Understand: 0.85,
    Apply: 1.0,
    Analyze: 1.15,
    Evaluate: 1.3,
  };
  const base = yieldBase[yieldScore] || 45;
  const mult = bloomMultiplier[bloomLevel] || 1.0;
  const result = Math.round(base * mult);
  return Math.min(MAX_STUDY_MINUTES, Math.max(MIN_STUDY_MINUTES, result));
}

// Compute importance based on yield and bloom level
function computeImportance(yieldScore, bloomLevel) {
  // Base importance by yield: High=9, Medium=6, Low=4
  const yieldBase = { High: 9, Medium: 6, Low: 4 };
  // Bloom level adds 0-1 points for higher cognitive levels
  const bloomBonus = {
    Remember: 0,
    Understand: 0,
    Apply: 0.5,
    Analyze: 0.5,
    Evaluate: 1,
  };
  const base = yieldBase[yieldScore] || 6;
  const bonus = bloomBonus[bloomLevel] || 0;
  return Math.min(10, Math.max(1, Math.round(base + bonus)));
}

function normalizeOverviewTopics(rawOverviewTopics, skeletonSummaries = []) {
  if (!Array.isArray(rawOverviewTopics)) return [];
  const normalized = [];

  rawOverviewTopics.forEach((ot, index) => {
    if (!ot || typeof ot !== 'object') return;

    // Always generate IDs - LLM should not provide them
    const id = `overview_${index + 1}`;
    const title = coerceTopicString(ot.title, `Topic group ${index + 1}`);
    const skeletonHint =
      coerceTopicString(
        ot.original_skeleton_ref ?? ot.originalSkeletonRef ?? ot.skeleton_reference,
        '',
      ) ||
      coerceTopicString(skeletonSummaries[index]?.title, `Unit ${index + 1}`);

    const subtopicsRaw = Array.isArray(ot.subtopics) ? ot.subtopics : [];
    const subtopics = [];

    subtopicsRaw.forEach((st, subIdx) => {
      if (!st || typeof st !== 'object') return;
      // Always generate IDs - LLM should not provide them
      const sid = `${id}_subtopic_${subIdx + 1}`;
      const stTitle = coerceTopicString(st.title, `Subtopic ${subIdx + 1}`);
      const bloomLevel = coerceEnumValue(st.bloom_level ?? st.bloomLevel, BLOOM_CANONICAL, 'Understand');
      const reasoning = coerceReasoning(st.exam_relevance_reasoning ?? st.reasoning);
      const yieldScore = coerceEnumValue(st.yield ?? st.exam_yield ?? st.yield_score, YIELD_CANONICAL, 'Medium');
      // Compute study time and importance based on yield and bloom level
      const studyMinutes = computeStudyMinutes(yieldScore, bloomLevel);
      const importance = computeImportance(yieldScore, bloomLevel);

      subtopics.push({
        id: sid,
        overviewId: id,
        title: stTitle,
        bloom_level: bloomLevel,
        estimated_study_time_minutes: studyMinutes,
        importance_score: importance,
        exam_relevance_reasoning: reasoning,
        yield: yieldScore,
      });
    });

    if (subtopics.length === 0) return;

    normalized.push({
      id,
      title,
      original_skeleton_ref: skeletonHint,
      subtopics,
    });
  });

  return normalized;
}

export async function synthesizeSyllabus({
  university,
  courseName,
  syllabusText,
  examFormatDetails,
  topics,
  attachments = [],
  userId,
  courseId,
}) {
  if (customSyllabusSynthesizer) {
    return customSyllabusSynthesizer({
      university,
      courseName,
      syllabusText,
      examFormatDetails,
      topics,
      attachments,
      userId,
      courseId,
    });
  }

  const usageStart = captureUsageTotals();
  try {
    const messages = plannerSyllabus({
      university,
      courseName,
      syllabusText,
      examFormatDetails,
      topics,
    });

    const { result } = await courseV2LLMCaller({
      stage: STAGES.PLANNER,
      messages,
      allowWeb: true,
      maxTokens: 8192,
      attachments,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 300000, // 5 minutes for PLANNER with web search
      userId,
      courseId,
      source: 'planner_syllabus',
    });

    const rawContent = result?.content;
    const parsed = tryParseJson(rawContent);
    const firstPass = CourseSkeletonSchema.safeParse(parsed);
    let validationError = null;
    let isMinimumsError = false;

    if (firstPass.success) {
      try {
        ensureSkeletonMinimums(firstPass.data);
        return firstPass.data;
      } catch (err) {
        validationError = err.message;
        isMinimumsError = true;
      }
    } else {
      validationError = firstPass.error.toString();
    }

    let criticMessages;
    if (isMinimumsError) {
      // For minimums error, we need full context to help the model expand
      criticMessages = [
        ...messages,
        {
          role: 'assistant',
          content: stringifyForPrompt(parsed),
        },
        {
          role: 'user',
          content: `The generated skeleton failed validation: ${validationError}\nPlease break down the course into more detailed, sequential units. Ensure at least 2 units are present.`,
        },
      ];
    } else {
      // For schema/parsing errors, use the existing compact repair prompt
      criticMessages = [
        ...messages.slice(0, 1),
        {
          role: 'user',
          content: `Prior output failed validation.
Error: ${validationError}
Original JSON: ${stringifyForPrompt(parsed)}
Return corrected JSON only.`,
        },
      ];
    }

    const { result: repairedResult } = await courseV2LLMCaller({
      stage: STAGES.PLANNER,
      messages: criticMessages,
      allowWeb: false,
      maxTokens: 8192,
      attachments,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 300000, // 5 minutes for repair call
      userId,
      courseId,
      source: 'planner_syllabus_repair',
    });

    const repairedParsed = tryParseJson(repairedResult?.content);
    const repaired = CourseSkeletonSchema.safeParse(repairedParsed);
    if (!repaired.success) {
      throw new Error(`Syllabus generation failed validation: ${repaired.error.toString()}`);
    }
    ensureSkeletonMinimums(repaired.data);
    return repaired.data;
  } finally {
    logStageUsage('SYLLABUS', usageStart);
  }
}

// Module, lesson, and assessment generation functions were removed.
// This service now focuses on syllabus synthesis and hierarchical topic generation only.

/**
 * Hierarchical topic generation (already working well; do not touch its use).
 */
export async function generateHierarchicalTopics(input = {}, userId, courseId = null) {
  const {
    university = null,
    courseTitle = 'Custom course',
    syllabusText = null,
    examFormatDetails = null,
    attachments = [],
    finishByDate = null,
    mode = 'deep',
  } = input || {};

  const usageStart = captureUsageTotals();
  let ragSessionId = null;
  let ragContext = '';

  // Create RAG session if syllabus or exam text is provided
  if (userId && (syllabusText || examFormatDetails)) {
    try {
      const ragResult = await createRagSessionWrapper({
        userId,
        syllabusText: syllabusText || '',
        examText: examFormatDetails || '',
      });
      ragSessionId = ragResult.sessionId;
      console.log(`[courseV2] RAG session created: ${ragSessionId}, chunks: syllabus=${ragResult.counts.syllabus}, exam=${ragResult.counts.exam}`);
    } catch (ragError) {
      console.warn('[courseV2] RAG session creation failed, continuing without RAG:', ragError.message);
    }
  }

  try {
    const syllabus = await synthesizeSyllabus({
      university,
      courseName: courseTitle,
      syllabusText,
      examFormatDetails,
      topics: [],
      attachments: attachments || [],
      userId,
      courseId,
    });

    const skeletonUnits = Array.isArray(syllabus?.skeleton) ? syllabus.skeleton : [];
    const rawTopicSummaries = skeletonUnits.map((unit, idx) => {
      const id = `unit_${unit?.sequence_order ?? idx + 1}`;
      const title = coerceTopicString(unit?.title, `Unit ${idx + 1}`);
      const concepts = Array.isArray(unit?.raw_concepts) ? unit.raw_concepts.filter(Boolean) : [];
      const conceptSummary = concepts.length ? `Concepts: ${concepts.join(', ')}` : '';
      const reviewLabel = unit?.is_exam_review ? 'Exam review unit.' : '';
      const description = [conceptSummary, reviewLabel].filter(Boolean).join(' ').trim();

      return {
        id,
        title,
        description,
        sequence_order: unit?.sequence_order ?? idx + 1,
        original_skeleton_ref: unit?.title ?? `Unit ${idx + 1}`,
      };
    });
    if (rawTopicSummaries.length === 0) {
      throw new Error('Course skeleton did not produce any structural units.');
    }

    // Retrieve RAG context if session exists
    if (ragSessionId) {
      try {
        // Build retrieval query from course title + exam details + skeleton headings
        const skeletonHeadings = rawTopicSummaries.map(s => s.title).join(', ');
        const retrievalQuery = [
          courseTitle,
          examFormatDetails || '',
          skeletonHeadings,
        ].filter(Boolean).join(' | ');

        ragContext = await retrieveContextWrapper({
          sessionId: ragSessionId,
          queryText: retrievalQuery,
          topK: RAG_TOP_K,
          maxChars: RAG_MAX_CONTEXT_CHARS,
        });
        if (ragContext) {
          console.log(`[courseV2] RAG context retrieved: ${ragContext.length} chars`);
        }
      } catch (ragError) {
        console.warn('[courseV2] RAG context retrieval failed:', ragError.message);
      }
    }

    const trimmedSyllabus = coerceTopicString(syllabusText, 'Not provided').slice(0, 4000);

    // Build RAG context section for prompt
    const ragContextSection = ragContext
      ? `\n\n### Authoritative Excerpts (use for specifics):\nThe following excerpts are from the student's actual syllabus and exam materials. Ground your topic coverage and exam relevance claims in these excerpts when possible.\n\n${ragContext}`
      : '';

    const systemPrompt = `You are an expert exam prep strategist. You are creating a master study plan for a student.

INPUTS:
1. The Course Skeleton (chronological list of topics).
2. The specific Exam Format (e.g., "Multiple choice focus" or "Proof heavy").
3. The raw syllabus text (for context).
4. Authoritative excerpts from the student's actual syllabus/exam materials (if provided).

YOUR TASK:
Expand the Skeleton into a detailed Topic Map. For every major topic, generate specific "Atomic Concepts" that act as study milestones.

CRITICAL RULES:
1. Granularity: Avoid generic titles like "Derivatives". Use actionable concepts like "Calculating derivatives using the Chain Rule".
2. Bloom's Taxonomy: Ensure subtopics vary in cognitive depth (Definitions -> Application -> Analysis).
3. Yield Scoring: Estimate how likely this topic is to appear on the exam (High/Medium/Low) based on the exam format provided.
4. Metadata powers Deep vs. Cram study modes, so fill every field carefully.
   - **MODE: ${mode.toUpperCase()}**
   ${mode === 'cram' ? '- FOCUS: MAXIMIZE EXAM VALUE. Generate FEWER topics overall—only high-yield, exam-critical concepts. Aggressively prune "nice-to-know" and peripheral information. Every topic must directly contribute to exam performance.' : '- FOCUS: MAXIMAL UNDERSTANDING AND DEEP RETENTION. Generate comprehensive topics that explore all details, nuances, edge cases, and interconnections. Include foundational concepts, theoretical underpinnings, and extended examples. Prioritize building lasting, transferable knowledge over exam shortcuts.'}
5. TITLES MUST BE CLEAN: Do NOT include numbering prefixes like "Module 1:", "Week 1:", "Chapter 1:". Just use the descriptive topic name.
6. GROUNDING: When authoritative excerpts are provided, use them to ground specific claims about topic coverage and exam relevance. Reference specific details from the excerpts in your exam_relevance_reasoning fields.

ENUM VALUES (use ONLY these exact strings):
- **bloom_level**: "Remember" | "Understand" | "Apply" | "Analyze" | "Evaluate"
- **yield**: "High" | "Medium" | "Low"

OUTPUT JSON STRUCTURE:
{
  "overviewTopics": [
    {
      "title": "Limits & Continuity",
      "original_skeleton_ref": "Week 1",
      "subtopics": [
        {
          "title": "The Epsilon-Delta Definition of a Limit",
          "bloom_level": "Understand",
          "exam_relevance_reasoning": "Syllabus explicitly mentions proofs for limits.",
          "yield": "High"
        }
      ]
    }
  ]
}

Rules:
- JSON must be valid (double quotes, no trailing commas, no comments).
- Provide at least 8 overview topics when possible, each with 4-8 atomic concepts.
- Do not include extra keys or wrapper text.
- Do NOT include "id", "overviewId", "estimated_study_time_minutes", or "importance_score" fields - these are added automatically.`;

    const userPrompt = `Course Details:
Institution: ${coerceTopicString(university, 'Unknown institution')}
Course / exam: ${coerceTopicString(courseTitle, 'Untitled course')}
Structure type: ${coerceTopicString(syllabus?.course_structure_type, 'Not specified')}
Exam / target date: ${finishByDate ? new Date(finishByDate).toISOString() : 'Not specified'}
Exam format: ${coerceTopicString(examFormatDetails, 'Not specified')}

Course Skeleton (chronological list):
${JSON.stringify(rawTopicSummaries, null, 2)}

Raw syllabus text snippet:
${trimmedSyllabus}${ragContextSection}

Using this information, produce competency-based overviewTopics with fully populated atomic concept metadata.`;

    const messages = [
      { role: 'system', content: systemPrompt.trim() },
      { role: 'user', content: userPrompt.trim() },
    ];

    const { result, model } = await courseV2LLMCaller({
      stage: STAGES.TOPICS,
      messages,
      maxTokens: 8192,
      allowWeb: false, // Disabled web search to avoid compatibility issues with Grok
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 300000, // 5 minutes for TOPICS
      userId,
      courseId,
      source: 'hierarchical_topics',
    });

    let parsed = tryParseJson(result?.content);
    let validationError = null;

    // Initial validation - use RawTopicMapSchema since LLM doesn't produce id/overviewId/computed fields
    if (parsed && typeof parsed === 'object') {
      const check = RawTopicMapSchema.safeParse({ overviewTopics: parsed.overviewTopics });
      if (!check.success) {
        validationError = check.error.toString();
      }
    } else {
      validationError = 'Output was not valid JSON (parse failed).';
    }

    // Repair loop if needed
    if (validationError) {
      console.log('[topics] Initial validation failed, attempting repair. Error:', validationError);

      const criticMessages = [
        ...messages,
        {
          role: 'user',
          content: `Prior output was invalid JSON. 
Validation error: ${validationError}
Original output: ${result.content?.slice(0, 2000) ?? 'N/A'}
Please return **only** a correct JSON object for the topic map, with no extra text.`
        }
      ];

      const { result: repairedResult } = await courseV2LLMCaller({
        stage: STAGES.TOPICS,
        messages: criticMessages,
        allowWeb: false,
        maxTokens: 8192,
        responseFormat: { type: 'json_object' },
        requestTimeoutMs: 300000, // 5 minutes for topic repair
        userId,
        courseId,
        source: 'hierarchical_topics_repair',
      });

      parsed = tryParseJson(repairedResult?.content);
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Topic generation returned invalid JSON after repair attempt.');
      }

      // Re-validate with RawTopicMapSchema
      const recheck = RawTopicMapSchema.safeParse({ overviewTopics: parsed.overviewTopics });
      if (!recheck.success) {
        throw new Error(`Topic generation failed validation after repair: ${recheck.error.toString()}`);
      }
    }

    // Normalize adds id, overviewId, estimated_study_time_minutes, importance_score
    const overviewTopics = normalizeOverviewTopics(parsed.overviewTopics, rawTopicSummaries);
    // Final validation with full schema to ensure normalization produced valid output
    const validated = TopicMapSchema.parse({ overviewTopics });
    return {
      overviewTopics: validated.overviewTopics,
      model: model || 'unknown',
      rag_session_id: ragSessionId,
    };
  } finally {
    logTopicsUsage(usageStart);
  }
}

// Removed course packaging, cross-linking, critic, and full pipeline functions.

