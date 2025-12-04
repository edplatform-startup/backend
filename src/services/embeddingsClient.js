/**
 * OpenRouter Embeddings Client
 * 
 * Provides embedTexts() for generating embeddings via OpenRouter API.
 * Uses the same HTTP patterns and config as grokClient.js.
 */

const DEFAULT_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1';
const DEFAULT_EMBEDDING_MODEL = process.env.OPENROUTER_EMBEDDING_MODEL || 'openai/text-embedding-3-small';
const DEFAULT_BATCH_SIZE = 64;
const MAX_RETRIES = 3;

// Use short backoff in test environment for faster tests
const isTestEnv = process.env.NODE_ENV === 'test' || process.env.VITEST;
const INITIAL_BACKOFF_MS = isTestEnv ? 10 : 1000;

let customEmbedExecutor = null;

/**
 * Override the embeddings executor for testing.
 * @param {Function|null} fn
 */
export function setEmbeddingsExecutor(fn) {
  customEmbedExecutor = typeof fn === 'function' ? fn : null;
}

/**
 * Clear the custom embeddings executor.
 */
export function clearEmbeddingsExecutor() {
  customEmbedExecutor = null;
}

function resolveApiKey(explicitKey) {
  const apiKey = explicitKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('Missing OpenRouter API key (set OPENROUTER_API_KEY)');
  }
  return apiKey;
}

/**
 * Calls the OpenRouter embeddings endpoint with retry logic.
 * @param {Object} options
 * @param {string} options.endpoint
 * @param {string} options.apiKey
 * @param {Object} options.body
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<Object>}
 */
async function callEmbeddingsApi({ endpoint, apiKey, body, signal }) {
  let lastError = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': process.env.PUBLIC_BASE_URL || 'https://api.kognolearn.com',
          'X-Title': 'EdTech Study Planner',
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        const err = new Error(`OpenRouter embeddings request failed: ${response.status} ${response.statusText}`);
        err.statusCode = response.status;
        err.details = errorText;

        // Retry on 429 (rate limit) or 5xx (server errors)
        const shouldRetry = response.status === 429 || response.status >= 500;
        if (shouldRetry && attempt < MAX_RETRIES - 1) {
          const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
          console.warn(`[embeddings] Retrying after ${response.status}, backoff ${backoff}ms`);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          lastError = err;
          continue;
        }
        throw err;
      }

      const text = await response.text();
      if (!text || text.trim() === '') {
        const err = new Error('OpenRouter embeddings returned empty response');
        err.statusCode = 502;
        throw err;
      }

      try {
        return JSON.parse(text);
      } catch (parseError) {
        const err = new Error('OpenRouter embeddings returned invalid JSON');
        err.statusCode = 502;
        err.details = `Failed to parse: ${parseError.message}`;
        throw err;
      }
    } catch (error) {
      // Handle AbortError or network errors
      const isAbort = error?.name === 'AbortError';
      const isRetryable = !isAbort && (error?.statusCode === 429 || error?.statusCode >= 500);

      if (isRetryable && attempt < MAX_RETRIES - 1) {
        const backoff = INITIAL_BACKOFF_MS * Math.pow(2, attempt);
        console.warn(`[embeddings] Retrying after error: ${error.message}, backoff ${backoff}ms`);
        await new Promise((resolve) => setTimeout(resolve, backoff));
        lastError = error;
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error('OpenRouter embeddings request failed after retries');
}

/**
 * Generate embeddings for an array of texts.
 * 
 * @param {string[]} texts - Array of text strings to embed
 * @param {Object} [options] - Options
 * @param {string} [options.model] - Embedding model (default: OPENROUTER_EMBEDDING_MODEL env var)
 * @param {string} [options.apiKey] - API key override
 * @param {number} [options.batchSize] - Batch size (default: 64)
 * @param {number} [options.requestTimeoutMs] - Request timeout in ms (default: 30000)
 * @returns {Promise<number[][]>} - Array of embedding vectors
 */
export async function embedTexts(texts, options = {}) {
  if (customEmbedExecutor) {
    return customEmbedExecutor(texts, options);
  }

  if (!Array.isArray(texts)) {
    throw new Error('texts must be an array of strings');
  }

  if (texts.length === 0) {
    return [];
  }

  const {
    model = DEFAULT_EMBEDDING_MODEL,
    apiKey: explicitApiKey,
    batchSize = DEFAULT_BATCH_SIZE,
    requestTimeoutMs = 30000,
  } = options;

  const apiKey = resolveApiKey(explicitApiKey);
  const endpoint = `${DEFAULT_BASE_URL}/embeddings`;
  const allEmbeddings = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);

    let controller;
    let timer;
    if (requestTimeoutMs && requestTimeoutMs > 0) {
      controller = new AbortController();
      timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    }

    try {
      const payload = await callEmbeddingsApi({
        endpoint,
        apiKey,
        body: { model, input: batch },
        signal: controller?.signal,
      });

      // OpenAI-compatible response: { data: [{ embedding: [...], index: 0 }, ...] }
      if (!payload?.data || !Array.isArray(payload.data)) {
        throw new Error('Invalid embeddings response: missing data array');
      }

      // Sort by index to ensure correct order
      const sorted = payload.data.slice().sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        if (!Array.isArray(item.embedding)) {
          throw new Error('Invalid embeddings response: missing embedding array');
        }
        allEmbeddings.push(item.embedding);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return allEmbeddings;
}
