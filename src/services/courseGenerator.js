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
    providedKey || process.env.OPENROUTER_GPT5_KEY || process.env.OPENROUTER_API_KEY;

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
  lines.push('You are designing a comprehensive self-paced study plan.');
  lines.push('Use the provided context to create a structured course.');
  lines.push('The final answer must be valid JSON matching the provided schema, no prose.');
  lines.push('---');
  lines.push(`Class / exam focus: ${className}`);
  lines.push(`Study window: ${startDate} → ${endDate}`);
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
  lines.push(
    'Output requirements: Return a JSON object. Keys should be formatted as "Module/Submodule" strings. Each value must be an array of 2-4 learning assets.'
  );
  lines.push(
    'Each asset object must be: { "Format": one of ["video", "reading", "flashcards", "mini quiz", "practice exam", "project", "lab"], "content": detailed description in under 60 words }.'
  );
  lines.push(
    'Ensure coverage across all requested topics, distribute workloads evenly across the date range, and respect prerequisites when sequencing.'
  );
  lines.push('Respond with JSON only.');

  return lines.join('\n');
}

function buildCourseSystemPrompt() {
  return [
    'You are an elite instructional designer collaborating with top universities.',
    'You must produce rigorously structured study plans.',
    'Always rely on provided materials or web_search when uncertain.',
    'Never invent facts; cite file names or search results inline when relevant.',
    'Return only strict JSON adhering to the schema.',
  ].join('\n');
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

  const { content, message } = await executeOpenRouterChat({
    apiKey,
    model: COURSE_MODEL_NAME,
    temperature: 0.3,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: { enabled: true, effort: 'high' },
    tools: [createWebSearchTool()],
    toolChoice: 'auto',
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
    responseFormat: { type: 'json_object' },
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
    throw Object.assign(new Error('Course generator returned empty content'), {
      statusCode: 502,
    });
  }

  let parsed;
  try {
    if (message?.parsed && typeof message.parsed === 'object') {
      parsed = message.parsed;
    } else {
      parsed = JSON.parse(raw);
    }
  } catch (error) {
    const err = new Error('Course generator returned invalid JSON');
    err.statusCode = 502;
    err.details = error.message;
    err.rawResponse = raw;
    throw err;
  }

  return {
    model: COURSE_MODEL_NAME,
    raw,
    courseStructure: parsed,
  };
}
