import { pickModel } from './modelRouter.js';
import { executeOpenRouterChat, createBrowsePageTool, createWebSearchTool } from './grokClient.js';

export async function callStageLLM({
  stage,
  messages,
  attachments = [],
  maxTokens = 1500,
  allowWeb = false,
  maxToolIterations,
  modelOverride = null,
  requestTimeoutMs,
  plugins,
  userId,
  source,
  courseId,
  reasoning = { enabled: true, effort: 'high' },
  responseFormat,
}) {
  const {
    model,
    temperature,
    top_p: topP,
    frequency_penalty: frequencyPenalty,
    presence_penalty: presencePenalty,
  } = pickModel(stage);
  const chosenModel = modelOverride || model;
  
  // Always use custom web_search tool (never OpenRouter's web plugin)
  const toolList = [];
  if (allowWeb) {
    toolList.push(createWebSearchTool());
  }

  const response = await executeOpenRouterChat({
    model: chosenModel,
    temperature,
    topP,
    frequencyPenalty,
    presencePenalty,
    maxTokens,
    tools: toolList,
    toolChoice: toolList.length ? 'auto' : undefined,
    maxToolIterations: toolList.length ? (maxToolIterations ?? 1) : undefined,
    enableWebSearch: false, // Never use OpenRouter's web plugin
    stage,
    messages,
    attachments,
    requestTimeoutMs,
    plugins,
    reasoning,
    responseFormat,
    userId,
    source: source || stage?.toLowerCase() || 'unknown',
    courseId,
  });

  return { model: chosenModel, result: response };
}
