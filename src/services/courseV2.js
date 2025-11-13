import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
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
  AssessmentsSchema,
  CoursePackageSchema,
} from '../schemas/courseV2.js';

const READING_WPM = Number(process.env.READING_WPM || 220);
const DEFAULT_MIN = {
  guided_example: Number(process.env.DEFAULT_ACTIVITY_MIN_GUIDED_EXAMPLE || 12),
  problem_set: Number(process.env.DEFAULT_ACTIVITY_MIN_PROBLEM_SET || 25),
  discussion: Number(process.env.DEFAULT_ACTIVITY_MIN_DISCUSSION || 10),
};

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

let customCourseGenerator = null;

export function setCourseV2Generator(fn) {
  customCourseGenerator = typeof fn === 'function' ? fn : null;
}

export function clearCourseV2Generator() {
  customCourseGenerator = null;
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

function validateModuleCoverage(modulesPlan, syllabus) {
  if (!modulesPlan?.modules || modulesPlan.modules.length < 6 || modulesPlan.modules.length > 10) {
    throw new Error('Module plan must include between 6 and 10 modules.');
  }

  const nodeIds = new Set((syllabus.topic_graph.nodes || []).map((node) => node.id));
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

export async function synthesizeSyllabus({ university, courseName }) {
  const usageStart = captureUsageTotals();
  try {
    const messages = plannerSyllabus(university, courseName);
    const { result } = await callStageLLM({
      stage: STAGES.PLANNER,
      messages,
      allowWeb: true,
      maxTokens: 1800,
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

    const { result: repairedResult } = await callStageLLM({
      stage: STAGES.PLANNER,
      messages: criticMessages,
      allowWeb: false,
      maxTokens: 1500,
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
      const { result } = await callStageLLM({
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

    const { result: selected } = await callStageLLM({
      stage: STAGES.SELECTOR,
      messages: selectorMessages,
      maxTokens: 1600,
    });

    const parsed = ModulesSchema.safeParse(tryParseJson(selected?.content));
    if (parsed.success) {
      validateModuleCoverage(parsed.data, syllabus);
      return parsed.data;
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

    const { result: repaired } = await callStageLLM({
      stage: STAGES.SELECTOR,
      messages: repairMessages,
      maxTokens: 1400,
    });

    const repairedParsed = ModulesSchema.safeParse(tryParseJson(repaired?.content));
    if (!repairedParsed.success) {
      throw new Error(`Module plan failed validation: ${repairedParsed.error.toString()}`);
    }

    validateModuleCoverage(repairedParsed.data, syllabus);
    return repairedParsed.data;
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

      const modulePrompt = [
        ...writerLessons(),
        {
          role: 'user',
          content: `Module:
${stringifyForPrompt(module)}

Related nodes (with summaries):
${stringifyForPrompt(relatedNodes)}

Requirements:
- Produce 2-4 lessons for this module.
- Duration 40-60 minutes each.
- Each lesson references readings (<=3) with credible URLs.
- Include activities referencing allowed types.
- Ensure objectives align with module outcomes.
Return ONLY JSON lessons array for this module.`,
        },
      ];

      const { result } = await callStageLLM({
        stage: STAGES.WRITER,
        messages: modulePrompt,
        maxTokens: 2000,
        allowWeb: true,
      });

      const parsedLessons = tryParseJson(result?.content);
      const moduleLessons = normalizeLessonsOutput(parsedLessons, module.id);
      if (moduleLessons.length === 0) {
        throw new Error(`Lesson generation returned no lessons for module ${module.id}`);
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

      const { result: repaired } = await callStageLLM({
        stage: STAGES.WRITER,
        messages: repairMessages,
        maxTokens: 1800,
      });

      const repairedRaw = tryParseJson(repaired?.content);
      const repairedPayload = normalizeLessonsContainer(repairedRaw);
      parsed = LessonsSchema.safeParse(repairedPayload);
      if (!parsed.success) {
        throw new Error(`Lesson design failed validation: ${parsed.error.toString()}`);
      }
    }

    enforceLessonConstraints(parsed.data, modules);
    return parsed.data;
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

    const { result } = await callStageLLM({
      stage: STAGES.ASSESSOR,
      messages,
      maxTokens: 2200,
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

      const { result: repaired } = await callStageLLM({
        stage: STAGES.ASSESSOR,
        messages: repairMessages,
        maxTokens: 2000,
      });

      const repairedRaw = tryParseJson(repaired?.content);
      parsed = AssessmentsSchema.safeParse(repairedRaw);
      if (!parsed.success) {
        throw new Error(`Assessment generation failed validation: ${parsed.error.toString()}`);
      }
      enforceAssessmentConstraints(parsed.data, modules, lessons, syllabus);
    }

    return parsed.data;
  } finally {
    logStageUsage('ASSESSMENTS', usageStart);
  }
}

export function crossLink(course) {
  if (!course || !Array.isArray(course?.modules?.modules) || !Array.isArray(course?.lessons?.lessons)) {
    return course;
  }

  const modulesArr = course.modules.modules;
  const lessonsArr = course.lessons.lessons;
  if (modulesArr.length === 0 || lessonsArr.length === 0) {
    return course;
  }

  const moduleIndexById = new Map();
  const moduleNodes = new Map();
  modulesArr.forEach((module, index) => {
    if (!module || !module.id) return;
    moduleIndexById.set(module.id, index);
    moduleNodes.set(module.id, new Set(Array.isArray(module.covers_nodes) ? module.covers_nodes : []));
  });

  const lessonsByModule = new Map();
  modulesArr.forEach((module) => {
    if (module?.id) lessonsByModule.set(module.id, []);
  });
  lessonsArr.forEach((lesson) => {
    const bucket = lessonsByModule.get(lesson.moduleId);
    if (bucket) bucket.push(lesson);
  });

  const topicNodeTitleById = new Map();
  (course.syllabus?.topic_graph?.nodes || []).forEach((node) => {
    if (node?.id) {
      topicNodeTitleById.set(node.id, node.title || node.id);
    }
  });

  const updatedLessons = lessonsArr.map((lesson) => {
    const moduleId = lesson.moduleId;
    const moduleIdx = moduleIndexById.get(moduleId);
    if (moduleIdx == null) {
      const { deduped, changed } = dedupeCrossRefsWithSeen(lesson.cross_refs);
      return changed ? { ...lesson, cross_refs: deduped } : lesson;
    }

    const currentNodes = moduleNodes.get(moduleId);
    if (!currentNodes || currentNodes.size === 0) {
      const { deduped, changed } = dedupeCrossRefsWithSeen(lesson.cross_refs);
      if (!changed) return lesson;
      return { ...lesson, cross_refs: deduped };
    }

    const { deduped: baseCrossRefs, seen, changed: crossRefChanged } = dedupeCrossRefsWithSeen(lesson.cross_refs);
    const additions = [];

    for (let i = 0; i < moduleIdx; i += 1) {
      const earlierModule = modulesArr[i];
      if (!earlierModule?.id) continue;
      const earlierNodes = moduleNodes.get(earlierModule.id);
      if (!earlierNodes || earlierNodes.size === 0) continue;

      const sharedNodeId = findFirstIntersection(currentNodes, earlierNodes);
      if (!sharedNodeId) continue;

      const sharedNodeTitle = topicNodeTitleById.get(sharedNodeId) || 'a prerequisite topic';
      const priorLessons = lessonsByModule.get(earlierModule.id) || [];

      for (const priorLesson of priorLessons) {
        const targetId = priorLesson?.id;
        if (!targetId || targetId === lesson.id || seen.has(targetId)) continue;
        additions.push({
          toLessonId: targetId,
          reason: `prior exposure to ${sharedNodeTitle}`,
        });
        seen.add(targetId);
      }
    }

    if (additions.length === 0 && !crossRefChanged) {
      return lesson;
    }

    const newCrossRefs = [...baseCrossRefs, ...additions];
    return { ...lesson, cross_refs: newCrossRefs };
  });

  return {
    ...course,
    lessons: {
      ...course.lessons,
      lessons: updatedLessons,
    },
  };
}

function dedupeCrossRefsWithSeen(crossRefs) {
  const seen = new Set();
  if (!Array.isArray(crossRefs)) {
    return { deduped: [], seen, changed: Boolean(crossRefs) };
  }

  const deduped = [];
  let changed = false;
  for (const ref of crossRefs) {
    if (!ref || typeof ref !== 'object') {
      changed = true;
      continue;
    }
    const target = ref.toLessonId;
    if (!target) {
      changed = true;
      continue;
    }
    if (seen.has(target)) {
      changed = true;
      continue;
    }
    seen.add(target);
    deduped.push(ref);
  }
  if (deduped.length !== crossRefs.length) {
    changed = true;
  }
  return { deduped, seen, changed };
}

function findFirstIntersection(setA, setB) {
  for (const value of setA) {
    if (setB.has(value)) return value;
  }
  return null;
}

function applyCoursePatch(course, patch) {
  if (!patch || typeof patch !== 'object') {
    return course;
  }

  const cloned = { ...course };

  if (patch.syllabus && typeof patch.syllabus === 'object') {
    cloned.syllabus = mergeObjects(course.syllabus, patch.syllabus);
  }
  if (patch.modules && typeof patch.modules === 'object') {
    cloned.modules = mergeObjects(course.modules, patch.modules);
  }
  if (patch.lessons && typeof patch.lessons === 'object') {
    cloned.lessons = mergeObjects(course.lessons, patch.lessons);
  }
  if (patch.assessments && typeof patch.assessments === 'object') {
    cloned.assessments = mergeObjects(course.assessments, patch.assessments);
  }

  return cloned;
}

function mergeObjects(original, patch) {
  if (!original || typeof original !== 'object') {
    return original;
  }
  const result = { ...original };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!(key in original)) continue;
    if (Array.isArray(original[key]) && Array.isArray(value)) {
      result[key] = value;
    } else if (
      original[key] && typeof original[key] === 'object' &&
      value && typeof value === 'object' && !Array.isArray(value)
    ) {
      result[key] = mergeObjects(original[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function validateFullCourse(course) {
  SyllabusSchema.parse(course.syllabus);
  ModulesSchema.parse(course.modules);
  LessonsSchema.parse(course.lessons);
  AssessmentsSchema.parse(course.assessments);
}

export async function criticAndRepair(course) {
  const usageStart = captureUsageTotals();
  try {
    if (!course) {
      return course;
    }

    const payload = {
      syllabus: course.syllabus,
      modules: course.modules,
      lessons: course.lessons,
      assessments: course.assessments,
    };

    const courseMessage = stringifyForPrompt(payload);
    const messages = [
      ...criticCourse(),
      {
        role: 'user',
        content: `Course package JSON:
${courseMessage}

Return critique with minimal revision_patch adhering to schemas.`,
      },
    ];

    const { result } = await callStageLLM({
      stage: STAGES.CRITIC,
      messages,
      maxTokens: 2000,
    });

    const parsed = tryParseJson(result?.content);
    if (!parsed || typeof parsed !== 'object') {
      return course;
    }

    const revisionPatch = parsed.revision_patch;
    if (!revisionPatch || typeof revisionPatch !== 'object') {
      return course;
    }

    const patchedCourse = applyCoursePatch(course, revisionPatch);

    try {
      validateFullCourse(patchedCourse);
      return patchedCourse;
    } catch (error) {
      console.warn('[courseV2] Critic patch rejected:', error?.message || error);
      return course;
    }
  } finally {
    logStageUsage('CRITIC', usageStart);
  }
}

export function packageCourse(course) {
  if (!course) {
    throw new Error('Cannot package undefined course');
  }

  const lessons = Array.isArray(course?.lessons?.lessons) ? course.lessons.lessons : [];
  let readingTime = 0;
  let practiceTime = 0;

  for (const lesson of lessons) {
    const readingEntries = Array.isArray(lesson?.reading) ? lesson.reading : [];
    for (const reading of readingEntries) {
      if (reading && typeof reading === 'object') {
        const est = Number.isInteger(reading?.est_min) ? reading.est_min : 12;
        readingTime += est;
      } else {
        readingTime += 12;
      }
    }

    const activities = Array.isArray(lesson?.activities) ? lesson.activities : [];
    for (const activity of activities) {
      if (!activity || typeof activity !== 'object') continue;
      switch (activity.type) {
        case 'guided_example':
          practiceTime += DEFAULT_MIN.guided_example;
          break;
        case 'problem_set':
          practiceTime += DEFAULT_MIN.problem_set;
          break;
        case 'discussion':
          practiceTime += DEFAULT_MIN.discussion;
          break;
        case 'project_work':
          practiceTime += DEFAULT_MIN.problem_set;
          break;
        default:
          break;
      }
    }
  }

  const videoTime = 0;
  const study_time_min = {
    reading: readingTime,
    video: videoTime,
    practice: practiceTime,
    total: readingTime + videoTime + practiceTime,
  };

  const packaged = {
    syllabus: course.syllabus,
    modules: course.modules,
    lessons: course.lessons,
    assessments: course.assessments,
    study_time_min,
  };

  return CoursePackageSchema.parse(packaged);
}

export async function generateCourseV2(courseSelection, userPrefs = {}) {
  if (customCourseGenerator) {
    const result = await customCourseGenerator(courseSelection, userPrefs);
    return CoursePackageSchema.parse(result);
  }
  const { college: university, title: courseName } = courseSelection || {};
  const syllabus = await synthesizeSyllabus({ university, courseName });
  const modules = await planModulesFromGraph(syllabus);
  const lessons = await designLessons(modules, syllabus);
  const assessments = await generateAssessments(modules, lessons, syllabus);
  let course = { syllabus, modules, lessons, assessments };
  course = crossLink(course);
  course = await criticAndRepair(course);
  const packaged = packageCourse(course);
  return CoursePackageSchema.parse(packaged);
}
