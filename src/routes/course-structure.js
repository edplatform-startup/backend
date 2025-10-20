import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import {
  isValidIsoDate,
  validateFileArray,
  validateUuid,
} from '../utils/validation.js';
import { generateCourseStructure } from '../services/courseGenerator.js';
import { getSupabase } from '../supabaseClient.js';

const router = Router();

function normalizeTopics(topics) {
  if (!Array.isArray(topics)) {
    return { valid: false, error: 'topics must be an array of strings' };
  }

  const sanitized = [];
  for (let i = 0; i < topics.length; i++) {
    const topic = topics[i];
    if (typeof topic !== 'string' || !topic.trim()) {
      return { valid: false, error: `topics[${i}] must be a non-empty string` };
    }
    sanitized.push(topic.trim());
  }

  if (sanitized.length === 0) {
    return { valid: false, error: 'topics must contain at least one topic' };
  }

  return { valid: true, value: sanitized };
}

function ensureCourseStructureShape(structure) {
  if (structure == null || typeof structure !== 'object' || Array.isArray(structure)) {
    return { valid: false, error: 'Course structure must be a JSON object' };
  }

  const keys = Object.keys(structure);
  if (keys.length === 0) {
    return { valid: false, error: 'Course structure must include at least one module key' };
  }

  for (const key of keys) {
    if (typeof key !== 'string' || !key.trim()) {
      return { valid: false, error: 'Course structure keys must be non-empty strings' };
    }

    const assets = structure[key];
    if (!Array.isArray(assets) || assets.length === 0) {
      return { valid: false, error: `Course structure for "${key}" must be a non-empty array` };
    }

    for (let i = 0; i < assets.length; i++) {
      const asset = assets[i];
      if (!asset || typeof asset !== 'object' || Array.isArray(asset)) {
        return { valid: false, error: `Asset ${i + 1} under "${key}" must be an object` };
      }

      const { Format, content } = asset;
      if (typeof Format !== 'string' || !Format.trim()) {
        return { valid: false, error: `Asset ${i + 1} under "${key}" must include a non-empty "Format"` };
      }
      if (typeof content !== 'string' || !content.trim()) {
        return { valid: false, error: `Asset ${i + 1} under "${key}" must include a non-empty "content"` };
      }
    }
  }

  return { valid: true };
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

router.post('/', async (req, res) => {
  const {
    topics,
    className,
    startDate,
    endDate,
    userId,
    syllabusText,
    syllabusFiles,
    examStructureText,
    examStructureFiles,
  } = req.body || {};

  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userIdValidation = validateUuid(userId, 'userId');
  if (!userIdValidation.valid) {
    return res.status(400).json({ error: userIdValidation.error });
  }

  const normalizedTopics = normalizeTopics(topics);
  if (!normalizedTopics.valid) {
    return res.status(400).json({ error: normalizedTopics.error });
  }

  if (typeof className !== 'string' || !className.trim()) {
    return res.status(400).json({ error: 'className must be a non-empty string' });
  }

  if (!startDate || !isValidIsoDate(startDate)) {
    return res.status(400).json({ error: 'startDate must be a valid ISO 8601 date string' });
  }

  if (!endDate || !isValidIsoDate(endDate)) {
    return res.status(400).json({ error: 'endDate must be a valid ISO 8601 date string' });
  }

  if (new Date(startDate).getTime() > new Date(endDate).getTime()) {
    return res.status(400).json({ error: 'startDate must be before endDate' });
  }

  let normalizedSyllabusText = null;
  if (syllabusText != null) {
    if (typeof syllabusText !== 'string') {
      return res.status(400).json({ error: 'syllabusText must be a string when provided' });
    }
    normalizedSyllabusText = syllabusText.trim();
  }

  let normalizedExamStructureText = null;
  if (examStructureText != null) {
    if (typeof examStructureText !== 'string') {
      return res.status(400).json({ error: 'examStructureText must be a string when provided' });
    }
    normalizedExamStructureText = examStructureText.trim();
  }

  const syllabusFilesValidation = validateFileArray(syllabusFiles, 'syllabusFiles');
  if (!syllabusFilesValidation.valid) {
    return res.status(400).json({ error: syllabusFilesValidation.error });
  }

  const examFilesValidation = validateFileArray(examStructureFiles, 'examStructureFiles');
  if (!examFilesValidation.valid) {
    return res.status(400).json({ error: examFilesValidation.error });
  }

  const attachments = [
    ...buildAttachmentList('syllabus', syllabusFilesValidation.value),
    ...buildAttachmentList('exam-structure', examFilesValidation.value),
  ];

  try {
    const result = await generateCourseStructure({
      topics: normalizedTopics.value,
      className: className.trim(),
      startDate: new Date(startDate).toISOString(),
      endDate: new Date(endDate).toISOString(),
      syllabusText: normalizedSyllabusText,
      syllabusFiles: syllabusFilesValidation.value,
      examStructureText: normalizedExamStructureText,
      examStructureFiles: examFilesValidation.value,
      attachments,
    });

    const validation = ensureCourseStructureShape(result.courseStructure);
    if (!validation.valid) {
      return res.status(502).json({
        error: 'Generated course structure failed validation',
        details: validation.error,
        raw: result.raw,
      });
    }

    const supabase = getSupabase();
    const courseId = randomUUID();
    const createdAt = new Date().toISOString();
    const record = {
      id: courseId,
      user_id: userId,
      user_uuid: userId,
      created_at: createdAt,
      course_data: result.courseStructure,
    };

    const { data, error: insertError } = await supabase
      .schema('api')
      .from('courses')
      .insert([record])
      .select('id')
      .single();

    if (insertError) {
      console.error('Failed to persist course structure:', insertError);
      return res.status(502).json({
        error: 'Failed to save course structure',
        details: insertError.message || insertError,
      });
    }

    const persistedId = data?.id ?? courseId;
    return res.status(201).json({ courseId: persistedId });
  } catch (error) {
    const status = error.statusCode && Number.isInteger(error.statusCode) ? error.statusCode : 500;
    console.error('Course structure generation failed:', error);
    return res.status(status).json({
      error: error.message || 'Failed to generate course structure',
      details: error.details,
      raw: error.rawResponse,
    });
  }
});

export default router;
