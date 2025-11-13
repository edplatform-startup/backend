import { Router } from 'express';
import { executeOpenRouterChat, createWebSearchTool } from '../services/grokClient.js';
import { validateUuid } from '../utils/validation.js';

const router = Router();

// POST /chat
// Body: {
//   system: string,
//   user: string,
//   context?: string | object | array,
//   useWebSearch?: boolean,
//   responseFormat?: 'text' | 'json',
//   temperature?: number,
//   maxTokens?: number,
//   attachments?: Array<{ type?: string, mimeType?: string, data?: string, url?: string, name?: string }>,
//   reasoning?: boolean | string | { enabled?: boolean, effort?: string, limits?: any }
// }
router.post('/', async (req, res) => {
  const {
    system,
    user,
    context,
    useWebSearch = false,
    responseFormat = 'text',
    temperature = 0.5,
    maxTokens = 600,
    attachments = [],
    reasoning,
    userId,
  } = req.body || {};

  if (!system || typeof system !== 'string' || !system.trim()) {
    return res.status(400).json({ error: 'Missing or invalid field: system' });
  }
  if (!user || typeof user !== 'string' || !user.trim()) {
    return res.status(400).json({ error: 'Missing or invalid field: user' });
  }
  const vu = validateUuid(userId, 'userId');
  if (!vu.valid) {
    return res.status(400).json({ error: vu.error });
  }

  let contextMessage;
  if (context != null) {
    try {
      if (typeof context === 'string') {
        contextMessage = context;
      } else {
        contextMessage = JSON.stringify(context);
      }
    } catch (e) {
      return res.status(400).json({ error: 'context must be serializable to JSON or a string' });
    }
  }

  try {
    const messages = [
      { role: 'system', content: system.trim() },
    ];

    if (contextMessage) {
      messages.push({ role: 'system', content: `Context:\n${contextMessage}` });
    }

    messages.push({ role: 'user', content: user.trim() });

    const tools = useWebSearch ? [createWebSearchTool()] : [];
    const shouldRequestJson = responseFormat === 'json' && !useWebSearch && tools.length === 0;
    const result = await executeOpenRouterChat({
      messages,
      model: 'x-ai/grok-4-fast',
      temperature,
      maxTokens,
      tools,
      toolChoice: useWebSearch ? 'auto' : undefined,
      attachments,
      reasoning,
      ...(shouldRequestJson ? { responseFormat: { type: 'json_object' } } : {}),
    });

    // Normalize content to string for convenience
    let text = '';
    if (Array.isArray(result.content)) {
      text = result.content
        .map((part) => (typeof part === 'string' ? part : part?.text || ''))
        .join('')
        .trim();
    } else if (typeof result.content === 'string') {
      text = result.content.trim();
    } else {
      text = '';
    }

    return res.status(200).json({
      model: 'x-ai/grok-4-fast',
      content: text,
    });
  } catch (e) {
    // Detailed error logging
    const status = e.statusCode || 500;
    const logBlock = {
      error: e.message,
      status,
      details: e.details,
      stack: e.stack,
      responseId: e.response?.id,
      finishReason: e.response?.choices?.[0]?.finish_reason,
      usage: e.response?.usage,
      preview: e.responsePreview,
      messages: e.messages,
      rawResponse: e.rawResponse,
    };
    // Log to server console for debugging
    console.error('Chat route error:', JSON.stringify(logBlock, null, 2));
    return res.status(status).json({
      error: 'Chat request failed',
      details: e.details || e.message,
      debug: logBlock,
    });
  }
});

export default router;
