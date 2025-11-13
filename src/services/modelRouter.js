export const STAGES = Object.freeze({
  PLANNER: 'PLANNER',
  WRITER: 'WRITER',
  ASSESSOR: 'ASSESSOR',
  LINKER: 'LINKER',
  CRITIC: 'CRITIC',
  SELECTOR: 'SELECTOR',
});

const DEFAULTS = {
  [STAGES.PLANNER]: { model: process.env.MODEL_PLANNER || 'openai/gpt-4o', temp: 0.28, top_p: 0.6 },
  [STAGES.WRITER]: {
    model: process.env.MODEL_WRITER || 'openai/gpt-4o-mini',
    temp: 0.55,
    top_p: 0.9,
    freq: 0.2,
    pres: 0.1,
  },
  [STAGES.ASSESSOR]: { model: process.env.MODEL_PLANNER || 'openai/gpt-4o', temp: 0.35, top_p: 0.7 },
  [STAGES.LINKER]: { model: process.env.MODEL_WRITER || 'openai/gpt-4o-mini', temp: 0.45, top_p: 0.85 },
  [STAGES.CRITIC]: { model: process.env.MODEL_CRITIC || 'openai/gpt-4o', temp: 0.15, top_p: 0.4 },
  [STAGES.SELECTOR]: { model: process.env.MODEL_CRITIC || 'openai/gpt-4o', temp: 0.1, top_p: 0.4 },
};

export function pickModel(stage) {
  const d = DEFAULTS[stage] || DEFAULTS[STAGES.PLANNER];
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

export const FALLBACKS = ['anthropic/claude-3.5-sonnet', 'meta/llama-3.1-70b-instruct'];

export function nextFallback(i) {
  return FALLBACKS[i] || null;
}
