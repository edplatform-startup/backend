import { pickModel } from './modelRouter.js';
import { executeOpenRouterChat, createBrowsePageTool } from './grokClient.js';

export async function callStageLLM({
  stage,
  messages,
  attachments = [],
  maxTokens = 1500,
  allowWeb = false,
  modelOverride = null,
  requestTimeoutMs,
  plugins,
  userId,
  source,
}) {
  const {
    model,
    temperature,
    top_p: topP,
    frequency_penalty: frequencyPenalty,
    presence_penalty: presencePenalty,
  } = pickModel(stage);
  const chosenModel = modelOverride || model;
  
  // Check if model has built-in web search (X.ai Grok models with :online or web plugin)
  const preferWebPlugin = /:online\b/.test(chosenModel) || /^x-ai\/grok/.test(chosenModel);
  const enableWebSearch = allowWeb && preferWebPlugin;
  
  // Build tool list: only add web_search tool if allowWeb is true AND model does not have built-in web search
  const toolList = [];
  if (allowWeb && !preferWebPlugin) {
    toolList.push(createBrowsePageTool());
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
    maxToolIterations: toolList.length ? 1 : undefined,
    enableWebSearch,
    stage,
    messages,
    attachments,
    requestTimeoutMs,
    plugins,
    userId,
    source: source || stage?.toLowerCase() || 'unknown',
  });

  return { model: chosenModel, result: response };
}
