import { pickModel, shouldUseTools, nextFallback } from './modelRouter.js';
import { executeOpenRouterChat, createBrowsePageTool } from './grokClient.js';

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
    const useTools = stageNeedsTools || allowWeb;
    const enableWebSearch = allowWeb || /:online\b/.test(chosenModel);
    const toolList = useTools && !enableWebSearch ? [createBrowsePageTool()] : [];

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
