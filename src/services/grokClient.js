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
  const TOOL_TIMEOUT_MS = 20000; // 20s per web_search call
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
  lines.push('You are an AI study planner who must output ONLY a comma-separated list of study topics with no additional text.');
  lines.push('Tasks:');
  lines.push('1. Analyze the provided materials about the course and exam.');
  lines.push('2. Use the web_search tool to do a deep and detailed analysis of the course being studied to generate the topics the user needs to learn.');
  lines.push('3. Determine a list of all topics to learn for someone to be prepared for an exam for that course.');
  lines.push('4. Ensure coverage of every concept from the class the learner must master for maximal success.');
  lines.push('5. Respond with only the comma-separated list of topics (no numbering, no explanations, no commas in names of topics).');
  lines.push('');
  lines.push('Provided context:');

  if (courseSelection) {
    lines.push(`- Course Selection: ${courseSelection.college} — ${courseSelection.course}`);
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
  lines.push('Remember: output only the comma-separated topics list. If you need more information, call the web_search tool with relevant queries.');

  return lines.join('\n');
}

const STUDY_TOPICS_SYSTEM_PROMPT = 'You are an AI study coach. Use the web_search tool when helpful to gather additional course insights. ALWAYS finish by responding with only a comma-separated list of study topics and nothing else.';

export async function generateStudyTopics(input) {
  if (customStudyTopicsGenerator) {
    return await customStudyTopicsGenerator(input);
  }

  const apiKey = resolveApiKey();
  const model = input?.model || DEFAULT_MODEL;
  const prompt = buildStudyTopicsPrompt(input || {});

  const { content } = await executeOpenRouterChat({
    apiKey,
    model,
    reasoning: { enabled: true, effort: 'high' },
    temperature: 0.4,
    maxTokens: 2048,
    tools: [createWebSearchTool()],
    toolChoice: 'auto',
    // Keep tool loops bounded to avoid platform timeouts
    maxToolIterations: 6,
    // Guard each OpenRouter round-trip with a timeout to avoid long hangs/abort cascades
    requestTimeoutMs: 50000,
    messages: [
      { role: 'system', content: STUDY_TOPICS_SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ],
  });

  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('')
      .trim();
  }

  if (typeof content !== 'string') {
    throw new Error('OpenRouter returned unexpected content format for study topics');
  }

  return content.trim();
}