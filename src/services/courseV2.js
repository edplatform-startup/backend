// src/services/courseV2.js

import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { getCostTotals } from './grokClient.js';
import { plannerSyllabus } from './prompts/courseV2Prompts.js';
import { CourseSkeletonSchema, TopicMapSchema } from '../schemas/courseV2.js';

const FOCUS_CANONICAL = new Map([
  ['conceptual', 'Conceptual'],
  ['computational', 'Computational'],
  ['memorization', 'Memorization'],
]);

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

function normalizeOverviewTopics(rawOverviewTopics, skeletonSummaries = []) {
  if (!Array.isArray(rawOverviewTopics)) return [];
  const normalized = [];

  rawOverviewTopics.forEach((ot, index) => {
    if (!ot || typeof ot !== 'object') return;

    const id =
      typeof ot.id === 'string' && ot.id.trim()
        ? ot.id.trim()
        : `overview_${index + 1}`;
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
      const sid =
        typeof st.id === 'string' && st.id.trim()
          ? st.id.trim()
          : `${id}_subtopic_${subIdx + 1}`;
      const overviewId = coerceTopicString(st.overviewId, id);
      const stTitle = coerceTopicString(st.title, `Subtopic ${subIdx + 1}`);
      const focus = coerceEnumValue(st.focus, FOCUS_CANONICAL, 'Conceptual');
      const bloomLevel = coerceEnumValue(st.bloom_level ?? st.bloomLevel, BLOOM_CANONICAL, 'Understand');
      const studyMinutes = coerceStudyMinutes(st.estimated_study_time_minutes ?? st.study_minutes);
      const importance = coerceImportance(st.importance_score ?? st.importance ?? st.priority);
      const reasoning = coerceReasoning(st.exam_relevance_reasoning ?? st.reasoning);
      const yieldScore = coerceEnumValue(st.yield ?? st.exam_yield ?? st.yield_score, YIELD_CANONICAL, 'Medium');

      subtopics.push({
        id: sid,
        overviewId,
        title: stTitle,
        focus,
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
}) {
  if (customSyllabusSynthesizer) {
    return customSyllabusSynthesizer({
      university,
      courseName,
      syllabusText,
      examFormatDetails,
      topics,
      attachments,
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
      maxTokens: 4800,
      attachments,
      responseFormat: { type: 'json_object' },
    });

    const rawContent = result?.content;
    const parsed = tryParseJson(rawContent);
    const firstPass = CourseSkeletonSchema.safeParse(parsed);

    if (firstPass.success) {
      ensureSkeletonMinimums(firstPass.data);
      return firstPass.data;
    }

    const criticMessages = [
      ...messages.slice(0, 1),
      {
        role: 'user',
        content: `Prior output failed validation.
Error: ${firstPass.error.toString()}
Original JSON: ${stringifyForPrompt(parsed)}
Return corrected JSON only.`,
      },
    ];

    const { result: repairedResult } = await courseV2LLMCaller({
      stage: STAGES.PLANNER,
      messages: criticMessages,
      allowWeb: false,
      maxTokens: 4500,
      attachments,
      responseFormat: { type: 'json_object' },
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
export async function generateHierarchicalTopics(input = {}) {
  const {
    university = null,
    courseTitle = 'Custom course',
    syllabusText = null,
    examFormatDetails = null,
    attachments = [],
    finishByDate = null,
  } = input || {};

  const usageStart = captureUsageTotals();
  try {
    const syllabus = await synthesizeSyllabus({
      university,
      courseName: courseTitle,
      syllabusText,
      examFormatDetails,
      topics: [],
      attachments: attachments || [],
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

    const systemPrompt = `You are an expert exam prep strategist. You are creating a master study plan for a student.

INPUTS:
1. The Course Skeleton (chronological list of topics).
2. The specific Exam Format (e.g., "Multiple choice focus" or "Proof heavy").
3. The raw syllabus text (for context).

YOUR TASK:
Expand the Skeleton into a detailed Topic Map. For every major topic, generate specific "Atomic Concepts" that act as study milestones.

CRITICAL RULES:
1. Granularity: Avoid generic titles like "Derivatives". Use actionable concepts like "Calculating derivatives using the Chain Rule".
2. Bloom's Taxonomy: Ensure subtopics vary in cognitive depth (Definitions -> Application -> Analysis).
3. Yield Scoring: Estimate how likely this topic is to appear on the exam (High/Medium/Low) based on the exam format provided.
4. Metadata powers Deep vs. Cram study modes, so fill every field carefully.

OUTPUT JSON STRUCTURE:
{
  "overviewTopics": [
    {
      "id": "uuid",
      "title": "Module 1: Limits & Continuity",
      "original_skeleton_ref": "Week 1",
      "subtopics": [
        {
          "id": "uuid",
          "overviewId": "uuid",
          "title": "The Epsilon-Delta Definition of a Limit",
          "focus": "Conceptual",
          "bloom_level": "Understand",
          "estimated_study_time_minutes": 45,
          "importance_score": 9,
          "exam_relevance_reasoning": "Syllabus explicitly mentions proofs for limits.",
          "yield": "High"
        }
      ]
    }
  ]
}

Rules:
- JSON must be valid (double quotes, no trailing commas, no comments).
- IDs must be unique across overview topics and subtopics.
- overviewId on each subtopic must match its parent overview topic id.
- Provide at least 8 overview topics when possible, each with 4-8 atomic concepts.
- Do not include extra keys or wrapper text.`;

    const trimmedSyllabus = coerceTopicString(syllabusText, 'Not provided').slice(0, 4000);
    const userPrompt = `Course Details:
Institution: ${coerceTopicString(university, 'Unknown institution')}
Course / exam: ${coerceTopicString(courseTitle, 'Untitled course')}
Structure type: ${coerceTopicString(syllabus?.course_structure_type, 'Not specified')}
Exam / target date: ${finishByDate ? new Date(finishByDate).toISOString() : 'Not specified'}
Exam format: ${coerceTopicString(examFormatDetails, 'Not specified')}

Course Skeleton (chronological list):
${JSON.stringify(rawTopicSummaries, null, 2)}

Raw syllabus text snippet:
${trimmedSyllabus}

Using this information, produce competency-based overviewTopics with fully populated atomic concept metadata.`;

    const { result, model } = await courseV2LLMCaller({
      stage: STAGES.TOPICS,
      messages: [
        { role: 'system', content: systemPrompt.trim() },
        { role: 'user', content: userPrompt.trim() },
      ],
      maxTokens: 6000,
      allowWeb: true,
      responseFormat: { type: 'json_object' },
    });

    const parsed = tryParseJson(result?.content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Topic generation returned invalid JSON.');
    }

    const overviewTopics = normalizeOverviewTopics(parsed.overviewTopics, rawTopicSummaries);
    const validated = TopicMapSchema.parse({ overviewTopics });
    return {
      overviewTopics: validated.overviewTopics,
      model: model || 'unknown',
    };
  } finally {
    logTopicsUsage(usageStart);
  }
}

// Removed course packaging, cross-linking, critic, and full pipeline functions.

