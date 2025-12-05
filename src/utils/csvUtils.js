/**
 * CSV Utilities for LLM Token Optimization
 * 
 * Provides conversion between JSON and CSV formats to reduce token usage
 * when communicating with LLMs, especially Gemini models.
 */

/**
 * Escapes a value for CSV format.
 * Handles commas, quotes, and newlines within fields.
 * @param {any} value - The value to escape
 * @returns {string} - CSV-safe string
 */
export function escapeCSV(value) {
  if (value == null) return '';
  const str = String(value);
  // If contains comma, quote, or newline, wrap in quotes and escape inner quotes
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Parses a CSV value, handling quoted fields.
 * @param {string} value - The CSV field value
 * @returns {string} - Unescaped value
 */
export function unescapeCSV(value) {
  if (!value) return '';
  let str = value.trim();
  // Remove surrounding quotes and unescape inner quotes
  if (str.startsWith('"') && str.endsWith('"')) {
    str = str.slice(1, -1).replace(/""/g, '"');
  }
  return str;
}

/**
 * Parses a CSV line respecting quoted fields.
 * @param {string} line - A single CSV line
 * @returns {string[]} - Array of field values
 */
export function parseCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  let i = 0;

  while (i < line.length) {
    const char = line[i];

    if (inQuotes) {
      if (char === '"') {
        // Check for escaped quote
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i += 2;
          continue;
        } else {
          // End of quoted field
          inQuotes = false;
          i++;
          continue;
        }
      } else {
        current += char;
        i++;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
        i++;
      } else if (char === ',') {
        fields.push(current.trim());
        current = '';
        i++;
      } else {
        current += char;
        i++;
      }
    }
  }

  // Push last field
  fields.push(current.trim());
  return fields;
}

/**
 * Parses a full CSV string into rows.
 * Handles multi-line quoted fields.
 * @param {string} csv - CSV string
 * @returns {string[][]} - 2D array of values
 */
export function parseCSV(csv) {
  if (!csv || typeof csv !== 'string') return [];

  const rows = [];
  const lines = csv.split('\n');
  let currentRow = '';
  let inQuotes = false;

  for (const line of lines) {
    if (!inQuotes) {
      currentRow = line;
    } else {
      currentRow += '\n' + line;
    }

    // Count quotes to determine if we're still in a quoted field
    let quoteCount = 0;
    for (let i = 0; i < currentRow.length; i++) {
      if (currentRow[i] === '"') {
        quoteCount++;
      }
    }

    // Odd number of quotes means we're inside a quoted field
    inQuotes = quoteCount % 2 === 1;

    if (!inQuotes) {
      const parsed = parseCSVLine(currentRow);
      if (parsed.length > 0 && parsed.some(f => f.length > 0)) {
        rows.push(parsed);
      }
    }
  }

  return rows;
}

// ============================================================================
// Quiz Question CSV Conversion
// ============================================================================

/**
 * Converts quiz questions array to CSV format for LLM input.
 * CSV Header: index,question,optionA,optionB,optionC,optionD,correct_index,expA,expB,expC,expD
 * @param {Array} questions - Array of quiz question objects
 * @returns {string} - CSV string
 */
export function quizToCSV(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return '';

  const header = 'index,question,optionA,optionB,optionC,optionD,correct_index,expA,expB,expC,expD';
  const rows = questions.map((q, i) => {
    const opts = q.options || [];
    const exps = q.explanation || [];
    return [
      i,
      escapeCSV(q.question || ''),
      escapeCSV(opts[0] || ''),
      escapeCSV(opts[1] || ''),
      escapeCSV(opts[2] || ''),
      escapeCSV(opts[3] || ''),
      q.correct_index ?? 0,
      escapeCSV(exps[0] || ''),
      escapeCSV(exps[1] || ''),
      escapeCSV(exps[2] || ''),
      escapeCSV(exps[3] || '')
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Parses CSV output from LLM into quiz questions array.
 * @param {string} csv - CSV string from LLM
 * @returns {Array} - Array of quiz question objects
 */
export function csvToQuiz(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) return []; // Need header + at least 1 data row

  // Skip header row
  const questions = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 7) continue; // Minimum required fields

    // Handle fields: index,question,optionA-D,correct_index,expA-D
    const question = {
      question: unescapeCSV(row[1]),
      options: [
        unescapeCSV(row[2]),
        unescapeCSV(row[3]),
        unescapeCSV(row[4]),
        unescapeCSV(row[5])
      ],
      correct_index: parseInt(row[6], 10) || 0,
      explanation: row.length >= 11 ? [
        unescapeCSV(row[7]),
        unescapeCSV(row[8]),
        unescapeCSV(row[9]),
        unescapeCSV(row[10])
      ] : ['', '', '', '']
    };

    // Validate correct_index
    if (question.correct_index < 0 || question.correct_index > 3) {
      question.correct_index = 0;
    }

    questions.push(question);
  }

  return questions;
}

// ============================================================================
// Flashcard CSV Conversion
// ============================================================================

/**
 * Converts flashcards array to CSV format.
 * CSV Header: index,front,back
 * @param {Array} flashcards - Array of flashcard objects
 * @returns {string} - CSV string
 */
export function flashcardsToCSV(flashcards) {
  if (!Array.isArray(flashcards) || flashcards.length === 0) return '';

  const header = 'index,front,back';
  const rows = flashcards.map((f, i) => {
    return [
      i,
      escapeCSV(f.front || ''),
      escapeCSV(f.back || '')
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Parses CSV output from LLM into flashcards array.
 * @param {string} csv - CSV string from LLM
 * @returns {Array} - Array of flashcard objects
 */
export function csvToFlashcards(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) return [];

  const flashcards = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 3) continue;

    flashcards.push({
      front: unescapeCSV(row[1]),
      back: unescapeCSV(row[2])
    });
  }

  return flashcards;
}

// ============================================================================
// Lesson Graph CSV Conversion (for Course Generator)
// ============================================================================

/**
 * Converts lessons array to CSV format for LLM input.
 * CSV Header: slug_id,title,module_group,estimated_minutes,bloom_level,intrinsic_exam_value,dependencies,reading_plan,video_queries,quiz_plan,flashcards_plan
 * @param {Array} lessons - Array of lesson objects
 * @returns {string} - CSV string
 */
export function lessonsToCSV(lessons) {
  if (!Array.isArray(lessons) || lessons.length === 0) return '';

  const header = 'slug_id,title,module_group,estimated_minutes,bloom_level,intrinsic_exam_value,dependencies,reading_plan,video_queries,quiz_plan,flashcards_plan';
  const rows = lessons.map(l => {
    const deps = Array.isArray(l.dependencies) ? l.dependencies.join('|') : '';
    const plans = l.content_plans || {};
    const videoQueries = Array.isArray(plans.video) ? plans.video.join('|') : '';

    return [
      escapeCSV(l.slug_id || ''),
      escapeCSV(l.title || ''),
      escapeCSV(l.module_group || ''),
      l.estimated_minutes || 30,
      escapeCSV(l.bloom_level || 'Understand'),
      l.intrinsic_exam_value || 5,
      escapeCSV(deps),
      escapeCSV(plans.reading || ''),
      escapeCSV(videoQueries),
      escapeCSV(plans.quiz || ''),
      escapeCSV(plans.flashcards || '')
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Parses CSV output from LLM into lessons array.
 * @param {string} csv - CSV string from LLM
 * @returns {Array} - Array of lesson objects
 */
export function csvToLessons(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) return [];

  const lessons = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 6) continue;

    const deps = row[6] ? row[6].split('|').map(d => d.trim()).filter(Boolean) : [];
    const videoQueries = row[8] ? row[8].split('|').map(v => v.trim()).filter(Boolean) : [];

    lessons.push({
      slug_id: unescapeCSV(row[0]),
      title: unescapeCSV(row[1]),
      module_group: unescapeCSV(row[2]),
      estimated_minutes: parseInt(row[3], 10) || 30,
      bloom_level: unescapeCSV(row[4]) || 'Understand',
      intrinsic_exam_value: parseInt(row[5], 10) || 5,
      dependencies: deps,
      content_plans: {
        reading: row[7] ? unescapeCSV(row[7]) : undefined,
        video: videoQueries.length > 0 ? videoQueries : undefined,
        quiz: row[9] ? unescapeCSV(row[9]) : undefined,
        flashcards: row[10] ? unescapeCSV(row[10]) : undefined
      }
    });
  }

  return lessons;
}

// ============================================================================
// Practice Problems CSV Conversion
// ============================================================================

/**
 * Converts practice problems to CSV format.
 * CSV Header: index,question,estimated_minutes,difficulty,topic_tags,total_points,solution_steps,final_answer,key_insights
 * @param {Array} problems - Array of practice problem objects
 * @returns {string} - CSV string
 */
export function practiceProblemsToCSV(problems) {
  if (!Array.isArray(problems) || problems.length === 0) return '';

  const header = 'index,question,estimated_minutes,difficulty,topic_tags,total_points,solution_steps,final_answer,key_insights';
  const rows = problems.map((p, i) => {
    const tags = Array.isArray(p.topic_tags) ? p.topic_tags.join('|') : '';
    const steps = Array.isArray(p.sample_answer?.solution_steps) ? p.sample_answer.solution_steps.join('|||') : '';
    const insights = Array.isArray(p.sample_answer?.key_insights) ? p.sample_answer.key_insights.join('|||') : '';

    return [
      i,
      escapeCSV(p.question || ''),
      p.estimated_minutes || 15,
      escapeCSV(p.difficulty || 'Medium'),
      escapeCSV(tags),
      p.rubric?.total_points || 10,
      escapeCSV(steps),
      escapeCSV(p.sample_answer?.final_answer || ''),
      escapeCSV(insights)
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Parses CSV output from LLM into practice problems array.
 * Note: This is a simplified version - rubric grading_criteria needs separate handling.
 * @param {string} csv - CSV string from LLM
 * @returns {Array} - Array of practice problem objects
 */
export function csvToPracticeProblems(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) return [];

  const problems = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 8) continue;

    const tags = row[4] ? row[4].split('|').map(t => t.trim()).filter(Boolean) : [];
    const steps = row[6] ? row[6].split('|||').map(s => s.trim()).filter(Boolean) : [];
    const insights = row[8] ? row[8].split('|||').map(s => s.trim()).filter(Boolean) : [];

    problems.push({
      question: unescapeCSV(row[1]),
      estimated_minutes: parseInt(row[2], 10) || 15,
      difficulty: unescapeCSV(row[3]) || 'Medium',
      topic_tags: tags,
      rubric: {
        total_points: parseInt(row[5], 10) || 10,
        grading_criteria: [], // Would need separate CSV section
        partial_credit_policy: 'Award partial credit for correct approach.'
      },
      sample_answer: {
        solution_steps: steps,
        final_answer: unescapeCSV(row[7]),
        key_insights: insights,
        alternative_approaches: []
      }
    });
  }

  return problems;
}

// ============================================================================
// Topic/Course Draft CSV Conversion
// ============================================================================

/**
 * Converts a course draft topics to CSV format.
 * CSV Header: topic_index,topic_title,subtopic_index,subtopic_title,description
 * @param {object} draft - Course draft object with topics
 * @returns {string} - CSV string
 */
export function courseDraftToCSV(draft) {
  if (!draft) return '';

  const header = 'topic_index,topic_title,subtopic_index,subtopic_title,description';
  const rows = [];

  const topics = draft.topics || draft.overviewTopics || draft.modules || [];

  topics.forEach((topic, ti) => {
    const topicTitle = typeof topic === 'string' ? topic : (topic.title || topic.name || '');
    const subtopics = topic?.subtopics || topic?.lessons || [];

    if (subtopics.length === 0) {
      rows.push([
        ti,
        escapeCSV(topicTitle),
        0,
        '',
        ''
      ].join(','));
    } else {
      subtopics.forEach((st, si) => {
        const stTitle = typeof st === 'string' ? st : (st.title || st.name || '');
        const stDesc = typeof st === 'object' ? (st.description || '') : '';
        rows.push([
          ti,
          escapeCSV(topicTitle),
          si,
          escapeCSV(stTitle),
          escapeCSV(stDesc)
        ].join(','));
      });
    }
  });

  return [header, ...rows].join('\n');
}

// ============================================================================
// Generic Array to CSV (for simple key-value objects)
// ============================================================================

/**
 * Converts an array of objects to CSV using specified keys.
 * @param {Array} items - Array of objects
 * @param {string[]} keys - Keys to extract (becomes header)
 * @returns {string} - CSV string
 */
export function arrayToCSV(items, keys) {
  if (!Array.isArray(items) || items.length === 0 || !Array.isArray(keys)) return '';

  const header = keys.join(',');
  const rows = items.map(item => {
    return keys.map(k => escapeCSV(item[k] ?? '')).join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Parses CSV to array of objects using header row as keys.
 * @param {string} csv - CSV string
 * @returns {Array} - Array of objects
 */
export function csvToArray(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) return [];

  const keys = rows[0];
  const items = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const item = {};
    keys.forEach((key, j) => {
      item[key] = unescapeCSV(row[j] || '');
    });
    items.push(item);
  }

  return items;
}

// ============================================================================
// Batched Content CSV Conversion (for module-level generation)
// ============================================================================

/**
 * Parses batched quiz CSV with lesson_id column and confidence scores.
 * CSV Header: lesson_id,index,scratchpad,question,optionA,optionB,optionC,optionD,correct_index,expA,expB,expC,expD,confidence
 * (scratchpad is internal LLM reasoning - skipped in parsing)
 * @param {string} csv - CSV string from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> quiz questions array
 */
export function csvToBatchedQuiz(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) return new Map();

  const result = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Require at least 9 columns: lesson_id, index, scratchpad, question, optionA-D, correct_index
    if (row.length < 9) continue;

    const lessonId = unescapeCSV(row[0]);
    if (!lessonId) continue;

    // Column indices after skipping scratchpad (row[2]):
    // row[3] = question, row[4-7] = options, row[8] = correct_index
    // row[9-12] = explanations, row[13] = confidence
    const confidence = row.length >= 14 ? parseFloat(row[13]) || 0.8 : 0.8;

    const question = {
      question: unescapeCSV(row[3]),
      options: [
        unescapeCSV(row[4]),
        unescapeCSV(row[5]),
        unescapeCSV(row[6]),
        unescapeCSV(row[7])
      ],
      correct_index: parseInt(row[8], 10) || 0,
      explanation: row.length >= 13 ? [
        unescapeCSV(row[9]),
        unescapeCSV(row[10]),
        unescapeCSV(row[11]),
        unescapeCSV(row[12])
      ] : ['', '', '', ''],
      _confidence: confidence,
      _needsValidation: confidence < 0.7
    };

    if (question.correct_index < 0 || question.correct_index > 3) {
      question.correct_index = 0;
    }

    if (!result.has(lessonId)) {
      result.set(lessonId, []);
    }
    result.get(lessonId).push(question);
  }

  return result;
}

/**
 * Parses batched flashcards CSV with lesson_id column.
 * CSV Header: lesson_id,index,scratchpad,front,back
 * (scratchpad is internal LLM reasoning - skipped in parsing)
 * @param {string} csv - CSV string from LLM
 * @returns {Map<string, Array>} - Map of lesson_id -> flashcards array
 */
export function csvToBatchedFlashcards(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) return new Map();

  const result = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Require at least 5 columns: lesson_id, index, scratchpad, front, back
    if (row.length < 5) continue;

    const lessonId = unescapeCSV(row[0]);
    if (!lessonId) continue;

    // Skip row[2] (scratchpad) - it's for LLM internal reasoning
    const flashcard = {
      front: unescapeCSV(row[3]),
      back: unescapeCSV(row[4])
    };

    // Skip if front or back is empty
    if (!flashcard.front || !flashcard.back) continue;

    if (!result.has(lessonId)) {
      result.set(lessonId, []);
    }
    result.get(lessonId).push(flashcard);
  }

  return result;
}

/**
 * Parses batched readings output. Uses delimiter-separated format.
 * Format: Each reading starts with ===LESSON:lesson_id=== header
 * @param {string} text - Raw text from LLM with delimited readings
 * @returns {Map<string, string>} - Map of lesson_id -> reading markdown
 */
export function parseBatchedReadings(text) {
  const result = new Map();
  if (!text) return result;

  // Split on lesson headers
  const parts = text.split(/===LESSON:([^=]+)===/);

  // parts[0] is before first header (ignore), then alternating: lessonId, content
  for (let i = 1; i < parts.length; i += 2) {
    const lessonId = parts[i]?.trim();
    const content = parts[i + 1]?.trim();
    if (lessonId && content) {
      result.set(lessonId, content);
    }
  }

  return result;
}

/**
 * Creates a lesson plan summary for batched generation prompts.
 * @param {Array} lessons - Array of lesson objects with id, title, and content_payload.generation_plans
 * @returns {string} - Formatted summary for prompt
 */
export function formatLessonPlansForBatch(lessons) {
  return lessons.map((l, i) => {
    const plans = l.content_payload?.generation_plans || {};
    return `[${l.id}] "${l.title}"\n  Reading plan: ${plans.reading || 'Generate comprehensive reading'}\n  Quiz plan: ${plans.quiz || 'Generate quiz'}\n  Flashcards plan: ${plans.flashcards || 'Generate flashcards'}`;
  }).join('\n\n');
}

/**
 * Parses batched inline questions CSV output.
 * CSV format: lesson_id,chunk_index,scratchpad,question,optionA,optionB,optionC,optionD,correct_index,expA,expB,expC,expD,confidence
 * (scratchpad is internal LLM reasoning - skipped in parsing)
 * @param {string} csv - CSV string with header
 * @returns {Map<string, Array>} - Map of lesson_id -> array of inline question objects
 */
export function csvToBatchedInlineQuestions(csv) {
  const result = new Map();
  const rows = parseCSV(csv);
  if (rows.length < 2) return result;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    // Require at least 13 columns: lesson_id, chunk_index, scratchpad, question, optionA-D, correct_index, expA-D
    if (row.length < 13) continue;

    const lessonId = unescapeCSV(row[0]);
    const chunkIndex = parseInt(row[1], 10) || 0;
    // Skip row[2] (scratchpad) - it's for LLM internal reasoning
    const question = unescapeCSV(row[3]);
    const options = [unescapeCSV(row[4]), unescapeCSV(row[5]), unescapeCSV(row[6]), unescapeCSV(row[7])];
    const correctIndex = parseInt(row[8], 10) || 0;
    const explanations = [unescapeCSV(row[9]), unescapeCSV(row[10]), unescapeCSV(row[11]), unescapeCSV(row[12])];
    const confidence = row.length > 13 ? parseFloat(row[13]) || 0.8 : 0.8;

    if (!question || options.some(o => !o)) continue;

    if (!result.has(lessonId)) {
      result.set(lessonId, []);
    }

    result.get(lessonId).push({
      chunkIndex,
      question,
      options,
      answerIndex: correctIndex,
      explanation: explanations,
      confidence,
      _needsValidation: confidence < 0.7
    });
  }

  return result;
}

/**
 * Parses batched video selection CSV output.
 * CSV format: lesson_id,video_index,title,thumbnail,url,confidence
 * @param {string} csv - CSV string with header
 * @returns {Map<string, Array>} - Map of lesson_id -> array of video objects
 */
export function csvToBatchedVideos(csv) {
  const result = new Map();
  const rows = parseCSV(csv);
  if (rows.length < 2) return result;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 4) continue;

    const lessonId = unescapeCSV(row[0]);
    const videoIndex = parseInt(row[1], 10) || 0;
    const title = unescapeCSV(row[2]);
    const thumbnail = row.length > 3 ? unescapeCSV(row[3]) : '';
    const url = row.length > 4 ? unescapeCSV(row[4]) : '';
    const confidence = row.length > 5 ? parseFloat(row[5]) || 0.8 : 0.8;

    if (!title) continue;

    // Extract videoId from URL if present
    let videoId = '';
    if (url) {
      const match = url.match(/(?:v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
      videoId = match ? match[1] : '';
    }

    if (!result.has(lessonId)) {
      result.set(lessonId, []);
    }

    result.get(lessonId).push({
      videoIndex,
      videoId,
      title,
      thumbnail,
      url,
      confidence
    });
  }

  return result;
}

// ============================================================================
// Hybrid Format: CSV with JSON fallback for complex nested data
// ============================================================================

/**
 * Determines if data is simple enough for CSV or needs JSON.
 * @param {any} data - The data to analyze
 * @returns {boolean} - true if CSV is appropriate
 */
export function isCSVAppropriate(data) {
  if (!data) return false;
  if (!Array.isArray(data)) return false;
  if (data.length === 0) return false;

  // Check first item for complexity
  const sample = data[0];
  if (typeof sample !== 'object') return false;

  // Count nested objects/arrays
  let nestedCount = 0;
  for (const value of Object.values(sample)) {
    if (typeof value === 'object' && value !== null) {
      nestedCount++;
    }
  }

  // If more than 2 nested structures, prefer JSON
  return nestedCount <= 2;
}
