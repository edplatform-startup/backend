const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const WEB_SEARCH_ENDPOINT = 'https://openrouter.ai/api/v1/tools/web_search';
const MODEL_FALLBACK = 'x-ai/grok-4-fast';
const MAX_TOOL_ITERATIONS = 3;

let customGenerator = null;
let customSearchExecutor = null;

export function setStudyTopicsGenerator(fn) {
  customGenerator = typeof fn === 'function' ? fn : null;
}

export function clearStudyTopicsGenerator() {
  customGenerator = null;
}

export function setWebSearchExecutor(fn) {
  customSearchExecutor = typeof fn === 'function' ? fn : null;
}

export function clearWebSearchExecutor() {
  customSearchExecutor = null;
}

function buildPrompt({
  finishByDate,
  timeRemainingDays,
  courseSelection,
  syllabusText,
  syllabusFiles,
  examFormatDetails,
  examFiles,
}) {
  const lines = [];
  lines.push('You are an AI study planner who must output ONLY a comma-separated list of study topics with no additional text.');
  lines.push('Tasks:');
  lines.push('1. Analyze the provided materials about the course and exam.');
  lines.push('2. Use the web_search tool when helpful to supplement course knowledge and best study practices.');
  lines.push('3. Determine the most important topics to learn given the time remaining.');
  lines.push('4. Respond with only the comma-separated list of topics (no numbering, no explanations).');
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

function supportsReasoning(modelName) {
  return typeof modelName === 'string' && modelName.startsWith('openai/');
}

async function callChatCompletion({ apiKey, model, messages, reasoningEffort }) {
  const response = await fetch(OPENROUTER_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://edtech-backend-api.onrender.com',
      'X-Title': 'EdTech Study Planner',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: 600,
      temperature: 0.4,
      tools: [{ type: 'web_search' }],
      tool_choice: { type: 'auto' },
      ...(supportsReasoning(model) && reasoningEffort
        ? { reasoning: { effort: reasoningEffort } }
        : {}),
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => response.statusText);
    const err = new Error(`OpenRouter request failed: ${response.status} ${response.statusText}`);
    err.details = errorText;
    throw err;
  }

  return response.json();
}

async function performWebSearch(apiKey, query) {
  if (customSearchExecutor) {
    return await customSearchExecutor(query);
  }

  const normalizedQuery = (query || '').toString().trim();
  if (!normalizedQuery) {
    return 'No search performed: empty query.';
  }

  const response = await fetch(WEB_SEARCH_ENDPOINT, {
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

export async function generateStudyTopics(input) {
  if (customGenerator) {
    return await customGenerator(input);
  }

  const apiKey = process.env.OPENROUTER_GROK_4_FAST_KEY;
  if (!apiKey) {
    throw new Error('Missing OPENROUTER_GROK_4_FAST_KEY environment variable');
  }

  const model = input?.model || MODEL_FALLBACK;
  const prompt = buildPrompt(input || {});

  const messages = [
    {
      role: 'system',
      content:
        'You are an AI study coach. Use the web_search tool when helpful to gather additional course insights. ALWAYS finish by responding with only a comma-separated list of study topics and nothing else.',
    },
    {
      role: 'user',
      content: prompt,
    },
  ];

  let iterations = 0;
  let lastPayload = null;

  while (iterations < MAX_TOOL_ITERATIONS) {
    iterations += 1;
    lastPayload = await callChatCompletion({
      apiKey,
      model,
      messages,
      reasoningEffort: 'high',
    });
    const choice = lastPayload?.choices?.[0];
    const message = choice?.message;

    if (!message) {
      throw new Error('OpenRouter response missing message');
    }

    messages.push(message);

    const toolCalls = message.tool_calls;
    if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
      const content = message.content;
      if (!content || typeof content !== 'string') {
        throw new Error('OpenRouter response missing content');
      }
      return content.trim();
    }

    for (const call of toolCalls) {
      const callId = call?.id || `tool_call_${iterations}`;
      const argsStr = call?.function?.arguments || call?.web_search?.arguments || '{}';
      let query = '';
      try {
        const parsed = JSON.parse(argsStr);
        query = parsed?.query || parsed?.q || parsed?.search || '';
      } catch (err) {
        console.warn('Failed to parse tool arguments:', err);
      }

      let toolContent;
      try {
        toolContent = await performWebSearch(apiKey, query);
      } catch (toolErr) {
        toolContent = `Web search error: ${toolErr.message}`;
      }

      messages.push({
        role: 'tool',
        tool_call_id: callId,
        name: call?.function?.name || 'web_search',
        content: toolContent,
      });
    }
  }

  throw new Error('Exceeded maximum tool iterations without final answer');
}
