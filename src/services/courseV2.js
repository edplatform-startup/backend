import { callStageLLM } from './llmCall.js';
import { STAGES, nextFallback } from './modelRouter.js';
import { getCostTotals } from './grokClient.js';
import {
  plannerSyllabus,
  plannerModules,
  writerLessons,
  selectorModules,
  assessorAssessments,
  criticCourse,
} from './prompts/courseV2Prompts.js';
import {
  SyllabusSchema,
  ModulesSchema,
  LessonsSchema,
  LessonSchema,
  AssessmentsSchema,
  CoursePackageSchema,
} from '../schemas/courseV2.js';

const READING_WPM = Number(process.env.READING_WPM || 220);
const DEFAULT_MIN = {
  guided_example: Number(process.env.DEFAULT_ACTIVITY_MIN_GUIDED_EXAMPLE || 12),
  problem_set: Number(process.env.DEFAULT_ACTIVITY_MIN_PROBLEM_SET || 25),
  discussion: Number(process.env.DEFAULT_ACTIVITY_MIN_DISCUSSION || 10),
};

const IDEAL_MIN_MODULES = 6;
const IDEAL_MAX_MODULES = 10;
const FALLBACK_MIN_MODULES = 4;
const FALLBACK_MAX_MODULES = 10;
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
    /* ignore logging errors */
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
    /* ignore logging errors */
  }
}

let customCourseGenerator = null;
let courseV2LLMCaller = callStageLLM;
let customSyllabusSynthesizer = null;

export function setCourseV2Generator(fn) {
  customCourseGenerator = typeof fn === 'function' ? fn : null;
}

export function clearCourseV2Generator() {
  customCourseGenerator = null;
}

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
            console.error('[courseV2] JSON parse failed after removing trailing commas:', tertiaryError);
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

function extractTopicNodesFromSyllabus(syllabus) {
  if (!Array.isArray(syllabus?.topic_graph?.nodes)) {
    return [];
  }
  return syllabus.topic_graph.nodes;
}

function buildFallbackModulePlanFromTopics(topicNodes) {
  if (!Array.isArray(topicNodes) || topicNodes.length === 0) {
    throw new Error('Cannot build modules: no topics available.');
  }

  const idealCount = Math.min(
    FALLBACK_MAX_MODULES,
    Math.max(FALLBACK_MIN_MODULES, Math.ceil(topicNodes.length / 3)),
  );

  const modules = [];
  const buckets = Array.from({ length: idealCount }, () => []);
  topicNodes.forEach((node, index) => {
    buckets[index % idealCount].push(node);
  });

  for (const slice of buckets) {
    if (!slice.length) continue;
    const moduleNumber = modules.length + 1;
    const first = slice[0] || {};
    const primaryLabel = first.title || first.name || first.id || `Concept ${moduleNumber}`;
    const coveredTitles = slice.map((node) => node.title || node.name || node.id);
    const previousId = modules.length === 0 ? null : modules[modules.length - 1].id;
    modules.push({
      id: `fallback_module_${moduleNumber}`,
      title: `Module ${moduleNumber}: ${primaryLabel}`,
      description: `Learn and practice ${slice.length} key concept(s) related to ${primaryLabel}.`,
      dependsOn: previousId ? [previousId] : [],
      outcomes: [`Master the concepts spanning ${coveredTitles.join(', ')}`],
      hours_estimate: Math.max(6, slice.length * 3),
      covers_nodes: slice.map((node) => node.id).filter(Boolean),
    });
  }

  if (modules.length === 0) {
    throw new Error('Fallback module builder produced no modules.');
  }

  return { modules };
}

function ensureModulePlanHasModules(plan, syllabus) {
  if (Array.isArray(plan?.modules) && plan.modules.length > 0) {
    return plan;
  }

  console.warn('[courseV2] Module planner returned 0 modules, falling back to deterministic plan.');
  const topics = extractTopicNodesFromSyllabus(syllabus);
  return buildFallbackModulePlanFromTopics(topics);
}

function validateModuleCoverage(modulesPlan, syllabus) {
  const modules = Array.isArray(modulesPlan?.modules) ? modulesPlan.modules : [];
  const count = modules.length;

  if (count === 0) {
    throw new Error('Module plan must include at least one module.');
  }

  if (count < IDEAL_MIN_MODULES || count > IDEAL_MAX_MODULES) {
    console.warn(
      `[courseV2] module count ${count} is outside the recommended ${IDEAL_MIN_MODULES}-${IDEAL_MAX_MODULES} range; proceeding anyway.`,
    );
  }

  const nodeIds = new Set((syllabus?.topic_graph?.nodes || []).map((node) => node.id));
  for (const module of modulesPlan.modules) {
    if (!Array.isArray(module?.covers_nodes) || module.covers_nodes.length === 0) {
      throw new Error(`Module ${module?.id || '<unknown>'} missing covers_nodes.`);
    }
    for (const nodeId of module.covers_nodes) {
      if (!nodeIds.has(nodeId)) {
        throw new Error(`Module ${module.id} references unknown node id ${nodeId}.`);
      }
    }
  }
}

function normalizeLessonsOutput(rawLessons, fallbackModuleId) {
  const rawArray = Array.isArray(rawLessons)
    ? rawLessons
    : rawLessons && typeof rawLessons === 'object' && Array.isArray(rawLessons.lessons)
      ? rawLessons.lessons
      : [];

  const lessons = [];
  let counter = 0;
  for (const entry of rawArray) {
    if (!entry || typeof entry !== 'object') continue;
    counter += 1;
    const normalized = { ...entry };
    if (typeof normalized.id !== 'string' || !normalized.id.trim()) {
      normalized.id = `${fallbackModuleId || 'module'}-lesson-${counter}`;
    }
    if (typeof normalized.moduleId !== 'string' || !normalized.moduleId.trim()) {
      normalized.moduleId = fallbackModuleId;
    }
    if (normalized.duration_min != null) {
      normalized.duration_min = Number(normalized.duration_min);
      if (Number.isNaN(normalized.duration_min)) normalized.duration_min = 45;
      else if (normalized.duration_min < 35) normalized.duration_min = 40;
      else if (normalized.duration_min > 70) normalized.duration_min = 60;
    }
    if (Array.isArray(normalized.reading) && normalized.reading.length > 3) {
      normalized.reading = normalized.reading.slice(0, 3);
    }
    lessons.push(normalized);
  }

  return lessons;
}

function normalizeLessonsContainer(raw) {
  if (raw && typeof raw === 'object' && Array.isArray(raw.lessons)) {
    return { lessons: raw.lessons };
  }
  if (Array.isArray(raw)) {
    return { lessons: raw };
  }
  return { lessons: [] };
}

function enforceLessonConstraints(lessonsPlan, modulesPlan) {
  const moduleIds = new Set((modulesPlan.modules || []).map((module) => module.id));
  const counts = new Map();

  for (const lesson of lessonsPlan.lessons) {
    if (!moduleIds.has(lesson.moduleId)) {
      throw new Error(`Lesson ${lesson.id} references unknown moduleId ${lesson.moduleId}.`);
    }
    counts.set(lesson.moduleId, (counts.get(lesson.moduleId) || 0) + 1);

    if (!Array.isArray(lesson.objectives) || lesson.objectives.length === 0) {
      throw new Error(`Lesson ${lesson.id} must include objectives.`);
    }
    if (typeof lesson.duration_min !== 'number' || Number.isNaN(lesson.duration_min)) {
      throw new Error(`Lesson ${lesson.id} requires numeric duration_min.`);
    }
    if (lesson.duration_min < 35 || lesson.duration_min > 70) {
      throw new Error(`Lesson ${lesson.id} duration_min must be ~40-60 minutes.`);
    }
    if (Array.isArray(lesson.reading) && lesson.reading.length > 3) {
      throw new Error(`Lesson ${lesson.id} exceeds maximum readings.`);
    }
  }

  for (const moduleId of moduleIds) {
    const count = counts.get(moduleId) || 0;
    if (count < 2 || count > 4) {
      throw new Error(`Module ${moduleId} must have between 2 and 4 lessons (found ${count}).`);
    }
  }
}

function buildFallbackLessons(modulesPlan, syllabus, limitModuleIds = null) {
  const allModules = Array.isArray(modulesPlan?.modules) ? modulesPlan.modules : [];
  const modules = Array.isArray(limitModuleIds) && limitModuleIds.length
    ? allModules.filter((module) => module && limitModuleIds.includes(module.id))
    : allModules;

  if (modules.length === 0) {
    throw new Error('Cannot build fallback lessons: no modules provided.');
  }

  const nodeMap = new Map((syllabus?.topic_graph?.nodes || []).map((node) => [node.id, node]));
  const lessons = [];
  const placeholderUrl = 'https://example.com/placeholder';
  const activityTypes = ['guided_example', 'problem_set', 'discussion', 'project_work'];

  modules.forEach((module, moduleIdx) => {
    const moduleNodes = (module?.covers_nodes || []).map((nodeId) => nodeMap.get(nodeId)).filter(Boolean);
    const lessonCount = Math.min(4, Math.max(2, moduleNodes.length ? Math.ceil(moduleNodes.length / 2) : 2));

    for (let i = 0; i < lessonCount; i += 1) {
      const focusNodes = moduleNodes.slice(i * 2, i * 2 + 2);
      const objectiveSources = focusNodes.length
        ? focusNodes
        : moduleNodes.length
          ? moduleNodes
          : [{ title: module.title }];

      const objectives = objectiveSources.slice(0, 3).map((node) => {
        const nodeTitle = node?.title || node?.name || node?.id || module.title;
        return `Understand ${nodeTitle}`;
      });
      if (objectives.length === 0) {
        objectives.push(`Understand ${module.title}`);
      }
      if (objectives.length === 1) {
        objectives.push(`Apply ${module.title} concepts`);
      }

      const readings = [];
      for (const node of objectiveSources) {
        if (!Array.isArray(node?.refs)) continue;
        for (const ref of node.refs) {
          if (typeof ref === 'string' && readings.length < 3) {
            readings.push({
              title: `${node.title || module.title} reference ${readings.length + 1}`,
              url: ref,
              est_min: 12,
            });
          }
        }
        if (readings.length >= 3) break;
      }
      if (readings.length === 0) {
        readings.push({ title: `${module.title} primer`, url: placeholderUrl, est_min: 12 });
      }

      const activityType = activityTypes[(moduleIdx + i) % activityTypes.length];
      lessons.push({
        id: `${module.id}-fallback-lesson-${i + 1}`,
        moduleId: module.id,
        title: `${module.title}: Part ${i + 1}`,
        objectives,
        duration_min: 45,
        reading: readings.slice(0, 3),
        activities: [
          {
            type: activityType,
            goal: `Reinforce ${module.title} concepts via ${activityType.replace('_', ' ')}`,
            steps: [
              'Review key ideas from the lesson summary.',
              'Apply the concept to a realistic scenario.',
            ],
          },
        ],
        bridge_from: [],
        bridge_to: [],
        cross_refs: [],
      });
    }
  });

  const payload = { lessons };
  try {
    if (!limitModuleIds) {
      const validated = LessonsSchema.parse(payload);
      enforceLessonConstraints(validated, modulesPlan);
      return validated;
    }

    lessons.forEach((lesson) => LessonSchema.parse(lesson));
    enforceLessonConstraints(payload, { modules });
    return payload;
  } catch (error) {
    console.error('[courseV2][LESSONS] Fallback lesson builder produced invalid plan:', error);
    throw error;
  }
}

function buildModuleLessonPrompt(module, relatedNodes, correctionDirective = '') {
  const baseContent = `Module:
${stringifyForPrompt(module)}

Related nodes (with summaries):
${stringifyForPrompt(relatedNodes)}

Requirements:
- Produce 2-4 lessons for this module.
- Duration 40-60 minutes each.
- Each lesson references readings (<=3) with credible URLs.
- Include activities referencing allowed types.
- Ensure objectives align with module outcomes.
Return ONLY JSON lessons array for this module.`;

  const correctionBlock = correctionDirective
    ? `

CORRECTION: ${correctionDirective}`
    : '';

  return [
    ...writerLessons(),
    {
      role: 'user',
      content: `${baseContent}${correctionBlock}`,
    },
  ];
}

function enforceAssessmentConstraints(assessmentsPlan, modulesPlan, lessonsPlan, syllabus) {
  const moduleIds = new Set((modulesPlan.modules || []).map((module) => module.id));
  const lessonIds = new Set((lessonsPlan.lessons || []).map((lesson) => lesson.id));
  const nodeIds = new Set((syllabus?.topic_graph?.nodes || []).map((node) => node.id));

  if (!Array.isArray(assessmentsPlan.weekly_quizzes) || assessmentsPlan.weekly_quizzes.length < 2) {
    throw new Error('Assessments must include at least two weekly quizzes.');
  }

  for (const quiz of assessmentsPlan.weekly_quizzes) {
    if (!moduleIds.has(quiz.moduleId)) {
      throw new Error(`Assessment quiz references unknown moduleId ${quiz.moduleId}.`);
    }
    if (!Array.isArray(quiz.items) || quiz.items.length < 3 || quiz.items.length > 6) {
      throw new Error(`Weekly quiz for module ${quiz.moduleId} must include 3-6 items.`);
    }
    for (const item of quiz.items) {
      if (!Array.isArray(item.anchors) || item.anchors.length === 0) {
        throw new Error(`Assessment item for module ${quiz.moduleId} is missing anchors.`);
      }
      for (const anchor of item.anchors) {
        if (!lessonIds.has(anchor) && !nodeIds.has(anchor)) {
          throw new Error(`Assessment item anchor ${anchor} must match a lesson ID or node ID.`);
        }
      }
    }
  }
}

function buildFallbackAssessments(modulesPlan, lessonsPlan, syllabus) {
  const modules = Array.isArray(modulesPlan?.modules) ? modulesPlan.modules : [];
  if (modules.length === 0) {
    throw new Error('Cannot build fallback assessments: no modules provided.');
  }

  const lessonsByModule = new Map();
  (lessonsPlan?.lessons || []).forEach((lesson) => {
    if (!lesson?.moduleId) return;
    if (!lessonsByModule.has(lesson.moduleId)) {
      lessonsByModule.set(lesson.moduleId, []);
    }
    lessonsByModule.get(lesson.moduleId).push(lesson);
  });

  const fallbackLessonId = lessonsPlan?.lessons?.[0]?.id;
  const quizModules = modules.slice(0, Math.max(2, Math.min(modules.length, 6)));
  const weekly_quizzes = quizModules.map((module) => {
    const lessonAnchors = (lessonsByModule.get(module.id) || []).map((lesson) => lesson.id);
    const anchor = lessonAnchors[0] || module.covers_nodes?.[0] || fallbackLessonId;
    const items = Array.from({ length: 3 }, (_, idx) => ({
      type: 'mcq',
      question: `${module.title}: concept check ${idx + 1}`,
      options: [
        'Reinforce the primary concept.',
        'Introduce a distractor example.',
        'Explore an edge case.',
        'Clarify a misconception.',
      ],
      answerIndex: 0,
      explanation: `Review fundamentals for ${module.title}.`,
      anchors: anchor ? [anchor] : [],
    }));
    return {
      moduleId: module.id,
      items,
    };
  });

  const outcomes = Array.isArray(syllabus?.outcomes) && syllabus.outcomes.length > 0 ? syllabus.outcomes : ['Demonstrate mastery'];
  const project = {
    title: 'Applied Course Project',
    brief: 'Synthesize key learnings into a concise deliverable tying together module outcomes.',
    milestones: ['Outline goals and success criteria', 'Produce final artifact aligned to outcomes'],
    rubric: 'Assess clarity, conceptual mastery, and evidence of practice.',
  };

  const exam_blueprint = {
    sections: [
      {
        title: 'Concept Mastery',
        weight_pct: 60,
        outcomes: outcomes.slice(0, 2),
      },
      {
        title: 'Applied Practice',
        weight_pct: 40,
        outcomes: outcomes.slice(2, 4).length ? outcomes.slice(2, 4) : outcomes.slice(0, 2),
      },
    ],
  };

  const payload = { weekly_quizzes, project, exam_blueprint };
  try {
    const validated = AssessmentsSchema.parse(payload);
    enforceAssessmentConstraints(validated, modulesPlan, lessonsPlan, syllabus);
    return validated;
  } catch (error) {
    console.error('[courseV2] Fallback assessment builder produced invalid plan:', error);
    throw error;
  }
}

async function attemptAssessmentRepair({ repairMessages, modules, lessons, syllabus, modelOverride = null }) {
  let result;
  try {
    ({ result } = await courseV2LLMCaller({
      stage: STAGES.ASSESSOR,
      messages: repairMessages,
      maxTokens: 2400,
      allowWeb: false,
      modelOverride,
    }));
  } catch (err) {
    console.error('[courseV2][ASSESSMENTS] attemptAssessmentRepair call failed:', err);
    return { success: false, error: err };
  }
  const repairedRaw = tryParseJson(result?.content);
  const parsedAttempt = AssessmentsSchema.safeParse(repairedRaw);
  if (!parsedAttempt.success) {
    return { success: false, error: parsedAttempt.error };
  }

  try {
    enforceAssessmentConstraints(parsedAttempt.data, modules, lessons, syllabus);
    return { success: true, data: parsedAttempt.data };
  } catch (error) {
    return { success: false, error };
  }
}

export async function synthesizeSyllabus({ university, courseName, syllabusText, examFormatDetails, topics, attachments = [] }) {
  if (customSyllabusSynthesizer) {
    return await customSyllabusSynthesizer({ university, courseName, syllabusText, examFormatDetails, topics, attachments });
  }
  const usageStart = captureUsageTotals();
  try {
    const messages = plannerSyllabus({ university, courseName, syllabusText, examFormatDetails, topics });
    const { result } = await courseV2LLMCaller({
      stage: STAGES.PLANNER,
      messages,
      allowWeb: true,
      maxTokens: 1800,
      attachments,
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
  const usageStart = captureUsageTotals();
  try {
    if (!syllabus?.topic_graph?.nodes || syllabus.topic_graph.nodes.length < 4) {
      throw new Error('Syllabus topic graph missing required nodes for module planning');
    }

    const systemPrompt = plannerModules();
    const userContent = `Topic graph:
${stringifyForPrompt(syllabus.topic_graph)}

Outcomes:
${stringifyForPrompt(syllabus.outcomes)}

Task: Propose 6-10 modules covering all nodes.`;

    const candidates = [];
    for (let i = 0; i < 3; i += 1) {
      const { result } = await courseV2LLMCaller({
        stage: STAGES.PLANNER,
        messages: [...systemPrompt, { role: 'user', content: userContent }],
        maxTokens: 1600,
      });
      const candidate = tryParseJson(result?.content);
      if (candidate) {
        candidates.push(candidate);
      }
    }

    if (candidates.length === 0) {
      throw new Error('Module planning produced no valid candidates');
    }

    const selectorMessages = [
      ...selectorModules(),
      {
        role: 'user',
        content: `Candidates:
${stringifyForPrompt(candidates)}

Choose or merge into the best single module plan JSON.`,
      },
    ];

    const { result: selected } = await courseV2LLMCaller({
      stage: STAGES.SELECTOR,
      messages: selectorMessages,
      maxTokens: 1600,
    });

    const parsed = ModulesSchema.safeParse(tryParseJson(selected?.content));
    if (parsed.success) {
      const normalizedPlan = ensureModulePlanHasModules(parsed.data, syllabus);
      validateModuleCoverage(normalizedPlan, syllabus);
      return normalizedPlan;
    }

    const repairMessages = [
      { role: 'system', content: 'You repair JSON module plans to satisfy schema exactly. Return ONLY corrected JSON.' },
      {
        role: 'user',
        content: `Validation failed: ${parsed.error.toString()}
Topic graph: ${stringifyForPrompt(syllabus.topic_graph)}
Original: ${selected?.content ?? ''}`,
      },
    ];

    const { result: repaired } = await courseV2LLMCaller({
      stage: STAGES.SELECTOR,
      messages: repairMessages,
      maxTokens: 1400,
    });

    const repairedParsed = ModulesSchema.safeParse(tryParseJson(repaired?.content));
    if (!repairedParsed.success) {
      throw new Error(`Module plan failed validation: ${repairedParsed.error.toString()}`);
    }

    const repairedPlan = ensureModulePlanHasModules(repairedParsed.data, syllabus);
    validateModuleCoverage(repairedPlan, syllabus);
    return repairedPlan;
  } finally {
    logStageUsage('MODULES', usageStart);
  }
}

export async function designLessons(modules, syllabus) {
  const usageStart = captureUsageTotals();
  try {
    if (!modules?.modules || modules.modules.length === 0) {
      throw new Error('Modules required to design lessons');
    }

    const nodeMap = new Map((syllabus.topic_graph.nodes || []).map((node) => [node.id, node]));
    const lessons = [];

    for (const module of modules.modules) {
      const relatedNodes = (module.covers_nodes || [])
        .map((nodeId) => nodeMap.get(nodeId))
        .filter(Boolean);
      const primaryPrompt = buildModuleLessonPrompt(module, relatedNodes);
      const { result } = await courseV2LLMCaller({
        stage: STAGES.WRITER,
        messages: primaryPrompt,
        maxTokens: 2000,
        allowWeb: true,
      });

      let moduleLessons = normalizeLessonsOutput(tryParseJson(result?.content), module.id);

      if (moduleLessons.length === 0) {
        console.warn(`[courseV2][LESSONS] Lesson generation parse/empty for module ${module.id}; retrying with correction prompt.`);
        var correctionPrompt = buildModuleLessonPrompt(
          module,
          relatedNodes,
          'The previous output was invalid JSON or contained zero lessons. Return ONLY a JSON array (or {"lessons": [...]}) of lessons for this module with all required fields (id, moduleId, title, objectives, duration_min, reading[], activities[], bridge_from[], bridge_to[], cross_refs[]). No commentary, markdown, or extra text.',
        );
        const { result: retryResult } = await courseV2LLMCaller({
          stage: STAGES.WRITER,
          messages: correctionPrompt,
          maxTokens: 1600,
          allowWeb: false,
        });
        moduleLessons = normalizeLessonsOutput(tryParseJson(retryResult?.content), module.id);
      }

      if (moduleLessons.length === 0) {
        const fallbackModel = nextFallback(0);
        if (fallbackModel) {
          console.warn(`[courseV2][LESSONS] Lesson generation parse/empty for module ${module.id} persisted; trying fallback model ${fallbackModel}.`);
          const { result: altResult } = await courseV2LLMCaller({
            stage: STAGES.WRITER,
            messages: correctionPrompt,
            maxTokens: 1600,
            allowWeb: false,
            modelOverride: fallbackModel,
          });
          const altLessons = normalizeLessonsOutput(tryParseJson(altResult?.content), module.id);
          if (altLessons.length > 0) {
            lessons.push(...altLessons);
            continue;
          }
        }
        console.warn(`[courseV2][LESSONS] Lesson generation returned no lessons for module ${module.id}; using fallback.`);
        const fallback = buildFallbackLessons(modules, syllabus, [module.id]);
        lessons.push(...fallback.lessons);
        continue;
      }

      lessons.push(...moduleLessons);
    }

    const lessonsPayload = { lessons };
    let parsed = LessonsSchema.safeParse(lessonsPayload);
    if (!parsed.success) {
      const repairMessages = [
        { role: 'system', content: 'You fix lesson JSON to satisfy schema. Return ONLY corrected JSON.' },
        {
          role: 'user',
          content: `Validation failed: ${parsed.error.toString()}
Modules: ${stringifyForPrompt(modules)}
Original lessons: ${stringifyForPrompt(lessonsPayload)}`,
        },
      ];

      const { result: repaired } = await courseV2LLMCaller({
        stage: STAGES.WRITER,
        messages: repairMessages,
        maxTokens: 1800,
      });

      const repairedRaw = tryParseJson(repaired?.content);
      const repairedPayload = normalizeLessonsContainer(repairedRaw);
      parsed = LessonsSchema.safeParse(repairedPayload);
    }

    if (!parsed.success || parsed.data.lessons.length < 6) {
      const reason = parsed.success
        ? 'too few lessons'
        : parsed.error.toString();
      console.warn(`[courseV2][LESSONS] Lesson plan invalid after repair (${reason}); using fallback lessons.`);
      const fallback = buildFallbackLessons(modules, syllabus);
      parsed = { success: true, data: fallback };
    }

    try {
      enforceLessonConstraints(parsed.data, modules);
      return parsed.data;
    } catch (error) {
      console.warn('[courseV2][LESSONS] Lesson constraint enforcement failed:', error?.message || error);
      const errMsg = error?.message || '';
      let patchedLessons = parsed.data.lessons;
      let constraintFixed = false;
      // Handle lesson count per module constraints
      const countMatch = errMsg.match(/Module\s+([^ ]+)\s+must have between 2 and 4 lessons \(found (\d+)\)/);
      if (countMatch) {
        const moduleId = countMatch[1];
        const foundCount = Number(countMatch[2] || 0);
        if (foundCount < 2) {
          console.warn(`[courseV2][LESSONS] Adding fallback lessons to module ${moduleId} to reach minimum lessons.`);
          try {
            const fixPlan = buildFallbackLessons(modules, syllabus, [moduleId]);
            const newLessons = fixPlan.lessons || [];
            const existingLessons = patchedLessons.filter(lesson => lesson.moduleId === moduleId);
            if (existingLessons.length === 1 && newLessons.length > 0) {
              // add one fallback lesson
              patchedLessons.push(newLessons[0]);
            } else if (existingLessons.length === 0) {
              // add all fallback lessons (at least 2)
              patchedLessons = patchedLessons.concat(newLessons);
            }
            constraintFixed = true;
          } catch (e) {
            console.error('[courseV2][LESSONS] Failed to build fallback lessons for module', moduleId, e);
          }
        } else if (foundCount > 4) {
          console.warn(`[courseV2][LESSONS] Removing extra lessons from module ${moduleId} to meet maximum allowed.`);
          const moduleLessons = patchedLessons.filter(lesson => lesson.moduleId === moduleId);
          if (moduleLessons.length > 4) {
            const extraLessons = moduleLessons.slice(4);
            const extraIds = new Set(extraLessons.map(l => l.id));
            patchedLessons = patchedLessons.filter(lesson => !(lesson.moduleId === moduleId && extraIds.has(lesson.id)));
          }
          constraintFixed = true;
        }
      }
      // Handle other constraints: adjust lesson durations if out of range
      if (/duration_min must be ~40-60/.test(errMsg)) {
        patchedLessons.forEach(lesson => {
          if (lesson.duration_min < 35) lesson.duration_min = 40;
          if (lesson.duration_min > 70) lesson.duration_min = 60;
        });
        constraintFixed = true;
      }
      // If any fix applied, try enforcing again
      if (constraintFixed) {
        try {
          const patchedPayload = { lessons: patchedLessons };
          enforceLessonConstraints(patchedPayload, modules);
          return patchedPayload;
        } catch (finalError) {
          console.warn('[courseV2][LESSONS] Lesson constraint enforcement failed after patch, using fallback lessons:', finalError);
        }
      }
      // If unable to fix or fixes still not passing constraints, fallback on deterministic lessons
      const fallbackAll = buildFallbackLessons(modules, syllabus);
      const validatedFallback = LessonsSchema.parse(fallbackAll);
      enforceLessonConstraints(validatedFallback, modules);
      return validatedFallback;
    }
  } finally {
    logStageUsage('LESSONS', usageStart);
  }
}

export async function generateAssessments(modules, lessons, syllabus) {
  const usageStart = captureUsageTotals();
  try {
    if (!modules?.modules || modules.modules.length === 0) {
      throw new Error('Modules required to generate assessments');
    }
    if (!lessons?.lessons || lessons.lessons.length === 0) {
      throw new Error('Lessons required to generate assessments');
    }
    if (!Array.isArray(syllabus?.outcomes) || syllabus.outcomes.length === 0) {
      throw new Error('Syllabus outcomes required to generate assessments');
    }

    const lessonsByModule = modules.modules.map((module) => ({
      moduleId: module.id,
      moduleTitle: module.title,
      lessons: lessons.lessons
        .filter((lesson) => lesson.moduleId === module.id)
        .map((lesson) => ({ id: lesson.id, title: lesson.title })),
    }));

    const messages = [
      ...assessorAssessments(),
      {
        role: 'user',
        content: `Course outcomes:
${stringifyForPrompt(syllabus.outcomes)}

Modules:
${stringifyForPrompt(modules.modules)}

Lessons grouped by module:
${stringifyForPrompt(lessonsByModule)}

Requirements:
- Provide weekly_quizzes with moduleId referencing modules and 3-6 items each.
- Each quiz item must include anchors referencing lesson IDs or topic node IDs.
- Include a capstone project and an exam blueprint aligned to outcomes.
Return ONLY JSON.`,
      },
    ];

    const { result } = await courseV2LLMCaller({
      stage: STAGES.ASSESSOR,
      messages,
      maxTokens: 3000,
      allowWeb: false,
    });

    const rawAssessments = tryParseJson(result?.content);
    let parsed = AssessmentsSchema.safeParse(rawAssessments);
    let structuralError = null;

    if (parsed.success) {
      try {
        enforceAssessmentConstraints(parsed.data, modules, lessons, syllabus);
      } catch (error) {
        structuralError = error;
      }
    }

    if (!parsed.success || structuralError) {
      const validationMessage = parsed.success ? structuralError?.message ?? 'Custom assessment validation failed.' : parsed.error.toString();
      const repairMessages = [
        { role: 'system', content: 'You fix assessment JSON to satisfy schema and requirements exactly. Return ONLY corrected JSON.' },
        {
          role: 'user',
          content: `Validation failed: ${validationMessage}
Course outcomes: ${stringifyForPrompt(syllabus.outcomes)}
Modules: ${stringifyForPrompt(modules.modules)}
Lessons grouped by module: ${stringifyForPrompt(lessonsByModule)}
Original JSON: ${stringifyForPrompt(rawAssessments)}`,
        },
      ];

      let repairOutcome = await attemptAssessmentRepair({ repairMessages, modules, lessons, syllabus });

      if (!repairOutcome.success) {
        const fallbackModel = nextFallback(0);
        if (fallbackModel) {
          console.warn('[courseV2][ASSESSMENTS] Assessment repair failed, trying fallback model.');
          repairOutcome = await attemptAssessmentRepair({
            repairMessages,
            modules,
            lessons,
            syllabus,
            modelOverride: fallbackModel,
          });
        }
      }

      if (!repairOutcome.success) {
        const errorMessage = repairOutcome.error?.toString?.() || 'Assessment repair failed validation.';
        throw new Error(`Assessment generation failed validation: ${errorMessage}`);
      }

      return repairOutcome.data;
    }

    return parsed.data;
  } finally {
    logStageUsage('ASSESSMENTS', usageStart);
  }
}

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
