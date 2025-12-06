import { getSupabase } from '../supabaseClient.js';
import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { v4 as uuidv4 } from 'uuid';
import {
  regenerateReading,
  regenerateQuiz,
  regenerateFlashcards,
  generateVideoSelection,
  generateReading,
  generateQuiz,
  generateFlashcards,
} from './courseContent.js';

/**
 * Restructure log entry for tracking Gemini decisions and worker executions
 */
class RestructureLog {
  constructor(courseId, userId, prompt) {
    this.courseId = courseId;
    this.userId = userId;
    this.prompt = prompt;
    this.startTime = Date.now();
    this.geminiPlan = null;
    this.operations = [];
    this.workerExecutions = [];
  }

  logGeminiPlan(plan) {
    this.geminiPlan = {
      timestamp: new Date().toISOString(),
      plan,
    };
    console.log(`[Restructure] Gemini Plan for course ${this.courseId}:`);
    console.log(JSON.stringify(plan, null, 2));
  }

  logOperation(type, details) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      ...details,
    };
    this.operations.push(entry);
    console.log(`[Restructure] Operation: ${type}`, JSON.stringify(details));
  }

  logWorkerExecution(lessonId, lessonTitle, contentType, instruction, status, error = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      lessonId,
      lessonTitle,
      contentType,
      instruction,
      status,
      error,
    };
    this.workerExecutions.push(entry);
    const statusEmoji = status === 'success' ? '✓' : status === 'skipped' ? '○' : '✗';
    console.log(`[Restructure Worker] ${statusEmoji} ${lessonTitle} - ${contentType}: ${status}${error ? ` (${error})` : ''}`);
  }

  getSummary() {
    return {
      courseId: this.courseId,
      userId: this.userId,
      prompt: this.prompt,
      durationMs: Date.now() - this.startTime,
      geminiPlan: this.geminiPlan,
      operationCount: this.operations.length,
      operations: this.operations,
      workerExecutions: this.workerExecutions,
      stats: {
        modulesAdded: this.operations.filter(o => o.type === 'add_module').length,
        modulesRemoved: this.operations.filter(o => o.type === 'remove_module').length,
        lessonsAdded: this.operations.filter(o => o.type === 'add_lesson').length,
        lessonsRemoved: this.operations.filter(o => o.type === 'remove_lesson').length,
        lessonsEdited: this.operations.filter(o => o.type === 'edit_lesson').length,
        workerSuccesses: this.workerExecutions.filter(w => w.status === 'success').length,
        workerFailures: this.workerExecutions.filter(w => w.status === 'failed').length,
      },
    };
  }
}

/**
 * Restructures a course based on a user prompt.
 * Supports: adding/removing modules, adding/removing lessons, editing lesson content.
 * 
 * @param {string} courseId 
 * @param {string} userId 
 * @param {string} prompt - The user's instruction for what to change.
 * @param {string[]} initialAffectedLessonIds - Optional list of lesson IDs the user already identified.
 */
export async function restructureCourse(courseId, userId, prompt, initialAffectedLessonIds = []) {
  const supabase = getSupabase();
  const log = new RestructureLog(courseId, userId, prompt);

  // 1. Fetch Course Structure
  const { data: nodes, error } = await supabase
    .schema('api')
    .from('course_nodes')
    .select('id, title, description, content_payload, module_ref, estimated_minutes, bloom_level')
    .eq('course_id', courseId)
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to fetch course nodes: ${error.message}`);

  const { data: course } = await supabase
    .schema('api')
    .from('courses')
    .select('title, metadata')
    .eq('id', courseId)
    .single();

  const courseTitle = course?.title || 'Course';
  const courseMode = course?.metadata?.mode || 'deep';

  // Build module structure from existing nodes
  const moduleMap = new Map();
  for (const node of nodes || []) {
    const moduleRef = node.module_ref || 'Unassigned';
    if (!moduleMap.has(moduleRef)) {
      moduleMap.set(moduleRef, []);
    }
    moduleMap.get(moduleRef).push(node);
  }

  const courseStructure = {
    modules: Array.from(moduleMap.entries()).map(([name, lessons]) => ({
      name,
      lessons: lessons.map(l => ({
        id: l.id,
        title: l.title,
        description: l.description,
        has_content: !!(l.content_payload?.reading || l.content_payload?.quiz),
      })),
    })),
  };

  // 2. Ask Gemini to create a restructuring plan
  const planSystemPrompt = `You are the Course Architect. Your job is to analyze a course restructuring request and create a detailed execution plan.
  RETURN JSON ONLY. DO NOT Return Markdown. DO NOT return any preamble or explanation text.

Current Course: "${courseTitle}"
Current Structure:
${JSON.stringify(courseStructure, null, 2)}

User Request: "${prompt}"
User Suggested Lesson IDs: ${JSON.stringify(initialAffectedLessonIds)}

You must return a JSON plan with the following structure:
{
  "reasoning": "Your analysis of what needs to change and why",
  "operations": [
    {
      "type": "add_module",
      "module_name": "New Module Name",
      "position": "after:ExistingModuleName" | "before:ExistingModuleName" | "start" | "end",
      "lessons": [
        {
          "title": "Lesson Title",
          "description": "Brief description",
          "content_plan": "What the lesson should cover"
        }
      ]
    },
    {
      "type": "remove_module",
      "module_name": "Module to Remove"
    },
    {
      "type": "add_lesson",
      "module_name": "Target Module",
      "position": "after:LessonId" | "before:LessonId" | "start" | "end",
      "lesson": {
        "title": "New Lesson Title",
        "description": "Brief description",
        "content_plan": "What to cover"
      }
    },
    {
      "type": "remove_lesson",
      "lesson_id": "uuid-of-lesson-to-remove"
    },
    {
      "type": "edit_lesson",
      "lesson_id": "uuid",
      "changes": {
        "title": "New title (optional)",
        "description": "New description (optional)",
        "reading": "Specific instruction for reading changes",
        "quiz": "Specific instruction for quiz changes",
        "flashcards": "Specific instruction for flashcard changes",
        "video": ["new search query 1", "new search query 2"]
      }
    }
  ]
}

IMPORTANT:
- Only include operations that are needed to satisfy the user's request
- For edit_lesson, only include the content types that need changing
- Be specific in your change instructions so worker models know exactly what to do
- Ensure lesson IDs reference actual existing lessons when editing/removing`;

  const { result: planResult } = await callStageLLM({
    stage: STAGES.LESSON_ARCHITECT,
    maxTokens: 8192,
    messages: [
      { role: 'system', content: planSystemPrompt },
      { role: 'user', content: 'Create the restructuring plan based on the user request.' }
    ],
    responseFormat: { type: 'json_object' },
    userId,
    courseId,
    source: 'course_restructure_plan',
  });

  let plan;
  try {
    const cleanJson = planResult.content
      .replace(/^```json\s*/, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '')
      .trim();
    plan = JSON.parse(cleanJson);
  } catch (e) {
    throw new Error(`Failed to parse Lesson Architect restructure plan: ${e.message}`);
  }

  log.logGeminiPlan(plan);

  if (!plan.operations || !Array.isArray(plan.operations) || plan.operations.length === 0) {
    return { 
      success: true, 
      message: 'No changes needed.',
      log: log.getSummary(),
    };
  }

  // 3. Execute each operation
  const results = [];
  const validNodeIds = new Set((nodes || []).map(n => n.id));

  const CONCURRENCY_LIMIT = 20;

  const opResults = await runWithConcurrency(plan.operations, CONCURRENCY_LIMIT, async (operation) => {
    try {
      switch (operation.type) {
        case 'add_module':
          await executeAddModule(supabase, courseId, userId, courseTitle, courseMode, operation, log);
          break;

        case 'remove_module':
          await executeRemoveModule(supabase, courseId, userId, operation, log);
          break;

        case 'add_lesson':
          await executeAddLesson(supabase, courseId, userId, courseTitle, courseMode, operation, log);
          break;

        case 'remove_lesson':
          if (validNodeIds.has(operation.lesson_id)) {
            await executeRemoveLesson(supabase, courseId, userId, operation, log);
          } else {
            log.logOperation('remove_lesson', { lesson_id: operation.lesson_id, status: 'skipped', reason: 'invalid_id' });
          }
          break;

        case 'edit_lesson':
          if (validNodeIds.has(operation.lesson_id)) {
            const node = nodes.find(n => n.id === operation.lesson_id);
            await executeEditLesson(supabase, courseId, userId, courseTitle, node, operation, log);
          } else {
            log.logOperation('edit_lesson', { lesson_id: operation.lesson_id, status: 'skipped', reason: 'invalid_id' });
          }
          break;

        default:
          log.logOperation('unknown', { type: operation.type, status: 'skipped' });
      }
      return { operation: operation.type, status: 'completed' };
    } catch (opError) {
      console.error(`[Restructure] Operation failed:`, operation.type, opError);
      log.logOperation(operation.type, { status: 'failed', error: opError.message });
      return { operation: operation.type, status: 'failed', error: opError.message };
    }
  });

  opResults.forEach(r => {
    if (r.status === 'fulfilled') {
      results.push(r.value);
    } else {
      results.push({ operation: 'unknown', status: 'failed', error: r.reason?.message });
    }
  });

  const summary = log.getSummary();
  console.log(`[Restructure] Complete. Duration: ${summary.durationMs}ms, Operations: ${summary.operationCount}`);

  return { 
    success: true, 
    results,
    log: summary,
  };
}

/**
 * Execute add_module operation
 */
async function executeAddModule(supabase, courseId, userId, courseTitle, courseMode, operation, log) {
  const { module_name, lessons = [] } = operation;
  const nowIso = new Date().toISOString();

  log.logOperation('add_module', { module_name, lessonCount: lessons.length });

  await runWithConcurrency(lessons, 20, async (lessonSpec) => {
    const lessonId = uuidv4();
    
    // Generate content for the new lesson
    log.logWorkerExecution(lessonId, lessonSpec.title, 'reading', lessonSpec.content_plan, 'started');
    
    let reading = null;
    let quiz = null;
    let flashcards = null;

    try {
      const readingResult = await generateReading(
        lessonSpec.title,
        lessonSpec.content_plan,
        courseTitle,
        module_name,
        [],
        courseMode,
        userId,
        courseId
      );
      reading = readingResult.data;
      log.logWorkerExecution(lessonId, lessonSpec.title, 'reading', lessonSpec.content_plan, 'success');
    } catch (e) {
      log.logWorkerExecution(lessonId, lessonSpec.title, 'reading', lessonSpec.content_plan, 'failed', e.message);
    }

    try {
      const quizResult = await generateQuiz(
        lessonSpec.title,
        lessonSpec.content_plan,
        courseTitle,
        module_name,
        [],
        courseMode,
        userId,
        courseId
      );
      quiz = quizResult.data;
      log.logWorkerExecution(lessonId, lessonSpec.title, 'quiz', lessonSpec.content_plan, 'success');
    } catch (e) {
      log.logWorkerExecution(lessonId, lessonSpec.title, 'quiz', lessonSpec.content_plan, 'failed', e.message);
    }

    try {
      const flashcardsResult = await generateFlashcards(
        lessonSpec.title,
        lessonSpec.content_plan,
        courseTitle,
        module_name,
        userId,
        courseId
      );
      flashcards = flashcardsResult.data;
      log.logWorkerExecution(lessonId, lessonSpec.title, 'flashcards', lessonSpec.content_plan, 'success');
    } catch (e) {
      log.logWorkerExecution(lessonId, lessonSpec.title, 'flashcards', lessonSpec.content_plan, 'failed', e.message);
    }

    // Insert the new lesson node
    const { error: insertError } = await supabase
      .schema('api')
      .from('course_nodes')
      .insert({
        id: lessonId,
        course_id: courseId,
        user_id: userId,
        title: lessonSpec.title,
        description: lessonSpec.description || lessonSpec.content_plan,
        module_ref: module_name,
        content_payload: {
          status: 'ready',
          reading,
          quiz,
          flashcards,
        },
        created_at: nowIso,
        updated_at: nowIso,
      });

    if (insertError) {
      throw new Error(`Failed to insert lesson "${lessonSpec.title}": ${insertError.message}`);
    }

    // Initialize user_node_state
    await supabase
      .schema('api')
      .from('user_node_state')
      .insert({
        course_id: courseId,
        node_id: lessonId,
        user_id: userId,
        confidence_score: 0.1,
        familiarity_score: 0.1,
      });
  });
}

/**
 * Execute remove_module operation
 */
async function executeRemoveModule(supabase, courseId, userId, operation, log) {
  const { module_name } = operation;

  // Find all lessons in this module
  const { data: moduleLessons, error: fetchError } = await supabase
    .schema('api')
    .from('course_nodes')
    .select('id, title')
    .eq('course_id', courseId)
    .eq('user_id', userId)
    .eq('module_ref', module_name);

  if (fetchError) {
    throw new Error(`Failed to fetch lessons for module "${module_name}": ${fetchError.message}`);
  }

  log.logOperation('remove_module', { 
    module_name, 
    lessonCount: moduleLessons?.length || 0,
    lessons: moduleLessons?.map(l => l.title) || [],
  });

  if (!moduleLessons || moduleLessons.length === 0) {
    return;
  }

  const lessonIds = moduleLessons.map(l => l.id);

  // Delete user_node_state entries
  await supabase
    .schema('api')
    .from('user_node_state')
    .delete()
    .in('node_id', lessonIds);

  // Delete node_dependencies
  await supabase
    .schema('api')
    .from('node_dependencies')
    .delete()
    .or(`parent_id.in.(${lessonIds.join(',')}),child_id.in.(${lessonIds.join(',')})`);

  // Delete the lessons
  const { error: deleteError } = await supabase
    .schema('api')
    .from('course_nodes')
    .delete()
    .in('id', lessonIds);

  if (deleteError) {
    throw new Error(`Failed to delete module lessons: ${deleteError.message}`);
  }
}

/**
 * Execute add_lesson operation
 */
async function executeAddLesson(supabase, courseId, userId, courseTitle, courseMode, operation, log) {
  const { module_name, lesson } = operation;
  const lessonId = uuidv4();
  const nowIso = new Date().toISOString();

  log.logOperation('add_lesson', { module_name, lesson_title: lesson.title });

  let reading = null;
  let quiz = null;
  let flashcards = null;

  try {
    const readingResult = await generateReading(
      lesson.title,
      lesson.content_plan,
      courseTitle,
      module_name,
      [],
      courseMode,
      userId,
      courseId
    );
    reading = readingResult.data;
    log.logWorkerExecution(lessonId, lesson.title, 'reading', lesson.content_plan, 'success');
  } catch (e) {
    log.logWorkerExecution(lessonId, lesson.title, 'reading', lesson.content_plan, 'failed', e.message);
  }

  try {
    const quizResult = await generateQuiz(
      lesson.title,
      lesson.content_plan,
      courseTitle,
      module_name,
      [],
      courseMode,
      userId,
      courseId
    );
    quiz = quizResult.data;
    log.logWorkerExecution(lessonId, lesson.title, 'quiz', lesson.content_plan, 'success');
  } catch (e) {
    log.logWorkerExecution(lessonId, lesson.title, 'quiz', lesson.content_plan, 'failed', e.message);
  }

  try {
    const flashcardsResult = await generateFlashcards(
      lesson.title,
      lesson.content_plan,
      courseTitle,
      module_name,
      userId,
      courseId
    );
    flashcards = flashcardsResult.data;
    log.logWorkerExecution(lessonId, lesson.title, 'flashcards', lesson.content_plan, 'success');
  } catch (e) {
    log.logWorkerExecution(lessonId, lesson.title, 'flashcards', lesson.content_plan, 'failed', e.message);
  }

  const { error: insertError } = await supabase
    .schema('api')
    .from('course_nodes')
    .insert({
      id: lessonId,
      course_id: courseId,
      user_id: userId,
      title: lesson.title,
      description: lesson.description || lesson.content_plan,
      module_ref: module_name,
      content_payload: {
        status: 'ready',
        reading,
        quiz,
        flashcards,
      },
      created_at: nowIso,
      updated_at: nowIso,
    });

  if (insertError) {
    throw new Error(`Failed to insert lesson "${lesson.title}": ${insertError.message}`);
  }

  await supabase
    .schema('api')
    .from('user_node_state')
    .insert({
      course_id: courseId,
      node_id: lessonId,
      user_id: userId,
      confidence_score: 0.1,
      familiarity_score: 0.1,
    });
}

/**
 * Execute remove_lesson operation
 */
async function executeRemoveLesson(supabase, courseId, userId, operation, log) {
  const { lesson_id } = operation;

  // Fetch lesson info for logging
  const { data: lesson } = await supabase
    .schema('api')
    .from('course_nodes')
    .select('title, module_ref')
    .eq('id', lesson_id)
    .single();

  log.logOperation('remove_lesson', { 
    lesson_id, 
    lesson_title: lesson?.title,
    module: lesson?.module_ref,
  });

  // Delete user_node_state
  await supabase
    .schema('api')
    .from('user_node_state')
    .delete()
    .eq('node_id', lesson_id);

  // Delete node_dependencies
  await supabase
    .schema('api')
    .from('node_dependencies')
    .delete()
    .or(`parent_id.eq.${lesson_id},child_id.eq.${lesson_id}`);

  // Delete the lesson
  const { error: deleteError } = await supabase
    .schema('api')
    .from('course_nodes')
    .delete()
    .eq('id', lesson_id);

  if (deleteError) {
    throw new Error(`Failed to delete lesson: ${deleteError.message}`);
  }
}

/**
 * Execute edit_lesson operation
 */
async function executeEditLesson(supabase, courseId, userId, courseTitle, node, operation, log) {
  const { lesson_id, changes } = operation;
  const payload = node.content_payload || {};
  const newPayload = { ...payload };
  let updated = false;

  log.logOperation('edit_lesson', { 
    lesson_id, 
    lesson_title: node.title,
    changes_requested: Object.keys(changes || {}),
  });

  // Update title/description if specified
  const updateFields = {};
  if (changes.title) updateFields.title = changes.title;
  if (changes.description) updateFields.description = changes.description;

  // Reading changes
  if (changes.reading && payload.reading) {
    log.logWorkerExecution(lesson_id, node.title, 'reading', changes.reading, 'started');
    try {
      const res = await regenerateReading(
        node.title, 
        payload.reading, 
        changes.reading, 
        courseTitle, 
        node.module_ref, 
        [], 
        userId, 
        courseId
      );
      newPayload.reading = res.data;
      updated = true;
      log.logWorkerExecution(lesson_id, node.title, 'reading', changes.reading, 'success');
    } catch (e) {
      log.logWorkerExecution(lesson_id, node.title, 'reading', changes.reading, 'failed', e.message);
    }
  }

  // Quiz changes
  if (changes.quiz && payload.quiz) {
    log.logWorkerExecution(lesson_id, node.title, 'quiz', changes.quiz, 'started');
    try {
      const res = await regenerateQuiz(
        node.title, 
        payload.quiz, 
        changes.quiz, 
        courseTitle, 
        node.module_ref, 
        [], 
        userId, 
        courseId
      );
      newPayload.quiz = res.data;
      updated = true;
      log.logWorkerExecution(lesson_id, node.title, 'quiz', changes.quiz, 'success');
    } catch (e) {
      log.logWorkerExecution(lesson_id, node.title, 'quiz', changes.quiz, 'failed', e.message);
    }
  }

  // Flashcard changes
  if (changes.flashcards && payload.flashcards) {
    log.logWorkerExecution(lesson_id, node.title, 'flashcards', changes.flashcards, 'started');
    try {
      const res = await regenerateFlashcards(
        node.title, 
        payload.flashcards, 
        changes.flashcards, 
        courseTitle, 
        node.module_ref, 
        userId, 
        courseId
      );
      newPayload.flashcards = res.data;
      updated = true;
      log.logWorkerExecution(lesson_id, node.title, 'flashcards', changes.flashcards, 'success');
    } catch (e) {
      log.logWorkerExecution(lesson_id, node.title, 'flashcards', changes.flashcards, 'failed', e.message);
    }
  }

  // Video changes
  if (changes.video && Array.isArray(changes.video) && changes.video.length > 0) {
    log.logWorkerExecution(lesson_id, node.title, 'video', changes.video.join(', '), 'started');
    try {
      const res = await generateVideoSelection(changes.video, userId, courseId);
      newPayload.video = res.videos;
      newPayload.video_logs = res.logs;
      updated = true;
      log.logWorkerExecution(lesson_id, node.title, 'video', changes.video.join(', '), 'success');
    } catch (e) {
      log.logWorkerExecution(lesson_id, node.title, 'video', changes.video.join(', '), 'failed', e.message);
    }
  }

  // Persist changes
  if (updated || Object.keys(updateFields).length > 0) {
    const { error: updateError } = await supabase
      .schema('api')
      .from('course_nodes')
      .update({
        ...updateFields,
        content_payload: newPayload,
        updated_at: new Date().toISOString(),
      })
      .eq('id', lesson_id);

    if (updateError) {
      throw new Error(`Failed to update lesson: ${updateError.message}`);
    }
  }
}

async function runWithConcurrency(items, limit, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let index = 0;

  async function next() {
    const currentIndex = index;
    index += 1;
    if (currentIndex >= items.length) return;
    try {
      const value = await worker(items[currentIndex], currentIndex);
      results[currentIndex] = { status: 'fulfilled', value };
    } catch (error) {
      results[currentIndex] = { status: 'rejected', reason: error };
    }
    return next();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}
