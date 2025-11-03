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
          signal: AbortSignal.timeout(30000), // 30s timeout for browse_page
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

async function callOpenRouterApi({ endpoint, apiKey, body, signal }) {
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const shouldRetry = attempt < MAX_RETRIES;
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://edtech-backend-api.onrender.com',
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
      console.error('[openrouter] request failed:', error);
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
    const inlineText = buildAttachmentsInlineText(validatedAttachments);
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
      payload = await callOpenRouterApi({ endpoint, apiKey, body: requestBody, signal: effectiveSignal });
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
        const handler = toolHandlers.get(toolName);
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
  lines.push('You are an AI study planner extracting topics. Output ONLY a JSON array of domain-specific topics (strings, no extras).');
  lines.push('Prohibited: meta-skills like study skills, time management, note-taking, exam strategies, revision, productivity.');
  lines.push('Tasks:');
  lines.push('1. Analyze provided syllabus text/files and exam details.');
  // Build web_search query from courseSelection
  let query = '';
  if (courseSelection) {
    const cs = courseSelection || {};
    const code = cs.code || cs.id || '';
    const title = cs.title || cs.course || cs.name || cs.courseTitle || '';
    query = [code, title].filter(Boolean).join(' ');
  }
  if (query) {
    lines.push(`2. Use your built-in web search for: "${query} official syllabus outline site:.edu" to locate and incorporate the official syllabus.`);
  } else {
    lines.push('2. Use your built-in web search for "official syllabus outline site:.edu" plus relevant keywords to locate and incorporate the official syllabus.');
  }
  lines.push('3. Call browse_page once on the best syllabus/exam link (instructions: "Extract all listed topics, subtopics, and learning objectives as bullet points") if needed for full extraction.');
  lines.push('4. Cross-reference for completeness: include prerequisites, examples, and exam-covered concepts while staying within the course scope.');
  lines.push('5. Limit to at most one browse_page call.');
  lines.push('6. Ensure 15-30 topics covering every course element for exam success.');
  lines.push('7. Respond with ONLY: { "topics": ["Topic1", "Topic2", ...] }');
  lines.push('');
  lines.push('Provided context:');

  if (courseSelection) {
    const cs = courseSelection || {};
    const college = cs.college || cs.institution || cs.university || cs.school || '';
    const title = cs.title || cs.course || cs.name || cs.courseTitle || '';
    const code = cs.code || cs.id || '';
    const courseLabel = [college, [code, title].filter(Boolean).join(' ')].filter(Boolean).join(' — ');
    if (courseLabel) {
      lines.push(`- Course: ${courseLabel}`);
    }
  }
  if (finishByDate) {
    lines.push(`- Target Exam/Completion Date: ${finishByDate}`);
  }
  if (typeof timeRemainingDays === 'number') {
    lines.push(`- Time remaining (days): ${timeRemainingDays}`);
  }
  if (syllabusText) {
    lines.push('- Syllabus Text:');
    lines.push(syllabusText);
  }
  if (Array.isArray(syllabusFiles) && syllabusFiles.length) {
    lines.push('- Syllabus Files:');
    lines.push(
      syllabusFiles
        .map((file, index) => `  ${index + 1}. ${file.name}${file.url ? ` (${file.url})` : ''}`)
        .join('\n')
    );
  }
  if (examFormatDetails) {
    lines.push(`- Exam Format Details: ${examFormatDetails}`);
  }
  if (Array.isArray(examFiles) && examFiles.length) {
    lines.push('- Exam Files:');
    lines.push(
      examFiles
        .map((file, index) => `  ${index + 1}. ${file.name}${file.url ? ` (${file.url})` : ''}`)
        .join('\n')
    );
  }

  lines.push('');
  lines.push('Use built-in search before final output.');

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
  const envMap = process.env.OPENROUTER_PRICE_MAP ? (() => { try { return JSON.parse(process.env.OPENROUTER_PRICE_MAP); } catch { return null; } })() : null;
  const defaultMap = {
    'anthropic/claude-sonnet-4': { in: 0.003, out: 0.015 },
    'x-ai/grok-4-fast': { in: 0.001, out: 0.002 },
    'google/gemini-2.5-flash': { in: 0.0006, out: 0.0018 },
    'openai/gpt-4o': { in: 0.005, out: 0.015 },
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

  const apiKey = resolveApiKey();
  const requestedModel = input?.model || 'anthropic/claude-sonnet-4';
  const fallbackModel = 'x-ai/grok-4-fast';
  const prompt = buildStudyTopicsPrompt(input || {});

  // Prepare attachments from syllabusFiles and examFiles
  const attachments = [];
  if (Array.isArray(input?.syllabusFiles)) {
    attachments.push(...input.syllabusFiles);
  }
  if (Array.isArray(input?.examFiles)) {
    attachments.push(...input.examFiles);
  }

  const primaryModel = requestedModel.includes(':online') ? requestedModel : `${requestedModel}:online`;
  let totalCallsUsed = 0;
  const consumeCall = () => {
    if (totalCallsUsed >= MAX_TOTAL_CALLS) {
      throw new Error('Study topics call budget exhausted');
    }
    totalCallsUsed += 1;
  };

  const baseMessages = [
    { role: 'system', content: STUDY_TOPICS_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const runOnceWithModel = async (mdl, extraUserMessage, { requireTools = true } = {}) => {
    const messages = extraUserMessage ? [...baseMessages, { role: 'user', content: extraUserMessage }] : baseMessages;
    const timeouts = [35000];
    let lastErr;

    for (let idx = 0; idx < timeouts.length; idx += 1) {
      try {
        consumeCall();
        const { content } = await executeOpenRouterChat({
          apiKey,
          model: mdl,
          reasoning: { enabled: true, effort: 'medium' },
          temperature: 0.2,
          maxTokens: 1200,
          tools: requireTools ? [createBrowsePageTool()] : [],
          toolChoice: requireTools ? 'auto' : undefined,
          maxToolIterations: requireTools ? 1 : 0,
          requestTimeoutMs: timeouts[idx],
          responseFormat: { type: 'json_object' },
          messages,
          attachments,
          enableWebSearch: true,
        });

        const text = Array.isArray(content)
          ? content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('').trim()
          : typeof content === 'string' ? content.trim() : '';

        const topics = parseTopicsText(text);
        return { text, topics };
      } catch (err) {
        lastErr = err;
        if (err?.name === 'AbortError' && idx < timeouts.length - 1) {
          continue;
        }
        throw err;
      }
    }

    if (lastErr) throw lastErr;

    return { text: '', topics: [] };
  };

  const runOnce = async (extraUserMessage) => {
    try {
      return await runOnceWithModel(primaryModel, extraUserMessage, { requireTools: true });
    } catch (err) {
      if (err?.name === 'AbortError') {
        try {
          return await runOnceWithModel(primaryModel, extraUserMessage, { requireTools: false });
        } catch {/* ignore and fall through */}
      }
      try {
        return await runOnceWithModel(fallbackModel, extraUserMessage, { requireTools: true });
      } catch (e2) {
        if (e2?.name === 'AbortError') {
          return await runOnceWithModel(fallbackModel, extraUserMessage, { requireTools: false });
        }
        throw e2;
      }
    }
  };

  let attempt = 0;
  let last = await runOnce();
  while (attempt < 1 && isGenericTopicList(last.topics)) {
    attempt += 1;
    const correction = [
      'Correction: Previous output included generics, meta-skills, or insufficient coverage (fewer than 15 topics or missing syllabus elements).',
      'Requirements:',
      '- Use built-in web search to extract FULL syllabus topics/subtopics (aim 15-30 within course scope).',
      '- Limit to one browse_page call if needed.',
      '- Verify against official sources; exclude ALL meta-items.',
      'Respond ONLY with JSON: { "topics": ["Topic1", "Topic2", ...] }'
    ].join('\n');
    last = await runOnce(correction);
  }

  if (!last.text) {
    throw new Error('OpenRouter returned unexpected content format for study topics');
  }

  try {
    const totals = getCostTotals();
    console.log('[topics] usage:', {
      prompt_tokens: totals.prompt,
      completion_tokens: totals.completion,
      total_tokens: totals.total,
      estimated_usd: Number(totals.usd.toFixed(6)),
      calls: totals.calls,
    });
  } catch {}

  return last.text;
}

export function createWebSearchTool() {
  return {
    name: 'web_search',
    description: 'Run a simple web search and return top results formatted as brief bullets.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
    handler: async (args) => {
      const query = (args && args.query) || '';
      if (!query) return 'No query provided to web_search.';
      try {
        const response = await fetch(`https://example.com/search?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': 'EdTechBot/1.0' },
        });
        const text = await response.text();
        if (!text || text.trim() === '') {
          return 'No results returned by web_search.';
        }
        try {
          const parsed = JSON.parse(text);
          const results = Array.isArray(parsed.results) ? parsed.results : [];
          if (results.length === 0) return text;
          const lines = results.map((r, i) => {
            const title = r.title || r.name || 'Untitled';
            const snippet = r.snippet || r.description || '';
            const tail = snippet ? ` - ${snippet}` : '';
            return `${i + 1}. ${title}${tail}`;
          });
          return lines.join('\n');
        } catch (err) {
          // not JSON - return raw text
          return text;
        }
      } catch (error) {
        return `Error running web_search: ${error.message}`;
      }
    },
  };
}