import { pickModel, shouldUseTools, nextFallback } from './modelRouter.js';
import { executeOpenRouterChat, createBrowsePageTool, createWebSearchTool } from './grokClient.js';

export async function callStageLLM({
  stage,
  messages,
  attachments = [],
  maxTokens = 1500,
  allowWeb = false,
  modelOverride = null,
}) {
  let attempt = 0;
  let lastErr = null;

  while (attempt < 3) {
    const fallbackModel = attempt === 0 ? null : nextFallback(attempt - 1);
    const {
      model,
      temperature,
      top_p: topP,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
    } = pickModel(stage);
    const chosenModel = (modelOverride && attempt === 0 ? modelOverride : null) || fallbackModel || model;
    const stageNeedsTools = shouldUseTools(stage);
    const preferWebPlugin = allowWeb && /^x-ai\/grok/.test(chosenModel);
    const enableWebSearch = allowWeb && (preferWebPlugin || /:online\b/.test(chosenModel));

    const toolList = [];
    if (stageNeedsTools && !enableWebSearch) {
      toolList.push(createBrowsePageTool());
    }
    if (allowWeb) {
      toolList.push(createWebSearchTool());
    }

    try {
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
      });

      return { model: chosenModel, result: response };
    } catch (error) {
      lastErr = error;
      attempt += 1;
    }
  }

  throw lastErr;
}
