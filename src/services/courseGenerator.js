import { executeOpenRouterChat, createWebSearchTool } from './grokClient.js';

const COURSE_MODEL_NAME = 'google/gemini-2.5-pro';
const FALLBACK_MODEL_NAME = 'x-ai/grok-4-fast';
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_MAX_TOOL_ITERATIONS = 6;
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
  lines.push('- Format must be one of: video, reading, flashcards, mini quiz, practice exam.');
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
    'Rushingness Index (time left ÷ topics left) determines step pruning order: drop (1) Learn Topics familiar, (2) Practice Problems familiar, (3) Practice Problems unfamiliar, (4) Learn Topics familiar, (5) Review if still rushed.',
    'Because no practice results exist yet, only output steps involving learning topics, practicing with those topics, and testing the user on the topics, anticipating later loops implicitly.',
    'Always rely on provided materials or the web_search tool when unsure, and never fabricate facts or information. Review generated courses for factual inaccuracies or biases and prune them.',
    `Respond exclusively with ultra-concise action lines in the format "${OUTPUT_FORMAT_HINT}" using lowercase format labels.`,
    'Each module should be a larger topic with submodules being subtopics of this, never explicity say "Learn Topics" or "Do Practice Problems" only use names relevant to the course generated.',
    'No prose, no explanations, no JSON, no code fences.',
  ].join('\n');
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
    temperature: 0.3,
    maxTokens: DEFAULT_MAX_TOKENS,
    reasoning: { enabled: true, effort: 'medium' },
    tools: [createWebSearchTool()],
    toolChoice: 'auto',
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
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
  if (message?.parsed && typeof message.parsed === 'object' && !Array.isArray(message.parsed)) {
    return { ok: true, courseStructure: message.parsed };
  }
  // Try JSON first
  if (raw) {
    try {
      const asJson = JSON.parse(raw);
      if (asJson && typeof asJson === 'object' && !Array.isArray(asJson)) {
        return { ok: true, courseStructure: asJson };
      }
    } catch (_) {
      // ignore
    }
  }
  // Then concise lines format
  try {
    const structure = convertConcisePlanToStructure(raw);
    return { ok: true, courseStructure: structure };
  } catch (error) {
    return { ok: false, error };
  }
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

async function callModelJson({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 45000, retries = 1 }) {
  const doExec = async ({ signal, model, correction }) => {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    if (correction) messages.push({ role: 'user', content: correction });

    const { content, message } = await executeOpenRouterChat({
      apiKey,
      model,
      temperature: 0.2,
      maxTokens: 1200,
      reasoning: { enabled: true, effort: 'medium' },
      tools,
      toolChoice: tools?.length ? 'auto' : undefined,
      maxToolIterations: 3,
      attachments,
      responseFormat: { type: 'json_object' },
      messages,
      signal,
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
        return await withTimeout((signal) => doExec({ signal, model: modelName, correction }), timeoutMs, 'model-json');
      } catch (err) {
        if (attempt >= retries) throw err;
        attempt += 1;
        correction = 'Your previous response was not valid JSON or did not match the requested structure. Return STRICT JSON only, no prose and no code fences.';
      }
    }
  };

  try {
    return await runWithModel(COURSE_MODEL_NAME);
  } catch (_) {
    // Fallback to Grok 4 Fast
    return await runWithModel(FALLBACK_MODEL_NAME);
  }
}

// Prompt builders per format
function buildVideoPrompt({ className, moduleKey, desc }) {
  const system = 'You are a precise research assistant who finds the best short YouTube video for a topic. Always return strict JSON and always make sure the final response has a video.';
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    'Task: Use the web_search tool to identify a single high-quality YouTube video (≤ 15 minutes) that best teaches this topic.',
    'Choose official or reputable sources. Prefer concise, focused explanations.',
    'The professor desigining this course specified instructions given earlier, use them to guide your search',
    'Return JSON exactly as: { "url": "https://www.youtube.com/...", "title": "...", "summary": "..." }',
    'The url MUST be a valid YouTube video link: youtube.com/watch?v=..., youtu.be/..., shorts, or embed URLs are acceptable.',
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

async function callVideoJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 45000 }) {
  let attempts = 0;
  let correction = '';
  while (attempts <= 2) { // max 2 retries beyond first
    const userWithCorrection = correction ? `${user}\n\nIMPORTANT: ${correction}` : user;
    let json;
    try {
      json = await callModelJson({ apiKey, system, user: userWithCorrection, attachments, tools, timeoutMs, retries: 0 });
    } catch (err) {
      if (attempts >= 2) throw err;
      attempts += 1;
      correction = 'Your previous response was invalid or empty. Return STRICT JSON exactly { "url": "https://www.youtube.com/...", "title": "...", "summary": "..." }. The url MUST contain "www.youtube.com". No extra keys, no prose, no code fences.';
      continue;
    }

    const normalized = normalizeVideoJson(json);
    if (normalized && isValidYouTubeVideoUrl(normalized.url)) {
      return normalized;
    }

    if (attempts >= 2) {
      const e = new Error('Video JSON missing required YouTube URL or fields');
      e.statusCode = 502;
      e.details = { json };
      throw e;
    }
    attempts += 1;
    correction = 'Your previous response did not include a valid YouTube video URL in "url" (accepted: youtube.com/watch?v=..., youtu.be/..., shorts, embed) or was missing required fields. Return STRICT JSON: { "url": "https://www.youtube.com/watch?v=...", "title": "...", "summary": "..." } only.';
  }
}

function buildReadingPrompt({ className, moduleKey, desc }) {
  const system = 'You are an expert educator writing a focused teaching article for learners. Always return strict JSON.';
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    'Write a single teaching article with:\n- a clear, concise title\n- a well-structured body using Markdown headings and paragraphs\n- math using LaTeX (inline $...$ or block $$...$$) when helpful',
    'Return JSON exactly as: { "title": "...", "body": "..." }',
    'No extra keys, no prose outside JSON, no code fences.',
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

async function callReadingJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 45000 }) {
  let attempts = 0;
  let correction = '';
  while (attempts <= 2) {
    const userWithCorrection = correction ? `${user}\n\nIMPORTANT: ${correction}` : user;
    let json;
    try {
      json = await callModelJson({ apiKey, system, user: userWithCorrection, attachments, tools, timeoutMs, retries: 0 });
    } catch (err) {
      if (attempts >= 2) throw err;
      attempts += 1;
      correction = 'Your previous response was invalid or empty. Return STRICT JSON exactly { "title": "...", "body": "..." }. No extra keys, no code fences, no prose.';
      continue;
    }

    const normalized = normalizeReadingJson(json);
    if (normalized) return normalized;

    if (attempts >= 2) {
      const e = new Error('Reading JSON missing required fields');
      e.statusCode = 502;
      e.details = { json };
      throw e;
    }
    attempts += 1;
    correction = 'Your previous response did not include both top-level fields "title" and "body". Return STRICT JSON: { "title": "...", "body": "..." } only.';
  }
}

function buildFlashcardsPrompt({ className, moduleKey, desc }) {
  const system = 'You are a flashcard expert creating concise flashcards for long-term retention. Only include concept explanations, definitions, or key facts. Do not include practice problems or unrelated content. Use math or formulas only if directly relevant.';
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    'Generate 3–7 flashcards. Each card is exactly a triple: [question, answer, explanation].',
    'Use Markdown for math: inline $...$; blocks $$...$$ when needed.',
    'Return STRICT JSON exactly as: { "cards": [ ["question","answer","explanation"], ... ] }',
    'No extra keys, no prose outside JSON, no code fences.',
  ].join('\n');
  return { system, user };
}

function normalizeFlashcardsJson(json) {
  // Accept { cards: [ [q,a,e], ... ] }
  if (json && typeof json === 'object' && Array.isArray(json.cards)) {
    const ok = json.cards.every(
      (c) => Array.isArray(c) && c.length === 3 && c.every((s) => typeof s === 'string' && s.trim() !== '')
    );
    if (ok) return { cards: json.cards.map((c) => c.map((s) => s.trim())) };
  }
  // Accept { cards: [ { question, answer, explanation } ] }
  if (json && typeof json === 'object' && Array.isArray(json.cards)) {
    const mapped = json.cards
      .map((c) =>
        c && typeof c === 'object'
          ? [c.question, c.answer, c.explanation].filter((x) => typeof x === 'string')
          : null
      )
      .filter(Boolean);
    if (mapped.length > 0 && mapped.every((c) => c.length === 3)) {
      return { cards: mapped.map((c) => c.map((s) => s.trim())) };
    }
  }
  return null;
}

async function callFlashcardsJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 45000 }) {
  let attempts = 0;
  let correction = '';
  while (attempts <= 2) {
    const userWithCorrection = correction ? `${user}\n\nIMPORTANT: ${correction}` : user;
    let json;
    try {
      json = await callModelJson({ apiKey, system, user: userWithCorrection, attachments, tools, timeoutMs, retries: 0 });
    } catch (err) {
      if (attempts >= 2) throw err;
      attempts += 1;
      correction = 'Your previous response was invalid or empty. Return STRICT JSON exactly { "cards": [ ["question","answer","explanation"], ... ] }. No extra keys, no code fences, no prose.';
      continue;
    }

    const normalized = normalizeFlashcardsJson(json);
    if (normalized && Array.isArray(normalized.cards) && normalized.cards.length > 0) {
      return normalized;
    }

    if (attempts >= 2) {
      const e = new Error('Flashcards JSON missing required shape');
      e.statusCode = 502;
      e.details = { json };
      throw e;
    }
    attempts += 1;
    correction = 'Your previous response did not include top-level { "cards": [ ["question","answer","explanation"], ... ] }. Ensure each card has exactly 3 non-empty strings.';
  }
}

function buildMiniQuizPrompt({ className, moduleKey, desc }) {
  const system = 'You are a careful quiz author. Always return strict JSON.';
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    'Create 4–6 MCQ questions with exactly 4 options, one correct answer, and a short explanation. Follow the instructions the professor gave.',
    'Return JSON: { "questions": [ { "question": "...", "options": ["A","B","C","D"], "answer": "B", "explanation": "..." } ] }',
  ].join('\n');
  return { system, user };
}

function buildPracticeExamPrompt({ className, moduleKey, desc, examStructureText }) {
  const system = 'You are a university exam setter. Always return strict JSON.';
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    examStructureText ? `Exam hints: ${examStructureText}` : '',
    'Create a practice exam that fits the exam structure or hints if they are specified. Follow the instructions the professor gave.',
    'MCQ have 4 options, one correct answer, brief explanation.',
    'FRQ provide a detailed prompt and a short rubric.',
    'Return JSON: { "mcq": [ { "question": "...", "options": ["A","B","C","D"], "answer": "C", "explanation": "..." } ], "frq": [ { "prompt": "...", "rubric": "..." } ] }',
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

async function generateOneAsset({ apiKey, supabase, userId, courseId, className, examStructureText, moduleKey, asset }) {
  const fmt = asset?.Format?.toLowerCase?.();
  const desc = asset?.content || '';
  const table = tableForFormat(fmt);
  if (!table) return null; // unsupported

  let builder;
  let tools = [];
  switch (fmt) {
    case 'video':
      builder = buildVideoPrompt;
      tools = [createWebSearchTool()];
      break;
    case 'reading':
      builder = buildReadingPrompt;
      tools = [createWebSearchTool()];
      break;
    case 'flashcards':
      builder = buildFlashcardsPrompt;
      tools = [createWebSearchTool()];
      break;
    case 'mini quiz':
      builder = buildMiniQuizPrompt;
      tools = [createWebSearchTool()];
      break;
    case 'practice exam':
      builder = (ctx) => buildPracticeExamPrompt({ ...ctx, examStructureText });
      tools = [createWebSearchTool()];
      break;
    default:
      return null;
  }

  const { system, user } = builder({ className, moduleKey, desc });
  const json = fmt === 'video'
    ? await callVideoJsonWithValidation({ apiKey, system, user, tools, timeoutMs: 45000 })
    : fmt === 'reading'
    ? await callReadingJsonWithValidation({ apiKey, system, user, tools, timeoutMs: 45000 })
    : fmt === 'flashcards'
    ? await callFlashcardsJsonWithValidation({ apiKey, system, user, tools, timeoutMs: 45000 })
    : await callModelJson({ apiKey, system, user, tools, timeoutMs: 45000, retries: 1 });

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
  const { supabase, userId, courseId, className, examStructureText, apiKey } = ctx;
  if (!supabase || !userId || !courseId) return structure; // noop if not provided

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
          const id = await generateOneAsset({ apiKey, supabase, userId, courseId, className, examStructureText, moduleKey, asset });
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

  return { ...base, courseStructure: augmented };
}
