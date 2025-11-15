import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { getSupabase } from '../supabaseClient.js';
import { getCostTotals } from '../services/grokClient.js';
import { generateHierarchicalTopics } from '../services/courseV2.js';
import { generateCoursePackageWithAssets } from '../services/courseBuilder.js';
import {
  isValidIsoDate,
  validateFileArray,
  validateUuid,
} from '../utils/validation.js';

const router = Router();
const COURSE_GENERATOR_MODEL = 'google/gemini-2.5-pro';

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

router.post('/', async (req, res) => {
  const shared = parseSharedCourseInputs(req.body || {});
  if (!shared.valid) {
    return res.status(400).json({ error: shared.error });
  }

  const topicsValidation = normalizeTopics(req.body?.topics);
  if (!topicsValidation.valid) {
    return res.status(400).json({ error: topicsValidation.error });
  }

  const familiarityValidation = normalizeTopicFamiliarity(topicsValidation.value, req.body?.topicFamiliarity);
  if (!familiarityValidation.valid) {
    return res.status(400).json({ error: familiarityValidation.error });
  }

  const className =
    toTrimmedString(req.body?.courseTitle) ||
    toTrimmedString(req.body?.className) ||
    toTrimmedString(shared.courseSelection?.title) ||
    'Custom Course';

  const supabase = getSupabase();
  const courseId = randomUUID();

  try {
    const createdAt = new Date().toISOString();
    const placeholder = {
      id: courseId,
      user_id: shared.userId,
      created_at: createdAt,
      course_data: {},
      title: className,
      topics: topicsValidation.value,
      topic_familiarity: familiarityValidation.value.length ? familiarityValidation.value : null,
    };

    const preInsert = await supabase
      .schema('api')
      .from('courses')
      .insert([placeholder])
      .select('id')
      .single();

    if (preInsert.error) {
      console.error('Failed to persist placeholder course:', preInsert.error);
      return res.status(502).json({
        error: 'Failed to save course placeholder',
        details: preInsert.error.message || preInsert.error,
      });
    }

    const usageStart = getCostTotals();

    const result = await generateCoursePackageWithAssets({
      courseSelection: shared.courseSelection,
      userPrefs: req.body?.userPrefs || {},
      topics: topicsValidation.value,
      topicFamiliarity: familiarityValidation.value,
      syllabusText: shared.syllabusText,
      examFormatDetails: shared.examFormatDetails,
      attachments: shared.attachments,
      finishByDate: shared.finishByDateIso,
      supabase,
      courseId,
      userId: shared.userId,
      className,
    });

    try {
      const usageEnd = getCostTotals();
      if (usageStart && usageEnd) {
        const delta = {
          prompt: usageEnd.prompt - usageStart.prompt,
          completion: usageEnd.completion - usageStart.completion,
          total: usageEnd.total - usageStart.total,
          usd: Number((usageEnd.usd - usageStart.usd).toFixed(6)),
          calls: usageEnd.calls - usageStart.calls,
        };
        console.log('[course] usage:', delta);
      }
    } catch {/* ignore usage logging errors */}

    const courseData = {
      version: '2.0',
      model: COURSE_GENERATOR_MODEL,
      generated_at: new Date().toISOString(),
      inputs: {
        topics: topicsValidation.value,
        topicFamiliarity: familiarityValidation.value,
        courseSelection: shared.courseSelection,
        finishByDate: shared.finishByDateIso,
        syllabusText: shared.syllabusText,
        examFormatDetails: shared.examFormatDetails,
      },
      package: result.course,
      assets: result.assets,
    };

    const { error: updateError } = await supabase
      .schema('api')
      .from('courses')
      .update({ course_data: courseData })
      .eq('id', courseId)
      .select('id')
      .single();

    if (updateError) {
      console.error('Failed to update course record:', updateError);
      await supabase.schema('api').from('courses').delete().eq('id', courseId);
      return res.status(502).json({
        error: 'Failed to save course data',
        details: updateError.message || updateError,
      });
    }

    return res.status(201).json({ courseId });
  } catch (error) {
    console.error('Course generation failed:', error);
    try {
      await supabase.schema('api').from('courses').delete().eq('id', courseId);
    } catch {/* ignore cleanup errors */}
    return res.status(error?.statusCode || 500).json({
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

function parseSharedCourseInputs(body) {
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
  } = body;

  if (!userId) {
    return { valid: false, error: 'Missing required field: userId' };
  }

  const uuidValidation = validateUuid(userId, 'userId');
  if (!uuidValidation.valid) {
    return { valid: false, error: uuidValidation.error };
  }

  let finishByDateIso = null;
  let timeRemainingDays = null;
  if (finishByDate != null) {
    if (!isValidIsoDate(finishByDate)) {
      return { valid: false, error: 'finishByDate must be a valid ISO 8601 date string' };
    }
    finishByDateIso = new Date(finishByDate).toISOString();
    const finishDateMs = new Date(finishByDateIso).getTime();
    if (!Number.isNaN(finishDateMs)) {
      const diff = finishDateMs - Date.now();
      timeRemainingDays = Math.max(0, Math.round(diff / (1000 * 60 * 60 * 24)));
    }
  }

  let normalizedSyllabusText = null;
  if (syllabusText != null) {
    if (typeof syllabusText !== 'string') {
      return { valid: false, error: 'syllabusText must be a string when provided' };
    }
    normalizedSyllabusText = syllabusText.trim() || null;
  }

  let normalizedExamFormatDetails = null;
  if (examFormatDetails != null) {
    if (typeof examFormatDetails !== 'string') {
      return { valid: false, error: 'examFormatDetails must be a string when provided' };
    }
    normalizedExamFormatDetails = examFormatDetails.trim() || null;
  }

  const syllabusFilesValidation = validateFileArray(syllabusFiles, 'syllabusFiles');
  if (!syllabusFilesValidation.valid) {
    return { valid: false, error: syllabusFilesValidation.error };
  }

  const examFilesValidation = validateFileArray(examFiles, 'examFiles');
  if (!examFilesValidation.valid) {
    return { valid: false, error: examFilesValidation.error };
  }

  const attachments = [
    ...buildAttachmentList('syllabus', syllabusFilesValidation.value),
    ...buildAttachmentList('exam', examFilesValidation.value),
  ];

  return {
    valid: true,
    userId,
    finishByDateIso,
    timeRemainingDays,
    syllabusText: normalizedSyllabusText,
    examFormatDetails: normalizedExamFormatDetails,
    syllabusFiles: syllabusFilesValidation.value,
    examFiles: examFilesValidation.value,
    attachments,
    courseSelection: normalizeCourseSelection({ university, courseTitle, rawSelection: courseSelection }),
  };
}

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

function buildAttachmentList(label, files) {
  if (!Array.isArray(files) || files.length === 0) return [];

  return files
    .map((file, index) => {
      const attachment = {
        type: 'file',
        name: `${label}-${index + 1}-${file.name}`,
      };

      if (file.type) {
        attachment.mimeType = file.type;
      }

      if (file.content) {
        attachment.data = file.content;
      } else if (file.url) {
        attachment.url = file.url;
      } else {
        return null;
      }

      return attachment;
    })
    .filter(Boolean);
}

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

export default router;
