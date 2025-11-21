import {
  isValidIsoDate,
  validateFileArray,
  validateUuid,
} from './validation.js';

/**
 * Parses and validates shared course input fields
 * Used by both /topics and /courses endpoints
 */
export function parseSharedCourseInputs(body) {
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

/**
 * Builds attachment list from file array for LLM processing
 */
export function buildAttachmentList(label, files) {
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

/**
 * Normalizes course selection from various input formats
 */
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
