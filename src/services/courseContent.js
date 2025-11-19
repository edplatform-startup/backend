import { getSupabase } from '../supabaseClient.js';
import { executeOpenRouterChat } from './grokClient.js';

const STATUS_PENDING = 'pending';
const STATUS_READY = 'ready';
const STATUS_ERROR = 'error';
const COURSE_STATUS_READY = 'ready';
const COURSE_STATUS_BLOCKED = 'needs_attention';
const DEFAULT_CONCURRENCY = 5;

let customSaveCourseStructure = null;
let customGenerateContent = null;
let grokExecutor = executeOpenRouterChat;
let customYouTubeFetcher = null;

export function __setSaveCourseStructureOverride(fn) {
  customSaveCourseStructure = typeof fn === 'function' ? fn : null;
}

export function __resetSaveCourseStructureOverride() {
  customSaveCourseStructure = null;
}

export function __setGenerateCourseContentOverride(fn) {
  customGenerateContent = typeof fn === 'function' ? fn : null;
}

export function __resetGenerateCourseContentOverride() {
  customGenerateContent = null;
}

export function __setGrokExecutor(fn) {
  grokExecutor = typeof fn === 'function' ? fn : executeOpenRouterChat;
}

export function __resetGrokExecutor() {
  grokExecutor = executeOpenRouterChat;
}

export function __setYouTubeFetcher(fn) {
  customYouTubeFetcher = typeof fn === 'function' ? fn : null;
}

export function __resetYouTubeFetcher() {
  customYouTubeFetcher = null;
}

export async function saveCourseStructure(courseId, userId, lessonGraph) {
  if (customSaveCourseStructure) {
    return await customSaveCourseStructure(courseId, userId, lessonGraph);
  }
  return persistCourseStructure(courseId, userId, lessonGraph);
}

export async function generateCourseContent(courseId, options = {}) {
  if (customGenerateContent) {
    return await customGenerateContent(courseId, options);
  }
  return runContentWorker(courseId, options);
}

function normalizeGraphInput(lessonGraph = {}) {
  if (!lessonGraph || typeof lessonGraph !== 'object') {
    throw new Error('[saveCourseStructure] lessonGraph must be an object');
  }
  const nodes = Array.isArray(lessonGraph.finalNodes)
    ? lessonGraph.finalNodes
    : Array.isArray(lessonGraph.nodes)
    ? lessonGraph.nodes
    : [];
  const edges = Array.isArray(lessonGraph.finalEdges)
    ? lessonGraph.finalEdges
    : Array.isArray(lessonGraph.edges)
    ? lessonGraph.edges
    : [];
  return { nodes, edges };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cloneJson(value) {
  if (!isPlainObject(value)) return {};
  return JSON.parse(JSON.stringify(value));
}

async function persistCourseStructure(courseId, userId, lessonGraph) {
  if (!courseId) throw new Error('[saveCourseStructure] courseId is required');
  if (!userId) throw new Error('[saveCourseStructure] userId is required');
  const { nodes, edges } = normalizeGraphInput(lessonGraph);
  if (!nodes.length) {
    throw new Error('[saveCourseStructure] lessonGraph contains no nodes');
  }

  const supabase = getSupabase();
  const nowIso = new Date().toISOString();

  const nodePayloads = nodes.map((node) => {
    if (!node?.id) {
      throw new Error('[saveCourseStructure] Node is missing id');
    }
    const basePayload = isPlainObject(node.content_payload) ? { ...node.content_payload } : {};
    const metadata = isPlainObject(node.metadata) ? { ...node.metadata } : null;
    const generationPlans = isPlainObject(basePayload.generation_plans)
      ? basePayload.generation_plans
      : isPlainObject(node.content_plans)
      ? cloneJson(node.content_plans)
      : {};
    const contentPayload = {
      ...basePayload,
      status: STATUS_PENDING,
      generation_plans: generationPlans,
      metadata: metadata ?? basePayload.metadata ?? null,
    };

    return {
      id: node.id,
      course_id: courseId,
      user_id: userId,
      title: node.title ?? null,
      description: node.description ?? null,
      intrinsic_exam_value: node.intrinsic_exam_value ?? null,
      bloom_level: node.bloom_level ?? null,
      yield_tag: node.yield_tag ?? null,
      estimated_minutes: node.estimated_minutes ?? null,
      is_checkpoint: Boolean(node.is_checkpoint),
      in_degree: node.in_degree ?? 0,
      out_degree: node.out_degree ?? 0,
      module_ref: node.module_ref ?? null,
      confidence_score: typeof node.confidence_score === 'number' ? node.confidence_score : 0.1,
      generation_prompt: generationPlans ? JSON.stringify(generationPlans) : node.generation_prompt ?? null,
      content_payload: contentPayload,
      metadata,
      created_at: node.created_at ?? nowIso,
      updated_at: nowIso,
    };
  });

  const { error: nodeError } = await supabase
    .schema('api')
    .from('course_nodes')
    .insert(nodePayloads)
    .select('id');

  if (nodeError) {
    throw new Error(`[saveCourseStructure] Failed to insert course nodes: ${nodeError.message || nodeError}`);
  }

  if (edges.length) {
    const edgePayloads = edges.map((edge) => {
      if (!edge?.parent_id || !edge?.child_id) {
        throw new Error('[saveCourseStructure] Edge missing parent_id or child_id');
      }
      return {
        course_id: courseId,
        parent_id: edge.parent_id,
        child_id: edge.child_id,
      };
    });
    const { error: edgeError } = await supabase
      .schema('api')
      .from('node_dependencies')
      .insert(edgePayloads)
      .select('parent_id');
    if (edgeError) {
      throw new Error(`[saveCourseStructure] Failed to insert node dependencies: ${edgeError.message || edgeError}`);
    }
  }

  const userNodeStatePayloads = nodes.map((node) => ({
    course_id: courseId,
    node_id: node.id,
    user_id: userId,
    confidence_score: typeof node.confidence_score === 'number' ? node.confidence_score : 0.1,
    familiarity_score: typeof node.confidence_score === 'number' ? node.confidence_score : 0.1,
  }));

  const { error: stateError } = await supabase
    .schema('api')
    .from('user_node_state')
    .insert(userNodeStatePayloads)
    .select('node_id');

  if (stateError) {
    throw new Error(`[saveCourseStructure] Failed to initialize user_node_state: ${stateError.message || stateError}`);
  }

  return { nodeCount: nodes.length, edgeCount: edges.length };
}

async function runContentWorker(courseId, options = {}) {
  if (!courseId) throw new Error('[generateCourseContent] courseId is required');
  const supabase = getSupabase();

  const { data: pendingNodes, error: fetchError } = await supabase
    .schema('api')
    .from('course_nodes')
    .select('id, title, content_payload, metadata')
    .eq('course_id', courseId)
    .contains('content_payload', { status: STATUS_PENDING });

  if (fetchError) {
    throw new Error(`[generateCourseContent] Failed to load pending nodes: ${fetchError.message || fetchError}`);
  }

  if (!pendingNodes || pendingNodes.length === 0) {
    await updateCourseStatus(supabase, courseId, COURSE_STATUS_READY, { processed: 0, failed: 0 });
    return { processed: 0, failed: 0, status: COURSE_STATUS_READY };
  }

  const limit = pendingNodes.length < 20 ? Math.max(1, pendingNodes.length) : options.concurrency || DEFAULT_CONCURRENCY;
  const results = await runWithConcurrency(pendingNodes, limit, async (node) => {
    try {
      await processNode(node, supabase);
      return { nodeId: node.id };
    } catch (error) {
      await markNodeError(node, supabase, error);
      throw error;
    }
  });

  const failures = results.filter((result) => result.status === 'rejected');
  const summary = {
    processed: pendingNodes.length,
    failed: failures.length,
  };
  const courseStatus = failures.length ? COURSE_STATUS_BLOCKED : COURSE_STATUS_READY;
  await updateCourseStatus(supabase, courseId, courseStatus, summary);

  return { ...summary, status: courseStatus, failures: failures.map((f) => f.reason?.message || 'Unknown error') };
}

async function processNode(node, supabase) {
  const payload = isPlainObject(node.content_payload) ? { ...node.content_payload } : {};
  const plans = isPlainObject(payload.generation_plans) ? payload.generation_plans : null;
  if (!plans || Object.keys(plans).length === 0) {
    throw new Error('Node is missing generation_plans');
  }

  const existingMetadata = isPlainObject(payload.metadata)
    ? payload.metadata
    : isPlainObject(node.metadata)
    ? node.metadata
    : null;

  const readingPromise = plans.reading ? generateReading(node.title, plans.reading) : Promise.resolve(null);
  const quizPromise = plans.quiz ? generateQuiz(node.title, plans.quiz) : Promise.resolve(null);
  const flashcardsPromise = plans.flashcards ? generateFlashcards(node.title, plans.flashcards) : Promise.resolve(null);
  const videoPromise = plans.video ? fetchVideoResource(plans.video) : Promise.resolve(null);

  const [reading, quiz, flashcards, video] = await Promise.all([
    readingPromise,
    quizPromise,
    flashcardsPromise,
    videoPromise,
  ]);

  const finalPayload = {
    reading,
    quiz,
    flashcards,
    video,
    generation_plans: plans,
    metadata: existingMetadata,
    status: STATUS_READY,
  };

  const { error: updateError } = await supabase
    .schema('api')
    .from('course_nodes')
    .update({ content_payload: finalPayload })
    .eq('id', node.id)
    .select('id')
    .single();

  if (updateError) {
    throw new Error(`[generateCourseContent] Failed to update node ${node.id}: ${updateError.message || updateError}`);
  }
}

async function markNodeError(node, supabase, error) {
  const payload = isPlainObject(node.content_payload) ? { ...node.content_payload } : {};
  payload.status = STATUS_ERROR;
  payload.error_message = error?.message || 'Unknown worker error';

  await supabase
    .schema('api')
    .from('course_nodes')
    .update({ content_payload: payload })
    .eq('id', node.id)
    .select('id')
    .single();
}

async function updateCourseStatus(supabase, courseId, status, summary) {
  try {
    const { data: courseRow } = await supabase
      .schema('api')
      .from('courses')
      .select('course_data')
      .eq('id', courseId)
      .single();

    const previous = isPlainObject(courseRow?.course_data) ? courseRow.course_data : {};
    const next = {
      ...previous,
      status,
      last_worker_summary: {
        ...(isPlainObject(previous.last_worker_summary) ? previous.last_worker_summary : {}),
        ...summary,
        updated_at: new Date().toISOString(),
      },
    };

    await supabase
      .schema('api')
      .from('courses')
      .update({ course_data: next })
      .eq('id', courseId)
      .select('id')
      .single();
  } catch (error) {
    console.warn('[generateCourseContent] Failed to update course status:', error?.message || error);
  }
}

async function runWithConcurrency(items, limit, worker) {
  if (!items.length) return [];
  const results = new Array(items.length);
  let index = 0;

  async function next() {
    const currentIndex = index;
    index += 1;
    if (currentIndex >= items.length) return;
    try {
      const value = await worker(items[currentIndex], currentIndex);
      results[currentIndex] = { status: 'fulfilled', value };
    } catch (error) {
      results[currentIndex] = { status: 'rejected', reason: error };
    }
    return next();
  }

  const runners = Array.from({ length: Math.min(limit, items.length) }, () => next());
  await Promise.all(runners);
  return results;
}

function coerceModelText(content) {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('')
      .trim();
  }
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return content.text.trim();
  }
  return '';
}

function stripJsonFences(raw) {
  return raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function parseJsonArray(raw, fallbackKey) {
  if (!raw) return [];
  const stripped = stripJsonFences(raw);
  if (!stripped) return [];
  let parsed;
  try {
    parsed = JSON.parse(stripped);
  } catch (error) {
    throw new Error(`Failed to parse JSON for ${fallbackKey}: ${error.message}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (fallbackKey && Array.isArray(parsed[fallbackKey])) return parsed[fallbackKey];
  return [];
}

async function generateReading(title, plan) {
  const messages = [
    {
      role: 'system',
      content: 'You are an elite instructional designer creating rigorous university-level study materials. Always return polished Markdown with headers, callouts, and applied examples.',
    },
    {
      role: 'user',
      content: `Write a comprehensive university-level reading lesson in Markdown for "${title || 'this lesson'}". ${plan}`,
    },
  ];
  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.35,
    maxTokens: 1800,
    messages,
    requestTimeoutMs: 120000,
  });
  const text = coerceModelText(content);
  if (!text) {
    throw new Error('Reading generator returned empty content');
  }
  return text;
}

async function generateQuiz(title, plan) {
  const messages = [
    {
      role: 'system',
      content:
        'Produce rigorous assessment content. Always respond with JSON: {"questions": [{"question":"...","options":["..."],"correct_index":0,"explanation":"..."}]}',
    },
    {
      role: 'user',
      content: `Generate a JSON array of 3 multiple-choice questions for "${title || 'this lesson'}". Each item must include { question, options[], correct_index, explanation }. ${plan}`,
    },
  ];
  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.2,
    maxTokens: 900,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 120000,
  });
  const text = coerceModelText(content);
  const questions = parseJsonArray(text, 'questions');
  if (!questions.length) {
    throw new Error('Quiz generator returned no questions');
  }
  return questions.map((item, index) => normalizeQuizItem(item, index));
}

function normalizeQuizItem(item, index) {
  const question = typeof item?.question === 'string' ? item.question.trim() : '';
  const explanation = typeof item?.explanation === 'string' ? item.explanation.trim() : '';
  const options = Array.isArray(item?.options) ? item.options.map((opt) => (typeof opt === 'string' ? opt : String(opt))) : [];
  const correctIndex = Number.isInteger(item?.correct_index) ? item.correct_index : 0;
  if (!question || options.length < 2) {
    throw new Error(`Quiz item ${index + 1} is invalid`);
  }
  return {
    question,
    options,
    correct_index: correctIndex,
    explanation: explanation || 'Answer rationale not provided.',
  };
}

async function generateFlashcards(title, plan) {
  const messages = [
    {
      role: 'system',
      content:
        'Return JSON only: {"flashcards": [{"front":"Question?","back":"Answer"}]} with graduate-level precision and mnemonics when helpful.',
    },
    {
      role: 'user',
      content: `Generate a JSON array of 5 flashcards for "${title || 'this topic'}". Each flashcard must have { front, back }. ${plan}`,
    },
  ];
  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.25,
    maxTokens: 700,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 120000,
  });
  const text = coerceModelText(content);
  const flashcards = parseJsonArray(text, 'flashcards');
  if (!flashcards.length) {
    throw new Error('Flashcard generator returned no cards');
  }
  return flashcards.map((card, index) => normalizeFlashcard(card, index));
}

function normalizeFlashcard(card, index) {
  const front = typeof card?.front === 'string' ? card.front.trim() : '';
  const back = typeof card?.back === 'string' ? card.back.trim() : '';
  if (!front || !back) {
    throw new Error(`Flashcard ${index + 1} is invalid`);
  }
  return { front, back };
}

async function fetchVideoResource(queries) {
  if (!Array.isArray(queries) || queries.length === 0) {
    return null;
  }
  if (customYouTubeFetcher) {
    try {
      return await customYouTubeFetcher(queries);
    } catch (error) {
      console.warn('[generateCourseContent] Custom YouTube fetcher failed:', error?.message || error);
      return null;
    }
  }
  const apiKey = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    return null;
  }

  for (const query of queries) {
    try {
      const url = new URL('https://www.googleapis.com/youtube/v3/search');
      url.searchParams.set('part', 'snippet');
      url.searchParams.set('q', query);
      url.searchParams.set('maxResults', '1');
      url.searchParams.set('type', 'video');
      url.searchParams.set('key', apiKey);

      const response = await fetch(url.toString(), {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        continue;
      }
      const data = await response.json();
      const first = Array.isArray(data?.items) ? data.items[0] : null;
      if (!first?.id?.videoId) {
        continue;
      }
      return {
        videoId: first.id.videoId,
        title: first.snippet?.title || 'Unknown title',
        thumbnail: first.snippet?.thumbnails?.high?.url || first.snippet?.thumbnails?.default?.url || null,
      };
    } catch (error) {
      console.warn('[generateCourseContent] YouTube search failed:', error?.message || error);
    }
  }
  return null;
}
