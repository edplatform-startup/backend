const DEFAULT_CHAT_ENDPOINT = process.env.OPENROUTER_CHAT_URL || 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_WEB_SEARCH_ENDPOINT = process.env.OPENROUTER_WEB_SEARCH_URL || 'https://openrouter.ai/api/v1/tools/web_search';
const DEFAULT_MODEL = 'x-ai/grok-4-fast';
const DEFAULT_MAX_TOOL_ITERATIONS = 3;

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

async function defaultWebSearch(query, apiKey) {
  if (customWebSearchExecutor) {
    return await customWebSearchExecutor(query);
  }

  const normalizedQuery = (query || '').toString().trim();
  if (!normalizedQuery) {
    return 'No search performed: empty query.';
  }

  const response = await fetch(DEFAULT_WEB_SEARCH_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ query: normalizedQuery }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    throw new Error(`Web search failed: ${response.status} ${response.statusText} ${errorText}`);
  }

  const data = await response.json();
  if (Array.isArray(data?.results) && data.results.length > 0) {
    return data.results
      .map((item, index) => {
        const snippet = item.snippet || item.description || '';
        return `${index + 1}. ${item.title}${snippet ? ` - ${snippet}` : ''}`;
      })
      .join('\n');
  }

  return JSON.stringify(data);
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

  return response.json();
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
  } = options;

  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages array is required');
  }

  const apiKey = resolveApiKey(explicitApiKey);
  const conversation = messages.map((msg) => ({ ...msg }));
  const { definitions: toolDefinitions, handlers: toolHandlers } = formatToolDefinitions(tools);
  const reasoningPayload = sanitizeReasoning(reasoning);

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

    if (toolDefinitions.length > 0) {
      requestBody.tools = toolDefinitions;
      requestBody.tool_choice = toolChoice || 'auto';
    } else if (toolChoice && toolChoice !== 'none') {
      requestBody.tool_choice = toolChoice;
    }

    const payload = await callOpenRouterApi({ endpoint, apiKey, body: requestBody, signal });
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
  lines.push('2. Use the web_search tool when helpful to supplement course knowledge and best study practices.');
  lines.push('3. Determine the most important topics to learn given the time remaining.');
  lines.push('4. Ensure coverage of every concept the learner must master for maximal success.');
  lines.push('5. Respond with only the comma-separated list of topics (no numbering, no explanations).');
  lines.push('');
  lines.push('Provided context:');

  if (courseSelection) {
    lines.push(`- Course Selection: ${courseSelection.code} — ${courseSelection.title}`);
  }
  if (finishByDate) {
    lines.push(`- Target Exam/Completion Date: ${finishByDate}`);
  }
  if (typeof timeRemainingDays === 'number') {
    lines.push(`- Estimated days remaining: ${timeRemainingDays}`);
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
    maxTokens: 600,
    tools: [createWebSearchTool()],
    toolChoice: 'auto',
    maxToolIterations: DEFAULT_MAX_TOOL_ITERATIONS,
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