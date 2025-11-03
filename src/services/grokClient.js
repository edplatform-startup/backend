const DEFAULT_CHAT_ENDPOINT = process.env.OPENROUTER_CHAT_URL || 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_WEB_SEARCH_ENDPOINT = process.env.OPENROUTER_WEB_SEARCH_URL || 'https://openrouter.ai/api/v1/tools/web_search';
const DEFAULT_MODEL = 'x-ai/grok-4-fast';
const DEFAULT_MAX_TOOL_ITERATIONS = 9;

let customStudyTopicsGenerator = null;
let customWebSearchExecutor = null;
let customChatExecutor = null;

export function setStudyTopicsGenerator(fn) {
  customStudyTopicsGenerator = typeof fn === 'function' ? fn : null;
}

export function clearStudyTopicsGenerator() {
  customStudyTopicsGenerator = null;
}

export function setWebSearchExecutor(fn) {
  customWebSearchExecutor = typeof fn === 'function' ? fn : null;
}

export function clearWebSearchExecutor() {
  customWebSearchExecutor = null;
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
    if (!isLikelyText(buf)) return null;
    const text = buf.toString('utf8');
    // basic sanity: avoid lots of NULs
    if (/\u0000/.test(text)) return null;
    return text;
  } catch {
    return null;
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
      const text = decodeBase64ToUtf8Safe(att.data);
      if (typeof text === 'string' && text.trim()) {
        body = text.trim();
      } else {
        body = '[content omitted: non-text or undecodable]';
      }
    } else if (att.url) {
      body = `URL provided: ${att.url}`;
    } else {
      body = '[no data or url provided]';
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

async function defaultWebSearch(query, apiKey) {
  if (customWebSearchExecutor) {
    return await customWebSearchExecutor(query);
  }

  const normalizedQuery = (query || '').toString().trim();
  if (!normalizedQuery) {
    return 'No search performed: empty query.';
  }

  // Add a defensive timeout for the web_search tool so tool calls don't hang the whole request
  const controller = new AbortController();
  const TOOL_TIMEOUT_MS = 30000; // 30s per web_search call (increased for Claude Sonnet reasoning)
  const timer = setTimeout(() => controller.abort(), TOOL_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(DEFAULT_WEB_SEARCH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query: normalizedQuery }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') {
      // Return a benign string so the LLM can continue without failing the entire run
      return 'web_search timed out.';
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Web search failed: ${response.status} ${response.statusText} ${errorText}`);
  }

  // Read as text first to gracefully handle empty/invalid JSON bodies
  const raw = await response.text().catch(() => '');
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    // Return a benign string so the LLM can continue, instead of throwing
    return 'No results returned by web_search.';
  }

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    // Fallback: return the raw text (truncated) so the model can still use it
    return trimmed.slice(0, 1000);
  }

  if (Array.isArray(data?.results) && data.results.length > 0) {
    return data.results
      .map((item, index) => {
        const snippet = item.snippet || item.description || '';
        return `${index + 1}. ${item.title}${snippet ? ` - ${snippet}` : ''}`;
      })
      .join('\n');
  }

  // If JSON is valid but not in expected shape, return a compact JSON string
  try {
    return typeof data === 'string' ? data : JSON.stringify(data);
  } catch {
    return '[web_search] Unrecognized response format.';
  }
}

export function createWebSearchTool() {
  return {
    name: 'web_search',
    description: 'Perform a web search to gather additional information.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query.'
        }
      },
      required: ['query']
    },
    handler: async (args, context) => {
      const query = args?.query || '';
      return defaultWebSearch(query, context.apiKey);
    },
  };
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
      
      try {
        const response = await fetch(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; EdTechBot/1.0)',
          },
          signal: AbortSignal.timeout(20000), // 20s timeout (increased for Claude Sonnet reasoning)
        });
        
        if (!response.ok) {
          return `Failed to fetch page: ${response.status} ${response.statusText}`;
        }
        
        const text = await response.text();
        // Simple text extraction - strip HTML tags and limit size
        const cleanText = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 8000); // Limit to 8KB
        
        return cleanText || 'Page content could not be extracted.';
      } catch (error) {
        return `Error browsing page: ${error.message}`;
      }
    },
  };
}

async function callOpenRouterApi({ endpoint, apiKey, body, signal }) {
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
    // Optional per-request timeout used for each round-trip to OpenRouter (defensive default)
    requestTimeoutMs = 55000,
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
  const shouldInlineAttachments = typeof model === 'string' && /^x-ai\/grok/.test(model);
  if (shouldInlineAttachments && validatedAttachments.length > 0) {
    const inlineText = buildAttachmentsInlineText(validatedAttachments);
    if (inlineText) {
      conversation.push({ role: 'user', content: inlineText });
    }
  }

  let iterations = 0;

  while (true) {
    const requestBody = {
      model,
      max_tokens: maxTokens,
      temperature,
      messages: conversation,
    };

    if (typeof topP === 'number') requestBody.top_p = topP;
    if (typeof frequencyPenalty === 'number') requestBody.frequency_penalty = frequencyPenalty;
    if (typeof presencePenalty === 'number') requestBody.presence_penalty = presencePenalty;
    if (reasoningPayload !== undefined) requestBody.reasoning = reasoningPayload;
    if (responseFormat && typeof responseFormat === 'object') {
      requestBody.response_format = responseFormat;
    }

    if (toolDefinitions.length > 0) {
      requestBody.tools = toolDefinitions;
      requestBody.tool_choice = toolChoice || 'auto';
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

    // Build a local controller to enforce per-request timeout and also honor any upstream signal
    let controller;
    let timer;
    let effectiveSignal = signal;
    if (!effectiveSignal && requestTimeoutMs && requestTimeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      effectiveSignal = controller.signal;
    } else if (signal && requestTimeoutMs && requestTimeoutMs > 0) {
      // Compose: if caller provided a signal, piggyback a timeout onto it
      controller = new AbortController();
      // If outer signal aborts, propagate
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
      accumulateUsage(model, payload?.usage || payload?.meta?.usage || {});
    } catch {}
    const message = payload?.choices?.[0]?.message;

    if (!message) {
      throw new Error('OpenRouter response missing message');
    }

    conversation.push(message);
    const toolCalls = message.tool_calls;

    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      return {
        content: message.content,
        message,
        response: payload,
      };
    }

    if (iterations >= maxToolIterations) {
      throw new Error('Exceeded maximum tool iterations without final answer');
    }

    iterations += 1;

    for (const call of toolCalls) {
      const toolName = call?.function?.name;
      const handler = toolHandlers.get(toolName);
      const args = parseToolArguments(call?.function?.arguments);

      let toolResult;
      try {
        if (handler) {
          toolResult = await handler(args, {
            apiKey,
            tool: toolName,
            iteration: iterations,
            messages: conversation,
          });
        } else if (toolName === 'web_search') {
          toolResult = await defaultWebSearch(args?.query, apiKey);
        } else {
          toolResult = `Tool "${toolName}" not supported.`;
        }
      } catch (error) {
        toolResult = `Tool ${toolName || 'unknown'} threw an error: ${error.message}`;
      }

      conversation.push({
        role: 'tool',
        tool_call_id: call?.id || `${toolName || 'tool'}_${iterations}`,
        name: toolName,
        content: typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult),
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
    lines.push(`2. Use web_search (query: "${query} syllabus site:.edu") and browse_page on syllabus/exam files (instructions: "Extract all listed topics, subtopics, and learning objectives as bullet points") to compile exhaustive list.`);
  } else {
    lines.push('2. Use web_search and browse_page on syllabus/exam files (instructions: "Extract all listed topics, subtopics, and learning objectives as bullet points") to compile exhaustive list.');
  }
  lines.push('3. Cross-reference for completeness: include all prerequisites, examples, and exam-covered concepts.');
  lines.push('4. Ensure 15-30 topics covering every course element for exam success.');
  lines.push('5. Respond with ONLY: { "topics": ["Topic1", "Topic2", ...] }');
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
  lines.push('MUST call tools before final output.');

  return lines.join('\n');
}

const STUDY_TOPICS_SYSTEM_PROMPT = 'You are an AI study coach extracting exhaustive, accurate course topics. MUST use web_search to find official syllabus/outline (prefer .edu sites) and browse_page on provided files/URLs for full extraction. Focus ONLY on domain-specific concepts (e.g., "Two\'s Complement", "Stack Frames")—NEVER include meta-skills (study skills, time management, etc.). Err on over-coverage: list 15-30 subtopics to ensure all core/exam-relevant items are included, but stay within the exact course scope (no unrelated CS topics). Output ONLY a JSON array of topics for parsing.';

function parseTopicsText(raw) {
  const text = (raw || '').toString().trim();
  if (!text) return [];

  // Try JSON first: expect { "topics": [ ... ] } or a bare [ ... ]
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text);
      const arr = Array.isArray(parsed)
        ? parsed
        : (parsed && Array.isArray(parsed.topics) ? parsed.topics : null);
      if (Array.isArray(arr)) {
        return arr
          .map((t) => (typeof t === 'string' ? t.trim() : String(t)))
          .filter((t) => t.length > 0)
          .slice(0, 100);
      }
    } catch {}
  }

  // Fallback: comma-separated list
  return text
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .slice(0, 100);
}

function isGenericTopicList(topics) {
  if (!Array.isArray(topics) || topics.length === 0) return true;
  // List of generic/meta keywords to reject
  const banned = [
    'study', 'time management', 'note', 'exam', 'review', 'revision', 'learning strategies', 'productivity', 'mindset', 'motivation', 'test-taking'
  ];
  const lc = topics.map((t) => t.toLowerCase());
  // If any topic contains banned words, or if all topics are very short generic terms, flag it
  const hasBanned = lc.some((t) => banned.some((b) => t.includes(b)));
  if (hasBanned) return true;
  // Heuristic: if too few topics or too vague words
  if (topics.length < 15) return true;
  return false;
}

// --- Lightweight usage/cost tracking ---
const __usageTotals = { prompt: 0, completion: 0, total: 0, usd: 0, calls: 0, perModel: {} };

function getPriceForModel(model) {
  // USD per 1K tokens (approx; override with OPENROUTER_PRICE_MAP if provided)
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
  const primaryModel = input?.model || 'anthropic/claude-sonnet-4';
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

  const baseMessages = [
    { role: 'system', content: STUDY_TOPICS_SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  const runOnceWithModel = async (mdl, extraUserMessage) => {
    const messages = extraUserMessage ? [...baseMessages, { role: 'user', content: extraUserMessage }] : baseMessages;
    const timeouts = [30000, 45000];
    let lastErr;

    for (let idx = 0; idx < timeouts.length; idx += 1) {
      try {
        const { content } = await executeOpenRouterChat({
          apiKey,
          model: mdl,
          reasoning: { enabled: true, effort: 'medium' },
          temperature: 0.2,
          maxTokens: 800,
          tools: [createWebSearchTool(), createBrowsePageTool()],
          toolChoice: 'required',
          maxToolIterations: 2,
          requestTimeoutMs: timeouts[idx],
          responseFormat: { type: 'json_object' },
          messages,
          attachments,
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
      return await runOnceWithModel(primaryModel, extraUserMessage);
    } catch (err) {
      // Fallback to Grok Fast on failure
      return await runOnceWithModel(fallbackModel, extraUserMessage);
    }
  };

  // Attempt up to 2 total tries with corrective guidance if output is generic or insufficient
  let attempt = 0;
  let last = await runOnce();
  while (attempt < 1 && isGenericTopicList(last.topics)) {
    attempt += 1;
    const correction = [
      'Correction: Previous output included generics, meta-skills, or insufficient coverage (fewer than 15 topics or missing syllabus elements).',
      'Requirements:',
      '- Re-call web_search/browse_page to extract FULL syllabus topics/subtopics (aim 15-30 within course scope).',
      '- Verify against official sources; exclude ALL meta-items.',
      'Respond ONLY with JSON: { "topics": ["Topic1", "Topic2", ...] }'
    ].join('\n');
    last = await runOnce(correction);
  }

  if (!last.text) {
    throw new Error('OpenRouter returned unexpected content format for study topics');
  }

  // Log cost delta for this generation
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