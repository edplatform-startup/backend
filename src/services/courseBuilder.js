import { generateCourseV2 } from './courseV2.js';
import { generateAssetsContent } from './courseAssets.js';

let customCourseBuilder = null;

export function setCourseBuilder(fn) {
  customCourseBuilder = typeof fn === 'function' ? fn : null;
}

export function clearCourseBuilder() {
  customCourseBuilder = null;
}

function summarizeModule(module, lessons = []) {
  const lessonTitles = lessons.map((lesson) => lesson.title).filter(Boolean);
  const parts = [];
  if (Array.isArray(module?.outcomes) && module.outcomes.length > 0) {
    parts.push(`Outcomes: ${module.outcomes.join(', ')}`);
  }
  if (lessonTitles.length > 0) {
    parts.push(`Lessons: ${lessonTitles.join('; ')}`);
  }
  if (Array.isArray(module?.covers_nodes) && module.covers_nodes.length > 0) {
    parts.push(`Nodes: ${module.covers_nodes.join(', ')}`);
  }
  const detail = parts.join(' | ');
  return detail || `Deep dive into ${module?.title || module?.id || 'this module'}`;
}

export function buildAssetPlanFromCourse(course) {
  const modules = Array.isArray(course?.modules?.modules) ? course.modules.modules : [];
  const lessons = Array.isArray(course?.lessons?.lessons) ? course.lessons.lessons : [];
  const lessonsByModule = new Map();
  for (const lesson of lessons) {
    if (!lesson || typeof lesson !== 'object') continue;
    const moduleId = lesson.moduleId;
    if (!moduleId) continue;
    if (!lessonsByModule.has(moduleId)) {
      lessonsByModule.set(moduleId, []);
    }
    lessonsByModule.get(moduleId).push(lesson);
  }

  const plan = {};
  modules.forEach((module, index) => {
    if (!module || typeof module !== 'object') return;
    const moduleKey = module.title || module.id || `Module ${index + 1}`;
    const summary = summarizeModule(module, lessonsByModule.get(module.id) || []);

    plan[moduleKey] = [
      { Format: 'video', content: `Produce a concise walkthrough for ${moduleKey}. ${summary}` },
      { Format: 'reading', content: `Write an applied reading for ${moduleKey}. ${summary}` },
      { Format: 'flashcards', content: `Generate spaced-repetition flashcards for ${moduleKey}. ${summary}` },
      { Format: 'mini quiz', content: `Author active-recall quiz items for ${moduleKey}. ${summary}` },
      { Format: 'practice exam', content: `Create integrative exam practice covering ${moduleKey}. ${summary}` },
    ];
  });

  return plan;
}

export async function generateCoursePackageWithAssets(options = {}) {
  if (customCourseBuilder) {
    return await customCourseBuilder(options);
  }

  const {
    courseSelection,
    userPrefs,
    topics,
    topicFamiliarity,
    syllabusText,
    examFormatDetails,
    attachments,
    finishByDate,
    supabase,
    courseId,
    userId,
    className,
    apiKey,
  } = options;

  const course = await generateCourseV2({
    courseSelection,
    userPrefs,
    topics,
    topicFamiliarity,
    syllabusText,
    examFormatDetails,
    attachments,
    finishByDate,
  });

  const assetPlan = buildAssetPlanFromCourse(course);
  const assets = await generateAssetsContent(assetPlan, {
    supabase,
    userId,
    courseId,
    className,
    examFormatDetails,
    apiKey,
    topicFamiliarity,
  });

  return { course, assets };
}
