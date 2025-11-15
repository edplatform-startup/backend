import { runtimeConfig } from '../config/env.js';

export const STAGES = Object.freeze({
  PLANNER: 'PLANNER',
  WRITER: 'WRITER',
  ASSESSOR: 'ASSESSOR',
  LINKER: 'LINKER',
  CRITIC: 'CRITIC',
  SELECTOR: 'SELECTOR',
  TOPICS: 'TOPICS',
});

const { courseV2Models = {} } = runtimeConfig;

const plannerModel = courseV2Models.syllabus || process.env.MODEL_PLANNER || 'x-ai/grok-4-fast';
const writerModel = courseV2Models.lessons || process.env.MODEL_WRITER || 'x-ai/grok-4-fast';
const assessorModel = courseV2Models.modules || plannerModel;
const criticModel = process.env.MODEL_CRITIC || courseV2Models.modules || 'x-ai/grok-4-fast';
const topicsModel =
  courseV2Models.topics ||
  process.env.MODEL_TOPICS ||
  process.env.TOPIC_MODEL ||
  writerModel ||
  plannerModel;
const topicTempRaw = process.env.TOPIC_MODEL_TEMP;
const topicTopPRaw = process.env.TOPIC_MODEL_TOP_P;
const topicTemp = topicTempRaw == null || topicTempRaw === '' ? 0.4 : Number(topicTempRaw);
const topicTopP = topicTopPRaw == null || topicTopPRaw === '' ? 0.75 : Number(topicTopPRaw);

const DEFAULTS = {
  [STAGES.PLANNER]: { model: plannerModel, temp: 0.28, top_p: 0.6 },
  [STAGES.WRITER]: {
    model: writerModel,
    temp: 0.55,
    top_p: 0.9,
    freq: 0.2,
    pres: 0.1,
  },
  [STAGES.ASSESSOR]: { model: assessorModel, temp: 0.35, top_p: 0.7 },
  [STAGES.LINKER]: { model: writerModel, temp: 0.45, top_p: 0.85 },
  [STAGES.CRITIC]: { model: criticModel, temp: 0.15, top_p: 0.4 },
  [STAGES.SELECTOR]: { model: criticModel, temp: 0.1, top_p: 0.4 },
  [STAGES.TOPICS]: {
    model: topicsModel,
    temp: Number.isFinite(topicTemp) ? topicTemp : 0.4,
    top_p: Number.isFinite(topicTopP) ? topicTopP : 0.75,
  },
};

export function pickModel(stage) {
  const d = DEFAULTS[stage];
  if (!d || !d.model) {
    const label = stage || 'UNKNOWN';
    throw new Error(`No model configuration found for stage "${label}"`);
  }
  return {
    model: d.model,
    temperature: d.temp,
    top_p: d.top_p,
    frequency_penalty: d.freq ?? 0,
    presence_penalty: d.pres ?? 0,
  };
}

export function shouldUseTools(stage) {
  return stage === STAGES.PLANNER || stage === STAGES.WRITER || stage === STAGES.ASSESSOR;
}

const resolvedFallbacks = [courseV2Models.fallback, courseV2Models.secondaryFallback].filter(Boolean);

export const FALLBACKS = resolvedFallbacks.length
  ? resolvedFallbacks
  : ['anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.3-70b-instruct:free'];

export function nextFallback(i) {
  return FALLBACKS[i] || null;
}
