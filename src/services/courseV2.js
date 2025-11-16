// src/services/courseV2.js

import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { getCostTotals } from './grokClient.js';
import { plannerSyllabus } from './prompts/courseV2Prompts.js';
import { SyllabusSchema } from '../schemas/courseV2.js';

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

function ensureSyllabusMinimums(syllabus) {
  if (!Array.isArray(syllabus?.topic_graph?.nodes) || syllabus.topic_graph.nodes.length < 4) {
    throw new Error('Syllabus must include at least 4 topic graph nodes.');
  }
  if (!Array.isArray(syllabus?.sources) || syllabus.sources.length < 1) {
    throw new Error('Syllabus must include at least one source.');
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
    const firstPass = SyllabusSchema.safeParse(parsed);

    if (firstPass.success) {
      ensureSyllabusMinimums(firstPass.data);
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
    const repaired = SyllabusSchema.safeParse(repairedParsed);
    if (!repaired.success) {
      throw new Error(`Syllabus generation failed validation: ${repaired.error.toString()}`);
    }
    ensureSyllabusMinimums(repaired.data);
    return repaired.data;
  } finally {
    logStageUsage('SYLLABUS', usageStart);
  }
}

export async function planModulesFromGraph(syllabus) {
  throw new Error('Course generation is not implemented');
}

export async function designLessons(modules, syllabus) {
  throw new Error('Course generation is not implemented');
}

export async function generateAssessments(modules, lessons, syllabus) {
  throw new Error('Course generation is not implemented');
}

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

    const nodes = Array.isArray(syllabus?.topic_graph?.nodes) ? syllabus.topic_graph.nodes : [];
    const rawTopicSummaries = nodes.map((node, idx) => ({
      id: node?.id ?? `node_${idx + 1}`,
      title: coerceTopicString(node?.title || node?.name || node?.label, `Topic ${idx + 1}`),
      description: coerceTopicString(node?.description || node?.summary, ''),
    }));

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
Exam / target date: ${finishByDate ? new Date(finishByDate).toISOString() : 'Not specified'}
Exam format: ${coerceTopicString(examFormatDetails, 'Not specified')}

Syllabus-derived topic nodes (raw, unstructured):
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

export function crossLink(course) {
  throw new Error('Course generation is not implemented');
}

export async function criticAndRepair(course) {
  throw new Error('Course generation is not implemented');
}

export function packageCourse(course) {
  throw new Error('Course generation is not implemented');
}

export async function generateCourseV2(optionsOrSelection, maybeUserPrefs = {}) {
  throw new Error('Course generation is not implemented');
}

