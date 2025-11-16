import test from 'node:test';
import assert from 'node:assert/strict';

import { callStageLLM } from '../src/services/llmCall.js';
import { STAGES } from '../src/services/modelRouter.js';
import { setOpenRouterChatExecutor, clearOpenRouterChatExecutor } from '../src/services/grokClient.js';

test('callStageLLM provides web_search tool when allowWeb is true', async (t) => {
  let receivedOptions;
  const executor = async (options) => {
    receivedOptions = options;
    return {
      content: 'ok',
      message: { role: 'assistant', content: 'ok' },
      response: { choices: [{ finish_reason: 'stop' }] },
    };
  };

  setOpenRouterChatExecutor(executor);
  t.after(() => {
    clearOpenRouterChatExecutor();
  });

  await callStageLLM({
    stage: STAGES.PLANNER,
    messages: [{ role: 'user', content: 'Plan with sources' }],
    allowWeb: true,
    maxTokens: 200,
  });

  assert.ok(receivedOptions, 'custom executor should be invoked');
  assert.equal(receivedOptions.enableWebSearch, true);
  const toolNames = Array.isArray(receivedOptions.tools)
    ? receivedOptions.tools.map((tool) => tool?.name)
    : [];
  assert.ok(toolNames.includes('web_search'), 'web_search tool should be included when allowWeb is true');
});
