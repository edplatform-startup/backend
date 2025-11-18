import { runtimeConfig } from '../config/env.js';

export const STAGES = Object.freeze({
  PLANNER: 'PLANNER',
  TOPICS: 'TOPICS',
});

const { courseV2Models = {} } = runtimeConfig;

const plannerModel = courseV2Models.syllabus || process.env.MODEL_PLANNER || 'x-ai/grok-4-fast';
const topicsModel =
  courseV2Models.topics || process.env.MODEL_TOPICS || process.env.TOPIC_MODEL || plannerModel;
const topicTempRaw = process.env.TOPIC_MODEL_TEMP;
const topicTopPRaw = process.env.TOPIC_MODEL_TOP_P;
const topicTemp = topicTempRaw == null || topicTempRaw === '' ? 0.4 : Number(topicTempRaw);
const topicTopP = topicTopPRaw == null || topicTopPRaw === '' ? 0.75 : Number(topicTopPRaw);

const DEFAULTS = {
  [STAGES.PLANNER]: { model: plannerModel, temp: 0.28, top_p: 0.6 },
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
  return stage === STAGES.PLANNER || stage === STAGES.TOPICS;
}

// Fallback models removed - using single model per stage only
export const FALLBACKS = [];

export function nextFallback(i) {
  return FALLBACKS[i] || null;
}
