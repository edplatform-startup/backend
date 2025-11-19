import { runtimeConfig } from '../config/env.js';

const DEFAULT_CHAT_ENDPOINT = process.env.OPENROUTER_CHAT_URL || 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL = 'x-ai/grok-4-fast';
const DEFAULT_MAX_TOOL_ITERATIONS = 1;
const MAX_TOTAL_CALLS = 6;
const TOOL_RESULT_CHAR_LIMIT = 2000;

const browsePageCache = new Map();

let customStudyTopicsGenerator = null;
let customChatExecutor = null;

export function setStudyTopicsGenerator(fn) {
  customStudyTopicsGenerator = typeof fn === 'function' ? fn : null;
}

export function clearStudyTopicsGenerator() {
  customStudyTopicsGenerator = null;
}

export function setOpenRouterChatExecutor(fn) {
  customChatExecutor = typeof fn === 'function' ? fn : null;
}

export function clearOpenRouterChatExecutor() {
  customChatExecutor = null;
}

function resolveApiKey(explicitKey) {
  const apiKey = explicitKey || process.env.OPENROUTER_GROK_4_FAST_KEY || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OpenRouter API key (set OPENROUTER_GROK_4_FAST_KEY or OPENROUTER_API_KEY)');
  }
  return apiKey;
}

function sanitizeReasoning(reasoning) {
  if (reasoning == null) return undefined;

  if (typeof reasoning === 'boolean') {
    return { enabled: reasoning };
  }

  if (typeof reasoning === 'string') {
    return { enabled: true, effort: reasoning };
  }

  if (typeof reasoning === 'object') {
    const result = {};
    if (Object.prototype.hasOwnProperty.call(reasoning, 'enabled')) {
      result.enabled = Boolean(reasoning.enabled);
    } else {
      result.enabled = true;
    }
    if (reasoning.effort) {
      result.effort = reasoning.effort;
    }
    if (reasoning.limits) {
      result.limits = reasoning.limits;
    }
    return result;
  }

  return undefined;
}

function formatToolDefinitions(tools) {
  if (!Array.isArray(tools) || tools.length === 0) {
    return { definitions: [], handlers: new Map() };
  }

  const definitions = [];
  const handlers = new Map();

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue;
    const {
      name,
      description = '',
      parameters = { type: 'object', properties: {}, required: [] },
      handler,
    } = tool;

    if (!name) continue;

    definitions.push({
      type: 'function',
      function: {
        name,
        description,
        parameters,
      },
    });

    if (typeof handler === 'function') {
      handlers.set(name, handler);
    }
  }

  return { definitions, handlers };
}

function stripCodeFences(raw) {
  if (typeof raw !== 'string') return '';
  return raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function parseToolArguments(rawArgs) {
  if (rawArgs == null) return {};

  let source = rawArgs;
  if (typeof rawArgs === 'string') {
    source = stripCodeFences(rawArgs);
  }

  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (!trimmed) {
      return {};
    }
    try {
      return JSON.parse(trimmed);
    } catch (error) {
      console.warn('Failed to parse tool arguments:', error);
      return {};
    }
  }

  if (typeof source === 'object') {
    return source;
  }

  return {};
}

function sanitizeToolContent(content) {
  if (content == null) return '';
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  return str.length > TOOL_RESULT_CHAR_LIMIT ? `${str.slice(0, TOOL_RESULT_CHAR_LIMIT)}\n[truncated]` : str;
}

function isLikelyText(buffer) {
  if (!buffer || buffer.length === 0) return false;
  let printable = 0;
  const len = Math.min(buffer.length, 4096);
  for (let i = 0; i < len; i++) {
    const c = buffer[i];
    // allow common whitespace and printable ASCII
    if (
      c === 9 || c === 10 || c === 13 || // tab, LF, CR
      (c >= 32 && c <= 126)
    ) {
      printable++;
    }
  }
  return printable / len > 0.85;
}

function decodeBase64ToUtf8Safe(b64) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const isPdf = buf.slice(0, 4).toString('utf8') === '%PDF';
    if (isPdf) {
      return { text: '[PDF attachment detected; text extraction deferred to browse_page tool.]', isPdf: true };
    }
    if (!isLikelyText(buf)) {
      return { text: '[content omitted: non-text or undecodable]', isPdf: false };
    }
    const text = buf.toString('utf8');
    // If decoding produced the Unicode replacement character, treat as undecodable binary
    if (text.includes('\uFFFD')) {
      return { text: '[content omitted: undecodable binary data]', isPdf: false };
    }
    return { text, isPdf: false };
  } catch {
    return { text: '[content omitted: failed to decode attachment]', isPdf: false };
  }
}

function buildAttachmentsInlineText(attachments, opts = {}) {
  const maxPerFileChars = opts.maxPerFileChars || 8000;
  const maxTotalChars = opts.maxTotalChars || 24000;
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  let out = [];
  let total = 0;
  let index = 1;
  for (const att of attachments) {
    if (!att || typeof att !== 'object') continue;
    const name = att.name || `file_${index}`;
    const mime = att.mimeType || att.mime_type || att.type || 'file';
    let header = `File ${index}: ${name} (${mime})`;
    let body = '';
    if (att.data) {
      const decoded = decodeBase64ToUtf8Safe(att.data);
      body = (decoded.text || '').trim();
    } else if (att.url) {
      const isPdfUrl = /\.pdf($|\?)/i.test(att.url);
      body = isPdfUrl
        ? `URL provided: ${att.url} (PDF detected; use browse_page for extraction)`
        : `URL provided: ${att.url}`;
    } else {
      body = '[no data or url provided]';
    }

    if (!body.trim()) {
      body = '[content omitted: empty attachment]';
    }

    if (body.length > maxPerFileChars) {
      body = body.slice(0, maxPerFileChars) + '\n[truncated]';
    }

    const block = `${header}\n${body}`;
    if (total + block.length > maxTotalChars) {
      out.push('[additional files truncated due to size]');
      break;
    }
    out.push(block);
    total += block.length;
    index++;
  }
  if (out.length === 0) return '';
  return [
    'Attached materials (inlined as text for models without file-input support):',
    '---',
    out.join('\n\n---\n\n'),
  ].join('\n');
}

export function createBrowsePageTool() {
  return {
    name: 'browse_page',
    description: 'Fetch and read the full content of a specific webpage URL.',
    parameters: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the page to browse and extract content from.'
        }
      },
      required: ['url']
    },
    handler: async (args) => {
      const url = args?.url || '';
      if (!url || !url.startsWith('http')) {
        return 'Invalid URL provided for browse_page.';
      }

      if (browsePageCache.has(url)) {
        return browsePageCache.get(url);
      }
      
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; EdTechBot/1.0)',
          },
          signal: AbortSignal.timeout(180000), // 30s timeout for browse_page
        });
        
        if (!response.ok) {
          const failure = `Failed to fetch page: ${response.status} ${response.statusText}`;
          browsePageCache.set(url, failure);
          return failure;
        }

        const contentType = response.headers.get('content-type') || '';
        const isPdf = /pdf/i.test(contentType) || /\.pdf($|\?)/i.test(url);
        if (isPdf) {
          const simulated = `Simulated PDF extraction for ${url}. Use syllabus bullet points from PDF when forming topics.`;
          browsePageCache.set(url, simulated);
          return simulated;
        }
        
        const text = await response.text();
        // Simple text extraction - strip HTML tags and limit size
        const cleanText = sanitizeToolContent(
          text
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
        );

        const finalText = cleanText || 'Page content could not be extracted.';
        browsePageCache.set(url, finalText);
        return finalText;
      } catch (error) {
        console.error('[browse_page] error:', error);
        const message = `Error browsing page: ${error.message}`;
        browsePageCache.set(url, message);
        return message;
      }
    },
  };
}

export function createWebSearchTool() {
  return {
    name: 'web_search',
    description: 'Run a quick web search and summarize the top suggestions for further browsing.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query to run on DuckDuckGo suggestions.' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = (args?.query || '').trim();
      if (!query) return 'No query provided to web_search.';

      const endpoint = `https://duckduckgo.com/ac/?q=${encodeURIComponent(query)}`;
      try {
        const response = await fetch(endpoint, {
          headers: { 'User-Agent': 'EdTechBot/1.0' },
          signal: AbortSignal.timeout(10000),
        });

        if (!response.ok) {
          return `web_search failed: ${response.status} ${response.statusText}`;
        }

        let suggestions;
        try {
          suggestions = await response.json();
        } catch (error) {
          console.error('[web_search] failed to parse suggestions:', error);
          return 'web_search could not parse results.';
        }

        if (!Array.isArray(suggestions) || suggestions.length === 0) {
          return `No web search suggestions found for "${query}".`;
        }

        const lines = suggestions
          .map((entry, index) => {
            const phrase = (entry?.phrase || entry?.text || entry?.value || '').trim();
            if (!phrase) return null;
            return `${index + 1}. ${phrase}`;
          })
          .filter(Boolean)
          .slice(0, 5);

        if (lines.length === 0) {
          return `No web search suggestions found for "${query}".`;
        }

        return [
          `Top web search suggestions for "${query}":`,
          ...lines,
          'Use browse_page on one of these results (if a concrete URL is known) to gather details.',
        ].join('\n');
      } catch (error) {
        console.error('[web_search] error:', error);
        return `Error running web_search: ${error.message}`;
      }
    },
  };
}

const pluginToolHandlerCache = new Map();

function getPluginToolHandler(name) {
  if (pluginToolHandlerCache.has(name)) {
    return pluginToolHandlerCache.get(name);
  }

  let handler = null;
  if (name === 'browse_page') {
    handler = createBrowsePageTool().handler;
  } else if (name === 'web_search') {
    handler = createWebSearchTool().handler;
  }

  if (handler) {
    pluginToolHandlerCache.set(name, handler);
  }

  return handler;
}

async function callOpenRouterApi({ endpoint, apiKey, body, signal, meta = {} }) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const shouldRetry = attempt < MAX_RETRIES;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://api.kognolearn.com',
          'X-Title': 'EdTech Study Planner',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        const err = new Error(`OpenRouter request failed: ${response.status} ${response.statusText}`);
        err.details = errorText;
        err.statusCode = response.status;
        // Detect token limit errors from provider error text and annotate
        try {
          const t = String(errorText || '').toLowerCase();
          if (/(token(s)? (limit|exceed|exceeded|too many|max_tokens|max tokens|maximum context length|context_length|context length))/.test(t)) {
            err.isTokenLimit = true;
            err.tokenLimitDetails = {
              model: (body && (body.model || body.modelName)) || meta.model || 'unknown',
              maxTokens: (body && body.max_tokens) || (body && body.maxTokens) || null,
              stage: meta.stage || 'unknown',
              originalMessage: errorText,
            };
            const tokenMeta = err.tokenLimitDetails;
            console.error(`\[openrouter\]\[TOKEN\] model hit token limit: stage=${tokenMeta.stage} model=${tokenMeta.model} maxTokens=${tokenMeta.maxTokens ?? 'unknown'}`);
          }
        } catch (ignore) {}
        if (shouldRetry && (response.status === 502 || response.status === 400)) {
          const backoff = 2000 * (attempt + 1);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }
        throw err;
      }

      const text = await response.text();
      if (!text || text.trim() === '') {
        const err = new Error('OpenRouter returned empty response');
        err.statusCode = 502;
        err.details = 'The API returned a 200 OK but with no content';
        throw err;
      }

      try {
        return JSON.parse(text);
      } catch (error) {
        const err = new Error('OpenRouter returned invalid JSON');
        err.statusCode = 502;
        err.details = `Failed to parse response: ${error.message}`;
        err.responsePreview = text.slice(0, 500);
        throw err;
      }
    } catch (error) {
      const isAbort = error?.name === 'AbortError';
      if (shouldRetry && (isAbort || error?.statusCode === 502 || error?.statusCode === 400)) {
        const backoff = 2000 * (attempt + 1);
        console.warn('[openrouter] retrying after error:', error.message);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        continue;
      }
      const stageLabel = meta?.stage || 'unknown';
      const modelLabel = meta?.model || body?.model || body?.modelName || 'unknown';
      console.error(`[openrouter] request failed: stage=${stageLabel} model=${modelLabel}`, error);
      throw error;
    }
  }
  throw new Error('OpenRouter request failed after retries');
}

export async function executeOpenRouterChat(options = {}) {
  if (customChatExecutor) {
    return await customChatExecutor(options);
  }

  const {
    messages,
    model = DEFAULT_MODEL,
    temperature = 0.5,
    topP,
    frequencyPenalty,
    presencePenalty,
    maxTokens = 600,
    reasoning,
    tools = [],
    toolChoice,
    maxToolIterations = DEFAULT_MAX_TOOL_ITERATIONS,
    endpoint = DEFAULT_CHAT_ENDPOINT,
    apiKey: explicitApiKey,
    signal,
    attachments = [],
    attachmentsInlineOptions,
    responseFormat,
    requestTimeoutMs = 55000,
    enableWebSearch = false,
  } = options;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages array is required');
  }

  const apiKey = resolveApiKey(explicitApiKey);
  const conversation = messages.map((msg) => ({ ...msg }));
  const validatedAttachments = Array.isArray(attachments)
    ? attachments.filter((att) => att && typeof att === 'object')
    : [];
  const { definitions: toolDefinitions, handlers: toolHandlers } = formatToolDefinitions(tools);
  const reasoningPayload = sanitizeReasoning(reasoning);
  const isAnthropicModel = model.startsWith('anthropic/');
  const shouldInlineAttachments = typeof model === 'string' && /^x-ai\/grok/.test(model);
  if (shouldInlineAttachments && validatedAttachments.length > 0) {
    const inlineText = buildAttachmentsInlineText(validatedAttachments, attachmentsInlineOptions);
    if (inlineText) {
      conversation.push({ role: 'user', content: inlineText });
    }
  }

  let iterations = 0;
  let forceFinalRun = false;
  let finalRunAttempts = 0;

  while (true) {
    let effectiveModel = model;
    const requestBody = {
      model: effectiveModel,
      max_tokens: maxTokens,
      temperature,
      messages: conversation,
    };

    if (enableWebSearch) {
      requestBody.plugins = [{ id: 'web' }];
    }

    if (typeof topP === 'number') requestBody.top_p = topP;
    if (typeof frequencyPenalty === 'number') requestBody.frequency_penalty = frequencyPenalty;
    if (typeof presencePenalty === 'number') requestBody.presence_penalty = presencePenalty;
    if (reasoningPayload !== undefined) requestBody.reasoning = reasoningPayload;
    if (responseFormat && typeof responseFormat === 'object') {
      requestBody.response_format = responseFormat;
    }

    if (!forceFinalRun && toolDefinitions.length > 0) {
      requestBody.tools = toolDefinitions;
      requestBody.tool_choice = toolChoice || 'auto';
    } else if (forceFinalRun) {
      requestBody.tool_choice = 'none';
    }

    if (!shouldInlineAttachments && validatedAttachments.length > 0) {
      requestBody.attachments = validatedAttachments.map((attachment, index) => {
        const { type, mimeType, data, url, name } = attachment;
        const normalized = { type: type || 'file' };
        if (mimeType) normalized.mime_type = mimeType;
        if (name) normalized.name = name;
        if (url) normalized.url = url;
        if (data) normalized.data = data;
        normalized.id = attachment.id || `attachment_${index + 1}`;
        return normalized;
      });
    }

    let controller;
    let timer;
    let effectiveSignal = signal;
    if (!effectiveSignal && requestTimeoutMs && requestTimeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      effectiveSignal = controller.signal;
    } else if (signal && requestTimeoutMs && requestTimeoutMs > 0) {
      controller = new AbortController();
      if (typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
      }
      timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      effectiveSignal = controller.signal;
    }

    let payload;
    try {
      try {
        payload = await callOpenRouterApi({ endpoint, apiKey, body: requestBody, signal: effectiveSignal, meta: { stage: options?.stage || 'unknown', model: effectiveModel } });
      } catch (error) {
        // Provide additional logging for token limit errors, including stage and maxTokens
        if (error && error.isTokenLimit) {
          const d = error.tokenLimitDetails || {};
          const stageLabel = d.stage || options?.stage || 'unknown';
          const modelLabel = d.model || effectiveModel;
          const tokenLimit = d.maxTokens || requestBody?.max_tokens || 'unknown';
          const errMsg = d.originalMessage || error.message || String(error);
          console.error(`[openrouter][TOKEN] request failed: stage=${stageLabel}, model=${modelLabel}, maxTokens=${tokenLimit}; error=${errMsg}`);
        }
        throw error;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
    try {
      accumulateUsage(effectiveModel, payload?.usage || payload?.meta?.usage || {});
    } catch {}
    const message = payload?.choices?.[0]?.message;

    if (!message) {
      throw new Error('OpenRouter response missing message');
    }

    conversation.push(message);
    const toolCalls = message.tool_calls || (isAnthropicModel && message.content ? message.content.filter(c => c.type === 'tool_use') : []);

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return {
        content: message.content,
        message,
        response: payload,
      };
    }

    if (forceFinalRun) {
      finalRunAttempts += 1;
      conversation.push({
        role: 'system',
        content: 'Tool responses received but tool usage disabled. Provide final JSON response immediately.',
      });
      if (finalRunAttempts > 2) {
        throw new Error('Model failed to provide final answer without tools.');
      }
      continue;
    }

    if (iterations >= maxToolIterations) {
      forceFinalRun = true;
      conversation.push({
        role: 'system',
        content: 'Tool limit reached. Respond next message with JSON { "topics": [...] } without calling tools.',
      });
      continue;
    }

    iterations += 1;

    let toolResponseMessages = [];
    for (const call of toolCalls) {
      const toolName = call?.function?.name || call.name;
      const args = parseToolArguments(call?.function?.arguments || call.input);
      const callId = call.id;

      let toolResult;
      try {
        let handler = toolHandlers.get(toolName);
        if (!handler) {
          handler = getPluginToolHandler(toolName);
        }

        if (handler) {
          toolResult = await handler(args, {
            apiKey,
            tool: toolName,
            iteration: iterations,
            messages: conversation,
          });
        } else {
          toolResult = `Tool "${toolName}" not supported.`;
        }
      } catch (error) {
        console.error(`[tool:${toolName}] execution error:`, error);
        toolResult = `Tool ${toolName || 'unknown'} threw an error: ${error.message}`;
      }

      const sanitizedResult = sanitizeToolContent(toolResult);

      if (isAnthropicModel) {
        toolResponseMessages.push({
          type: 'tool_result',
          tool_use_id: callId,
          content: sanitizedResult
        });
      } else {
        conversation.push({
          role: 'tool',
          tool_call_id: callId,
          name: toolName,
          content: sanitizedResult,
        });
      }
    }

    if (isAnthropicModel && toolResponseMessages.length > 0) {
      conversation.push({
        role: 'user',
        content: toolResponseMessages
      });
    }
  }
}

function buildStudyTopicsPrompt({
  finishByDate,
  timeRemainingDays,
  courseSelection,
  syllabusText,
  syllabusFiles,
  examFormatDetails,
  examFiles,
} = {}) {
  const lines = [];
  const cs = courseSelection || {};
  const college = cs.college || cs.institution || cs.university || cs.school || '';
  const title = cs.title || cs.course || cs.name || cs.courseTitle || '';
  const code = cs.code || cs.id || '';
  const courseLabel = [college, [code, title].filter(Boolean).join(' ')].filter(Boolean).join(' — ') || 'this course';

  lines.push(`Derive exam topics directly from the official syllabus for ${courseLabel}.`);
  lines.push('Always prioritize primary sources (.edu syllabus, handbook, exam brief). Search the web if attachments/text are insufficient, then browse the best syllabus link once to extract bullet topics.');
  lines.push('Topics must be domain concepts or prerequisite knowledge needed on the exam. Strictly exclude logistics or meta items (no "Exam Review", "Study Skills", etc.).');
  lines.push('Return ONLY valid JSON shaped as { "topics": ["Topic1", ...] } with 15-30 distinct entries ordered by syllabus flow.');
  lines.push('');
  lines.push('Context for alignment:');
  if (finishByDate) lines.push(`- Target exam date: ${finishByDate}`);
  if (typeof timeRemainingDays === 'number') lines.push(`- Days remaining: ${timeRemainingDays}`);
  if (syllabusText) {
    lines.push('- Syllabus notes:');
    lines.push(syllabusText);
  }
  if (Array.isArray(syllabusFiles) && syllabusFiles.length) {
    lines.push('- Syllabus files provided.');
  }
  if (examFormatDetails) {
    lines.push(`- Exam format: ${examFormatDetails}`);
  }
  if (Array.isArray(examFiles) && examFiles.length) {
    lines.push('- Exam files provided.');
  }

  return lines.join('\n');
}

const STUDY_TOPICS_SYSTEM_PROMPT = [
  'You are an AI study coach extracting exhaustive, accurate course topics. ALWAYS use your built-in web search before giving the final answer, and call browse_page at most once if needed for a specific URL.',
  'Priorities: search for an official syllabus/outline (prefer .edu), extract every bullet/topic, focus strictly on domain concepts (e.g., "Two\'s Complement", "Stack Frames"). Never include meta-skills like study habits, time management, or revision strategies.',
  'Good output example: {"topics":["Instruction Set Architecture","Two\'s Complement Arithmetic","Pipeline Hazards","Cache Coherence"]}',
  'Bad output examples: {"topics":["Study Skills","Time Management"]} or "1. Topic One" (not JSON).',
  'Return ONLY valid JSON shaped exactly as {"topics":["Topic1","Topic2",...]}. Ensure 15-30 precise, course-scoped topics, with no duplicates.'
].join('\n\n');

export function parseTopicsText(raw) {
  const original = (raw || '').toString();
  const stripped = stripCodeFences(original).trim();
  if (!stripped) return [];

  const looksJson = stripped.startsWith('{') || stripped.startsWith('[');
  if (looksJson) {
    try {
      const parsed = JSON.parse(stripped);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.topics) ? parsed.topics : null);
      if (Array.isArray(arr)) {
        const seen = new Set();
        const deduped = [];
        for (const entry of arr) {
          if (entry == null) continue;
          const value = typeof entry === 'string' ? entry.trim() : String(entry).trim();
          if (!value) continue;
          const key = value.toLowerCase();
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(value);
          if (deduped.length >= 100) break;
        }
        return deduped;
      }
      return [];
    } catch {
      return [];
    }
  }

  const seen = new Set();
  const deduped = [];
  const candidates = stripped
    .replace(/\r?\n+/g, ',')
    .replace(/\s+-\s+/g, ',')
    .split(',');
  for (const raw of candidates) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(value);
    if (deduped.length >= 100) break;
  }
  return deduped;
}

function isGenericTopicList(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return true;
  const banned = [
    'study', 'time management', 'note', 'exam', 'review', 'revision', 'learning strategies', 'productivity', 'mindset', 'motivation', 'test-taking',
    'introduction', 'intro', 'overview', 'basics', 'fundamentals', 'principles', 'concepts', 'summary', 'general tips'
  ];
  const lc = topics.map((t) => t.toLowerCase());
  const hasBanned = lc.some((t) => banned.some((b) => t.includes(b)));
  if (hasBanned) return true;
  if (topics.length < 10 || topics.length > 40) return true;
  return false;
}

// --- Lightweight usage/cost tracking ---
const __usageTotals = { prompt: 0, completion: 0, total: 0, usd: 0, calls: 0, perModel: {} };

function getPriceForModel(model) {
  const envMap = runtimeConfig.openrouterPriceMap;
  const defaultMap = {
    'anthropic/claude-sonnet-4': { in: 0.003, out: 0.015 },
    'x-ai/grok-4-fast': { in: 0.001, out: 0.002 },
    'google/gemini-2.5-flash': { in: 0.0006, out: 0.0018 },
    'nousresearch/hermes-4-70b': { in: 0.0005, out: 0.001 },
    'anthropic/claude-haiku-3.5': { in: 0.0008, out: 0.004 },
    'x-ai/grok-3-beta': { in: 0.001, out: 0.002 },
    'deepseek/deepseek-v3': { in: 0.001, out: 0.0025 },
    'deepseek/deepseek-coder-v2': { in: 0.0008, out: 0.002 },
    'microsoft/phi-3.5-mini-128k': { in: 0.0002, out: 0.0006 },
  };
  const map = envMap || defaultMap;
  return map[model] || { in: 0, out: 0 };
}

export function getCostTotals() {
  return JSON.parse(JSON.stringify(__usageTotals));
}

function accumulateUsage(model, usage) {
  if (!usage) return;
  const prompt = Number(usage.prompt_tokens || usage.input_tokens || 0) || 0;
  const completion = Number(usage.completion_tokens || usage.output_tokens || 0) || 0;
  const total = Number(usage.total_tokens || prompt + completion || 0) || (prompt + completion);
  const price = getPriceForModel(model);
  const usd = (prompt * price.in + completion * price.out) / 1000;
  __usageTotals.prompt += prompt;
  __usageTotals.completion += completion;
  __usageTotals.total += total;
  __usageTotals.usd += usd;
  __usageTotals.calls += 1;
  if (!__usageTotals.perModel[model]) {
    __usageTotals.perModel[model] = { prompt: 0, completion: 0, total: 0, usd: 0, calls: 0 };
  }
  __usageTotals.perModel[model].prompt += prompt;
  __usageTotals.perModel[model].completion += completion;
  __usageTotals.perModel[model].total += total;
  __usageTotals.perModel[model].usd += usd;
  __usageTotals.perModel[model].calls += 1;
}

export async function generateStudyTopics(input) {
  if (customStudyTopicsGenerator) {
    return await customStudyTopicsGenerator(input);
  }

  const usageStart = getCostTotals();
  const prompt = buildStudyTopicsPrompt(input || {});
  const model = input?.model || runtimeConfig.stageModels?.planner || DEFAULT_MODEL;

  const normalizedAttachments = (Array.isArray(input?.attachments) ? input.attachments : [])
    .filter((att) => att && typeof att === 'object');

  const fallbackFromFiles = (files = [], label = 'file') =>
    files
      .filter((file) => file && typeof file === 'object')
      .map((file, index) => ({
        type: 'file',
        name: `${label}-${index + 1}-${file.name || 'attachment'}`,
        mimeType: file.type,
        data: file.content,
        url: file.url,
      }));

  const attachments = normalizedAttachments.length
    ? normalizedAttachments
    : [
        ...fallbackFromFiles(input?.syllabusFiles, 'syllabus'),
        ...fallbackFromFiles(input?.examFiles, 'exam'),
      ].filter((att) => att.url || att.data);

  const primaryMessages = [
    { role: 'system', content: STUDY_TOPICS_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const chatArgs = {
    model: model.includes(':online') ? model : `${model}:online`,
    temperature: 0.45,
    maxTokens: 900,
    tools: [createWebSearchTool(), createBrowsePageTool()],
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
    enableWebSearch: true,
    attachments,
    attachmentsInlineOptions: { maxPerFileChars: 4000, maxTotalChars: 12000 },
    messages: primaryMessages,
  };

  const first = await executeOpenRouterChat(chatArgs);
  const firstText = Array.isArray(first.content)
    ? first.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('').trim()
    : typeof first.content === 'string'
      ? first.content.trim()
      : '';

  const coerceTopics = (raw) => {
    const stripped = stripCodeFences(raw);
    if (!stripped) {
      throw new Error('Empty response');
    }
    let json;
    try {
      json = JSON.parse(stripped);
    } catch (error) {
      throw new Error(`Invalid JSON: ${error.message}`);
    }
    const arr = Array.isArray(json)
      ? json
      : (json && Array.isArray(json.topics) ? json.topics : null);
    if (!Array.isArray(arr) || arr.length === 0) {
      throw new Error('topics array missing or empty');
    }
    const deduped = [];
    const seen = new Set();
    for (const entry of arr) {
      if (entry == null) continue;
      const value = typeof entry === 'string' ? entry.trim() : String(entry).trim();
      if (!value) continue;
      const lower = value.toLowerCase();
      if (seen.has(lower)) continue;
      if (/exam|review|study skills|time management|revision/i.test(value)) continue;
      seen.add(lower);
      deduped.push(value);
      if (deduped.length >= 30) break;
    }
    if (!deduped.length) {
      throw new Error('topics array became empty after filtering');
    }
    return deduped;
  };

  let topics;
  try {
    topics = coerceTopics(firstText);
  } catch (error) {
    const repairMessages = [
      { role: 'system', content: 'You repair JSON into valid {"topics":[...]} format. Return ONLY corrected JSON.' },
      {
        role: 'user',
        content: `Original response:\n${firstText || '[empty]'}\n\nError: ${error.message}`,
      },
    ];
    const repair = await executeOpenRouterChat({
      model,
      temperature: 0.2,
      maxTokens: 400,
      messages: repairMessages,
    });
    const repairText = Array.isArray(repair.content)
      ? repair.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('').trim()
      : typeof repair.content === 'string'
        ? repair.content.trim()
        : '';
    topics = coerceTopics(repairText);
  }

  if (!topics || topics.length === 0) {
    throw new Error('Model returned no usable topics');
  }

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
      console.log('[topics] usage:', delta);
    }
  } catch {}

  return JSON.stringify({ topics });
}

