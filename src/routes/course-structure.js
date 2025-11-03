import { executeOpenRouterChat, createBrowsePageTool, getCostTotals } from '../services/courseGenerator.js';
// Optimized model configuration
const COURSE_MODEL_NAME = 'anthropic/claude-sonnet-4';
const FALLBACK_MODEL_NAME = 'x-ai/grok-4-fast';

// Per-content-type model configuration (prefer providers supporting tools + JSON)
const VIDEO_MODEL = 'openai/gpt-4o';
const VIDEO_FALLBACK = 'x-ai/grok-4-fast';
const READING_MODEL = 'openai/gpt-4o';
const READING_FALLBACK = 'deepseek/deepseek-v3';
const FLASHCARDS_MODEL = 'x-ai/grok-4-fast';
const FLASHCARDS_FALLBACK = 'anthropic/claude-haiku-3.5';
const MINI_QUIZ_MODEL = 'anthropic/claude-haiku-3.5';
const MINI_QUIZ_FALLBACK = 'x-ai/grok-4-fast';
const PRACTICE_EXAM_MODEL = 'anthropic/claude-sonnet-4';
const PRACTICE_EXAM_FALLBACK = 'x-ai/grok-3-beta';

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_MAX_TOOL_ITERATIONS = 2;
const MAX_RETRIES_PER_MODEL = 2; // additional retries after first attempt

let customCourseGenerator = null;

export function setCourseStructureGenerator(fn) {
  customCourseGenerator = typeof fn === 'function' ? fn : null;
}

export function clearCourseStructureGenerator() {
  customCourseGenerator = null;
}

function resolveCourseApiKey(providedKey) {
  const key =
    providedKey || process.env.OPENROUTER_GEMINI_KEY || process.env.OPENROUTER_API_KEY;

  if (!key) {
    throw new Error('Missing OpenRouter API key for Gemini 2.5 Pro (set OPENROUTER_GEMINI_KEY or OPENROUTER_API_KEY).');
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
]);

const OUTPUT_FORMAT_HINT = 'Module/Submodule | Format | Desc';
const MAX_DESCRIPTION_WORDS = 32;

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
  // Compute days left until end date (from "now") and include explicitly for pacing
  let daysLeft = null;
  if (endDate) {
    const end = new Date(endDate);
    if (!Number.isNaN(end.getTime())) {
      const now = new Date();
      const diffMs = end.getTime() - now.getTime();
      if (diffMs >= 0) {
        daysLeft = Math.max(0, Math.ceil(diffMs / (1000 * 60 * 60 * 24)));
      } else {
        daysLeft = 0;
      }
    }
  }

  lines.push("Inputs for today's learner context:");
  lines.push(`Class / exam focus: ${className}`);
  lines.push(`Study window: ${startDate} → ${endDate}`);
  if (daysLeft != null) {
    lines.push(`Days left until end date: ${daysLeft}`);
  }
  lines.push('Requested topics to emphasise:');
  lines.push('');
  topics.forEach((topic) => {
    lines.push(topic);
  });
  lines.push('');

  if (Array.isArray(topicFamiliarity) && topicFamiliarity.length > 0) {
    lines.push('Learner self-assessed familiarity levels:');
    lines.push('');
    topicFamiliarity.forEach(({ topic, familiarity }) => {
      if (!topic || !familiarity) return;
      lines.push(`${topic}: ${familiarity} (scale: low/medium/high)`);
    });
    lines.push('');
  }

  if (syllabusText) {
    lines.push('Syllabus description:');
    lines.push(syllabusText);
    lines.push('');
  }

  if (Array.isArray(syllabusFiles) && syllabusFiles.length) {
    lines.push('Syllabus files:');
    lines.push('');
    syllabusFiles.forEach((file) => {
      const parts = [file.name];
      if (file.type) parts.push(`${file.type}`);
      if (file.size != null) parts.push(`${file.size} bytes`);
      if (file.url) parts.push(`→ ${file.url}`);
      lines.push(parts.join(' '));
    });
    lines.push('');
  }

  if (examStructureText) {
    lines.push('Exam structure description:');
    lines.push(examStructureText);
    lines.push('');
  }

  if (Array.isArray(examStructureFiles) && examStructureFiles.length) {
    lines.push('Exam structure files:');
    examStructureFiles.forEach((file) => {
      const parts = [file.name];
      if (file.type) parts.push(`${file.type}`);
      if (file.size != null) parts.push(`${file.size} bytes`);
      if (file.url) parts.push(`→ ${file.url}`);
      lines.push(parts.join(' '));
    });
    lines.push('');
  }

  // Calculate global familiarity level
  let globalFamiliarity = 'medium';
  if (Array.isArray(topicFamiliarity) && topicFamiliarity.length > 0) {
    const familiarityMap = { low: 1, medium: 2, high: 3 };
    const avg = topicFamiliarity.reduce((sum, { familiarity }) => {
      return sum + (familiarityMap[familiarity?.toLowerCase()] || 2);
    }, 0) / topicFamiliarity.length;
    globalFamiliarity = avg < 1.7 ? 'low' : avg > 2.3 ? 'high' : 'medium';
  }

  lines.push('');
  lines.push('');
  lines.push(`Objective: Generate a deep, detailed learning sequence that respects prerequisites and the learner's familiarity (${globalFamiliarity} global). Use the provided "Days left" to pace breadth vs. depth: if <= 1 day left, compress to essentials; if ample, add enrichment, advanced sections, spaced review.`);
  lines.push('Design guidance:' );
  lines.push('- For EACH module/topic, include multiple assets: readings, videos, flashcards, and mini quizzes; periodically add practice exams/cumulative reviews. Judge which format is best suited to teach the specific topics but each module should have multiple formats and there should be a breadth of topics and a depth of understanding per topic.');
  lines.push('- Cover definitions, core concepts, derivations/proofs where relevant, worked examples, edge cases, and common misconceptions but adhere to what is covered in the course.');
  lines.push('- Ensure scaffolding from basics → applications → mixed practice → review.');
  lines.push('- Favor variety for retention and deep understanding and build a nuanced course.');
  lines.push('- Aim for at least 3–6 steps per topic (more if days allow).');
  lines.push('Return JSON: { "steps": [ { "module": "Main Topic", "submodule": "Subtopic", "format": "video|reading|flashcards|mini quiz|practice exam", "content": "Imperative action for the most important aspects of this (i.e., what the user should gain from this) (≤100 words, e.g., \'Explain regression via linear model with real dataset example\')" } ] }');
  lines.push('No extra text.');

  return lines.join('\n');
}

function buildCourseSystemPrompt() {
  return [
    'You are an elite instructional designer using evidence-based practices (Bloom\'s taxonomy, active recall, spaced repetition).',
    'Create a comprehensive, exam-aligned course plan that fosters deep understanding, not a shallow outline.',
    'Sequence adaptively: prerequisites first → learn (concept building) → practice (worked/mixed problems) → spaced review and checkpoints.',
    'Scale depth by days remaining (provided in user message): compress to essentials when days are few; otherwise expand with enrichment, case studies, and advanced applications.',
    'Use provided syllabus/files (browse_page) and built-in search for accuracy—do not fabricate.',
    'Output a JSON steps array ordered by execution. Prefer variety (reading, video, flashcards, mini quiz) and include practice exams periodically.',
  ].join(' ');
}

function allowedFormatsList() {
  return Array.from(new Set(Array.from(VALID_FORMATS.values()))).join(', ');
}

function buildCorrectionLineFromError(error) {
  const base = `Your previous response did not follow the required output. Fix it now by responding ONLY with lines in the exact format "${OUTPUT_FORMAT_HINT}" using one of [${allowedFormatsList()}], no prose, no JSON, no code fences.`;
  if (!error) return base;
  const detail = typeof error?.details === 'string' ? error.details : error?.message;
  if (detail) {
    return `${base} What you got wrong: ${detail}`;
  }
  return base;
}

async function tryGeneratePlanOnce({ apiKey, model, messages, attachments }) {
  
  const result = await executeOpenRouterChat({
    apiKey,
    model,
    temperature: 0.2,
    maxTokens: 800,
    reasoning: { enabled: true, effort: 'medium' },
    tools: [createBrowsePageTool()],
    toolChoice: 'auto',
    maxToolIterations: 2,
    enableWebSearch: true,
    responseFormat: { type: 'json_object' },
    attachments,
    messages,
  });
  return result;
}

function extractRawFromResult({ content, message }) {
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
  return raw || '';
}

function tryParseCourseStructure(raw, message) {
  // Accept SDK-parsed object if present
  if (message?.parsed && typeof message.parsed === 'object') {
    const obj = message.parsed;
    if (Array.isArray(obj.steps)) {
      return { ok: true, courseStructure: convertStepsArrayToStructure(obj.steps) };
    }
    if (!Array.isArray(obj)) {
      return { ok: true, courseStructure: obj };
    }
  }
  
  // Try JSON first
  if (raw) {
    try {
      const asJson = JSON.parse(raw);
      if (asJson && typeof asJson === 'object') {
        if (Array.isArray(asJson.steps)) {
          return { ok: true, courseStructure: convertStepsArrayToStructure(asJson.steps) };
        }
        if (!Array.isArray(asJson)) {
          return { ok: true, courseStructure: asJson };
        }
      }
    } catch (_) {
      // ignore
    }
  }
  
  // Fallback: Then concise lines format (legacy)
  try {
    const structure = convertConcisePlanToStructure(raw);
    return { ok: true, courseStructure: structure };
  } catch (error) {
    return { ok: false, error };
  }
}

function convertStepsArrayToStructure(steps) {
  if (!Array.isArray(steps)) {
    throw new Error('Steps must be an array');
  }
  
  const structure = {};
  for (const step of steps) {
    if (!step || typeof step !== 'object') continue;
    
    const { module, submodule, format, content } = step;
    if (!module || !format) continue;
    
    const moduleKey = `${module}${submodule ? '/' + submodule : ''}`;
    if (!structure[moduleKey]) {
      structure[moduleKey] = [];
    }
    
    const normalizedFormat = VALID_FORMATS.get(format?.toLowerCase()?.trim());
    if (!normalizedFormat) continue;
    
    structure[moduleKey].push({
      'Format': normalizedFormat,
      'content': content || '',
    });
  }
  
  if (Object.keys(structure).length === 0) {
    throw new Error('No valid steps found in response');
  }
  
  return structure;
}

async function generateWithRetriesAndFallback({ apiKey, baseMessages, attachments }) {
  const attemptsLog = [];

  // helper to run attempts for a specific model
  const runForModel = async (modelName) => {
    const corrections = [];
    for (let attempt = 0; attempt <= MAX_RETRIES_PER_MODEL; attempt++) {
      const msgs = [...baseMessages];
      if (corrections.length) {
        msgs.push({ role: 'user', content: corrections[corrections.length - 1] });
      }

      let chat;
      try {
        chat = await tryGeneratePlanOnce({ apiKey, model: modelName, messages: msgs, attachments });
      } catch (err) {
        attemptsLog.push({ model: modelName, attempt: attempt + 1, error: err?.message || 'request failed' });
        if (attempt >= MAX_RETRIES_PER_MODEL) {
          return { ok: false };
        }
        const correction = buildCorrectionLineFromError(err);
        corrections.push(correction);
        continue;
      }

      const raw = extractRawFromResult(chat);
      if (!raw) {
        const debug = summarizeMessageForDebug(chat?.message, chat?.response);
        const err = new Error('Course generator returned empty content');
        err.details = { finishReason: debug?.finishReason || 'unknown', responseId: chat?.response?.id };
        attemptsLog.push({ model: modelName, attempt: attempt + 1, error: err.message });
        if (attempt >= MAX_RETRIES_PER_MODEL) {
          return { ok: false };
        }
        const correction = buildCorrectionLineFromError(err);
        corrections.push(correction);
        continue;
      }

      const parsed = tryParseCourseStructure(raw, chat?.message);
      if (parsed.ok) {
        return {
          ok: true,
          model: modelName,
          raw,
          courseStructure: parsed.courseStructure,
          retries: attempt,
          corrections,
          attemptsLog,
        };
      }

      // build correction and retry
      attemptsLog.push({ model: modelName, attempt: attempt + 1, error: parsed.error?.message || 'unparseable content' });
      if (attempt >= MAX_RETRIES_PER_MODEL) {
        return { ok: false };
      }
      const correction = buildCorrectionLineFromError(parsed.error);
      corrections.push(correction);
    }
    return { ok: false };
  };

  // Try primary (Gemini)
  const primary = await runForModel(COURSE_MODEL_NAME);
  if (primary.ok) {
    return { ...primary, fallbackOccurred: false, attemptedModels: [{ name: COURSE_MODEL_NAME, attempts: primary.retries + 1 }] };
  }

  // Fallback to Grok 4 Fast
  const fallback = await runForModel(FALLBACK_MODEL_NAME);
  if (fallback.ok) {
    return {
      ...fallback,
      fallbackOccurred: true,
      attemptedModels: [
        { name: COURSE_MODEL_NAME, attempts: MAX_RETRIES_PER_MODEL + 1 },
        { name: FALLBACK_MODEL_NAME, attempts: fallback.retries + 1 },
      ],
    };
  }

  const err = new Error('All models failed to produce a valid course structure');
  err.statusCode = 502;
  err.details = { attemptedModels: [COURSE_MODEL_NAME, FALLBACK_MODEL_NAME] };
  throw err;
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

  const baseMessages = [
    { role: 'system', content: buildCourseSystemPrompt() },
    { role: 'user', content: userMessage },
  ];

  const result = await generateWithRetriesAndFallback({
    apiKey,
    baseMessages,
    attachments: normalizedAttachments,
  });

  return {
    model: result.model,
    raw: result.raw,
    courseStructure: result.courseStructure,
    retries: result.retries,
    fallbackOccurred: result.fallbackOccurred,
    attemptedModels: result.attemptedModels,
  };
}

// --- Added helpers for per-asset JSON generation and persistence ---

function withTimeout(promiseFactory, timeoutMs, label = 'operation') {
  if (!timeoutMs || timeoutMs <= 0) return promiseFactory();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return promiseFactory(controller.signal)
    .finally(() => clearTimeout(timer));
}

async function callModelJson({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 30000, retries = 1, model = MINI_QUIZ_MODEL, fallbackModel = MINI_QUIZ_FALLBACK }) {
  const doExec = async ({ signal, currentModel, correction }) => {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    if (correction) messages.push({ role: 'user', content: correction });

    const { content, message } = await executeOpenRouterChat({
      apiKey,
      model: currentModel,
      temperature: 0.4,
      maxTokens: 800,
      reasoning: { enabled: true, effort: 'medium' },
      tools,
      toolChoice: tools?.length ? 'auto' : undefined,
      maxToolIterations: 2,
      attachments,
      responseFormat: { type: 'json_object' },
      messages,
      signal,
      enableWebSearch: true,
    });

    // Prefer parsed JSON provided by the SDK if available
    if (message?.parsed && typeof message.parsed === 'object') {
      return message.parsed;
    }

    const raw = normalizeContentParts(content);
    if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
    }
  };

  const runWithModel = async (modelName) => {
    let attempt = 0;
    let correction;
    while (attempt <= retries) {
      try {
        return await withTimeout((signal) => doExec({ signal, currentModel: modelName, correction }), timeoutMs, 'model-json');
      } catch (err) {
        if (attempt >= retries) throw err;
        attempt += 1;
        correction = 'Invalid. Return STRICT JSON with plausible distractors.';
      }
    }
  };

  try {
    return await runWithModel(model);
  } catch (_) {
    // Fallback model
    return await runWithModel(fallbackModel);
  }
}

// Prompt builders per format
function buildVideoPrompt({ className, moduleKey, desc, familiarityLevel = 'medium' }) {
  const system = `You are a precise curator of educational videos. MUST use built-in search for real YouTube videos. Tailor to ${familiarityLevel}: low=beginner intros; high=advanced applications. Prefer 1-2 short videos (≤15min total) from reputable sources (e.g., Khan Academy, 3Blue1Brown).`;
  
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    '',
    'CRITICAL: Use built-in search with tailored queries, e.g., "site:youtube.com {topic} {familiarityLevel} tutorial" or "{topic} advanced example youtube". Select 1-2 high-quality videos totaling ≤15min.',
    '',
    'RETURN JSON: { "videos": [ { "url": "https://www.youtube.com/watch?v=VIDEO_ID", "title": "exact title", "duration_min": number, "summary": "≤30 words on coverage" } ] }',
    '',
    'URLs MUST be valid (formats: watch?v=, youtu.be, shorts, embed). No placeholders.',
  ].join('\n');
  
  return { system, user };
}

function isValidYouTubeVideoUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const isYouTubeHost = host === 'youtu.be' || host.endsWith('youtube.com');
    if (!isYouTubeHost) return false;

    const isPlausibleId = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{6,15}$/i.test(id);

    if (host === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      return isPlausibleId(id);
    }

    const path = u.pathname;
    if (path === '/watch') {
      const v = u.searchParams.get('v');
      return isPlausibleId(v);
    }
    if (path.startsWith('/shorts/') || path.startsWith('/embed/')) {
      const parts = path.split('/').filter(Boolean);
      const id = parts[1];
      return isPlausibleId(id);
    }
    return false;
  } catch {
    return false;
  }
}

function normalizeVideoJson(json) {
  if (!json || typeof json !== 'object') return null;
  const url = typeof json.url === 'string' ? json.url.trim() : undefined;
  const title = typeof json.title === 'string' ? json.title.trim() : undefined;
  // accept description but map to summary if needed
  const summaryRaw = typeof json.summary === 'string' ? json.summary : json.description;
  const summary = typeof summaryRaw === 'string' ? summaryRaw.trim() : undefined;
  if (!url || !title || !summary) return null;
  return { url, title, summary };
}

async function callVideoJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 30000 }) {
  let attempts = 0;
  let correction = '';
  
  while (attempts <= 2) { // max 2 retries
    const userWithCorrection = correction ? `${user}\n\nCORRECTION: ${correction}` : user;
    let json;
    try {
      const doExec = async ({ signal }) => {
        const messages = [
          { role: 'system', content: system },
          { role: 'user', content: userWithCorrection },
        ];

        const { content, message } = await executeOpenRouterChat({
          apiKey,
          model: VIDEO_MODEL,
          temperature: 0.4,
          maxTokens: 1000,
          reasoning: { enabled: true, effort: 'medium' },
          tools,
          toolChoice: 'auto', // Avoid provider errors for forced tool calling
          maxToolIterations: 2,
          attachments,
          responseFormat: { type: 'json_object' },
          messages,
          signal,
          enableWebSearch: true,
        });

        if (message?.parsed && typeof message.parsed === 'object') {
          return message.parsed;
        }

        const raw = normalizeContentParts(content);
        if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
        try {
          return JSON.parse(raw);
        } catch (e) {
          throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
        }
      };

      json = await withTimeout((signal) => doExec({ signal }), timeoutMs, 'video-json');
    } catch (err) {
      if (attempts >= 2) throw err;
      attempts += 1;
      correction = 'Invalid/empty response. MUST use built-in search for VALID YouTube videos tailored to familiarity. Return STRICT JSON { "videos": [ { "url": "...", "title": "...", "duration_min": ..., "summary": "..." } ] }. No extras.';
      continue;
    }

    // Validate videos array
    if (!json || !Array.isArray(json.videos) || json.videos.length === 0) {
      if (attempts >= 2) {
        const e = new Error('Video JSON missing videos array after maximum retries');
        e.statusCode = 502;
        e.details = { json, attempts };
        throw e;
      }
      attempts += 1;
      correction = 'Still invalid URL(s). Re-search and ensure working formats. ONLY JSON as above.';
      continue;
    }

    // Validate each video has valid YouTube URL
    const validVideos = json.videos.filter(v => 
      v && typeof v === 'object' && 
      v.url && v.title && 
      isValidYouTubeVideoUrl(v.url)
    );

    if (validVideos.length > 0) {
      return { videos: validVideos };
    }

    if (attempts >= 2) {
      const e = new Error('No valid YouTube URLs found after maximum retries');
      e.statusCode = 502;
      e.details = { json, attempts };
      throw e;
    }
    attempts += 1;
    correction = 'Still invalid URL(s). Re-search and ensure working formats. ONLY JSON as above.';
  }
}

function buildReadingPrompt({ className, moduleKey, desc, familiarityLevel = 'medium' }) {
  const system = 'You are an expert educator crafting concise, sourced articles. Use built-in search/browse_page for 2-3 facts/examples; cite inline (e.g., [Source]). Structure for Bloom\'s: intro (understand), examples (apply), summary (analyze). Cap body ≤800 words.';
  
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel} (scaffold more if low)`,
    '',
    'Write a focused article: title, body (Markdown: # Headings, paragraphs, LaTeX math $...$ or $$...$$).',
    'Return JSON: { "title": "...", "body": "..." }',
    'No extras.',
  ].join('\n');
  return { system, user };
}

function normalizeReadingJson(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.article && typeof json.article === 'object') {
    const t = typeof json.article.title === 'string' ? json.article.title.trim() : undefined;
    const b = typeof json.article.body === 'string' ? json.article.body.trim() : undefined;
    if (t && b) return { title: t, body: b };
  }
  const title = typeof json.title === 'string' ? json.title.trim() : undefined;
  const body = typeof json.body === 'string' ? json.body.trim() : undefined;
  if (!title || !body) return null;
  return { title, body };
}

async function callReadingJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 30000 }) {
  let attempts = 0;
  let correction = '';
  while (attempts <= 1) {
    const userWithCorrection = correction ? `${user}\n\nCORRECTION: ${correction}` : user;
    let json;
    try {
      const doExec = async ({ signal }) => {
        const messages = [
          { role: 'system', content: system },
          { role: 'user', content: userWithCorrection },
        ];

        const { content, message } = await executeOpenRouterChat({
          apiKey,
          model: READING_MODEL,
          temperature: 0.2,
          maxTokens: 1000,
          reasoning: { enabled: true, effort: 'medium' },
          tools,
          toolChoice: 'auto',
          maxToolIterations: 2,
          attachments,
          responseFormat: { type: 'json_object' },
          messages,
          signal,
          enableWebSearch: true,
        });

        if (message?.parsed && typeof message.parsed === 'object') {
          return message.parsed;
        }

        const raw = normalizeContentParts(content);
        if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
        try {
          return JSON.parse(raw);
        } catch (e) {
          throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
        }
      };

      json = await withTimeout((signal) => doExec({ signal }), timeoutMs, 'reading-json');
    } catch (err) {
      if (attempts >= 1) throw err;
      attempts += 1;
      correction = 'Invalid/empty. Return STRICT JSON { "title": "...", "body": "..." } with sources cited. Cap ≤800 words.';
      continue;
    }

    const normalized = normalizeReadingJson(json);
    if (normalized) return normalized;

    if (attempts >= 1) {
      const e = new Error('Reading JSON missing required fields');
      e.statusCode = 502;
      e.details = { json };
      throw e;
    }
    attempts += 1;
    correction = 'Invalid. Return STRICT JSON { "title": "...", "body": "..." } with sources cited. Cap ≤800 words.';
  }
}

function buildFlashcardsPrompt({ className, moduleKey, desc, familiarityLevel = 'medium' }) {
  const system = 'You create flashcards for active recall/spaced repetition (Anki-style). 5-8 cards: 20% cloze (e.g., "The slope in linear regression is {{c1::beta}}"). Focus: definitions, concepts, formulas (LaTeX). Add tag: difficulty (easy/medium/hard) based on familiarity.';
  
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    '',
    'Generate 5-8 cards as triples: [question/cloze, answer, explanation (≤20 words)]. Markdown math.',
    'Return JSON: { "cards": [ ["question", "answer", "explanation", "tag": "easy"] , ... ] }',
    'No extras.',
  ].join('\n');
  return { system, user };
}

function normalizeFlashcardsJson(json) {
  // Accept { cards: [ [q,a,e,tag], ... ] } - new format with tags
  if (json && typeof json === 'object' && Array.isArray(json.cards)) {
    const mapped = json.cards.map(c => {
      if (Array.isArray(c) && c.length >= 3) {
        return [
          typeof c[0] === 'string' ? c[0].trim() : '',
          typeof c[1] === 'string' ? c[1].trim() : '',
          typeof c[2] === 'string' ? c[2].trim() : '',
          typeof c[3] === 'string' ? c[3].trim() : 'medium' // default tag
        ];
      }
      // Accept { question, answer, explanation, tag } objects
      if (c && typeof c === 'object') {
        const q = typeof c.question === 'string' ? c.question.trim() : '';
        const a = typeof c.answer === 'string' ? c.answer.trim() : '';
        const e = typeof c.explanation === 'string' ? c.explanation.trim() : '';
        const t = typeof c.tag === 'string' ? c.tag.trim() : 'medium';
        if (q && a && e) return [q, a, e, t];
      }
      return null;
    }).filter(Boolean);
    
    if (mapped.length > 0) {
      return { cards: mapped };
    }
  }
  return null;
}

async function callFlashcardsJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 30000 }) {
  let attempts = 0;
  let correction = '';
  while (attempts <= 1) {
    const userWithCorrection = correction ? `${user}\n\nCORRECTION: ${correction}` : user;
    let json;
    try {
      const doExec = async ({ signal }) => {
        const messages = [
          { role: 'system', content: system },
          { role: 'user', content: userWithCorrection },
        ];

        const { content, message } = await executeOpenRouterChat({
          apiKey,
          model: FLASHCARDS_MODEL,
          temperature: 0.2,
          maxTokens: 800,
          reasoning: { enabled: true, effort: 'medium' },
          tools,
          toolChoice: 'auto',
          maxToolIterations: 2,
          attachments,
          responseFormat: { type: 'json_object' },
          messages,
          signal,
          enableWebSearch: true,
        });

        if (message?.parsed && typeof message.parsed === 'object') {
          return message.parsed;
        }

        const raw = normalizeContentParts(content);
        if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
        try {
          return JSON.parse(raw);
        } catch (e) {
          throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
        }
      };

      json = await withTimeout((signal) => doExec({ signal }), timeoutMs, 'flashcards-json');
    } catch (err) {
      if (attempts >= 1) throw err;
      attempts += 1;
      correction = 'Invalid. Return STRICT JSON { "cards": [ ["q", "a", "exp", "tag"] , ... ] } with 5-8 valid triples.';
      continue;
    }

    const normalized = normalizeFlashcardsJson(json);
    if (normalized && Array.isArray(normalized.cards) && normalized.cards.length > 0) {
      return normalized;
    }

    if (attempts >= 1) {
      const e = new Error('Flashcards JSON missing required shape');
      e.statusCode = 502;
      e.details = { json };
      throw e;
    }
    attempts += 1;
    correction = 'Invalid. Return STRICT JSON { "cards": [ ["q", "a", "exp", "tag"] , ... ] } with 5-8 valid triples.';
  }
}

async function callPracticeExamJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 30000 }) {
  let attempts = 0;
  let correction = '';
  while (attempts <= 2) {
    const userWithCorrection = correction ? `${user}\n\nCORRECTION: ${correction}` : user;
    let json;
    try {
      const doExec = async ({ signal }) => {
        const messages = [
          { role: 'system', content: system },
          { role: 'user', content: userWithCorrection },
        ];

        const { content, message } = await executeOpenRouterChat({
          apiKey,
          model: PRACTICE_EXAM_MODEL,
          temperature: 0.4,
          maxTokens: 1000,
          reasoning: { enabled: true, effort: 'high' },
          tools,
          toolChoice: 'auto',
          maxToolIterations: 2,
          attachments,
          responseFormat: { type: 'json_object' },
          messages,
          signal,
          enableWebSearch: true,
        });

        if (message?.parsed && typeof message.parsed === 'object') {
          return message.parsed;
        }

        const raw = normalizeContentParts(content);
        if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
        try {
          return JSON.parse(raw);
        } catch (e) {
          throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
        }
      };

      json = await withTimeout((signal) => doExec({ signal }), timeoutMs, 'practice-exam-json');
    } catch (err) {
      if (attempts >= 2) throw err;
      attempts += 1;
      correction = 'Invalid or empty. Return STRICT JSON: { "mcq": [ {"question":"...","options":["A","B","C","D"],"answer":"A","explanation":"..."} ], "frq": [ {"prompt":"...","model_answer":"...","rubric":"..."} ] }';
      continue;
    }

    // Validate has mcq and frq arrays
    if (json && typeof json === 'object' && (Array.isArray(json.mcq) || Array.isArray(json.frq))) {
      return json;
    }

    if (attempts >= 2) {
      const e = new Error('Practice exam JSON missing required structure');
      e.statusCode = 502;
      e.details = { json };
      throw e;
    }
    attempts += 1;
    correction = 'Invalid. Return STRICT JSON with mcq/frq arrays, including model answers.';
  }
}

function buildMiniQuizPrompt({ className, moduleKey, desc, familiarityLevel = 'medium', examStructureText }) {
  const system = 'You author quizzes for active retrieval. 3-5 MCQs: 4 plausible options (distractors from common errors), one correct, explanation. Scale difficulty to familiarity (easier if low). Mix with 1 short FRQ if fits.';
  
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    examStructureText ? `Exam hints: ${examStructureText}` : '',
    '',
    'Create 3-5 questions. MCQ: {question, options:["A...","B..."], answer:"A", explanation}. FRQ: {prompt, model_answer, rubric}.',
    'Return JSON: { "questions": [ {type: "mcq|frq", ...} ] }',
  ].filter(Boolean).join('\n');
  return { system, user };
}

function buildPracticeExamPrompt({ className, moduleKey, desc, familiarityLevel = 'medium', examStructureText }) {
  const system = 'You set realistic practice exams mirroring exam structure. Interleave topics; scale to familiarity. MCQs: 4 options, plausible distractors. FRQs: detailed prompt, model answer, rubric (point breakdown). 8-12 total questions.';
  
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey} (full scope if exam-level)`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    examStructureText ? `Exam hints: ${examStructureText}` : '',
    '',
    'Create balanced exam. MCQ/FRQ as above, with model answers for FRQ.',
    'Return JSON: { "mcq": [...], "frq": [ { "prompt": "...", "model_answer": "...", "rubric": "..." } ] }',
  ].filter(Boolean).join('\n');
  return { system, user };
}

function tableForFormat(fmt) {
  switch (fmt) {
    case 'video':
      return 'video_items';
    case 'reading':
      return 'reading_articles';
    case 'flashcards':
      return 'flashcard_sets';
    case 'mini quiz':
      return 'mini_quizzes';
    case 'practice exam':
      return 'practice_exams';
    default:
      return null;
  }
}

async function saveFormatRow(supabase, table, row) {
  const { data, error } = await supabase
    .schema('api')
    .from(table)
    .insert([row])
    .select('id')
    .single();
  if (error) {
    const err = new Error(`Failed to save ${table}`);
    err.statusCode = 502;
    err.details = error.message || error;
    throw err;
  }
  return data?.id;
}

async function generateOneAsset({ apiKey, supabase, userId, courseId, className, examStructureText, moduleKey, asset, familiarityLevel = 'medium' }) {
  const fmt = asset?.Format?.toLowerCase?.();
  const desc = asset?.content || '';
  const table = tableForFormat(fmt);
  if (!table) return null; // unsupported

  
  let builder;
  let tools = [];
  
  switch (fmt) {
    case 'video':
      builder = buildVideoPrompt;
      tools = [createBrowsePageTool()];
      break;
    case 'reading':
      builder = buildReadingPrompt;
      tools = [createBrowsePageTool()];
      break;
    case 'flashcards':
      builder = buildFlashcardsPrompt;
      tools = [createBrowsePageTool()];
      break;
    case 'mini quiz':
      builder = buildMiniQuizPrompt;
      tools = [createBrowsePageTool()];
      break;
    case 'practice exam':
      builder = (ctx) => buildPracticeExamPrompt({ ...ctx, examStructureText, familiarityLevel });
      tools = [createBrowsePageTool()];
      break;
    default:
      return null;
  }

  const { system, user } = builder({ className, moduleKey, desc, familiarityLevel, examStructureText });
  
  // Call appropriate model-specific validation function
  const json = fmt === 'video'
    ? await callVideoJsonWithValidation({ apiKey, system, user, tools, timeoutMs: 30000 })
    : fmt === 'reading'
    ? await callReadingJsonWithValidation({ apiKey, system, user, tools, timeoutMs: 30000 })
    : fmt === 'flashcards'
    ? await callFlashcardsJsonWithValidation({ apiKey, system, user, tools, timeoutMs: 30000 })
    : fmt === 'mini quiz'
    ? await callModelJson({ apiKey, system, user, tools, timeoutMs: 30000, retries: 1, model: MINI_QUIZ_MODEL, fallbackModel: MINI_QUIZ_FALLBACK })
    : await callPracticeExamJsonWithValidation({ apiKey, system, user, tools, timeoutMs: 30000 });

  const id = await saveFormatRow(supabase, table, {
    course_id: courseId,
    user_id: userId,
    module_key: moduleKey,
    content_prompt: desc,
    data: json,
  });

  return id;
}

async function runLimited(tasks, limit = 3) {
  const results = new Array(tasks.length);
  let i = 0;
  let active = 0;
  return new Promise((resolve, reject) => {
    const next = () => {
      if (i >= tasks.length && active === 0) return resolve(results);
      while (active < limit && i < tasks.length) {
        const cur = i++;
        active++;
        Promise.resolve()
          .then(tasks[cur])
          .then((res) => {
            results[cur] = { ok: true, value: res };
          })
          .catch((err) => {
            results[cur] = { ok: false, error: err };
          })
          .finally(() => {
            active--;
            next();
          });
      }
    };
    next();
  });
}

export async function generateAssetsContent(structure, ctx) {
  const { supabase, userId, courseId, className, examStructureText, apiKey, topicFamiliarity } = ctx;
  if (!supabase || !userId || !courseId) return structure; // noop if not provided

  // Calculate global familiarity level
  let familiarityLevel = 'medium';
  if (Array.isArray(topicFamiliarity) && topicFamiliarity.length > 0) {
    const familiarityMap = { low: 1, medium: 2, high: 3 };
    const avg = topicFamiliarity.reduce((sum, { familiarity }) => {
      return sum + (familiarityMap[familiarity?.toLowerCase()] || 2);
    }, 0) / topicFamiliarity.length;
    familiarityLevel = avg < 1.7 ? 'low' : avg > 2.3 ? 'high' : 'medium';
  }

  const moduleKeys = Object.keys(structure || {});
  const tasks = [];
  const locations = [];

  for (const moduleKey of moduleKeys) {
    const assets = Array.isArray(structure[moduleKey]) ? structure[moduleKey] : [];
    for (let idx = 0; idx < assets.length; idx++) {
      const asset = assets[idx];
      // Skip unsupported formats silently
      const fmt = asset?.Format?.toLowerCase?.();
      if (!tableForFormat(fmt)) {
        // mark for removal
        assets[idx] = null;
        continue;
      }

      locations.push({ moduleKey, idx });
      tasks.push(async () => {
        try {
          const id = await generateOneAsset({ 
            apiKey, 
            supabase, 
            userId, 
            courseId, 
            className, 
            examStructureText, 
            moduleKey, 
            asset,
            familiarityLevel 
          });
          return { id };
        } catch (error) {
          // Log full details and mark as failed
          console.warn('Asset generation failed:', { moduleKey, fmt, error: error?.message || error, details: error?.details });
          throw error;
        }
      });
    }
  }

  const results = await runLimited(tasks, 3);
  let successCount = 0;

  // Apply results back into the structure, dropping failed assets
  for (let i = 0; i < results.length; i++) {
    const loc = locations[i];
    const res = results[i];
    const arr = structure[loc.moduleKey];
    if (!res?.ok || !res.value?.id) {
      // drop this asset
      arr[loc.idx] = null;
    } else {
      successCount += 1;
      const asset = arr[loc.idx] || {};
      asset.id = res.value.id;
      arr[loc.idx] = asset;
    }
  }

  // Clean nulls and empty modules
  for (const moduleKey of moduleKeys) {
    const assets = (structure[moduleKey] || []).filter(Boolean);
    if (assets.length === 0) {
      delete structure[moduleKey];
    } else {
      structure[moduleKey] = assets;
    }
  }

  if (successCount === 0) {
    const err = new Error('All per-asset generations failed');
    err.statusCode = 502;
    throw err;
  }

  return structure;
}

// Extend main generator to optionally augment with per-asset content and persistence
export async function generateCourseStructureWithAssets(params) {
  const {
    userId,
    courseId,
    supabase,
    className,
    examStructureText,
    apiKey: explicitKey,
    ...rest
  } = params || {};

  // Snapshot usage before course generation
  const usageStart = getCostTotals();

  const base = await generateCourseStructure({ ...rest, className, examStructureText, apiKey: explicitKey });
  const apiKey = resolveCourseApiKey(explicitKey);
  const augmented = await generateAssetsContent(base.courseStructure, {
    supabase,
    userId,
    courseId,
    className,
    examStructureText,
    apiKey,
  });
  // Log usage delta after course generation
  try {
    const usageEnd = getCostTotals();
    const delta = {
      prompt: (usageEnd.prompt - usageStart.prompt),
      completion: (usageEnd.completion - usageStart.completion),
      total: (usageEnd.total - usageStart.total),
      usd: Number((usageEnd.usd - usageStart.usd).toFixed(6)),
      calls: (usageEnd.calls - usageStart.calls),
    };
    console.log('[course] usage:', delta);
  } catch {}

  return { ...base, courseStructure: augmented };
}