import { pickModel, shouldUseTools, nextFallback } from './modelRouter.js';
import { executeOpenRouterChat, createBrowsePageTool } from './grokClient.js';

export async function callStageLLM({ stage, messages, attachments = [], maxTokens = 1500, allowWeb = false }) {
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
    const chosenModel = fallbackModel || model;
    const useTools = shouldUseTools(stage) || allowWeb;

    try {
      const response = await executeOpenRouterChat({
        model: chosenModel,
        temperature,
        topP,
        frequencyPenalty,
        presencePenalty,
        maxTokens,
        tools: useTools ? [createBrowsePageTool()] : [],
        toolChoice: useTools ? 'auto' : undefined,
        maxToolIterations: useTools ? 1 : undefined,
        enableWebSearch: useTools || allowWeb,
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
