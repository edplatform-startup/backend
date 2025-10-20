import { Router } from 'express';
import { executeOpenRouterChat } from '../services/grokClient.js';

const router = Router();

const MODEL_NAME = process.env.GROK_MODEL || 'x-ai/grok-4-fast';
const API_KEY = process.env.OPENROUTER_GROK_4_FAST_KEY || process.env.OPENROUTER_API_KEY;

const SYSTEM_PROMPT = `You are an expert flashcard generator.
Output ONLY a valid JSON object and nothing else.
Keys must be the strings "1", "2", "3", ... with no gaps.
Each value must be an array of exactly three concise strings: [question, answer, explanation].
Keep answers factual, explanations insightful, and avoid markdown.
If you cannot comply, output an empty JSON object {}.`;

function normalizeLLMJson(rawContent) {
  let textContent = rawContent;

  if (Array.isArray(rawContent)) {
    textContent = rawContent
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) return part.text;
        return '';
      })
      .join('');
  } else if (rawContent && typeof rawContent === 'object' && 'text' in rawContent) {
    textContent = rawContent.text;
  }

  if (typeof textContent !== 'string') return null;

  const stripped = textContent
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  try {
    return JSON.parse(stripped);
  } catch (err) {
    return null;
  }
}

function validateFlashcards(candidate, expectedCount) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return { valid: false, error: 'Model response was not a JSON object.' };
  }

  const entries = Object.entries(candidate);
  if (entries.length === 0) {
    return { valid: false, error: 'Model response contained no flashcards.' };
  }

  if (expectedCount && entries.length !== expectedCount) {
    return { valid: false, error: `Expected ${expectedCount} flashcards but received ${entries.length}.` };
  }

  for (let i = 0; i < entries.length; i++) {
    const expectedKey = String(i + 1);
    const [key, value] = entries[i];
    if (key !== expectedKey) {
      return { valid: false, error: `Expected key "${expectedKey}" but received "${key}".` };
    }

    if (!Array.isArray(value) || value.length !== 3) {
      return { valid: false, error: `Flashcard ${key} must be an array of exactly three strings.` };
    }

    for (let j = 0; j < value.length; j++) {
      if (typeof value[j] !== 'string' || !value[j].trim()) {
        return { valid: false, error: `Flashcard ${key} index ${j} must be a non-empty string.` };
      }
      value[j] = value[j].trim();
    }
  }

  return { valid: true };
}

router.post('/', async (req, res) => {
  const topicInput = req.body?.topic ?? req.body?.description ?? req.body?.prompt;
  const topic = typeof topicInput === 'string' ? topicInput.trim() : '';

  if (!topic) {
    return res.status(400).json({ error: 'Missing required string field: topic' });
  }

  if (!API_KEY) {
    console.error('[flashcards] Missing OPENROUTER_GROK_4_FAST_KEY (or OPENROUTER_API_KEY) environment variable.');
    return res.status(500).json({ error: 'Flashcard generation is not configured.' });
  }

  const desiredCount = Number.isInteger(req.body?.count) ? req.body.count : undefined;
  const count = desiredCount && desiredCount > 0 && desiredCount <= 20 ? desiredCount : 5;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const { content } = await executeOpenRouterChat({
      model: MODEL_NAME,
      reasoning: { enabled: true, effort: 'low' },
      temperature: 0.3,
      maxTokens: 900,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Create exactly ${count} flashcards about "${topic}". Return only the JSON object, nothing else.`,
        },
      ],
      signal: controller.signal,
    });

    const flashcards = normalizeLLMJson(content);

    const validation = validateFlashcards(flashcards, count);
    if (!validation.valid) {
      console.error('[flashcards] Invalid flashcard payload:', validation.error, content);
      return res.status(502).json({ error: 'Received invalid flashcard format from Grok.' });
    }

    return res.json(flashcards);
  } catch (err) {
    if (err?.name === 'AbortError') {
      console.error('[flashcards] Grok request timed out.');
      return res.status(504).json({ error: 'Flashcard generation timed out.' });
    }

    console.error('[flashcards] Unexpected error:', err);
    const status = err?.message?.includes('OpenRouter request failed') ? 502 : 500;
    return res.status(status).json({ error: 'Unexpected error generating flashcards.' });
  } finally {
    clearTimeout(timeout);
  }
});

export default router;
