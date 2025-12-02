import { getSupabase } from '../supabaseClient.js';
import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import {
  regenerateReading,
  regenerateQuiz,
  regenerateFlashcards,
  regeneratePracticeExam,
  generateVideoSelection
} from './courseContent.js';

/**
 * Restructures specific lessons in a course based on a user prompt.
 * 
 * @param {string} courseId 
 * @param {string} userId 
 * @param {string} prompt - The user's instruction for what to change.
 * @param {string[]} initialAffectedLessonIds - Optional list of lesson IDs the user already identified.
 */
export async function restructureCourse(courseId, userId, prompt, initialAffectedLessonIds = []) {
  const supabase = getSupabase();

  // 1. Fetch Course Structure
  const { data: nodes, error } = await supabase
    .schema('api')
    .from('course_nodes')
    .select('id, title, description, content_payload, module_ref')
    .eq('course_id', courseId)
    .eq('user_id', userId);

  if (error) throw new Error(`Failed to fetch course nodes: ${error.message}`);
  if (!nodes || nodes.length === 0) throw new Error('Course has no nodes');

  const { data: course } = await supabase
    .schema('api')
    .from('courses')
    .select('title')
    .eq('id', courseId)
    .single();
    
  const courseTitle = course?.title || 'Course';

  // 2. Identify Lessons to Change (Gemini 3 Pro via Lesson Architect stage)
  // We pass the list of all lessons and the user's prompt.
  const nodeSummaries = nodes.map(n => ({ id: n.id, title: n.title, module: n.module_ref }));
  
  const selectionSystemPrompt = `You are the Course Architect. 
The user wants to restructure/modify the course based on a prompt.
You have a list of existing lessons.
Your task is to identify WHICH lessons need to be modified to satisfy the user's request.
The user may have already suggested some lessons, but you should add any others that are logically affected.

User Prompt: "${prompt}"
User Suggested IDs: ${JSON.stringify(initialAffectedLessonIds)}

Return JSON:
{
  "affected_lesson_ids": ["id1", "id2", ...]
}
Include ALL lessons that need modification (including the user's suggestions if valid).`;

  const selectionUserPrompt = `Course Structure:
${JSON.stringify(nodeSummaries)}

Identify all lessons that need to change.`;

  const { result: selectionResult } = await callStageLLM({
    stage: STAGES.LESSON_ARCHITECT, // Uses a smart model (Gemini 1.5 Pro or similar)
    maxTokens: 4096,
    messages: [
      { role: 'system', content: selectionSystemPrompt },
      { role: 'user', content: selectionUserPrompt }
    ],
    responseFormat: { type: 'json_object' },
    userId,
  });

  let affectedIds = [];
  try {
    const parsed = JSON.parse(selectionResult.content);
    affectedIds = parsed.affected_lesson_ids || [];
  } catch (e) {
    // Fallback to user provided list if LLM fails
    affectedIds = initialAffectedLessonIds;
  }

  // Ensure we only have valid IDs
  const validNodeIds = new Set(nodes.map(n => n.id));
  affectedIds = affectedIds.filter(id => validNodeIds.has(id));

  if (affectedIds.length === 0) {
    return { success: true, message: 'No lessons identified for change.' };
  }

  // 3. Generate Change Instructions (Gemini 3 Pro)
  // We do this in one batch or per lesson? 
  // Doing it per lesson might be better for context window, but batch is faster.
  // Let's do it per lesson to ensure high quality instructions.
  
  const results = [];

  for (const lessonId of affectedIds) {
    const node = nodes.find(n => n.id === lessonId);
    if (!node) continue;

    const payload = node.content_payload || {};
    const currentContentSummary = {
      has_reading: !!payload.reading,
      has_quiz: !!payload.quiz,
      has_flashcards: !!payload.flashcards,
      has_video: !!payload.video && payload.video.length > 0,
      has_practice_exam: !!payload.practice_exam
    };

    const instructionSystemPrompt = `You are the Content Strategist.
The user wants to modify the lesson "${node.title}" based on the prompt: "${prompt}".
Current Content Types: ${JSON.stringify(currentContentSummary)}

Your task is to generate specific "Change Instructions" for EACH content type that needs alteration.
If a content type does not need changing, omit it.
For videos, provide a NEW search query if the video needs to change.

Return JSON ONLY (no markdown, no conversational text):
{
  "reading": "instruction string...",
  "quiz": "instruction string...",
  "flashcards": "instruction string...",
  "practice_exam": "instruction string...",
  "video": ["new query 1", "new query 2"] 
}
`;

    const { result: instructionResult } = await callStageLLM({
      stage: STAGES.LESSON_ARCHITECT,
      maxTokens: 2048,
      messages: [{ role: 'user', content: `Generate change instructions for lesson "${node.title}".` }],
      responseFormat: { type: 'json_object' },
      userId,
    });

    let changePlans = {};
    try {
      const cleanJson = instructionResult.content
        .replace(/^```json\s*/, '')
        .replace(/^```\s*/, '')
        .replace(/\s*```$/, '')
        .trim();
      changePlans = JSON.parse(cleanJson);
    } catch (e) {
      console.error(`Failed to parse change instructions for lesson ${lessonId}`, e);
      continue;
    }

    // 4. Regenerate Content (Worker Model)
    const newPayload = { ...payload };
    let updated = false;

    // Reading
    if (changePlans.reading && payload.reading) {
      try {
        const res = await regenerateReading(node.title, payload.reading, changePlans.reading, courseTitle, node.module_ref);
        newPayload.reading = res.data;
        updated = true;
      } catch (e) {
        console.error(`Failed to regenerate reading for ${lessonId}`, e);
      }
    }

    // Quiz
    if (changePlans.quiz && payload.quiz) {
      try {
        const res = await regenerateQuiz(node.title, payload.quiz, changePlans.quiz, courseTitle, node.module_ref);
        newPayload.quiz = res.data;
        updated = true;
      } catch (e) {
        console.error(`Failed to regenerate quiz for ${lessonId}`, e);
      }
    }

    // Flashcards
    if (changePlans.flashcards && payload.flashcards) {
      try {
        const res = await regenerateFlashcards(node.title, payload.flashcards, changePlans.flashcards, courseTitle, node.module_ref);
        newPayload.flashcards = res.data;
        updated = true;
      } catch (e) {
        console.error(`Failed to regenerate flashcards for ${lessonId}`, e);
      }
    }

    // Practice Exam
    if (changePlans.practice_exam && payload.practice_exam) {
      try {
        const res = await regeneratePracticeExam(node.title, payload.practice_exam, changePlans.practice_exam, courseTitle, node.module_ref);
        newPayload.practice_exam = res.data;
        updated = true;
      } catch (e) {
        console.error(`Failed to regenerate practice exam for ${lessonId}`, e);
      }
    }

    // Video
    if (changePlans.video && Array.isArray(changePlans.video) && changePlans.video.length > 0) {
      try {
        // For video, we just search again with the new query
        const res = await generateVideoSelection(changePlans.video);
        newPayload.video = res.videos;
        newPayload.video_logs = res.logs;
        updated = true;
      } catch (e) {
        console.error(`Failed to regenerate video for ${lessonId}`, e);
      }
    }

    // 5. Update DB
    if (updated) {
      const { error: updateError } = await supabase
        .schema('api')
        .from('course_nodes')
        .update({ 
          content_payload: newPayload,
          updated_at: new Date().toISOString()
        })
        .eq('id', lessonId);
        
      if (updateError) {
        console.error(`Failed to update node ${lessonId}`, updateError);
        results.push({ id: lessonId, status: 'failed', error: updateError.message });
      } else {
        results.push({ id: lessonId, status: 'updated' });
      }
    } else {
      results.push({ id: lessonId, status: 'skipped' });
    }
  }

  return { success: true, affected_lessons: affectedIds, results };
}
