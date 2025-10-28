import { executeOpenRouterChat, createWebSearchTool } from './grokClient.js';

const COURSE_MODEL_NAME = 'openai/gpt-5';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_TOOL_ITERATIONS = 6;

let customCourseGenerator = null;

export function setCourseStructureGenerator(fn) {
  customCourseGenerator = typeof fn === 'function' ? fn : null;
}

export function clearCourseStructureGenerator() {
  customCourseGenerator = null;
}

function resolveCourseApiKey(providedKey) {
  const key =
    providedKey || process.env.OPENROUTER_GROK_4_FAST_KEY || process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error('Missing OpenRouter API key for GPT-5 (set OPENROUTER_GPT5_KEY or OPENROUTER_API_KEY).');
  }

  return key;
}

function stringifyJson(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    console.warn('Failed to stringify JSON content from course generator:', error);
    return '';
  }
}

function normalizeContentParts(value) {
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.content === 'string') return part.content;
        if (typeof part.json === 'string') return part.json;
        if (part.json && typeof part.json === 'object') return stringifyJson(part.json);
        if (typeof part.parsed === 'string') return part.parsed;
        if (part.parsed && typeof part.parsed === 'object') return stringifyJson(part.parsed);
        if (typeof part.data === 'string') return part.data;
        if (part.data && typeof part.data === 'object') return stringifyJson(part.data);
        if (part.type === 'output_json' && part.output_json) {
          return stringifyJson(part.output_json);
        }
        if (part.type === 'json' && part.value) {
          return stringifyJson(part.value);
        }
        return '';
      })
      .join('')
      .trim();
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (value && typeof value === 'object') {
    if (typeof value.text === 'string') return value.text.trim();
    if (typeof value.content === 'string') return value.content.trim();
    if (typeof value.json === 'string') return value.json.trim();
    if (value.json && typeof value.json === 'object') return stringifyJson(value.json).trim();
    if (typeof value.parsed === 'string') return value.parsed.trim();
    if (value.parsed && typeof value.parsed === 'object') return stringifyJson(value.parsed).trim();
    if (typeof value.data === 'string') return value.data.trim();
    if (value.data && typeof value.data === 'object') return stringifyJson(value.data).trim();
  }

  return '';
}

const VALID_FORMATS = new Map([
  ['video', 'video'],
  ['reading', 'reading'],
  ['reading excerpt', 'reading'],
  ['flashcards', 'flashcards'],
  ['mini quiz', 'mini quiz'],
  ['practice exam', 'practice exam'],
  ['practice problem', 'mini quiz'],
  ['practice problems', 'mini quiz'],
  ['practice', 'mini quiz'],
  ['practice set', 'mini quiz'],
  ['practice sets', 'mini quiz'],
  ['project', 'project'],
  ['lab', 'lab'],
]);

const OUTPUT_FORMAT_HINT = 'Module/Submodule | Format | Desc';
const MAX_DESCRIPTION_WORDS = 18;

function calculateRushingIndex(startDate, endDate, topicCount) {
  if (!startDate || !endDate || !topicCount) return null;
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  const diffMs = end.getTime() - start.getTime();
  if (diffMs <= 0) return null;
  const diffDays = Math.max(1, diffMs / (1000 * 60 * 60 * 24));
  return diffDays / topicCount;
}

function buildUserMessage({
  topics,
  className,
  startDate,
  endDate,
  syllabusText,
  syllabusFiles,
  examStructureText,
  examStructureFiles,
  topicFamiliarity,
}) {
  const lines = [];
  const rushingIndex = calculateRushingIndex(startDate, endDate, topics.length);

  lines.push("Inputs for today's learner context:");
  lines.push('---');
  lines.push(`Class / exam focus: ${className}`);
  lines.push(`Study window: ${startDate} → ${endDate}`);
  if (rushingIndex != null) {
    lines.push(`Approximate Rushingness Index (time left ÷ topics left): ${rushingIndex.toFixed(2)}`);
  }
  lines.push('Requested topics to emphasise:');
  topics.forEach((topic, index) => {
    lines.push(`  ${index + 1}. ${topic}`);
  });

  if (Array.isArray(topicFamiliarity) && topicFamiliarity.length > 0) {
    lines.push('Learner self-assessed familiarity levels:');
    topicFamiliarity.forEach(({ topic, familiarity }) => {
      if (!topic || !familiarity) return;
      lines.push(`  - ${topic}: ${familiarity}`);
    });
  }

  if (syllabusText) {
    lines.push('Syllabus description:');
    lines.push(syllabusText);
  }

  if (Array.isArray(syllabusFiles) && syllabusFiles.length) {
    lines.push('Syllabus files:');
    syllabusFiles.forEach((file, index) => {
      const annotations = [];
      if (file.type) annotations.push(file.type);
      if (file.size != null) annotations.push(`${file.size} bytes`);
      lines.push(
        `  ${index + 1}. ${file.name}${annotations.length ? ` (${annotations.join(', ')})` : ''}${
          file.url ? ` → ${file.url}` : ''
        }`
      );
    });
  }

  if (examStructureText) {
    lines.push('Exam structure description:');
    lines.push(examStructureText);
  }

  if (Array.isArray(examStructureFiles) && examStructureFiles.length) {
    lines.push('Exam structure files:');
    examStructureFiles.forEach((file, index) => {
      const annotations = [];
      if (file.type) annotations.push(file.type);
      if (file.size != null) annotations.push(`${file.size} bytes`);
      lines.push(
        `  ${index + 1}. ${file.name}${annotations.length ? ` (${annotations.join(', ')})` : ''}${
          file.url ? ` → ${file.url}` : ''
        }`
      );
    });
  }

  lines.push('---');
  lines.push('Objective: craft the Learn Topics and Do Practice Problems phases only, sequenced to respect prerequisites and the rushing guidance.');
  lines.push(`Favor concise descriptions (≤ ${MAX_DESCRIPTION_WORDS} words each) and avoid repeating the topic name in the description unless necessary.`);
  lines.push('For each planned action produce exactly one line in the format:');
  lines.push(`  ${OUTPUT_FORMAT_HINT}`);
  lines.push('Rules for the concise output:');
  lines.push('- Module/Submodule should capture the step and focus area, e.g., "Learn Topics - Supervised Learning/Regression".');
  lines.push('- Format must be one of: video, reading, flashcards, mini quiz, practice exam, project, lab.');
  lines.push('- Desc should be a direct imperative describing what to cover (≤ 18 words, no bullet markers).');
  lines.push('- Return only the line list, no extra text, explanations, or JSON. Maintain order of execution.');

  return lines.join('\n');
}

function buildCourseSystemPrompt() {
  return [
    'You are an elite instructional designer collaborating with top universities.',
    'Study process phases (loop until exam or time runs out): 1) Learn Topics, 2) Do Practice Problems, 3) Review/Learn Unfamiliar Topics, 4) repeat while time remains.',
    'Learn Topics covers conceptual understanding for all topics; Review concentrates on unfamiliar items revealed during practice.',
    'Time left and familiarity govern scaffolding: higher familiarity → less support during practice, lower familiarity → more guidance.',
    'Rushingness Index (time left ÷ topics left) determines step pruning order: drop (1) Learn Topics familiar, (2) Learn Topics unfamiliar, (3) Practice Problems, (4) Review if still rushed.',
    'Because no practice results exist yet, only output Learn Topics and Do Practice Problems steps, anticipating later loops implicitly.',
    'Always rely on provided materials or the web_search tool when unsure, and never fabricate facts.',
    `Respond exclusively with ultra-concise action lines in the format "${OUTPUT_FORMAT_HINT}" using lowercase format labels.`,
    'No prose, no explanations, no JSON, no code fences.',
  ].join('\n');
}

function convertConcisePlanToStructure(rawText) {
  const structure = {};
  if (typeof rawText !== 'string' || !rawText.trim()) {
    throw Object.assign(new Error('Model reply was empty'), {
      details: 'No content returned to transform into course structure.',
    });
  }

  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    throw Object.assign(new Error('Model reply lacked actionable lines'), {
      details: 'No non-empty lines were found in the response.',
      raw: rawText,
    });
  }

  for (const line of lines) {
    const normalizedLine = line.replace(/^[-•*\d.\s]+/, '').trim();
    const parts = normalizedLine.split('|').map((part) => part.trim()).filter(Boolean);

    if (parts.length < 3) {
      throw Object.assign(new Error('Malformed plan line'), {
        details: `Expected "${OUTPUT_FORMAT_HINT}" but received "${line}"`,
        raw: rawText,
      });
    }

    const [moduleKeyRaw, formatRaw, ...descParts] = parts;
    const moduleKey = moduleKeyRaw;
    const formatCanonical = VALID_FORMATS.get(formatRaw.toLowerCase());
    const description = descParts.join(' | ').trim();

    if (!moduleKey) {
      throw Object.assign(new Error('Missing module key'), {
        details: `Line missing module/submodule portion: "${line}"`,
        raw: rawText,
      });
    }

    if (!formatCanonical) {
      throw Object.assign(new Error('Unsupported format in plan'), {
        details: `Format "${formatRaw}" is not supported in line "${line}"`,
        raw: rawText,
      });
    }

    if (!description) {
      throw Object.assign(new Error('Missing description in plan'), {
        details: `Description missing for module "${moduleKey}": "${line}"`,
        raw: rawText,
      });
    }

    const words = description.split(/\s+/);
    if (words.length > MAX_DESCRIPTION_WORDS) {
      const truncated = words.slice(0, MAX_DESCRIPTION_WORDS).join(' ');
      structure[moduleKey] = structure[moduleKey] || [];
      structure[moduleKey].push({
        Format: formatCanonical,
        content: `${truncated}…`,
      });
      continue;
    }

    structure[moduleKey] = structure[moduleKey] || [];
    structure[moduleKey].push({
      Format: formatCanonical,
      content: description,
    });
  }

  if (Object.keys(structure).length === 0) {
    throw Object.assign(new Error('No modules extracted from plan'), {
      details: 'The response did not contain any module entries after parsing.',
      raw: rawText,
    });
  }

  return structure;
}

function summarizeMessageForDebug(message, response) {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const finishReason = response?.choices?.[0]?.finish_reason || message.finish_reason;
  const preview = normalizeContentParts(message.content || '')?.slice(0, 280) || undefined;

  const toolCalls = Array.isArray(message.tool_calls)
    ? message.tool_calls.map((call) => ({
        id: call?.id,
        name: call?.function?.name,
      }))
    : undefined;

  return {
    role: message.role,
    finishReason,
    preview,
    toolCalls,
  };
}

export async function generateCourseStructure({
  topics,
  className,
  startDate,
  endDate,
  syllabusText,
  syllabusFiles,
  examStructureText,
  examStructureFiles,
  topicFamiliarity,
  attachments = [],
  apiKey: explicitKey,
}) {
  if (customCourseGenerator) {
    return await customCourseGenerator({
      topics,
      className,
      startDate,
      endDate,
      syllabusText,
      syllabusFiles,
      examStructureText,
      examStructureFiles,
      topicFamiliarity,
      attachments,
    });
  }

  const apiKey = resolveCourseApiKey(explicitKey);

  const normalizedAttachments = Array.isArray(attachments)
    ? attachments.filter((att) => att && typeof att === 'object')
    : [];

  const userMessage = buildUserMessage({
    topics,
    className,
    startDate,
    endDate,
    syllabusText,
    syllabusFiles,
    examStructureText,
    examStructureFiles,
    topicFamiliarity,
  });

  const { content, message, response } = await executeOpenRouterChat({
    apiKey,
    model: COURSE_MODEL_NAME,
    temperature: 0.3,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: { enabled: true, effort: 'medium' },
    tools: [createWebSearchTool()],
    toolChoice: 'auto',
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
    attachments: normalizedAttachments,
    messages: [
      { role: 'system', content: buildCourseSystemPrompt() },
      { role: 'user', content: userMessage },
    ],
  });

  let raw = normalizeContentParts(content);

  if (!raw && message && typeof message === 'object') {
    if (message.parsed && typeof message.parsed === 'object') {
      raw = stringifyJson(message.parsed).trim();
    } else if (message.json && typeof message.json === 'object') {
      raw = stringifyJson(message.json).trim();
    } else if (message.data && typeof message.data === 'object') {
      raw = stringifyJson(message.data).trim();
    }
  }

  if (!raw) {
    const debug = summarizeMessageForDebug(message, response);
    const err = new Error('Course generator returned empty content');
    err.statusCode = 502;
    err.details = {
      finishReason: debug?.finishReason || 'unknown',
      responseId: response?.id,
      usage: response?.usage,
    };
    err.debug = debug;
    throw err;
  }

  let parsedStructure = null;

  if (message?.parsed && typeof message.parsed === 'object') {
    parsedStructure = message.parsed;
  } else {
    try {
      parsedStructure = JSON.parse(raw);
    } catch (error) {
      parsedStructure = null;
    }
  }

  if (!parsedStructure || typeof parsedStructure !== 'object' || Array.isArray(parsedStructure)) {
    try {
      parsedStructure = convertConcisePlanToStructure(raw);
    } catch (error) {
      const err = new Error('Course generator returned unparseable content');
      err.statusCode = 502;
      err.details = error.details || error.message;
      err.rawResponse = raw;
      throw err;
    }
  }

  return {
    model: COURSE_MODEL_NAME,
    raw,
    courseStructure: parsedStructure,
  };
}
