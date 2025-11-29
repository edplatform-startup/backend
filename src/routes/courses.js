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

const router = Router();

router.get('/:id/plan', async (req, res) => {
  const { id } = req.params;
  const { userId } = req.query;

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  try {
    const plan = await generateStudyPlan(id, userId);
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
    return res.json({
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
    });
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
    });

    return res.status(200).json({
      success: true,
      overviewTopics: result.overviewTopics,
      model: result.model,
    });
  } catch (err) {
    console.error('[topics] hierarchical topic generation error:', err);
    return res.status(502).json({
      error: 'Failed to generate topics for this course. Please try again or adjust your inputs.',
    });
  }
});

import { generateLessonGraph } from '../services/courseGenerator.js';

import { convertFilesToPdf } from '../services/examConverter.js';
import { uploadExamFile } from '../services/storage.js';

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
    let examFileUrl = null;
    if (parsedInputs.examFiles && parsedInputs.examFiles.length > 0) {
      try {
        console.log(`[courses] Converting ${parsedInputs.examFiles.length} exam files to PDF...`);
        const pdfBuffer = await convertFilesToPdf(parsedInputs.examFiles);
        
        console.log(`[courses] Uploading converted PDF for course ${courseId}...`);
        examFileUrl = await uploadExamFile(courseId, userId, pdfBuffer, 'exam_bundle.pdf');
        console.log(`[courses] Exam file uploaded: ${examFileUrl}`);

        // Update the course row with the new exam file URL
        if (examFileUrl) {
          const attachmentText = `\n\n**Attached Exam File**: [View PDF](${examFileUrl})`;
          combinedExamDetails = combinedExamDetails ? combinedExamDetails + attachmentText : attachmentText;
          
          await supabase
            .schema('api')
            .from('courses')
            .update({ exam_details: combinedExamDetails })
            .eq('id', courseId)
            .eq('user_id', userId);
        }
      } catch (err) {
        console.error('[courses] Failed to convert/upload exam files:', err);
        // We continue without the file, but log the error
      }
    }

    const { finalNodes, finalEdges } = await generateLessonGraph(grok_draft, user_confidence_map || {});

    const persistResult = await saveCourseStructure(courseId, userId, { finalNodes, finalEdges });
    const workerResult = await generateCourseContent(courseId);

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
      examFileUrl, // Return this for client confirmation if needed
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

    return res.json({ success: true, courseId });
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

export default router;
