import { executeOpenRouterChat, createBrowsePageTool } from './grokClient.js';

const UNIVERSAL_MODEL = 'google/gemini-2.5-pro';
const UNIVERSAL_FALLBACK = 'x-ai/grok-4-fast';
const VIDEO_MODEL = UNIVERSAL_MODEL;
const VIDEO_FALLBACK = UNIVERSAL_FALLBACK;
const READING_MODEL = UNIVERSAL_MODEL;
const READING_FALLBACK = UNIVERSAL_FALLBACK;
const FLASHCARDS_MODEL = UNIVERSAL_MODEL;
const FLASHCARDS_FALLBACK = UNIVERSAL_FALLBACK;
const MINI_QUIZ_MODEL = UNIVERSAL_MODEL;
const MINI_QUIZ_FALLBACK = UNIVERSAL_FALLBACK;
const PRACTICE_EXAM_MODEL = UNIVERSAL_MODEL;
const PRACTICE_EXAM_FALLBACK = UNIVERSAL_FALLBACK;

const DEFAULT_MAX_TOOL_ITERATIONS = 2;

function stringifyJson(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch (error) {
    console.warn('Failed to stringify JSON content from course assets:', error);
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

function withTimeout(promiseFactory, timeoutMs, label = 'operation') {
  if (!timeoutMs || timeoutMs <= 0) return promiseFactory();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(`${label} timed out`), timeoutMs);
  return promiseFactory(controller.signal)
    .finally(() => clearTimeout(timer));
}

async function callModelJson({
  apiKey,
  system,
  user,
  attachments = [],
  tools = [],
  timeoutMs = 30000,
  retries = 1,
  model = MINI_QUIZ_MODEL,
  fallbackModel = MINI_QUIZ_FALLBACK,
}) {
  const doExec = async ({ signal, currentModel, correction }) => {
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: correction ? `${user}\n\nCORRECTION: ${correction}` : user },
    ];

    const enableWebSearch = true;
    const effectiveTools = enableWebSearch ? [] : (tools || []);
    const shouldRequestJson = !enableWebSearch && effectiveTools.length === 0;
    const { content, message } = await executeOpenRouterChat({
      apiKey,
      model: currentModel,
      temperature: 0.4,
      maxTokens: 800,
      reasoning: { enabled: true, effort: 'medium' },
      tools: effectiveTools,
      toolChoice: effectiveTools.length ? 'auto' : undefined,
      maxToolIterations: effectiveTools.length ? DEFAULT_MAX_TOOL_ITERATIONS : undefined,
      attachments,
      ...(shouldRequestJson ? { responseFormat: { type: 'json_object' } } : {}),
      messages,
      signal,
      enableWebSearch,
    });

    if (message?.parsed && typeof message.parsed === 'object') {
      return message.parsed;
    }

    const raw = normalizeContentParts(content);
    if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
    }
  };

  const runWithModel = async (modelName) => {
    let attempt = 0;
    let correction;
    while (attempt <= retries) {
      try {
        return await withTimeout((signal) => doExec({ signal, currentModel: modelName, correction }), timeoutMs, 'model-json');
      } catch (error) {
        if (attempt >= retries) throw error;
        attempt += 1;
        correction = 'Invalid JSON. Respond with the exact schema requested.';
      }
    }
    return null;
  };

  try {
    return await runWithModel(model);
  } catch (err) {
    return await runWithModel(fallbackModel);
  }
}

function buildVideoPrompt({ className, moduleKey, desc, familiarityLevel = 'medium' }) {
  const system = `You are a precise curator of educational videos. MUST use built-in search for real YouTube videos. Tailor to ${familiarityLevel}: low=beginner intros; high=advanced applications. Prefer 1-2 short videos (≤15min total) from reputable sources.`;
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    '',
    'Use built-in search to locate the newest, most reliable examples. Prioritize official university/organization channels.',
    'Return JSON: { "videos": [ { "url": "https://www.youtube.com/watch?v=...", "title": "...", "duration_min": number, "summary": "≤30 words" } ] }',
  ].join('\n');
  return { system, user };
}

function isValidYouTubeVideoUrl(url) {
  if (typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const validHost = host === 'youtu.be' || host.endsWith('youtube.com');
    if (!validHost) return false;

    const isPlausibleId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{6,15}$/i.test(value);
    if (host === 'youtu.be') {
      const id = parsed.pathname.split('/').filter(Boolean)[0];
      return isPlausibleId(id);
    }

    if (parsed.pathname === '/watch') {
      return isPlausibleId(parsed.searchParams.get('v'));
    }

    if (parsed.pathname.startsWith('/shorts/') || parsed.pathname.startsWith('/embed/')) {
      const [, maybeId] = parsed.pathname.split('/').filter(Boolean);
      return isPlausibleId(maybeId);
    }

    return false;
  } catch {
    return false;
  }
}

function normalizeVideoJson(json) {
  if (!json || typeof json !== 'object') return null;
  const entries = Array.isArray(json.videos) ? json.videos : [];
  const normalized = entries
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const url = typeof entry.url === 'string' ? entry.url.trim() : '';
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
      const duration = Number.isFinite(entry.duration_min) ? entry.duration_min : undefined;
      if (!url || !title || !summary) return null;
      if (!isValidYouTubeVideoUrl(url)) return null;
      return { url, title, summary, duration_min: duration };
    })
    .filter(Boolean);
  if (normalized.length === 0) return null;
  return { videos: normalized };
}

async function callVideoJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 30000 }) {
  let attempts = 0;
  let correction = '';
  while (attempts <= 2) {
    const payload = correction ? `${user}\n\nCORRECTION: ${correction}` : user;
    let json;
    try {
      const exec = async ({ signal }) => {
        const messages = [
          { role: 'system', content: system },
          { role: 'user', content: payload },
        ];

        const enableWebSearch = true;
        const effectiveTools = enableWebSearch ? [] : (tools || []);
        const shouldRequestJson = !enableWebSearch && effectiveTools.length === 0;
        const { content, message } = await executeOpenRouterChat({
          apiKey,
          model: VIDEO_MODEL,
          temperature: 0.4,
          maxTokens: 1000,
          reasoning: { enabled: true, effort: 'medium' },
          tools: effectiveTools,
          toolChoice: effectiveTools.length ? 'auto' : undefined,
          maxToolIterations: effectiveTools.length ? DEFAULT_MAX_TOOL_ITERATIONS : undefined,
          attachments,
          ...(shouldRequestJson ? { responseFormat: { type: 'json_object' } } : {}),
          messages,
          signal,
          enableWebSearch,
        });

        if (message?.parsed && typeof message.parsed === 'object') {
          return message.parsed;
        }

        const raw = normalizeContentParts(content);
        if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
        try {
          return JSON.parse(raw);
        } catch (error) {
          throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
        }
      };

      json = await withTimeout((signal) => exec({ signal }), timeoutMs, 'video-json');
    } catch (error) {
      if (attempts >= 2) throw error;
      attempts += 1;
      correction = 'Invalid or empty. Return STRICT JSON for YouTube links only.';
      continue;
    }

    const normalized = normalizeVideoJson(json);
    if (normalized) return normalized;

    if (attempts >= 2) {
      const err = new Error('Video JSON validation failed');
      err.statusCode = 502;
      err.details = { json };
      throw err;
    }
    attempts += 1;
    correction = 'Provide valid YouTube URLs (watch?v= / youtu.be / shorts).';
  }
}

function buildReadingPrompt({ className, moduleKey, desc, familiarityLevel = 'medium' }) {
  const system = 'You are an expert educator crafting concise, sourced articles. Use built-in search/browse_page for 2-3 facts/examples; cite inline (e.g., [Source]). Structure for Bloom\'s taxonomy and keep body ≤800 words.';
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    '',
    'Write Markdown with headings, short paragraphs, and optional LaTeX math. Include intro, worked example, and reflective summary.',
    'Return JSON: { "title": "...", "body": "..." }',
  ].join('\n');
  return { system, user };
}

function normalizeReadingJson(json) {
  if (!json || typeof json !== 'object') return null;
  const title = typeof json.title === 'string' ? json.title.trim() : undefined;
  const body = typeof json.body === 'string' ? json.body.trim() : undefined;
  if (!title || !body) {
    if (json.article && typeof json.article === 'object') {
      const nestedTitle = typeof json.article.title === 'string' ? json.article.title.trim() : undefined;
      const nestedBody = typeof json.article.body === 'string' ? json.article.body.trim() : undefined;
      if (nestedTitle && nestedBody) {
        return { title: nestedTitle, body: nestedBody };
      }
    }
    return null;
  }
  return { title, body };
}

async function callReadingJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 60000 }) {
  const runWithModel = async (modelName) => {
    let attempts = 0;
    let correction = '';
    while (attempts <= 1) {
      const payload = correction ? `${user}\n\nCORRECTION: ${correction}` : user;
      let json;
      try {
        const exec = async ({ signal }) => {
          const messages = [
            { role: 'system', content: system },
            { role: 'user', content: payload },
          ];

          const enableWebSearch = true;
          const effectiveTools = enableWebSearch ? [] : (tools || []);
          const shouldRequestJson = !enableWebSearch && effectiveTools.length === 0;
          const { content, message } = await executeOpenRouterChat({
            apiKey,
            model: modelName,
            temperature: 0.2,
            maxTokens: 1000,
            reasoning: { enabled: true, effort: 'medium' },
            tools: effectiveTools,
            toolChoice: effectiveTools.length ? 'auto' : undefined,
            maxToolIterations: effectiveTools.length ? DEFAULT_MAX_TOOL_ITERATIONS : undefined,
            attachments,
            ...(shouldRequestJson ? { responseFormat: { type: 'json_object' } } : {}),
            messages,
            signal,
            enableWebSearch,
          });

          if (message?.parsed && typeof message.parsed === 'object') {
            return message.parsed;
          }

          const raw = normalizeContentParts(content);
          if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
          try {
            return JSON.parse(raw);
          } catch (error) {
            throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
          }
        };

        json = await withTimeout((signal) => exec({ signal }), timeoutMs, 'reading-json');
      } catch (error) {
        if (attempts >= 1) throw error;
        attempts += 1;
        correction = 'Return JSON { "title": "...", "body": "..." } with ≤800 words.';
        continue;
      }

      const normalized = normalizeReadingJson(json);
      if (normalized) return normalized;

      if (attempts >= 1) {
        const err = new Error('Reading JSON missing title/body');
        err.statusCode = 502;
        err.details = { json };
        throw err;
      }
      attempts += 1;
      correction = 'Provide both title and Markdown body as JSON fields.';
    }
    return null;
  };

  try {
    return await runWithModel(READING_MODEL);
  } catch (primaryError) {
    console.warn('[courseV2][ASSETS] reading-json primary model failed, retrying with fallback.');
    return await runWithModel(READING_FALLBACK);
  }
}

function buildFlashcardsPrompt({ className, moduleKey, desc, familiarityLevel = 'medium' }) {
  const system = 'You create spaced-repetition flashcards. Each card: front prompt, back answer, short explanation, optional tag (subtopic).';
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    '',
    'Return JSON: { "cards": [ ["prompt", "answer", "rationale", "tag"], ... ] } (5-8 cards).',
  ].join('\n');
  return { system, user };
}

function normalizeFlashcardsJson(json) {
  if (!json || typeof json !== 'object') return null;
  const cards = Array.isArray(json.cards) ? json.cards : [];
  const normalized = cards
    .map((card) => {
      if (Array.isArray(card) && card.length >= 2) {
        const [front, back, explanation, tag] = card;
        const prompt = typeof front === 'string' ? front.trim() : '';
        const answer = typeof back === 'string' ? back.trim() : '';
        const rationale = typeof explanation === 'string' ? explanation.trim() : '';
        const label = typeof tag === 'string' ? tag.trim() : '';
        if (!prompt || !answer) return null;
        return [prompt, answer, rationale, label || null];
      }
      if (card && typeof card === 'object') {
        const prompt = typeof card.prompt === 'string' ? card.prompt.trim() : '';
        const answer = typeof card.answer === 'string' ? card.answer.trim() : '';
        if (!prompt || !answer) return null;
        const rationale = typeof card.explanation === 'string' ? card.explanation.trim() : '';
        const label = typeof card.tag === 'string' ? card.tag.trim() : '';
        return [prompt, answer, rationale, label || null];
      }
      return null;
    })
    .filter(Boolean);
  if (normalized.length === 0) return null;
  return { cards: normalized };
}

async function callFlashcardsJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 30000 }) {
  let attempts = 0;
  let correction = '';
  while (attempts <= 1) {
    const payload = correction ? `${user}\n\nCORRECTION: ${correction}` : user;
    let json;
    try {
      const exec = async ({ signal }) => {
        const messages = [
          { role: 'system', content: system },
          { role: 'user', content: payload },
        ];

        const enableWebSearch = true;
        const effectiveTools = enableWebSearch ? [] : (tools || []);
        const shouldRequestJson = !enableWebSearch && effectiveTools.length === 0;
        const { content, message } = await executeOpenRouterChat({
          apiKey,
          model: FLASHCARDS_MODEL,
          temperature: 0.2,
          maxTokens: 800,
          reasoning: { enabled: true, effort: 'medium' },
          tools: effectiveTools,
          toolChoice: effectiveTools.length ? 'auto' : undefined,
          maxToolIterations: effectiveTools.length ? DEFAULT_MAX_TOOL_ITERATIONS : undefined,
          attachments,
          ...(shouldRequestJson ? { responseFormat: { type: 'json_object' } } : {}),
          messages,
          signal,
          enableWebSearch,
        });

        if (message?.parsed && typeof message.parsed === 'object') {
          return message.parsed;
        }

        const raw = normalizeContentParts(content);
        if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
        try {
          return JSON.parse(raw);
        } catch (error) {
          throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
        }
      };

      json = await withTimeout((signal) => exec({ signal }), timeoutMs, 'flashcards-json');
    } catch (error) {
      if (attempts >= 1) throw error;
      attempts += 1;
      correction = 'Return JSON { "cards": [ ["prompt","answer","exp","tag"], ... ] } with concrete facts.';
      continue;
    }

    const normalized = normalizeFlashcardsJson(json);
    if (normalized) return normalized;

    if (attempts >= 1) {
      const err = new Error('Flashcards JSON missing required shape');
      err.statusCode = 502;
      err.details = { json };
      throw err;
    }
    attempts += 1;
    correction = 'Ensure 5-8 cards with prompt/answer text.';
  }
}

async function callPracticeExamJsonWithValidation({ apiKey, system, user, attachments = [], tools = [], timeoutMs = 60000 }) {
  const runWithModel = async (modelName) => {
    let attempts = 0;
    let correction = '';
    while (attempts <= 2) {
      const payload = correction ? `${user}\n\nCORRECTION: ${correction}` : user;
      let json;
      try {
        const exec = async ({ signal }) => {
          const messages = [
            { role: 'system', content: system },
            { role: 'user', content: payload },
          ];

          const enableWebSearch = true;
          const effectiveTools = enableWebSearch ? [] : (tools || []);
          const shouldRequestJson = !enableWebSearch && effectiveTools.length === 0;
          const { content, message } = await executeOpenRouterChat({
            apiKey,
            model: modelName,
            temperature: 0.4,
            maxTokens: 1200,
            reasoning: { enabled: true, effort: 'high' },
            tools: effectiveTools,
            toolChoice: effectiveTools.length ? 'auto' : undefined,
            maxToolIterations: effectiveTools.length ? DEFAULT_MAX_TOOL_ITERATIONS : undefined,
            attachments,
            ...(shouldRequestJson ? { responseFormat: { type: 'json_object' } } : {}),
            messages,
            signal,
            enableWebSearch,
          });

          if (message?.parsed && typeof message.parsed === 'object') {
            return message.parsed;
          }

          const raw = normalizeContentParts(content);
          if (!raw) throw Object.assign(new Error('Empty JSON response'), { statusCode: 502 });
          try {
            return JSON.parse(raw);
          } catch (error) {
            throw Object.assign(new Error('Invalid JSON from model'), { statusCode: 502, raw });
          }
        };

        json = await withTimeout((signal) => exec({ signal }), timeoutMs, 'practice-exam-json');
      } catch (error) {
        if (attempts >= 2) throw error;
        attempts += 1;
        correction = 'Return JSON { "mcq": [...], "frq": [...] } with detailed answers.';
        continue;
      }

      if (json && typeof json === 'object' && (Array.isArray(json.mcq) || Array.isArray(json.frq))) {
        return json;
      }

      if (attempts >= 2) {
        const err = new Error('Practice exam JSON missing mcq/frq arrays');
        err.statusCode = 502;
        err.details = { json };
        throw err;
      }
      attempts += 1;
      correction = 'Include both MCQ and FRQ arrays with answers.';
    }
    return null;
  };

  try {
    return await runWithModel(PRACTICE_EXAM_MODEL);
  } catch (primaryError) {
    console.warn('[courseV2][ASSETS] practice-exam-json primary model failed, retrying with fallback.');
    return await runWithModel(PRACTICE_EXAM_FALLBACK);
  }
}

function buildMiniQuizPrompt({ className, moduleKey, desc, familiarityLevel = 'medium', examFormatDetails }) {
  const system = 'You author quizzes for active retrieval. Include 3-5 MCQs (4 options) plus optional 1 FRQ with model answer and rubric.';
  const user = [
    `Class: ${className}`,
    `Module: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    examFormatDetails ? `Exam hints: ${examFormatDetails}` : '',
    '',
    'Return JSON: { "questions": [ { "type": "mcq", "question": "...", "options": ["A","B","C","D"], "answer": "A", "explanation": "..." }, { "type": "frq", "prompt": "...", "model_answer": "...", "rubric": "..." } ] }',
  ].filter(Boolean).join('\n');
  return { system, user };
}

function buildPracticeExamPrompt({ className, moduleKey, desc, familiarityLevel = 'medium', examFormatDetails }) {
  const system = 'You set realistic practice exams mirroring the described assessment. Combine 8-12 total MCQ/FRQ items with model answers and rubrics.';
  const user = [
    `Class: ${className}`,
    `Scope: ${moduleKey}`,
    `Instruction: ${desc}`,
    `Familiarity: ${familiarityLevel}`,
    examFormatDetails ? `Exam hints: ${examFormatDetails}` : '',
    '',
    'Return JSON: { "mcq": [ ... ], "frq": [ ... ] } with detailed model answers.',
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

async function generateOneAsset({
  apiKey,
  supabase,
  userId,
  courseId,
  className,
  examFormatDetails,
  moduleKey,
  asset,
  familiarityLevel = 'medium',
}) {
  const fmt = asset?.Format?.toLowerCase?.();
  const desc = asset?.content || '';
  const table = tableForFormat(fmt);
  if (!table) return null;

  let builder;
  const tools = [createBrowsePageTool()];
  switch (fmt) {
    case 'video':
      builder = buildVideoPrompt;
      break;
    case 'reading':
      builder = buildReadingPrompt;
      break;
    case 'flashcards':
      builder = buildFlashcardsPrompt;
      break;
    case 'mini quiz':
      builder = (ctx) => buildMiniQuizPrompt({ ...ctx, examFormatDetails });
      break;
    case 'practice exam':
      builder = (ctx) => buildPracticeExamPrompt({ ...ctx, examFormatDetails });
      break;
    default:
      return null;
  }

  const { system, user } = builder({ className, moduleKey, desc, familiarityLevel });

  const json = fmt === 'video'
    ? await callVideoJsonWithValidation({ apiKey, system, user, tools })
    : fmt === 'reading'
    ? await callReadingJsonWithValidation({ apiKey, system, user, tools })
    : fmt === 'flashcards'
    ? await callFlashcardsJsonWithValidation({ apiKey, system, user, tools })
    : fmt === 'mini quiz'
    ? await callModelJson({ apiKey, system, user, tools, model: MINI_QUIZ_MODEL, fallbackModel: MINI_QUIZ_FALLBACK })
    : await callPracticeExamJsonWithValidation({ apiKey, system, user, tools });

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
  let cursor = 0;
  let active = 0;

  return new Promise((resolve) => {
    const next = () => {
      if (cursor >= tasks.length && active === 0) {
        resolve(results);
        return;
      }

      while (active < limit && cursor < tasks.length) {
        const index = cursor;
        cursor += 1;
        active += 1;
        Promise.resolve()
          .then(tasks[index])
          .then((value) => {
            results[index] = { ok: true, value };
          })
          .catch((error) => {
            results[index] = { ok: false, error };
          })
          .finally(() => {
            active -= 1;
            next();
          });
      }
    };

    next();
  });
}

export async function generateAssetsContent(structure, ctx) {
  const { supabase, userId, courseId, className, examFormatDetails, apiKey, topicFamiliarity } = ctx;
  if (!supabase || !userId || !courseId) return structure;

  let familiarityLevel = 'medium';
  if (Array.isArray(topicFamiliarity) && topicFamiliarity.length > 0) {
    const map = { low: 1, medium: 2, high: 3 };
    const avg =
      topicFamiliarity.reduce((sum, entry) => sum + (map[entry?.familiarity?.toLowerCase()] || 2), 0) /
      topicFamiliarity.length;
    familiarityLevel = avg < 1.7 ? 'low' : avg > 2.3 ? 'high' : 'medium';
  }

  const moduleKeys = Object.keys(structure || {});
  const tasks = [];
  const locations = [];

  for (const moduleKey of moduleKeys) {
    const assets = Array.isArray(structure[moduleKey]) ? structure[moduleKey] : [];
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      const fmt = asset?.Format?.toLowerCase?.();
      if (!tableForFormat(fmt)) {
        assets[index] = null;
        continue;
      }

      locations.push({ moduleKey, index });
      tasks.push(async () => {
        const id = await generateOneAsset({
          apiKey,
          supabase,
          userId,
          courseId,
          className,
          examFormatDetails,
          moduleKey,
          asset,
          familiarityLevel,
        });
        return { id };
      });
    }
  }

  const promises = await runLimited(tasks, 3);
  for (let i = 0; i < promises.length; i += 1) {
    const loc = locations[i];
    const res = promises[i];
    const arr = structure[loc.moduleKey];
    if (!res?.ok || !res.value?.id) {
      arr[loc.index] = null;
    } else {
      arr[loc.index] = { ...(arr[loc.index] || {}), id: res.value.id };
    }
  }

  for (const moduleKey of moduleKeys) {
    const filtered = (structure[moduleKey] || []).filter(Boolean);
    if (filtered.length === 0) {
      delete structure[moduleKey];
    } else {
      structure[moduleKey] = filtered;
    }
  }

  return structure;
}
