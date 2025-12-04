import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { getSupabase } from '../supabaseClient.js';
import { generateHierarchicalTopics } from '../services/courseV2.js';
import {
  isValidIsoDate,
  validateFileArray,
  validateUuid,
} from '../utils/validation.js';
import { saveCourseStructure, generateCourseContent } from '../services/courseContent.js';
import { generateStudyPlan } from '../services/studyPlan.js';
import { parseSharedCourseInputs, buildAttachmentList, toTrimmedString } from '../utils/courseInputParser.js';
import { gradeExam } from '../services/examGrader.js';
import { logUsageEvent } from '../utils/analytics.js';
import multer from 'multer';

const upload = multer({
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  storage: multer.memoryStorage()
});

const router = Router();

router.get('/:id/plan', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const plan = await generateStudyPlan(id, userId);
    // Log study plan generation
    await logUsageEvent(userId, 'study_plan_generated', {
      courseId: id,
      mode: plan.mode || 'standard',
      totalModules: plan.modules?.length || 0
    });
    return res.json(plan);
  } catch (error) {
    console.error('Error generating study plan:', error);
    return res.status(500).json({ error: 'Failed to generate study plan', details: error.message });
  }
});

// Update user progress for a specific lesson
router.patch('/:courseId/nodes/:nodeId/progress', async (req, res) => {
  const { courseId, nodeId } = req.params;
  const { userId, mastery_status, familiarity_score } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  const courseValidation = validateUuid(courseId, 'courseId');
  if (!courseValidation.valid) {
    return res.status(400).json({ error: courseValidation.error });
  }

  const nodeValidation = validateUuid(nodeId, 'nodeId');
  if (!nodeValidation.valid) {
    return res.status(400).json({ error: nodeValidation.error });
  }

  // Validate mastery_status if provided
  const validStatuses = ['pending', 'mastered', 'needs_review'];
  if (mastery_status && !validStatuses.includes(mastery_status)) {
    return res.status(400).json({
      error: `mastery_status must be one of: ${validStatuses.join(', ')}`
    });
  }

  // Validate familiarity_score if provided
  if (familiarity_score !== undefined) {
    const score = parseFloat(familiarity_score);
    if (isNaN(score) || score < 0 || score > 1) {
      return res.status(400).json({ error: 'familiarity_score must be a number between 0 and 1' });
    }
  }

  try {
    const supabase = getSupabase();

    // First verify the course exists and user owns it
    const { data: courseData, error: courseError } = await supabase
      .schema('api')
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('user_id', userId)
      .single();

    if (courseError || !courseData) {
      return res.status(404).json({ error: 'Course not found or access denied' });
    }

    // Verify the node belongs to this course
    const { data: nodeData, error: nodeError } = await supabase
      .schema('api')
      .from('course_nodes')
      .select('id')
      .eq('id', nodeId)
      .eq('course_id', courseId)
      .single();

    if (nodeError || !nodeData) {
      return res.status(404).json({ error: 'Lesson not found in this course' });
    }

    // Build update object
    const updateData = {
      updated_at: new Date().toISOString()
    };

    if (mastery_status) {
      updateData.mastery_status = mastery_status;
    }

    if (familiarity_score !== undefined) {
      updateData.familiarity_score = parseFloat(familiarity_score);
    }

    // Update or insert user_node_state
    const { data: existingState, error: fetchError } = await supabase
      .schema('api')
      .from('user_node_state')
      .select('*')
      .eq('user_id', userId)
      .eq('node_id', nodeId)
      .maybeSingle();

    if (fetchError) {
      console.error('Error fetching user state:', fetchError);
      return res.status(500).json({ error: 'Failed to fetch progress data', details: fetchError.message });
    }

    let result;
    if (existingState) {
      // Update existing record
      const { data, error: updateError } = await supabase
        .schema('api')
        .from('user_node_state')
        .update(updateData)
        .eq('user_id', userId)
        .eq('node_id', nodeId)
        .select('*')
        .single();

      if (updateError) {
        console.error('Error updating progress:', updateError);
        return res.status(500).json({ error: 'Failed to update progress', details: updateError.message });
      }
      result = data;
    } else {
      // Insert new record
      const insertData = {
        user_id: userId,
        node_id: nodeId,
        mastery_status: mastery_status || 'pending',
        familiarity_score: familiarity_score !== undefined ? parseFloat(familiarity_score) : 0.1,
        created_at: new Date().toISOString(),
        ...updateData
      };

      const { data, error: insertError } = await supabase
        .schema('api')
        .from('user_node_state')
        .insert(insertData)
        .select('*')
        .single();

      if (insertError) {
        console.error('Error inserting progress:', insertError);
        return res.status(500).json({ error: 'Failed to save progress', details: insertError.message });
      }
      result = data;
    }

    // Log progress update
    await logUsageEvent(userId, 'lesson_progress_updated', {
      courseId,
      lessonId: nodeId,
      mastery: result.mastery_status,
      familiarity: result.familiarity_score
    });

    return res.json({
      success: true,
      progress: {
        user_id: result.user_id,
        node_id: result.node_id,
        mastery_status: result.mastery_status,
        familiarity_score: result.familiarity_score,
        updated_at: result.updated_at
      }
    });
  } catch (error) {
    console.error('Error updating lesson progress:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

router.get('/:courseId/nodes/:nodeId', async (req, res) => {
  const { courseId, nodeId } = req.params;
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  const courseValidation = validateUuid(courseId, 'courseId');
  if (!courseValidation.valid) {
    return res.status(400).json({ error: courseValidation.error });
  }

  const nodeValidation = validateUuid(nodeId, 'nodeId');
  if (!nodeValidation.valid) {
    return res.status(400).json({ error: nodeValidation.error });
  }

  try {
    const supabase = getSupabase();

    // First verify the user owns the course
    const { data: courseData, error: courseError } = await supabase
      .schema('api')
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('user_id', userId)
      .single();

    if (courseError) {
      if (courseError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Course not found or access denied' });
      }
      console.error('Error verifying course ownership:', courseError);
      return res.status(500).json({ error: 'Failed to verify course access', details: courseError.message });
    }

    if (!courseData) {
      return res.status(404).json({ error: 'Course not found or access denied' });
    }

    // Fetch the node with all its content
    const { data: node, error: nodeError } = await supabase
      .schema('api')
      .from('course_nodes')
      .select('*')
      .eq('id', nodeId)
      .eq('course_id', courseId)
      .single();

    if (nodeError) {
      if (nodeError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Lesson not found' });
      }
      console.error('Error fetching lesson:', nodeError);
      return res.status(500).json({ error: 'Failed to fetch lesson', details: nodeError.message });
    }

    if (!node) {
      return res.status(404).json({ error: 'Lesson not found' });
    }

    // Check if the lesson is locked based on prerequisites
    let lockStatus;
    try {
      const { checkNodeLockStatus } = await import('../services/lessonLock.js');
      lockStatus = await checkNodeLockStatus(nodeId, courseId, userId);
    } catch (lockError) {
      console.error('Error checking lock status:', lockError);
      // Don't fail the request if lock check fails, just omit the lock status
      lockStatus = { isLocked: false, prerequisites: [] };
    }

    // Return the full node data
    const response = {
      success: true,
      lesson: {
        id: node.id,
        course_id: node.course_id,
        title: node.title,
        module_ref: node.module_ref,
        estimated_minutes: node.estimated_minutes,
        bloom_level: node.bloom_level,
        intrinsic_exam_value: node.intrinsic_exam_value,
        confidence_score: node.confidence_score,
        metadata: node.metadata,
        content_payload: node.content_payload,
        is_locked: lockStatus.isLocked,
        prerequisites: lockStatus.prerequisites,
      },
    };

    // Enrich quiz questions with ID and status from the quiz_questions table
    // This applies regardless of whether format filtering is requested
    if (response.lesson.content_payload?.quiz?.length > 0) {
      const { data: dbQuestions, error: quizDbError } = await supabase
        .schema('api')
        .from('quiz_questions')
        .select('id, question, status, selected_answer')
        .eq('course_id', courseId)
        .eq('node_id', nodeId)
        .eq('user_id', userId);

      if (!quizDbError && dbQuestions) {
        // Create a map of question text to DB record for quick lookup
        const questionMap = new Map();
        dbQuestions.forEach(dbQ => {
          questionMap.set(dbQ.question, { id: dbQ.id, status: dbQ.status, selectedAnswer: dbQ.selected_answer });
        });

        // Merge the ID, status, and selectedAnswer into each quiz question
        response.lesson.content_payload.quiz = response.lesson.content_payload.quiz.map(q => {
          const dbRecord = questionMap.get(q.question);
          return {
            ...q,
            id: dbRecord?.id || null,
            status: dbRecord?.status || 'unattempted',
            selectedAnswer: dbRecord?.selectedAnswer ?? null
          };
        });
      }
    }

    // Filter content based on format if requested
    const { format } = req.query;
    if (format && response.lesson.content_payload) {
      const payload = response.lesson.content_payload;
      let filteredData = {};

      switch (format.toLowerCase()) {
        case 'video':
          // For video, return only the videos array
          filteredData = {
            videos: payload.video || [],
            // optionally include logs if needed for debugging, but user asked for "only the videos key"
            // keeping it strictly to what was asked:
            // "only thing given should be the videos key"
          };
          break;
        case 'reading':
          filteredData = { body: payload.reading };
          break;
        case 'quiz':
          // Quiz questions are already enriched with id and status above
          filteredData = { questions: payload.quiz || [] };
          break;
        case 'flashcards':
          filteredData = { cards: payload.flashcards };
          break;
        case 'practice_exam':
          filteredData = { practice_exam: payload.practice_exam };
          break;
        default:
          // If format is unknown, return everything (or handle as error? defaulting to everything is safer)
          filteredData = payload;
      }

      // Replace the full payload with the filtered one
      // The user request said: "in the attached info the only thing given should be the videos key"
      // This implies the structure should be cleaner. 
      // Let's replace content_payload with the filtered data directly or keep it under content_payload?
      // "returned info when the content endpoint is called" -> likely referring to the JSON response.
      // The user example showed:
      // { "format": "video", "data": { ... } } 
      // But the current endpoint returns { success: true, lesson: { ... } }
      // I will modify content_payload in place to contain only the filtered keys.
      response.lesson.content_payload = filteredData;
    }

    // Log lesson opened
    await logUsageEvent(userId, 'lesson_opened', {
      courseId,
      lessonId: nodeId,
      title: node.title,
      reviewType: node.metadata?.review_type || null
    });

    return res.json(response);
  } catch (error) {
    console.error('Error fetching lesson content:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

router.get('/ids', async (req, res) => {
  const { userId } = req.query;

  if (!userId) return res.status(400).json({ error: 'userId is required' });
  const v = validateUuid(userId, 'userId');
  if (!v.valid) return res.status(400).json({ error: v.error });

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .schema('api')
      .from('courses')
      .select('id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase error fetching course ids:', error);
      return res.status(500).json({ error: 'Failed to fetch course ids', details: error.message });
    }

    return res.json({ userId, count: data.length, courseIds: data.map((r) => r.id) });
  } catch (e) {
    console.error('Unhandled error fetching course ids:', e);
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

router.get('/data', async (req, res) => {
  const { userId, courseId } = req.query || {};

  if (!userId || !courseId) {
    return res.status(400).json({ error: 'Missing required query parameters: userId and courseId' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  const courseValidation = validateUuid(courseId, 'courseId');
  if (!courseValidation.valid) {
    return res.status(400).json({ error: courseValidation.error });
  }

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .schema('api')
      .from('courses')
      .select('id, user_id, title, syllabus_text, exam_details, status')
      .eq('user_id', userId)
      .eq('id', courseId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Course not found' });
      }
      console.error('Supabase error fetching course data:', error);
      return res.status(500).json({ error: 'Failed to fetch course data', details: error.message || error });
    }

    if (!data) {
      return res.status(404).json({ error: 'Course not found' });
    }

    return res.json({ success: true, course: data });
  } catch (error) {
    console.error('Unhandled error fetching course data:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

router.get('/', async (req, res) => {
  const { userId, courseId } = req.query || {};

  if (!userId) {
    return res.status(400).json({ error: 'Missing required query parameters: userId' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: 'Invalid userId format. Must be a valid UUID.' });
  }

  if (courseId) {
    const courseValidation = validateUuid(courseId, 'courseId');
    if (!courseValidation.valid) {
      return res.status(400).json({ error: courseValidation.error });
    }
  }

  try {
    const supabase = getSupabase();
    if (courseId) {
      const { data, error } = await supabase
        .schema('api')
        .from('courses')
        .select('*')
        .eq('user_id', userId)
        .eq('id', courseId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          return res.status(404).json({ error: 'Course not found' });
        }
        console.error('Supabase error fetching course:', error);
        return res.status(500).json({
          error: 'Failed to fetch course',
          details: error.message || error,
        });
      }

      if (!data) {
        return res.status(404).json({ error: 'Course not found' });
      }

      // Calculate total estimated hours from nodes
      const { data: nodes, error: nodesError } = await supabase
        .schema('api')
        .from('course_nodes')
        .select('estimated_minutes')
        .eq('course_id', courseId);

      let totalHours = 0;
      if (!nodesError && nodes) {
        const totalMinutes = nodes.reduce((sum, node) => sum + (node.estimated_minutes || 0), 0);
        totalHours = totalMinutes / 60;
      }

      return res.json({ success: true, course: { ...data, total_estimated_hours: totalHours } });
    }

    const { data, error } = await supabase
      .schema('api')
      .from('courses')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Supabase error listing courses:', error);
      return res.status(500).json({
        error: 'Failed to list courses',
        details: error.message || error,
      });
    }

    const courses = Array.isArray(data) ? data : [];

    if (courses.length > 0) {
      const courseIds = courses.map((c) => c.id);
      const { data: nodes, error: nodesError } = await supabase
        .schema('api')
        .from('course_nodes')
        .select('course_id, estimated_minutes')
        .in('course_id', courseIds);

      if (!nodesError && nodes) {
        const minutesMap = {};
        nodes.forEach((node) => {
          minutesMap[node.course_id] = (minutesMap[node.course_id] || 0) + (node.estimated_minutes || 0);
        });

        courses.forEach((course) => {
          const totalMinutes = minutesMap[course.id] || 0;
          course.total_estimated_hours = totalMinutes / 60;
        });
      }
    }

    return res.json({ success: true, count: courses.length, courses });
  } catch (error) {
    console.error('Unhandled error fetching courses:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

router.post('/topics', async (req, res) => {
  // Extract userId from body if present, or rely on shared parser if it handles it (it usually doesn't extract userId for auth purposes)
  // The shared parser parses 'req.body'. We need to ensure userId is passed.
  // Let's check if req.body has userId.
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId is required' });

  const shared = parseSharedCourseInputs(req.body || {});
  if (!shared.valid) {
    return res.status(400).json({ error: shared.error });
  }

  try {
    const selection = shared.courseSelection || {};
    const university =
      selection.college ||
      selection.university ||
      toTrimmedString(req.body?.university) ||
      null;

    const courseTitle =
      toTrimmedString(req.body?.courseTitle) ||
      toTrimmedString(req.body?.className) ||
      toTrimmedString(selection.title) ||
      'Custom course';

    const result = await generateHierarchicalTopics({
      university,
      courseTitle,
      syllabusText: shared.syllabusText,
      examFormatDetails: shared.examFormatDetails,
      attachments: shared.attachments,
      finishByDate: shared.finishByDateIso,
      mode: req.body.mode || 'deep',
    }, shared.userId);

    // Log topics generation
    // Note: userId is extracted from body above
    await logUsageEvent(userId, 'topics_generated', {
      university,
      courseTitle
    });

    const response = {
      success: true,
      overviewTopics: result.overviewTopics,
      model: result.model,
    };

    // Add RAG session ID if available (does not break existing clients)
    if (result.rag_session_id) {
      response.rag_session_id = result.rag_session_id;
    }

    return res.status(200).json(response);
  } catch (err) {
    console.error('[topics] hierarchical topic generation error:', err);
    return res.status(502).json({
      error: 'Failed to generate topics for this course. Please try again or adjust your inputs.',
    });
  }
});

import { generateLessonGraph, generateReviewModule } from '../services/courseGenerator.js';
import { restructureCourse } from '../services/courseRestructure.js';
import { generatePracticeExam } from '../services/examGenerator.js';

import { convertFilesToPdf } from '../services/examConverter.js';
import { uploadExamFile, deleteCourseFiles, getCourseExamFiles } from '../services/storage.js';

router.post('/:courseId/review-modules', async (req, res) => {
  const { courseId } = req.params;
  const { userId, topics, examType } = req.body;

  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!topics || !Array.isArray(topics) || topics.length === 0) {
    return res.status(400).json({ error: 'topics array is required' });
  }
  if (!examType || !['midterm', 'final'].includes(examType)) {
    return res.status(400).json({ error: 'examType must be "midterm" or "final"' });
  }

  try {
    // 1. Generate Structure
    const lessonGraph = await generateReviewModule(topics, examType, userId, courseId);

    // 2. Persist Structure
    await saveCourseStructure(courseId, userId, lessonGraph);

    // 3. Generate Content
    const contentResult = await generateCourseContent(courseId);

    // Log review module creation
    await logUsageEvent(userId, 'review_module_created', {
      courseId,
      examType,
      newLessons: lessonGraph.finalNodes.length
    });

    return res.json({ success: true, nodeCount: lessonGraph.finalNodes.length, contentStatus: contentResult.status });
  } catch (error) {
    console.error('Error creating review module:', error);
    return res.status(500).json({ error: 'Failed to create review module', details: error.message });
  }

});

router.post('/:courseId/restructure', async (req, res) => {
  const { courseId } = req.params;
  const { userId, prompt, lessonIds } = req.body;

  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!prompt) return res.status(400).json({ error: 'prompt is required' });

  try {
    const result = await restructureCourse(courseId, userId, prompt, lessonIds);

    // Log course restructure
    await logUsageEvent(userId, 'course_restructured', {
      courseId,
      prompt,
      affectedLessonsCount: result.affected_lessons?.length || 0
    });

    return res.json(result);
  } catch (error) {
    console.error('Error restructuring course:', error);
    return res.status(500).json({ error: 'Failed to restructure course', details: error.message });
  }
});

router.get('/:courseId/review-modules', async (req, res) => {
  const { courseId } = req.params;
  const { userId, type } = req.query;

  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const supabase = getSupabase();
    let query = supabase
      .schema('api')
      .from('course_nodes')
      .select('*')
      .eq('course_id', courseId)
      .eq('user_id', userId);

    if (type) {
      // Filter by metadata->>review_type
      // Note: Supabase JS filter for JSONB value
      query = query.eq('metadata->>review_type', type);
    } else {
      // If no type is specified, only return nodes that HAVE a review_type
      query = query.not('metadata->>review_type', 'is', null);
    }

    const { data, error } = await query;

    if (error) throw error;

    // Log review modules access
    await logUsageEvent(userId, 'review_module_accessed', {
      courseId,
      filterType: type || 'all'
    });

    return res.json({ success: true, modules: data });
  } catch (error) {
    console.error('Error fetching review modules:', error);
    return res.status(500).json({ error: 'Failed to fetch review modules', details: error.message });
  }
});

router.post('/:courseId/exams/generate', async (req, res) => {
  const { courseId } = req.params;
  const { userId, lessons, type } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  const courseValidation = validateUuid(courseId, 'courseId');
  if (!courseValidation.valid) {
    return res.status(400).json({ error: courseValidation.error });
  }

  if (!lessons || !Array.isArray(lessons) || lessons.length === 0) {
    return res.status(400).json({ error: 'lessons array is required and cannot be empty' });
  }

  if (!type || !['midterm', 'final'].includes(type)) {
    return res.status(400).json({ error: 'type must be either "midterm" or "final"' });
  }

  try {
    const result = await generatePracticeExam(courseId, userId, lessons, type);

    // Log practice exam generation
    await logUsageEvent(userId, 'practice_exam_generated', {
      courseId,
      examType: type,
      coveredLessons: lessons.length
    });

    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error generating practice exam:', error);
    return res.status(500).json({ error: 'Failed to generate practice exam', details: error.message });
  }
});

router.get('/:courseId/exams/:type', async (req, res) => {
  const { courseId, type } = req.params;
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  const courseValidation = validateUuid(courseId, 'courseId');
  if (!courseValidation.valid) {
    return res.status(400).json({ error: courseValidation.error });
  }

  if (!['midterm', 'final'].includes(type)) {
    return res.status(400).json({ error: 'type must be either "midterm" or "final"' });
  }

  try {
    const files = await getCourseExamFiles(courseId, userId);

    // Filter for exams of the requested type
    // Matches: [timestamp]_[type]_exam.pdf OR [timestamp]_[type]_exam_[number].pdf
    const typeRegex = new RegExp(`_${type}_exam(?:_(\\d+))?\\.pdf$`);

    // Fetch grades from database
    const supabase = getSupabase();
    const { data: grades, error: gradesError } = await supabase
      .schema('api')
      .from('exam_grades')
      .select('*')
      .eq('course_id', courseId)
      .eq('user_id', userId)
      .eq('exam_type', type);

    if (gradesError) {
      console.error('Error fetching exam grades:', gradesError);
      // Continue without grades if fetch fails, or throw? 
      // Better to log and continue so we at least return the files.
    }

    const exams = files
      .filter(f => typeRegex.test(f.name))
      .map(f => {
        const match = f.name.match(typeRegex);
        const number = match[1] ? parseInt(match[1], 10) : 1;

        // Find matching grade
        const grade = grades ? grades.find(g => g.exam_number === number) : null;

        return {
          name: f.name,
          url: f.url,
          number,
          grade: grade ? {
            score: grade.score,
            feedback: grade.feedback,
            topic_grades: grade.topic_grades,
            created_at: grade.created_at
          } : null
        };
      })
      .sort((a, b) => a.number - b.number);

    // Log practice exam list view
    await logUsageEvent(userId, 'practice_exam_list_viewed', {
      courseId,
      examType: type
    });

    return res.json({ success: true, exams });
  } catch (error) {
    console.error('Error fetching practice exams:', error);
    return res.status(500).json({ error: 'Failed to fetch practice exams', details: error.message });
  }
});

// POST /:courseId/grade-exam - Grade an answered exam
router.post('/:courseId/grade-exam', upload.single('input_pdf'), async (req, res) => {
  const { courseId } = req.params;
  const { userId, exam_type, exam_number } = req.body;
  const inputPdf = req.file;

  if (!userId) {
    return res.status(400).json({ error: 'Missing required fields: userId' });
  }

  if (!exam_type) {
    return res.status(400).json({ error: 'Missing required fields: exam_type' });
  }

  if (!inputPdf) {
    return res.status(400).json({ error: 'Missing input_pdf file' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  const courseValidation = validateUuid(courseId, 'courseId');
  if (!courseValidation.valid) {
    return res.status(400).json({ error: courseValidation.error });
  }

  try {
    // Default to number 1 if not provided (backward compatibility attempt, though frontend should send it)
    const number = exam_number ? parseInt(exam_number, 10) : 1;

    const gradingResult = await gradeExam(courseId, userId, exam_type, number, inputPdf.buffer);

    // Persist the grade
    const supabase = getSupabase();
    const { data: savedGrade, error: saveError } = await supabase
      .schema('api')
      .from('exam_grades')
      .insert({
        user_id: userId,
        course_id: courseId,
        exam_type: exam_type,
        exam_number: number,
        score: gradingResult.overall_score,
        feedback: gradingResult.overall_feedback,
        topic_grades: gradingResult.topic_list
      })
      .select()
      .single();

    if (saveError) {
      console.error('Error saving exam grade:', saveError);
      // We don't fail the request if saving fails, but we log it. 
      // Alternatively, we could include a warning in the response.
    }

    // Log exam graded
    await logUsageEvent(userId, 'practice_exam_graded', {
      courseId,
      examType: exam_type,
      examNumber: number,
      score: gradingResult.overall_score
    });

    res.json({
      success: true,
      ...gradingResult,
      grade_id: savedGrade ? savedGrade.id : null
    });
  } catch (error) {
    console.error('Error grading exam:', error);
    res.status(500).json({ error: 'Failed to grade exam: ' + error.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const {
      userId,
      courseId: providedCourseId,
      courseMetadata,
      grok_draft,
      user_confidence_map = {},
      syllabusText,
      syllabusFiles,
      examFormatDetails,
      examFiles,
      seconds_to_complete,
      hours,
      minutes,
      rag_session_id,
    } = req.body || {};

    let finalSecondsToComplete = seconds_to_complete;
    if (typeof finalSecondsToComplete !== 'number' && (typeof hours === 'number' || typeof minutes === 'number')) {
      const h = typeof hours === 'number' ? hours : 0;
      const m = typeof minutes === 'number' ? minutes : 0;
      finalSecondsToComplete = (h * 3600) + (m * 60);
    }

    if (!userId) {
      return res.status(400).json({ error: 'Missing required field: userId' });
    }
    const userValidation = validateUuid(userId, 'userId');
    if (!userValidation.valid) {
      return res.status(400).json({ error: userValidation.error });
    }
    if (!grok_draft || typeof grok_draft !== 'object') {
      return res.status(400).json({ error: 'Missing or invalid grok_draft' });
    }

    let courseId = providedCourseId || uuidv4();
    if (providedCourseId) {
      const courseValidation = validateUuid(providedCourseId, 'courseId');
      if (!courseValidation.valid) {
        return res.status(400).json({ error: courseValidation.error });
      }
      courseId = providedCourseId;
    }

    // Process files and text inputs using the shared utility
    const parsedInputs = parseSharedCourseInputs({
      userId,
      syllabusText,
      syllabusFiles,
      examFormatDetails,
      examFiles,
    });

    if (!parsedInputs.valid) {
      return res.status(400).json({ error: parsedInputs.error });
    }

    // --- IMMEDIATE PERSISTENCE START ---
    const supabase = getSupabase();
    const normalizedMetadata = isPlainObject(courseMetadata) ? courseMetadata : {};
    // Default mode to 'deep' if not provided
    normalizedMetadata.mode = req.body.mode || normalizedMetadata.mode || 'deep';

    const title = deriveCourseTitle(grok_draft, normalizedMetadata);

    const combinedSyllabusText = parsedInputs.syllabusText ||
      normalizedMetadata.syllabus_text ||
      normalizedMetadata.syllabusText ||
      null;

    let combinedExamDetails = parsedInputs.examFormatDetails ||
      normalizedMetadata.exam_details ||
      normalizedMetadata.examDetails ||
      null;

    const rowPayload = {
      id: courseId,
      user_id: userId,
      title,
      syllabus_text: combinedSyllabusText,
      exam_details: combinedExamDetails,
      status: 'pending',
      seconds_to_complete: typeof finalSecondsToComplete === 'number' ? finalSecondsToComplete : null,
      metadata: normalizedMetadata, // Ensure metadata (with mode) is saved
    };

    // Insert the course row immediately so it exists in "pending" state
    const { error: insertError } = await supabase
      .schema('api')
      .from('courses')
      .insert(rowPayload)
      .select('id')
      .single();

    if (insertError) {
      if (insertError.code === '23505') {
        // Handle UPSERT if ID exists
        const { error: updateError } = await supabase
          .schema('api')
          .from('courses')
          .update(rowPayload)
          .eq('id', courseId)
          .eq('user_id', userId)
          .select('id')
          .single();
        if (updateError) {
          console.error('[courses] Failed to update existing course:', updateError);
          return res.status(500).json({ error: 'Failed to persist course metadata', details: updateError.message });
        }
      } else {
        console.error('[courses] Failed to persist course row:', insertError);
        return res.status(500).json({ error: 'Failed to persist course metadata', details: insertError.message });
      }
    }
    // --- IMMEDIATE PERSISTENCE END ---

    // Handle Exam File Conversion and Upload
    const examFileUrls = [];
    if (parsedInputs.examFiles && parsedInputs.examFiles.length > 0) {
      try {
        console.log(`[courses] Converting and uploading ${parsedInputs.examFiles.length} exam files individually...`);

        // Import the new single file converter
        const { convertSingleFileToPdf } = await import('../services/examConverter.js');

        for (let i = 0; i < parsedInputs.examFiles.length; i++) {
          const file = parsedInputs.examFiles[i];
          const examNumber = i + 1;
          const fileName = `exam${examNumber}.pdf`;

          try {
            const pdfBuffer = await convertSingleFileToPdf(file);
            const examUrl = await uploadExamFile(courseId, userId, pdfBuffer, fileName);

            examFileUrls.push({ name: fileName, url: examUrl });
            console.log(`[courses] Uploaded ${fileName}: ${examUrl}`);
          } catch (fileError) {
            console.error(`[courses] Failed to convert/upload ${fileName}:`, fileError);
            // Continue with other files even if one fails
          }
        }

        // Update the course row with all exam file URLs
        if (examFileUrls.length > 0) {
          const attachmentText = '\n\n**Attached Exam Files**:\n' +
            examFileUrls.map(({ name, url }) => `- [${name}](${url})`).join('\n');
          combinedExamDetails = combinedExamDetails ? combinedExamDetails + attachmentText : attachmentText;

          await supabase
            .schema('api')
            .from('courses')
            .update({ exam_details: combinedExamDetails })
            .eq('id', courseId)
            .eq('user_id', userId);
        }
      } catch (err) {
        console.error('[courses] Failed to process exam files:', err);
        // We continue without the files, but log the error
      }
    }

    const { finalNodes, finalEdges } = await generateLessonGraph(grok_draft, user_confidence_map || {}, userId, normalizedMetadata.mode, courseId, rag_session_id || null);

    const persistResult = await saveCourseStructure(courseId, userId, { finalNodes, finalEdges });
    const workerResult = await generateCourseContent(courseId);

    // Log course creation
    await logUsageEvent(userId, 'course_created', {
      courseId,
      title,
      nodeCount: persistResult.nodeCount
    });

    return res.status(201).json({
      success: true,
      courseId,
      nodeCount: persistResult.nodeCount,
      edgeCount: persistResult.edgeCount,
      worker: workerResult,
      course_structure: {
        nodes: finalNodes,
        edges: finalEdges,
      },
      examFileUrls, // Return array of uploaded exam files
    });
  } catch (error) {
    console.error('[courses] POST / error:', error);
    return res.status(500).json({ error: 'Failed to generate course structure', details: error.message });
  }
});

router.delete('/', async (req, res) => {
  const { userId, courseId } = req.query || {};

  if (!userId || !courseId) {
    return res.status(400).json({ error: 'Missing required query parameters: userId and courseId' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  const courseValidation = validateUuid(courseId, 'courseId');
  if (!courseValidation.valid) {
    return res.status(400).json({ error: courseValidation.error });
  }

  try {
    const supabase = getSupabase();

    const { data: course, error: fetchError } = await supabase
      .schema('api')
      .from('courses')
      .select('id')
      .eq('user_id', userId)
      .eq('id', courseId)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Course not found' });
      }
      console.error('Supabase error verifying course before delete:', fetchError);
      return res.status(500).json({ error: 'Failed to verify course before delete', details: fetchError.message || fetchError });
    }

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    // Clear object storage for this course (best-effort, don't block deletion)
    const storageResult = await deleteCourseFiles(courseId, userId);
    if (storageResult.errors.length > 0) {
      console.warn('Storage cleanup warnings:', storageResult.errors);
    }

    const { error: deleteError } = await supabase
      .schema('api')
      .from('courses')
      .delete()
      .eq('user_id', userId)
      .eq('id', courseId)
      .select('id')
      .single();

    if (deleteError) {
      console.error('Supabase error deleting course:', deleteError);
      return res.status(500).json({ error: 'Failed to delete course', details: deleteError.message || deleteError });
    }

    // Log course deletion
    await logUsageEvent(userId, 'course_deleted', { courseId });

    return res.json({ success: true, courseId, storageFilesDeleted: storageResult.deleted });
  } catch (error) {
    console.error('Unhandled error deleting course:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

router.patch('/:courseId/settings', async (req, res) => {
  const { courseId } = req.params;
  const { userId, seconds_to_complete, hours, minutes } = req.body;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  const courseValidation = validateUuid(courseId, 'courseId');
  if (!courseValidation.valid) {
    return res.status(400).json({ error: courseValidation.error });
  }

  if (seconds_to_complete !== undefined && (typeof seconds_to_complete !== 'number' || seconds_to_complete < 0)) {
    return res.status(400).json({ error: 'seconds_to_complete must be a non-negative number' });
  }

  try {
    const supabase = getSupabase();

    // Verify course exists and user owns it
    const { data: course, error: fetchError } = await supabase
      .schema('api')
      .from('courses')
      .select('id')
      .eq('user_id', userId)
      .eq('id', courseId)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Course not found' });
      }
      console.error('Supabase error verifying course:', fetchError);
      return res.status(500).json({ error: 'Failed to verify course', details: fetchError.message });
    }

    if (!course) {
      return res.status(404).json({ error: 'Course not found' });
    }

    const updateData = {
      updated_at: new Date().toISOString(),
    };

    if (seconds_to_complete !== undefined) {
      updateData.seconds_to_complete = seconds_to_complete;
    } else if (typeof hours === 'number' || typeof minutes === 'number') {
      const h = typeof hours === 'number' ? hours : 0;
      const m = typeof minutes === 'number' ? minutes : 0;
      updateData.seconds_to_complete = (h * 3600) + (m * 60);
    }

    const { data: updatedCourse, error: updateError } = await supabase
      .schema('api')
      .from('courses')
      .update(updateData)
      .eq('id', courseId)
      .select('id, seconds_to_complete, updated_at')
      .single();

    if (updateError) {
      console.error('Supabase error updating course settings:', updateError);
      return res.status(500).json({ error: 'Failed to update course settings', details: updateError.message });
    }

    return res.json({
      success: true,
      settings: updatedCourse,
    });
  } catch (error) {
    console.error('Unhandled error updating course settings:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

// parseSharedCourseInputs and buildAttachmentList are imported from utils/courseInputParser.js

function normalizeTopics(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { valid: false, error: 'topics must contain at least one topic' };
  }

  const topics = value
    .map((topic) => (typeof topic === 'string' ? topic.trim() : ''))
    .filter(Boolean);

  if (topics.length === 0) {
    return { valid: false, error: 'topics must contain non-empty strings' };
  }

  return { valid: true, value: topics };
}

function normalizeTopicFamiliarity(topics, topicFamiliarity) {
  if (!Array.isArray(topics) || topics.length === 0) {
    return { valid: false, error: 'topics are required before computing familiarity' };
  }

  if (!topicFamiliarity) {
    return { valid: true, value: [] };
  }

  const topicSet = new Set(topics);
  const normalized = new Map();

  const coerceFamiliarity = (rawValue, topic) => {
    if (typeof rawValue === 'string') {
      return { value: rawValue.trim() };
    }

    if (rawValue && typeof rawValue === 'object') {
      const candidate =
        typeof rawValue.familiarity === 'string'
          ? rawValue.familiarity.trim()
          : typeof rawValue.level === 'string'
            ? rawValue.level.trim()
            : typeof rawValue.value === 'string'
              ? rawValue.value.trim()
              : '';

      if (candidate) {
        return { value: candidate };
      }
    }

    return { error: `topicFamiliarity entry for "${topic}" must be a string (e.g. "beginner", "expert")` };
  };

  const assignFamiliarity = (topicName, rawValue) => {
    if (typeof topicName !== 'string' || !topicName.trim()) {
      return { error: 'topicFamiliarity entries must include a non-empty topic name' };
    }

    const normalizedTopic = topicName.trim();

    if (!topicSet.has(normalizedTopic)) {
      return { error: `topicFamiliarity includes unknown topic "${normalizedTopic}"` };
    }

    const { value, error } = coerceFamiliarity(rawValue, normalizedTopic);
    if (error) {
      return { error };
    }

    normalized.set(normalizedTopic, value);
    return { value };
  };

  if (Array.isArray(topicFamiliarity)) {
    for (let i = 0; i < topicFamiliarity.length; i += 1) {
      const entry = topicFamiliarity[i];
      if (!entry || typeof entry !== 'object') {
        return { valid: false, error: 'topicFamiliarity array entries must be objects' };
      }

      const topicName = typeof entry.topic === 'string' ? entry.topic : entry.name;
      const rawValue = entry.familiarity ?? entry.level ?? entry.value ?? entry.familiarityLevel;
      const { error } = assignFamiliarity(topicName, rawValue);
      if (error) {
        return { valid: false, error };
      }
    }
  } else if (typeof topicFamiliarity === 'object') {
    for (const [topicName, rawValue] of Object.entries(topicFamiliarity)) {
      const { error } = assignFamiliarity(topicName, rawValue);
      if (error) {
        return { valid: false, error };
      }
    }
  } else {
    return {
      valid: false,
      error: 'topicFamiliarity must be an object mapping topics to familiarity levels or an array of { topic, familiarity }',
    };
  }

  const result = Array.from(normalized.entries()).map(([topic, familiarity]) => ({ topic, familiarity }));
  return { valid: true, value: result };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function coerceDateOnly(value) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().split('T')[0];
}

function deriveCourseTitle(grokDraft, metadata) {
  if (metadata && typeof metadata.title === 'string' && metadata.title.trim()) {
    return metadata.title.trim();
  }
  if (metadata && typeof metadata.courseTitle === 'string' && metadata.courseTitle.trim()) {
    return metadata.courseTitle.trim();
  }
  if (grokDraft && typeof grokDraft.course_title === 'string' && grokDraft.course_title.trim()) {
    return grokDraft.course_title.trim();
  }
  if (grokDraft && typeof grokDraft.title === 'string' && grokDraft.title.trim()) {
    return grokDraft.title.trim();
  }
  return 'Generated course';
}


// GET /:courseId/questions
router.get('/:courseId/questions', async (req, res) => {
  const { courseId } = req.params;
  const { userId, correctness, attempted, lessons } = req.query;

  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const supabase = getSupabase();
    let query = supabase
      .schema('api')
      .from('quiz_questions')
      .select('*')
      .eq('course_id', courseId)
      .eq('user_id', userId);

    if (correctness) {
      // Support filtering for review: 'incorrect' and 'correct/flag' are both "needs review"
      if (correctness === 'needs_review') {
        query = query.in('status', ['incorrect', 'correct/flag']);
      } else {
        query = query.eq('status', correctness);
      }
    }

    if (attempted === 'true') {
      query = query.neq('status', 'unattempted');
    }

    if (lessons) {
      const lessonIds = lessons.split(',');
      query = query.in('node_id', lessonIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ success: true, questions: data });
  } catch (error) {
    console.error('Error fetching questions:', error);
    return res.status(500).json({ error: 'Failed to fetch questions', details: error.message });
  }
});

// PATCH /:courseId/questions
router.patch('/:courseId/questions', async (req, res) => {
  const { courseId } = req.params;
  const { userId, updates } = req.body; // updates: [{ id, status, selectedAnswer }]

  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'updates array is required' });

  // Valid status values
  const validStatuses = ['correct', 'incorrect', 'correct/flag', 'unattempted'];

  try {
    const supabase = getSupabase();

    // Verify course access
    const { data: courseAccess } = await supabase.schema('api').from('courses').select('id').eq('id', courseId).eq('user_id', userId).single();
    if (!courseAccess) return res.status(403).json({ error: 'Access denied' });

    const results = [];
    const errors = [];

    for (const update of updates) {
      const { id, status, selectedAnswer } = update;
      if (!id) {
        errors.push({ id, error: 'Missing id' });
        continue;
      }

      // Validate status if provided
      if (status !== undefined && !validStatuses.includes(status)) {
        errors.push({ id, error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
        continue;
      }

      // Build update object dynamically
      const updateData = { updated_at: new Date().toISOString() };
      if (status !== undefined) {
        updateData.status = status;
      }
      if (selectedAnswer !== undefined) {
        updateData.selected_answer = selectedAnswer;
      }

      // Must have at least one field to update besides updated_at
      if (status === undefined && selectedAnswer === undefined) {
        errors.push({ id, error: 'Missing status or selectedAnswer' });
        continue;
      }

      const { data, error } = await supabase
        .schema('api')
        .from('quiz_questions')
        .update(updateData)
        .eq('id', id)
        .eq('course_id', courseId)
        .eq('user_id', userId)
        .select();

      if (error) {
        errors.push({ id, error: error.message });
      } else if (!data || data.length === 0) {
        errors.push({ id, error: 'Question not found or access denied' });
      } else {
        results.push(data[0]);
      }
    }

    return res.json({ success: true, updated: results.length, results, errors });
  } catch (error) {
    console.error('Error updating questions:', error);
    return res.status(500).json({ error: 'Failed to update questions', details: error.message });
  }
});

// GET /:courseId/flashcards
router.get('/:courseId/flashcards', async (req, res) => {
  const { courseId } = req.params;
  const { userId, current_timestamp, lessons } = req.query;

  if (!userId) return res.status(400).json({ error: 'userId is required' });

  try {
    const supabase = getSupabase();
    let query = supabase
      .schema('api')
      .from('flashcards')
      .select('*')
      .eq('course_id', courseId)
      .eq('user_id', userId);

    if (current_timestamp) {
      query = query.lt('next_show_timestamp', current_timestamp);
    }

    if (lessons) {
      const lessonIds = lessons.split(',');
      query = query.in('node_id', lessonIds);
    }

    const { data, error } = await query;
    if (error) throw error;

    return res.json({ success: true, flashcards: data });
  } catch (error) {
    console.error('Error fetching flashcards:', error);
    return res.status(500).json({ error: 'Failed to fetch flashcards', details: error.message });
  }
});

// PATCH /:courseId/flashcards
router.patch('/:courseId/flashcards', async (req, res) => {
  const { courseId } = req.params;
  const { userId, updates } = req.body; // updates: [{ id, next_show_timestamp }]

  if (!userId) return res.status(400).json({ error: 'userId is required' });
  if (!updates || !Array.isArray(updates)) return res.status(400).json({ error: 'updates array is required' });

  try {
    const supabase = getSupabase();

    // Verify course access
    const { data: courseAccess } = await supabase.schema('api').from('courses').select('id').eq('id', courseId).eq('user_id', userId).single();
    if (!courseAccess) return res.status(403).json({ error: 'Access denied' });

    const results = [];
    const errors = [];

    await Promise.all(updates.map(async (update) => {
      const { id, next_show_timestamp } = update;
      if (!id || !next_show_timestamp) return;

      const { data, error } = await supabase
        .schema('api')
        .from('flashcards')
        .update({ next_show_timestamp, updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('course_id', courseId)
        .eq('user_id', userId)
        .select();

      if (error) errors.push({ id, error: error.message });
      else results.push(data[0]);
    }));

    return res.json({ success: true, updated: results.length, errors });
  } catch (error) {
    console.error('Error updating flashcards:', error);
    return res.status(500).json({ error: 'Failed to update flashcards', details: error.message });
  }
});

export default router;
