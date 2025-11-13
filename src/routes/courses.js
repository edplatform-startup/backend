import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { getCostTotals } from '../services/grokClient.js';
import { generateCourseV2 } from '../services/courseV2.js';
import {
  isValidIsoDate,
  validateFileArray,
  validateUuid,
} from '../utils/validation.js';

const router = Router();
const COURSE_V2_MODEL = 'course-v2';

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
      .select('id, user_id, course_data')
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

    return res.json({
      courseId: data.id,
      userId: data.user_id,
      course_data: data.course_data ?? null,
    });
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

      return res.json({ success: true, course: data });
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
    return res.json({ success: true, count: courses.length, courses });
  } catch (error) {
    console.error('Unhandled error fetching courses:', error);
    return res.status(500).json({ error: 'Internal server error', details: error.message });
  }
});

router.post('/', async (req, res) => {
  const {
    userId,
    finishByDate,
    university,
    courseTitle,
    courseSelection,
    syllabusText,
    syllabusFiles,
    examFormatDetails,
    examFiles,
  } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: 'Missing required field: userId' });
  }

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
    if (!Number.isNaN(finishDateMs)) {
      const diff = finishDateMs - Date.now();
      timeRemainingDays = Math.max(0, Math.round(diff / (1000 * 60 * 60 * 24)));
    }
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

  const syllabusFilesValidation = validateFileArray(syllabusFiles, 'syllabusFiles');
  if (!syllabusFilesValidation.valid) {
    return res.status(400).json({ error: syllabusFilesValidation.error });
  }
  const examFilesValidation = validateFileArray(examFiles, 'examFiles');
  if (!examFilesValidation.valid) {
    return res.status(400).json({ error: examFilesValidation.error });
  }

  const normalizedCourseSelection = normalizeCourseSelection({
    university,
    courseTitle,
    rawSelection: courseSelection,
  });

  const usageStart = getCostTotals();

  try {
    const course = await generateCourseV2(normalizedCourseSelection, req.body?.userPrefs || {});

    try {
      const usageEnd = getCostTotals();
      const delta = {
        prompt: usageEnd.prompt - usageStart.prompt,
        completion: usageEnd.completion - usageStart.completion,
        total: usageEnd.total - usageStart.total,
        usd: Number((usageEnd.usd - usageStart.usd).toFixed(6)),
        calls: usageEnd.calls - usageStart.calls,
      };
      console.log('[course] usage:', delta);
    } catch {}

    const topics = extractTopicsFromCourse(course);
    const rawTopicsText = topics.join(', ');

    return res.status(200).json({
      success: true,
      topics,
      rawTopicsText,
      model: COURSE_V2_MODEL,
      course,
    });
  } catch (error) {
    const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 502;
    console.error('Course generation failed:', error);
    return res.status(statusCode).json({
      error: error.message || 'Failed to generate course',
      details: error.details,
    });
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

function normalizeCourseSelection({ university, courseTitle, rawSelection }) {
  let normalized = null;

  if (university || courseTitle) {
    normalized = {
      college: toTrimmedString(university),
      title: toTrimmedString(courseTitle),
      code: '',
    };
  }

  if (!normalized && rawSelection) {
    const code = toTrimmedString(rawSelection.code ?? rawSelection.id);
    const title = toTrimmedString(
      rawSelection.title ?? rawSelection.name ?? rawSelection.course ?? rawSelection.courseTitle,
    );
    const college = toTrimmedString(rawSelection.college ?? rawSelection.university);

    if (code || title || college) {
      normalized = {
        code,
        title,
        college,
      };
    }
  }

  if (normalized) {
    normalized.code = normalized.code || '';
    normalized.title = normalized.title || '';
    normalized.college = normalized.college || '';
  }

  return normalized;
}

function toTrimmedString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

function extractTopicsFromCourse(course) {
  if (!course) return [];

  const nodeTitles = Array.isArray(course?.syllabus?.topic_graph?.nodes)
    ? course.syllabus.topic_graph.nodes
        .map((node) => (typeof node?.title === 'string' ? node.title.trim() : ''))
        .filter(Boolean)
    : [];

  if (nodeTitles.length > 0) {
    return nodeTitles;
  }

  const moduleTitles = Array.isArray(course?.modules?.modules)
    ? course.modules.modules
        .map((module) => (typeof module?.title === 'string' ? module.title.trim() : ''))
        .filter(Boolean)
    : [];

  return moduleTitles;
}

export default router;
