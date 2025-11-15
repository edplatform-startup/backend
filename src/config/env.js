import 'dotenv/config';
import { z } from 'zod';

const envSchema = z
  .object({
    MODEL_PLANNER: z.string().optional(),
    MODEL_WRITER: z.string().optional(),
    MODEL_CRITIC: z.string().optional(),
    COURSE_V2_DEFAULT_MODEL: z.string().optional(),
    COURSE_V2_SYLLABUS_MODEL: z.string().optional(),
    COURSE_V2_MODULES_MODEL: z.string().optional(),
    COURSE_V2_LESSONS_MODEL: z.string().optional(),
    COURSE_V2_TOPICS_MODEL: z.string().optional(),
    COURSE_V2_FALLBACK_MODEL: z.string().optional(),
    COURSE_V2_SECONDARY_FALLBACK_MODEL: z.string().optional(),
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

const courseV2Defaults = {
  defaultModel: normalizeModel(rawEnv.COURSE_V2_DEFAULT_MODEL, 'openai/gpt-4o-mini'),
  syllabusModel: normalizeModel(rawEnv.COURSE_V2_SYLLABUS_MODEL, rawEnv.MODEL_PLANNER || 'openai/gpt-4o'),
  modulesModel: normalizeModel(rawEnv.COURSE_V2_MODULES_MODEL, rawEnv.MODEL_PLANNER || 'openai/gpt-4o'),
  lessonsModel: normalizeModel(rawEnv.COURSE_V2_LESSONS_MODEL, rawEnv.MODEL_WRITER || 'openai/gpt-4o-mini'),
  topicsModel: normalizeModel(
    rawEnv.COURSE_V2_TOPICS_MODEL,
    rawEnv.TOPIC_MODEL || rawEnv.MODEL_TOPICS || rawEnv.MODEL_WRITER || 'openai/gpt-4o-mini',
  ),
  fallbackModel: normalizeModel(rawEnv.COURSE_V2_FALLBACK_MODEL, 'anthropic/claude-3.5-sonnet'),
  secondaryFallbackModel: normalizeModel(
    rawEnv.COURSE_V2_SECONDARY_FALLBACK_MODEL,
    'meta-llama/Meta-Llama-3.1-70B-Instruct',
  ),
};

export const runtimeConfig = {
  stageModels: {
    planner: normalizeModel(rawEnv.MODEL_PLANNER, 'anthropic/claude-sonnet-4'),
    writer: normalizeModel(rawEnv.MODEL_WRITER, 'anthropic/claude-sonnet-4'),
    critic: normalizeModel(rawEnv.MODEL_CRITIC, 'x-ai/grok-4-fast'),
  },
  courseV2Models: {
    default: courseV2Defaults.defaultModel,
    syllabus: courseV2Defaults.syllabusModel,
    modules: courseV2Defaults.modulesModel,
    lessons: courseV2Defaults.lessonsModel,
    topics: courseV2Defaults.topicsModel,
    fallback: courseV2Defaults.fallbackModel,
    secondaryFallback: courseV2Defaults.secondaryFallbackModel,
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
