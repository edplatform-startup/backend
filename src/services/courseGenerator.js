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

function normalizeContentParts(value) {
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object') {
          if (typeof part.text === 'string') return part.text;
          if (typeof part.content === 'string') return part.content;
        }
        return '';
      })
      .join('')
      .trim();
  }

  if (typeof value === 'string') {
    return value.trim();
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
  });

  const { content } = await executeOpenRouterChat({
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

  const raw = normalizeContentParts(content);

  if (!raw) {
    throw Object.assign(new Error('Course generator returned empty content'), {
      statusCode: 502,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
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
