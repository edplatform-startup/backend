import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { generateStudyTopics, parseTopicsText } from '../services/grokClient.js';
import {
  isValidIsoDate,
  validateFileArray,
  validateUuid,
} from '../utils/validation.js';

const router = Router();
// GET /courses/ids?userId=...
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

// GET /courses/data?userId=...&courseId=...
router.get('/data', async (req, res) => {
  const { userId, courseId } = req.query;
  if (!userId || !courseId) {
    return res.status(400).json({ error: 'userId and courseId are required' });
  }
  const v1 = validateUuid(userId, 'userId');
  if (!v1.valid) return res.status(400).json({ error: v1.error });
  const v2 = validateUuid(courseId, 'courseId');
  if (!v2.valid) return res.status(400).json({ error: v2.error });

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .schema('api')
      .from('courses')
      .select('id,user_id,course_data')
      .eq('id', courseId)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return res.status(404).json({ error: 'Course not found for user' });
      }
      console.error('Supabase error fetching course_data:', error);
      return res.status(500).json({ error: 'Failed to fetch course_data', details: error.message });
    }

    return res.json({ courseId: data.id, userId: data.user_id, course_data: data.course_data });
  } catch (e) {
    console.error('Unhandled error fetching course_data:', e);
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

// Use Grok 4 Fast for topic generation to minimize cost and latency
const MODEL_NAME = 'x-ai/grok-4-fast';

function normalizeCourseRow(row) {
  const courseData = row.course_data ?? row.course_json ?? null;
  const normalizedUserId = row.user_id ?? row.user_id ?? null;
  const normalizedUserUuid = row.user_id ?? row.user_id ?? null;
  return {
    id: row.id,
    user_id: normalizedUserId,
    user_id: normalizedUserUuid,
    course_data: courseData,
    course_json: courseData,
    created_at: row.created_at,
    finish_by_date: row.finish_by_date ?? null,
    course_selection: row.course_selection ?? null,
    syllabus_text: row.syllabus_text ?? null,
    syllabus_files: Array.isArray(row.syllabus_files) ? row.syllabus_files : [],
    exam_format_details: row.exam_format_details ?? null,
    exam_files: Array.isArray(row.exam_files) ? row.exam_files : [],
  };
}

// GET /courses?userId=xxx OR /courses?userId=xxx&courseId=yyy
// Query parameters: userId (required if courseId not provided), courseId (optional, requires userId)
router.get('/', async (req, res) => {
  const { userId, courseId } = req.query;

  // Validate that at least one parameter is provided
  if (!userId && !courseId) {
    return res.status(400).json({ 
      error: 'Missing required query parameters. Provide at least userId or both userId and courseId.' 
    });
  }

  // If courseId is provided, userId must also be provided
  if (courseId && !userId) {
    return res.status(400).json({ 
      error: 'userId is required when courseId is provided.' 
    });
  }

  // Validate UUID format
  if (userId) {
    const validation = validateUuid(userId, 'userId');
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid userId format. Must be a valid UUID.' });
    }
  }

  if (courseId) {
    const validation = validateUuid(courseId, 'courseId');
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid courseId format. Must be a valid UUID.' });
    }
  }

  try {
    const supabase = getSupabase();
    let query = supabase.schema('api').from('courses').select('*');

    // Case 1: Both userId and courseId provided - get specific course if it belongs to user
    if (userId && courseId) {
      query = query.eq('id', courseId).or(`user_id.eq.${userId},user_id.eq.${userId}`).single();
      
      const { data, error } = await query;

      if (error) {
        if (error.code === 'PGRST116') {
          // No rows returned
          return res.status(404).json({ 
            error: 'Course not found or does not belong to this user.' 
          });
        }
        console.error('Supabase error fetching course:', error);
        return res.status(500).json({ error: 'Failed to fetch course', details: error.message });
      }

      return res.json({
        success: true,
        course: normalizeCourseRow(data)
      });
    }

    // Case 2: Only userId provided - get all courses for this user
    if (userId) {
      query = query.or(`user_id.eq.${userId},user_id.eq.${userId}`).order('created_at', { ascending: false });
      
      const { data, error } = await query;

      if (error) {
        console.error('Supabase error fetching courses:', error);
        return res.status(500).json({ error: 'Failed to fetch courses', details: error.message });
      }

      return res.json({
        success: true,
        count: data.length,
        courses: data.map(normalizeCourseRow)
      });
    }
  } catch (e) {
    console.error('Unhandled error fetching courses:', e);
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

// POST /courses
// Body: {
//   userId: "user-uuid-string",
//   finishByDate?: string,
//   university?: string,
//   courseTitle?: string,
//   syllabusText?: string,
//   syllabusFiles?: [],
//   examFormatDetails?: string,
//   examFiles?: []
// }
router.post('/', async (req, res) => {
  const {
    userId,
    finishByDate,
    university,
    courseTitle,
    syllabusText,
    syllabusFiles,
    examFormatDetails,
    examFiles,
  } = req.body || {};
  
  if (!userId) {
    return res.status(400).json({ error: 'Missing required field: userId' });
  }

  // Validate UUID format (basic validation)
  const uuidValidation = validateUuid(userId, 'userId');
  if (!uuidValidation.valid) {
    return res.status(400).json({ error: 'Invalid userId format. Must be a valid UUID.' });
  }

  let normalizedFinishByDate = null;
  let timeRemainingDays = null;
  if (finishByDate != null) {
    if (!isValidIsoDate(finishByDate)) {
      return res.status(400).json({ error: 'finishByDate must be a valid ISO 8601 date string' });
    }
    normalizedFinishByDate = new Date(finishByDate).toISOString();
    const finishDateMs = new Date(normalizedFinishByDate).getTime();
    const nowMs = Date.now();
    if (!Number.isNaN(finishDateMs)) {
      timeRemainingDays = Math.max(0, Math.round((finishDateMs - nowMs) / (1000 * 60 * 60 * 24)));
    }
  }

  let normalizedCourseSelection = null;
  if (university || courseTitle) {
    normalizedCourseSelection = {
      college: university?.trim() || '',
      title: courseTitle?.trim() || '',
      code: ''
    };
  }

  let normalizedSyllabusText = null;
  if (syllabusText != null) {
    if (typeof syllabusText !== 'string') {
      return res.status(400).json({ error: 'syllabusText must be a string when provided' });
    }
    normalizedSyllabusText = syllabusText.trim() || null;
  }

  let normalizedExamFormatDetails = null;
  if (examFormatDetails != null) {
    if (typeof examFormatDetails !== 'string') {
      return res.status(400).json({ error: 'examFormatDetails must be a string when provided' });
    }
    normalizedExamFormatDetails = examFormatDetails.trim() || null;
  }

  // Parse files from frontend - they will be inlined as text for Grok 4 Fast (text/image only model)
  const syllabusFilesValidation = validateFileArray(syllabusFiles, 'syllabusFiles');
  if (!syllabusFilesValidation.valid) {
    return res.status(400).json({ error: syllabusFilesValidation.error });
  }

  const examFilesValidation = validateFileArray(examFiles, 'examFiles');
  if (!examFilesValidation.valid) {
    return res.status(400).json({ error: examFilesValidation.error });
  }

  try {
    const generationPayload = {
      finishByDate: normalizedFinishByDate,
      timeRemainingDays,
      courseSelection: normalizedCourseSelection,
      syllabusText: normalizedSyllabusText,
      syllabusFiles: syllabusFilesValidation.value,
      examFormatDetails: normalizedExamFormatDetails,
      examFiles: examFilesValidation.value,
      model: MODEL_NAME,
    };

    const withTimeout = (promise, ms) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutError = new Error('Study topic generation timed out');
        timeoutError.code = 'TOPIC_TIMEOUT';
        reject(timeoutError);
      }, ms);
      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });

    const TIMEOUT_MS = 60000;
    const defaultTopicsFallback = [
      'Course Logistics and Policies',
      'Learning Objectives and Outcomes',
      'Primary Textbook Units',
      'Laboratory Project Milestones',
      'Key Theoretical Frameworks',
      'Core Analytical Techniques',
      'Major Case Study Themes',
      'Assessment Rubric Components',
      'Supplementary Research Readings',
      'Final Deliverable Expectations'
    ];

    let attempt = 0;
    const maxAttempts = 2;
    let topicsResponse = '';
    let normalizedOutput = [];

    while (attempt < maxAttempts) {
      try {
        topicsResponse = await withTimeout(
          generateStudyTopics({
            ...generationPayload,
            retryAttempt: attempt,
          }),
          TIMEOUT_MS,
        );
      } catch (err) {
        console.error('[courses] study topic generation error:', err);
        if (err?.code === 'TOPIC_TIMEOUT' && attempt + 1 < maxAttempts) {
          attempt += 1;
          continue;
        }
        throw err;
      }

      normalizedOutput = parseTopicsText(topicsResponse);
      if (Array.isArray(normalizedOutput) && normalizedOutput.length > 0) {
        break;
      }

      attempt += 1;
      if (attempt >= maxAttempts) {
        normalizedOutput = defaultTopicsFallback;
        topicsResponse = JSON.stringify({ topics: defaultTopicsFallback });
      }
    }

    return res.status(200).json({
      success: true,
      topics: normalizedOutput,
      rawTopicsText: topicsResponse,
      model: MODEL_NAME,
    });
  } catch (e) {
    console.error('Unhandled error creating course:', e);
    if (e && e.name === 'FetchError') {
      return res.status(502).json({ error: 'Failed to reach study planner model', details: e.message });
    }
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

// DELETE /courses?userId=xxx&courseId=yyy
router.delete('/', async (req, res) => {
  const { userId, courseId } = req.query;

  if (!userId || !courseId) {
    return res.status(400).json({ error: 'userId and courseId are required' });
  }

  const v1 = validateUuid(userId, 'userId');
  if (!v1.valid) return res.status(400).json({ error: v1.error });

  const v2 = validateUuid(courseId, 'courseId');
  if (!v2.valid) return res.status(400).json({ error: v2.error });

  try {
    const supabase = getSupabase();
    
    // First verify the course exists and belongs to the user
    const { data: course, error: fetchError } = await supabase
      .schema('api')
      .from('courses')
      .select('id')
      .eq('id', courseId)
      .eq('user_id', userId)
      .single();

    if (fetchError) {
      if (fetchError.code === 'PGRST116') {
        return res.status(404).json({ error: 'Course not found or does not belong to this user' });
      }
      console.error('Supabase error verifying course:', fetchError);
      return res.status(500).json({ error: 'Failed to verify course', details: fetchError.message });
    }

    // Delete the course (cascade will handle related content)
    const { error: deleteError } = await supabase
      .schema('api')
      .from('courses')
      .delete()
      .eq('id', courseId)
      .eq('user_id', userId);

    if (deleteError) {
      console.error('Supabase error deleting course:', deleteError);
      return res.status(500).json({ error: 'Failed to delete course', details: deleteError.message });
    }

    return res.status(200).json({ success: true, message: 'Course deleted successfully', courseId });
  } catch (e) {
    console.error('Unhandled error deleting course:', e);
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

export default router;
