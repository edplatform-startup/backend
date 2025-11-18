// src/services/courseV2.js

import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { getCostTotals } from './grokClient.js';
import { plannerSyllabus } from './prompts/courseV2Prompts.js';
import { CourseSkeletonSchema } from '../schemas/courseV2.js';

const VALID_TOPIC_DIFFICULTIES = new Set(['introductory', 'intermediate', 'advanced']);

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

function normalizeOverviewTopics(rawOverviewTopics) {
  if (!Array.isArray(rawOverviewTopics)) return [];
  const normalized = [];

  rawOverviewTopics.forEach((ot, index) => {
    if (!ot || typeof ot !== 'object') return;

    const id =
      typeof ot.id === 'string' && ot.id.trim()
        ? ot.id.trim()
        : `overview_${index + 1}`;
    const title = coerceTopicString(ot.title, `Topic group ${index + 1}`);
    const description = coerceTopicString(ot.description, '');
    const likelyOnExam = Boolean(ot.likelyOnExam);

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
      const stDescription = coerceTopicString(st.description, '');
      const rawDiff = coerceTopicString(st.difficulty, 'intermediate').toLowerCase();
      const difficulty = VALID_TOPIC_DIFFICULTIES.has(rawDiff) ? rawDiff : 'intermediate';
      const stLikelyOnExam = Boolean(st.likelyOnExam);

      subtopics.push({
        id: sid,
        overviewId,
        title: stTitle,
        description: stDescription,
        difficulty,
        likelyOnExam: stLikelyOnExam,
      });
    });

    if (subtopics.length === 0) return;

    normalized.push({
      id,
      title,
      description,
      likelyOnExam,
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
      maxTokens: 1800,
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
      maxTokens: 1500,
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
      };
    });
    if (rawTopicSummaries.length === 0) {
      throw new Error('Course skeleton did not produce any structural units.');
    }

    const systemPrompt = `You are an expert university curriculum planner.
You design topic maps for students preparing for a specific course and exam. You will receive:
- The course name and institution.
- A rough list of topic nodes extracted from the syllabus/topic graph.

Your job:
- Propose a set of high-level OVERVIEW TOPICS that together cover the whole course/exam.
- These should be broad areas a student would recognize on a syllabus (8-16 total).
- Under each overview topic, propose SPECIFIC SUBTOPICS (5-15) that reflect exam-relevant concepts, skills, or question types.
- Err on the side of MORE subtopics so the union spans the entire course.
- Prefer splitting large ideas into concrete, exam-ready pieces.
- Avoid meta-topics like "study skills" unless explicitly required.

Output STRICT JSON using this structure ONLY:
{
  "overviewTopics": [
    {
      "id": "string",
      "title": "string",
      "description": "string",
      "likelyOnExam": true,
      "subtopics": [
        {
          "id": "string",
          "overviewId": "string",
          "title": "string",
          "description": "string",
          "difficulty": "introductory" | "intermediate" | "advanced",
          "likelyOnExam": boolean
        }
      ]
    }
  ]
}

Rules:
- JSON must be valid (double quotes, no trailing commas, no comments).
- IDs must be unique across overview topics and subtopics.
- overviewId on each subtopic must match its parent overview topic id.
- Do not include extra keys or wrapper text.`;

    const userPrompt = `Course Details:
Institution: ${coerceTopicString(university, 'Unknown institution')}
Course / exam: ${coerceTopicString(courseTitle, 'Untitled course')}
  Structure type: ${coerceTopicString(syllabus?.course_structure_type, 'Not specified')}
Exam / target date: ${finishByDate ? new Date(finishByDate).toISOString() : 'Not specified'}
Exam format: ${coerceTopicString(examFormatDetails, 'Not specified')}

  Course skeleton units (raw, unstructured):
${JSON.stringify(rawTopicSummaries, null, 2)}

Using these as a starting point, produce an exam-aligned topic map with overviewTopics and subtopics.`;

    const { result, model } = await courseV2LLMCaller({
      stage: STAGES.TOPICS,
      messages: [
        { role: 'system', content: systemPrompt.trim() },
        { role: 'user', content: userPrompt.trim() },
      ],
      maxTokens: 2200,
      allowWeb: true,
    });

    const parsed = tryParseJson(result?.content);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Topic generation returned invalid JSON.');
    }

    const overviewTopics = normalizeOverviewTopics(parsed.overviewTopics);
    return {
      overviewTopics,
      model: model || 'unknown',
    };
  } finally {
    logTopicsUsage(usageStart);
  }
}

// Removed course packaging, cross-linking, critic, and full pipeline functions.

