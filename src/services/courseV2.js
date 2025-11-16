// src/services/courseV2.js

import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { getCostTotals } from './grokClient.js';

const VALID_TOPIC_DIFFICULTIES = new Set(['introductory', 'intermediate', 'advanced']);

function captureUsageTotals() {
  try {
    return getCostTotals();
  } catch {
    return null;
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

function tryParseJson(str) {
  if (!str || typeof str !== 'string') return null;
  const trimmed = str.trim();
  if (!trimmed) return null;

  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

function stringifyForPrompt(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}

function coerceTopicString(value, defaultValue = '') {
  if (value == null) return defaultValue;
  if (typeof value === 'string') return value.trim() || defaultValue;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim() || defaultValue;
  }
  return defaultValue;
}

function normalizeOverviewTopics(rawOverviewTopics) {
  if (!Array.isArray(rawOverviewTopics)) return [];

  const usedTopicIds = new Set();
  const overviewTopics = [];

  for (const rawOverview of rawOverviewTopics) {
    if (!rawOverview || typeof rawOverview !== 'object') continue;

    const overviewId = coerceTopicString(rawOverview.id || rawOverview.topicId);
    const overviewTitle = coerceTopicString(
      rawOverview.title || rawOverview.name || rawOverview.overview,
      'Overview topic',
    );
    const overviewDescription = coerceTopicString(
      rawOverview.description || rawOverview.desc || rawOverview.summary,
      '',
    );

    const likelyOnExam =
      typeof rawOverview.likelyOnExam === 'boolean'
        ? rawOverview.likelyOnExam
        : rawOverview.likelyOnExam === 'true';

    if (!overviewId || usedTopicIds.has(overviewId)) continue;

    const overview = {
      id: overviewId,
      title: overviewTitle,
      description: overviewDescription,
      likelyOnExam,
      subtopics: [],
    };

    const rawSubtopics = Array.isArray(rawOverview.subtopics)
      ? rawOverview.subtopics
      : [];

    for (const rawSub of rawSubtopics) {
      if (!rawSub || typeof rawSub !== 'object') continue;

      const subId = coerceTopicString(rawSub.id || rawSub.subtopicId);
      const subTitle = coerceTopicString(
        rawSub.title || rawSub.name || rawSub.subtopic,
        'Subtopic',
      );
      const subDescription = coerceTopicString(
        rawSub.description || rawSub.desc || rawSub.summary,
        '',
      );
      let subDifficulty = coerceTopicString(rawSub.difficulty, 'intermediate').toLowerCase();
      if (!VALID_TOPIC_DIFFICULTIES.has(subDifficulty)) {
        subDifficulty = 'intermediate';
      }

      const subLikelyOnExam =
        typeof rawSub.likelyOnExam === 'boolean'
          ? rawSub.likelyOnExam
          : rawSub.likelyOnExam === 'true';

      if (!subId || usedTopicIds.has(subId)) continue;
      usedTopicIds.add(subId);

      overview.subtopics.push({
        id: subId,
        overviewId: overview.id,
        title: subTitle,
        description: subDescription,
        difficulty: subDifficulty,
        likelyOnExam: subLikelyOnExam,
      });
    }

    usedTopicIds.add(overviewId);
    overviewTopics.push(overview);
  }

  return overviewTopics;
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
    return await customSyllabusSynthesizer({
      university,
      courseName,
      syllabusText,
      examFormatDetails,
      topics,
      attachments,
    });
  }

  throw new Error('Course generation is not implemented');
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

