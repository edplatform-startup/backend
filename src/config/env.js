import 'dotenv/config';
import { z } from 'zod';

const envSchema = z
  .object({
    MODEL_PLANNER: z.string().optional(),
    MODEL_WRITER: z.string().optional(),
    MODEL_CRITIC: z.string().optional(),
    READING_WPM: z.string().optional(),
    DEFAULT_ACTIVITY_MIN_GUIDED_EXAMPLE: z.string().optional(),
    DEFAULT_ACTIVITY_MIN_PROBLEM_SET: z.string().optional(),
    DEFAULT_ACTIVITY_MIN_DISCUSSION: z.string().optional(),
    OPENROUTER_PRICE_MAP: z.string().optional(),
  })
  .passthrough();

const rawEnv = envSchema.parse(process.env);

function coercePositiveNumber(rawValue, fallback, label) {
  if (rawValue == null || rawValue === '') return fallback;
  const numeric = Number(rawValue);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return numeric;
}

let priceMap;
if (rawEnv.OPENROUTER_PRICE_MAP != null && rawEnv.OPENROUTER_PRICE_MAP !== '') {
  try {
    const parsed = JSON.parse(rawEnv.OPENROUTER_PRICE_MAP);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('OPENROUTER_PRICE_MAP must be a JSON object');
    }
    priceMap = parsed;
  } catch (error) {
    throw new Error(`OPENROUTER_PRICE_MAP must be valid JSON: ${error.message}`);
  }
}

function normalizeModel(value, fallback) {
  if (value == null) return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

export const runtimeConfig = {
  stageModels: {
    planner: normalizeModel(rawEnv.MODEL_PLANNER, 'anthropic/claude-sonnet-4'),
    writer: normalizeModel(rawEnv.MODEL_WRITER, 'anthropic/claude-sonnet-4'),
    critic: normalizeModel(rawEnv.MODEL_CRITIC, 'x-ai/grok-4-fast'),
  },
  readingWpm: coercePositiveNumber(rawEnv.READING_WPM, 220, 'READING_WPM'),
  defaultActivityMinutes: {
    guidedExample: coercePositiveNumber(
      rawEnv.DEFAULT_ACTIVITY_MIN_GUIDED_EXAMPLE,
      12,
      'DEFAULT_ACTIVITY_MIN_GUIDED_EXAMPLE',
    ),
    problemSet: coercePositiveNumber(
      rawEnv.DEFAULT_ACTIVITY_MIN_PROBLEM_SET,
      25,
      'DEFAULT_ACTIVITY_MIN_PROBLEM_SET',
    ),
    discussion: coercePositiveNumber(
      rawEnv.DEFAULT_ACTIVITY_MIN_DISCUSSION,
      10,
      'DEFAULT_ACTIVITY_MIN_DISCUSSION',
    ),
  },
  openrouterPriceMap: priceMap,
};
