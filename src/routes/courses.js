import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { generateStudyTopics } from '../services/grokClient.js';

const router = Router();

const MODEL_NAME = 'x-ai/grok-4-fast';

function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function validateFileArray(files, fieldName) {
  if (files == null) return { valid: true, value: [] };
  if (!Array.isArray(files)) {
    return { valid: false, error: `${fieldName} must be an array of file metadata objects` };
  }

  const sanitized = [];
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { valid: false, error: `${fieldName}[${i}] must be an object` };
    }

    const { name, url, size, type } = entry;

    if (typeof name !== 'string' || !name.trim()) {
      return { valid: false, error: `${fieldName}[${i}] must include a non-empty "name" string` };
    }

    if (url != null && (typeof url !== 'string' || !url.trim())) {
      return { valid: false, error: `${fieldName}[${i}] "url" must be a non-empty string when provided` };
    }

    if (size != null && (typeof size !== 'number' || Number.isNaN(size) || size < 0)) {
      return { valid: false, error: `${fieldName}[${i}] "size" must be a non-negative number when provided` };
    }

    if (type != null && typeof type !== 'string') {
      return { valid: false, error: `${fieldName}[${i}] "type" must be a string when provided` };
    }

    const sanitizedEntry = { name: name.trim() };
    if (url != null) sanitizedEntry.url = url.trim();
    if (size != null) sanitizedEntry.size = size;
    if (type != null) sanitizedEntry.type = type;
    sanitized.push(sanitizedEntry);
  }

  return { valid: true, value: sanitized };
}

function normalizeCourseRow(row) {
  return {
    id: row.id,
    user_uuid: row.user_uuid,
    course_json: row.course_json,
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
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  
  if (userId && !uuidRegex.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId format. Must be a valid UUID.' });
  }

  if (courseId && !uuidRegex.test(courseId)) {
    return res.status(400).json({ error: 'Invalid courseId format. Must be a valid UUID.' });
  }

  try {
    const supabase = getSupabase();
    let query = supabase.schema('api').from('courses').select('*');

    // Case 1: Both userId and courseId provided - get specific course if it belongs to user
    if (userId && courseId) {
      query = query.eq('user_uuid', userId).eq('id', courseId).single();
      
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
      query = query.eq('user_uuid', userId).order('created_at', { ascending: false });
      
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
//   courseSelection?: { code: string, title: string } | null,
//   syllabusText?: string,
//   syllabusFiles?: FileMeta[],
//   examFormatDetails?: string,
//   examFiles?: FileMeta[]
// }
router.post('/', async (req, res) => {
  const {
    userId,
    finishByDate,
    courseSelection,
    syllabusText,
    syllabusFiles,
    examFormatDetails,
    examFiles,
  } = req.body || {};
  
  if (!userId) {
    return res.status(400).json({ error: 'Missing required field: userId' });
  }

  // Validate UUID format (basic validation)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
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
  if (courseSelection != null) {
    if (typeof courseSelection !== 'object' || Array.isArray(courseSelection)) {
      return res.status(400).json({ error: 'courseSelection must be an object with code and title or null' });
    }
    const { code, title } = courseSelection;
    if (typeof code !== 'string' || !code.trim()) {
      return res.status(400).json({ error: 'courseSelection.code must be a non-empty string' });
    }
    if (typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({ error: 'courseSelection.title must be a non-empty string' });
    }
    normalizedCourseSelection = { code: code.trim(), title: title.trim() };
  }

  let normalizedSyllabusText = null;
  if (syllabusText != null) {
    if (typeof syllabusText !== 'string') {
      return res.status(400).json({ error: 'syllabusText must be a string when provided' });
    }
    normalizedSyllabusText = syllabusText;
  }

  let normalizedExamFormatDetails = null;
  if (examFormatDetails != null) {
    if (typeof examFormatDetails !== 'string') {
      return res.status(400).json({ error: 'examFormatDetails must be a string when provided' });
    }
    normalizedExamFormatDetails = examFormatDetails;
  }

  const syllabusFilesValidation = validateFileArray(syllabusFiles, 'syllabusFiles');
  if (!syllabusFilesValidation.valid) {
    return res.status(400).json({ error: syllabusFilesValidation.error });
  }

  const examFilesValidation = validateFileArray(examFiles, 'examFiles');
  if (!examFilesValidation.valid) {
    return res.status(400).json({ error: examFilesValidation.error });
  }

  try {
    const topicsResponse = await generateStudyTopics({
      finishByDate: normalizedFinishByDate,
      timeRemainingDays,
      courseSelection: normalizedCourseSelection,
      syllabusText: normalizedSyllabusText,
      syllabusFiles: syllabusFilesValidation.value,
      examFormatDetails: normalizedExamFormatDetails,
      examFiles: examFilesValidation.value,
      model: MODEL_NAME,
    });

    const normalizedOutput = topicsResponse
      .replace(/\r?\n+/g, ',')
      .replace(/\s+-\s+/g, ',')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);

    if (normalizedOutput.length === 0) {
      return res.status(502).json({
        error: 'Model did not return any study topics',
      });
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

export default router;
