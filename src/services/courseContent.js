import { getSupabase } from '../supabaseClient.js';
import { executeOpenRouterChat } from './grokClient.js';
import { tryParseJson } from '../utils/jsonUtils.js';
import yts from 'yt-search';

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

// Export for testing - internal functions exposed for unit tests
export { mergeValidatedArray as __mergeValidatedArray };
export { validateExplanations as __validateExplanations };
export { checkRationaleConsistency as __checkRationaleConsistency };
export { MIN_EXPLANATION_LENGTH as __MIN_EXPLANATION_LENGTH };

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
    .select('id, title, content_payload, metadata, module_ref, user_id, course_id')
    .eq('course_id', courseId)
    .contains('content_payload', { status: STATUS_PENDING });

  if (fetchError) {
    throw new Error(`[generateCourseContent] Failed to load pending nodes: ${fetchError.message || fetchError}`);
  }

  if (!pendingNodes || pendingNodes.length === 0) {
    await updateCourseStatus(supabase, courseId, COURSE_STATUS_READY);
    return { processed: 0, failed: 0, status: COURSE_STATUS_READY };
  }

  const limit = pendingNodes.length < 20 ? Math.max(1, pendingNodes.length) : options.concurrency || DEFAULT_CONCURRENCY;

  // Optimization: Fetch course title once if possible, or we can rely on it being passed or fetched inside.
  // Since we don't have it easily here without another query, let's fetch it once.
  const { data: courseData } = await supabase.schema('api').from('courses').select('title, metadata, user_id').eq('id', courseId).single();
  const courseTitle = courseData?.title || 'Unknown Course';
  const mode = courseData?.metadata?.mode || 'deep';
  const userName = courseData?.metadata?.user_name || courseData?.user_id || 'Unknown User';

  // Progress tracking for logging
  let completedNodes = 0;
  const totalNodes = pendingNodes.length;
  const logProgress = (stage) => {
    const percent = Math.round((completedNodes / totalNodes) * 100);
    console.log(`[Course Generation] User: ${userName} | Course: "${courseTitle}" | ${stage} | ${percent}% complete`);
  };

  logProgress('Starting content generation');

  // Fetch all nodes and edges to build dependency map for context injection
  const { data: allNodes } = await supabase
    .schema('api')
    .from('course_nodes')
    .select('id, title')
    .eq('course_id', courseId);

  const { data: allEdges } = await supabase
    .schema('api')
    .from('node_dependencies')
    .select('parent_id, child_id')
    .eq('course_id', courseId);

  const nodeTitleMap = new Map((allNodes || []).map(n => [n.id, n.title]));
  const prereqMap = new Map();

  if (allEdges) {
    allEdges.forEach(edge => {
      if (!prereqMap.has(edge.child_id)) {
        prereqMap.set(edge.child_id, []);
      }
      const pTitle = nodeTitleMap.get(edge.parent_id);
      if (pTitle) {
        prereqMap.get(edge.child_id).push(pTitle);
      }
    });
  }

  const results = await runWithConcurrency(pendingNodes, limit, async (node, index) => {
    try {
      const prereqs = prereqMap.get(node.id) || [];
      await processNode(node, supabase, courseTitle, prereqs, mode, userName);
      completedNodes++;
      logProgress(`Completed node ${completedNodes}/${totalNodes}: "${node.title}"`);
      return { nodeId: node.id };
    } catch (error) {
      await markNodeError(node, supabase, error);
      completedNodes++;
      logProgress(`Failed node ${completedNodes}/${totalNodes}: "${node.title}"`);
      throw error;
    }
  });

  const failures = results.filter((result) => result.status === 'rejected');

  // Aggregate stats from successful results
  const aggregateStats = {
    reading: { total: 0, immediate: 0, repaired_llm: 0, failed: 0, retries: 0 },
    quiz: { total: 0, immediate: 0, repaired_llm: 0, failed: 0, retries: 0 },
    flashcards: { total: 0, immediate: 0, repaired_llm: 0, failed: 0, retries: 0 },
    practice_problems: { total: 0, immediate: 0, repaired_llm: 0, failed: 0, retries: 0, verified: 0, corrected: 0 },
    video: { total: 0, successful: 0, failed: 0 }
  };

  results.forEach((result) => {
    if (result.status === 'fulfilled' && result.value?.stats) {
      const nodeStats = result.value.stats;
      Object.keys(nodeStats).forEach((type) => {
        if (aggregateStats[type]) {
          aggregateStats[type].total += nodeStats[type].total || 0;
          aggregateStats[type].immediate += nodeStats[type].immediate || 0;
          aggregateStats[type].repaired_llm += nodeStats[type].repaired_llm || 0;
          aggregateStats[type].failed += nodeStats[type].failed || 0;
          aggregateStats[type].retries += nodeStats[type].retries || 0;
        }
      });
    }
  });

  Object.entries(aggregateStats).forEach(([type, stats]) => {
    if (type === 'video') {
    } else {
    }
  });

  const summary = {
    processed: pendingNodes.length,
    failed: failures.length,
    stats: aggregateStats
  };
  const courseStatus = failures.length ? COURSE_STATUS_BLOCKED : COURSE_STATUS_READY;
  await updateCourseStatus(supabase, courseId, courseStatus);

  // Final completion log
  console.log(`[Course Generation] User: ${userName} | Course: "${courseTitle}" | COMPLETED | 100% complete | ${pendingNodes.length - failures.length}/${pendingNodes.length} nodes successful`);

  return { ...summary, status: courseStatus, failures: failures.map((f) => f.reason?.message || 'Unknown error') };
}

async function processNode(node, supabase, courseTitle, prereqs = [], mode = 'deep', userName = 'Unknown User') {
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

  const moduleName = node.module_ref || 'General Module';
  const lessonName = node.title || 'Untitled Lesson';

  // Helper for logging stage progress
  const logStage = (stage) => {
    console.log(`[Course Generation] User: ${userName} | Course: "${courseTitle}" | Lesson: "${lessonName}" | Stage: ${stage}`);
  };

  // Wrap each generator in a try-catch to prevent one failure from blocking the whole node
  const safeGenerate = async (promise, label) => {
    logStage(label);
    try {
      return await promise;
    } catch (error) {
      return null; // Return null to indicate failure but allow other content to proceed
    }
  };

  const readingPromise = plans.reading
    ? safeGenerate(generateReading(lessonName, plans.reading, courseTitle, moduleName, prereqs, mode, node.user_id, node.course_id), 'Generating Reading')
    : Promise.resolve(null);

  const quizPromise = plans.quiz
    ? safeGenerate(generateQuiz(lessonName, plans.quiz, courseTitle, moduleName, prereqs, mode, node.user_id, node.course_id), 'Generating Quiz')
    : Promise.resolve(null);

  const flashcardsPromise = plans.flashcards
    ? safeGenerate(generateFlashcards(lessonName, plans.flashcards, courseTitle, moduleName, node.user_id, node.course_id), 'Generating Flashcards')
    : Promise.resolve(null);

  const practiceProblemsPlan = plans.practice_problems ?? plans.practiceProblems;
  const practiceProblemsPromise = practiceProblemsPlan
    ? safeGenerate(generatePracticeProblems(lessonName, practiceProblemsPlan, courseTitle, moduleName, node.user_id, node.course_id), 'Generating Practice Problems')
    : Promise.resolve(null);

  const videoPromise = plans.video
    ? safeGenerate(generateVideoSelection(plans.video, node.user_id, node.course_id), 'Selecting Video')
    : Promise.resolve({ videos: [], logs: [] });

  const [readingRes, quizRes, flashcardsRes, videoResult, practiceProblemsRes] = await Promise.all([
    readingPromise,
    quizPromise,
    flashcardsPromise,
    videoPromise,
    practiceProblemsPromise,
  ]);

  // Save Quizzes to DB
  if (quizRes?.data?.length) {
    const quizPayloads = quizRes.data.map(q => ({
      course_id: node.course_id,
      node_id: node.id,
      user_id: node.user_id,
      question: q.question,
      options: q.options,
      correct_index: q.correct_index,
      correct_index: q.correct_index,
      explanation: JSON.stringify(q.explanation),
      status: 'unattempted'
    }));
    const { error: quizError } = await supabase.schema('api').from('quiz_questions').insert(quizPayloads);
    if (quizError) {
      console.error(`[processNode] Failed to save quizzes for node ${node.id}:`, quizError);
      // We don't throw here to avoid failing the whole node content update, but we log it.
    }
  }

  // Save Flashcards to DB
  if (flashcardsRes?.data?.length) {
    const flashcardPayloads = flashcardsRes.data.map(f => ({
      course_id: node.course_id,
      node_id: node.id,
      user_id: node.user_id,
      front: f.front,
      back: f.back,
      next_show_timestamp: new Date().toISOString()
    }));
    const { error: fcError } = await supabase.schema('api').from('flashcards').insert(flashcardPayloads);
    if (fcError) {
      console.error(`[processNode] Failed to save flashcards for node ${node.id}:`, fcError);
    }
  }

  const videos = videoResult?.videos || [];
  const videoLogs = videoResult?.logs || [];
  const videoUrls = Array.isArray(videos) ? videos.map(v => `https://www.youtube.com/watch?v=${v.videoId}`).join(', ') : '';

  const finalPayload = {
    reading: readingRes?.data || null,
    quiz: quizRes?.data || null,
    flashcards: flashcardsRes?.data || null,
    practice_problems: practiceProblemsRes?.data || null,
    video: videos, // Keep original array structure
    video_urls: videoUrls, // New CSV field
    video_logs: videoLogs, // Detailed logs
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

  // Collect stats
  const nodeStats = {
    reading: readingRes?.stats || {},
    quiz: quizRes?.stats || {},
    flashcards: flashcardsRes?.stats || {},
    practice_problems: practiceProblemsRes?.stats || {},
    video: { total: 1, successful: videos.length > 0 ? 1 : 0, failed: videos.length === 0 ? 1 : 0 }
  };

  return { nodeId: node.id, stats: nodeStats };
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

async function updateCourseStatus(supabase, courseId, status) {
  try {
    const { error } = await supabase
      .schema('api')
      .from('courses')
      .update({ status })
      .eq('id', courseId)
      .select('id')
      .single();

    if (error) {
      throw error;
    }
  } catch (error) {
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

function cleanModelOutput(raw) {
  return raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```markdown\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .replace(/\\'/g, "'")
    .trim();
}

function parseJsonArray(raw, fallbackKey) {
  if (!raw) return [];
  try {
    const parsed = tryParseJson(raw, 'parseJsonArray');
    if (Array.isArray(parsed)) return parsed;
    if (fallbackKey && Array.isArray(parsed[fallbackKey])) return parsed[fallbackKey];
    return [];
  } catch (error) {
    throw new Error(`Failed to parse JSON for ${fallbackKey}: ${error.message}`);
  }
}

function parseJsonObject(raw, label) {
  if (!raw) return null;
  try {
    return tryParseJson(raw, label);
  } catch (error) {
    throw new Error(`Failed to parse JSON for ${label}: ${error.message}`);
  }
}

async function repairContentArray(items, validator, repairPromptBuilder, label, userId, courseId) {
  let currentItems = [...items];
  const maxRetries = 2;

  let validItems = new Array(items.length).fill(null);
  let brokenIndices = [];

  const stats = {
    total: items.length,
    immediate: 0,
    repaired_llm: 0,
    failed: 0,
    retries: 0
  };

  // Initial Pass
  for (let i = 0; i < currentItems.length; i++) {
    const result = validator(currentItems[i], i);
    if (result.valid) {
      validItems[i] = result.data;
      stats.immediate++;
    } else {
      brokenIndices.push({ index: i, item: currentItems[i], error: result.error });
    }
  }

  if (brokenIndices.length === 0) {
    return { items: validItems.filter(Boolean), stats };
  }


  // Retry Loop
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    if (brokenIndices.length === 0) break;
    stats.retries++;


    const brokenItems = brokenIndices.map(b => b.item);
    const errors = brokenIndices.map(b => b.error);
    const prompt = repairPromptBuilder(brokenItems, errors);

    try {
      const { content } = await grokExecutor({
        model: 'x-ai/grok-4-fast',
        temperature: 0.2,
        maxTokens: 2048,
        messages: [
          { role: 'system', content: 'You are a JSON repair assistant. Fix the provided broken JSON objects based on the error messages. Return a JSON object with a key "repaired_items" containing the array of fixed objects.' },
          { role: 'user', content: prompt }
        ],
        responseFormat: { type: 'json_object' },
        requestTimeoutMs: 60000,
        reasoning: 'high',
        userId,
        source: 'content_repair',
        courseId,
      });

      const raw = coerceModelText(content);
      const repairedArray = parseJsonArray(raw, 'repaired_items');

      const nextBrokenIndices = [];
      let repairedInThisBatch = 0;

      // Try to match repaired items to broken indices
      for (let k = 0; k < brokenIndices.length; k++) {
        const originalIndexInfo = brokenIndices[k];
        const repairedItem = repairedArray[k];

        if (!repairedItem) {
          nextBrokenIndices.push(originalIndexInfo);
          continue;
        }

        const result = validator(repairedItem, originalIndexInfo.index);
        if (result.valid) {
          validItems[originalIndexInfo.index] = result.data;
          repairedInThisBatch++;
        } else {
          nextBrokenIndices.push({
            index: originalIndexInfo.index,
            item: repairedItem,
            error: result.error
          });
        }
      }

      stats.repaired_llm += repairedInThisBatch;
      brokenIndices = nextBrokenIndices;

    } catch (err) {
    }
  }

  stats.failed = brokenIndices.length;
  if (stats.failed > 0) {
  } else {
  }

  // Return valid items, filtering out any that are still null
  return { items: validItems.filter(item => item !== null), stats };
}

// ============================================================================
// LaTeX Utilities
// ============================================================================

/**
 * Extract LaTeX content from model output, removing markdown code fences if present
 */
function extractLatexContent(raw) {
  if (!raw) return '';

  let content = raw.trim();

  // Remove markdown code fences (```latex ... ``` or ``` ... ```)
  const fenceMatch = content.match(/^```(?:latex)?\s*\n([\s\S]*?)\n```$/);
  if (fenceMatch) {
    content = fenceMatch[1].trim();
  }

  return content;
}

/**
 * Verify LaTeX document structure and common issues
 * Returns { valid: boolean, errors: string[], warnings: string[] }
 */
function verifyLatex(latex) {
  const errors = [];
  const warnings = [];

  if (!latex || typeof latex !== 'string') {
    return { valid: false, errors: ['LaTeX content is empty or invalid'], warnings: [] };
  }

  // Check for document class
  if (!latex.includes('\\documentclass')) {
    errors.push('Missing \\documentclass declaration');
  }

  // Check for document environment
  const hasBeginDoc = latex.includes('\\begin{document}');
  const hasEndDoc = latex.includes('\\end{document}');

  if (!hasBeginDoc) {
    errors.push('Missing \\begin{document}');
  }
  if (!hasEndDoc) {
    errors.push('Missing \\end{document}');
  }

  // Check for balanced braces
  const braceBalance = checkBraceBalance(latex);
  if (braceBalance !== 0) {
    errors.push(`Unbalanced braces: ${braceBalance > 0 ? 'too many opening' : 'too many closing'} braces`);
  }

  // Check for unmatched environments
  const unmatchedEnvs = findUnmatchedEnvironments(latex);
  if (unmatchedEnvs.length > 0) {
    errors.push(`Unmatched environments: ${unmatchedEnvs.join(', ')}`);
  }

  // Warn about markdown remnants
  if (latex.includes('**') || latex.includes('##') || /^[\*\-]\s/m.test(latex)) {
    warnings.push('Possible markdown syntax detected');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}

/**
 * Check if braces are balanced
 * Returns 0 if balanced, positive if more opening, negative if more closing
 */
function checkBraceBalance(text) {
  let balance = 0;
  let inComment = false;

  for (let i = 0; i < text.length; i++) {
    // Skip comments
    if (text[i] === '%' && (i === 0 || text[i - 1] !== '\\')) {
      inComment = true;
    }
    if (inComment && text[i] === '\n') {
      inComment = false;
      continue;
    }
    if (inComment) continue;

    // Count braces (ignore escaped ones)
    if (text[i] === '{' && (i === 0 || text[i - 1] !== '\\')) {
      balance++;
    } else if (text[i] === '}' && (i === 0 || text[i - 1] !== '\\')) {
      balance--;
    }
  }

  return balance;
}

/**
 * Find unmatched \begin{X} and \end{X} pairs
 * Returns array of unmatched environment names
 */
function findUnmatchedEnvironments(text) {
  const stack = [];
  const unmatched = [];

  // Match all \begin{envname} and \end{envname}
  const beginRegex = /\\begin\{([^}]+)\}/g;
  const endRegex = /\\end\{([^}]+)\}/g;

  const begins = [];
  const ends = [];

  let match;
  while ((match = beginRegex.exec(text)) !== null) {
    begins.push({ type: 'begin', name: match[1], index: match.index });
  }
  while ((match = endRegex.exec(text)) !== null) {
    ends.push({ type: 'end', name: match[1], index: match.index });
  }

  // Merge and sort by position
  const all = [...begins, ...ends].sort((a, b) => a.index - b.index);

  for (const item of all) {
    if (item.type === 'begin') {
      stack.push(item.name);
    } else {
      if (stack.length === 0 || stack[stack.length - 1] !== item.name) {
        unmatched.push(item.name);
      } else {
        stack.pop();
      }
    }
  }

  // Add remaining unclosed environments
  unmatched.push(...stack);

  return unmatched;
}

/**
 * Clean up LaTeX content to fix common issues
 */
function cleanupLatex(latex) {
  if (!latex) return '';

  let cleaned = latex;

  // 1. Remove markdown code fences if present
  cleaned = extractLatexContent(cleaned);

  // 2. Convert markdown bold/italic to LaTeX (outside math mode)
  // This is a simple replacement - doesn't handle math mode perfectly but helps
  cleaned = cleaned.replace(/\*\*([^*]+)\*\*/g, '\\textbf{$1}');
  cleaned = cleaned.replace(/\*([^*]+)\*/g, '\\textit{$1}');

  // 3. Convert markdown headers to LaTeX sections (if not in LaTeX format)
  cleaned = cleaned.replace(/^###\s+(.+)$/gm, '\\subsubsection{$1}');
  cleaned = cleaned.replace(/^##\s+(.+)$/gm, '\\subsection{$1}');
  cleaned = cleaned.replace(/^#\s+(.+)$/gm, '\\section{$1}');

  // 4. Convert markdown lists to LaTeX (basic conversion)
  // This is challenging to do perfectly, so we'll keep it simple

  // 5. Normalize whitespace
  // Remove excessive blank lines (more than 2)
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  // 6. Ensure document has proper structure if missing
  if (!cleaned.includes('\\documentclass')) {
    cleaned = '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{amsthm}\n\\usepackage{geometry}\n\\usepackage{hyperref}\n\\usepackage{enumitem}\n\n' + cleaned;
  }

  if (!cleaned.includes('\\begin{document}')) {
    const docClassEnd = cleaned.indexOf('\\documentclass');
    const insertPos = cleaned.indexOf('\n\n', docClassEnd) + 2;
    cleaned = cleaned.slice(0, insertPos) + '\\begin{document}\n\n' + cleaned.slice(insertPos);
  }

  if (!cleaned.includes('\\end{document}')) {
    cleaned += '\n\n\\end{document}';
  }

  return cleaned.trim();
}




/**
 * Split markdown content into logical chunks.
 * Avoids splitting inside code blocks or LaTeX.
 * Merges small chunks.
 */
function splitContentIntoChunks(markdown) {
  if (!markdown) return [];

  const lines = markdown.split('\n');
  const chunks = [];
  let currentChunk = [];
  let inCodeBlock = false;
  let inLatexBlock = false;

  for (const line of lines) {
    // Toggle block states
    if (line.trim().startsWith('```')) {
      inCodeBlock = !inCodeBlock;
    }
    if (line.trim().startsWith('$$')) {
      inLatexBlock = !inLatexBlock;
    }

    // Check for split points (headers) only if not in a block
    const isHeader = /^#{1,3}\s/.test(line);

    if (isHeader && !inCodeBlock && !inLatexBlock && currentChunk.length > 0) {
      // Push current chunk if it has substantive content
      const chunkText = currentChunk.join('\n').trim();
      if (chunkText) {
        chunks.push(chunkText);
      }
      currentChunk = [line];
    } else {
      currentChunk.push(line);
    }
  }

  // Push last chunk
  if (currentChunk.length > 0) {
    const chunkText = currentChunk.join('\n').trim();
    if (chunkText) {
      chunks.push(chunkText);
    }
  }

  // Filter and merge chunks to ensure minimum size
  const mergedChunks = [];
  let buffer = '';
  const MIN_CHUNK_SIZE = 1500;

  for (const chunk of chunks) {
    if (buffer.length < MIN_CHUNK_SIZE) {
      buffer += (buffer ? '\n\n' : '') + chunk;
    } else {
      mergedChunks.push(buffer);
      buffer = chunk;
    }
  }

  if (buffer) {
    // If the last buffer is small and we have previous chunks, merge it to the last one
    if (mergedChunks.length > 0 && buffer.length < 500) {
      mergedChunks[mergedChunks.length - 1] += '\n\n' + buffer;
    } else {
      mergedChunks.push(buffer);
    }
  }

  return mergedChunks;
}



/**
 * Generate a single multiple-choice question for a chunk.
 */
import { pickModel, STAGES } from './modelRouter.js';

/**
 * Generate a single multiple-choice question for a chunk.
 */
/**
 * Generate a single multiple-choice question for a chunk.
 */
function validateInlineQuestionFormat(markdown) {
  if (!markdown) return { valid: false, error: 'Empty content' };

  // 1. Header Check
  const headerRegex = /(?:^Question:|^[\*]{0,2}Question:[\*]{0,2}|^[\*]{0,2}Check Your Understanding[\*]{0,2})/mi;
  if (!headerRegex.test(markdown)) {
    return { valid: false, error: 'Missing or invalid header' };
  }

  // 2. Options Check
  const optionRegex = /^[-*]?\s*[A-D][.)]\s+/gm;
  const options = markdown.match(optionRegex);
  if (!options || options.length < 4) {
    return { valid: false, error: 'Must have at least 4 options (A-D)' };
  }

  const letters = options.map(o => o.match(/[A-D]/i)[0].toUpperCase());
  const uniqueLetters = new Set(letters);
  if (!uniqueLetters.has('A') || !uniqueLetters.has('B') || !uniqueLetters.has('C') || !uniqueLetters.has('D')) {
    return { valid: false, error: 'Missing one or more options A-D' };
  }

  // 3. Answer Section Check
  const detailsRegex = /<details>[\s\S]*?<\/details>/i;
  const detailsMatch = markdown.match(detailsRegex);
  if (!detailsMatch) {
    return { valid: false, error: 'Missing <details> block for answer' };
  }

  const answerRegex = /\*\*Answer:\*\*\s*[A-D]/i;
  if (!answerRegex.test(detailsMatch[0])) {
    return { valid: false, error: 'Missing or invalid **Answer:** format inside details' };
  }

  return { valid: true };
}

function manualRepairInlineQuestion(markdown) {
  let repaired = markdown;

  // 1. Repair Header
  const headerRegex = /(?:^Question:|^[\*]{0,2}Question:[\*]{0,2}|^[\*]{0,2}Check Your Understanding[\*]{0,2})/mi;
  if (!headerRegex.test(repaired)) {
    repaired = `**Check Your Understanding**\n\n${repaired}`;
  }

  // 2. Repair Answer Section
  const answerRegex = /(\*\*Answer:\*\*\s*[A-D][\s\S]*)/i;
  const detailsRegex = /<details>[\s\S]*?<\/details>/i;

  if (answerRegex.test(repaired) && !detailsRegex.test(repaired)) {
    const match = repaired.match(answerRegex);
    if (match) {
      const answerBlock = match[0];
      repaired = repaired.replace(answerBlock, '');
      repaired = repaired.trim() + `\n\n<details><summary>Show Answer</summary>\n\n${answerBlock.trim()}\n</details>`;
    }
  }

  return repaired;
}

export async function generateInlineQuestion(chunkText, contextInfo = {}, userId, courseId) {


  const systemPrompt = {
    role: 'system',
    content: `You are an expert instructional designer and subject matter expert. 
Your goal is to create a single, high-quality multiple-choice question that tests DEEP UNDERSTANDING of the provided text.
Avoid simple recall questions. Focus on:
- Synthesis of concepts
- Application of knowledge
- Identifying key implications or causes

Return JSON ONLY:
{
  "question": "string",
  "options": ["A", "B", "C", "D"],
  "answerIndex": number (0-3),
  "explanation": ["Expl for A", "Expl for B", "Expl for C", "Expl for D"]
}
Ensure answerIndex is valid.
"explanation" must be an array of 4 strings, corresponding to each option.
- For the correct option, explain WHY it is correct.
- For incorrect options, explain WHY they are incorrect.
- Do NOT give away the answer by making the correct option significantly longer or always in the same position.
Use inline LaTeX (\\(...\\)) or display math (\\[...\\]) only when required. Do NOT use $ or $$.`,
  };

  const userPrompt = {
    role: 'user',
    content: `Create one deep-understanding multiple-choice question for this content:\n\n${chunkText.slice(0, 1500)}...`,
  };

  try {
    const response = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0.3, // Slightly higher for creativity in question design
      maxTokens: 16384,
      messages: [systemPrompt, userPrompt],
      responseFormat: { type: 'json_object' },
      reasoning: 'high',
      userId,
      source: 'inline_question',
      courseId,
    });

    const content = response.content;
    const raw = coerceModelText(content);
    let parsed = parseJsonObject(raw, 'inline_question');

    // --- VALIDATION & REPAIR ---
    const validator = (item) => {
      try {
        if (!item || typeof item !== 'object') throw new Error('Item is not an object');
        if (!item.question || typeof item.question !== 'string') throw new Error('Missing question');
        if (!Array.isArray(item.options) || item.options.length !== 4) throw new Error('Options must be an array of 4 strings');
        if (!Number.isInteger(item.answerIndex) || item.answerIndex < 0 || item.answerIndex > 3) throw new Error('answerIndex must be 0-3');
        if (!Array.isArray(item.explanation) || item.explanation.length !== 4) throw new Error('Explanation must be an array of 4 strings');
        
        // Strict explanation validation - same as quiz questions
        const expValidation = validateExplanations(item.explanation, 4);
        if (!expValidation.valid) throw new Error(`Explanation validation failed: ${expValidation.error}`);
        
        // Rationale consistency check - convert to quiz format for the check
        const quizFormatItem = {
          question: item.question,
          options: item.options,
          correct_index: item.answerIndex,
          explanation: item.explanation
        };
        const consistency = checkRationaleConsistency(quizFormatItem);
        if (!consistency.valid) {
          console.warn(`[generateInlineQuestion] Rationale consistency warnings: ${consistency.warnings.join(', ')}`);
        }
        
        return { valid: true, data: item };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    };

    const repairPrompt = (brokenItems, errors) => {
      return `The following inline question is invalid:\n${JSON.stringify(brokenItems[0], null, 2)}\n\nError:\n${errors[0]}\n\nPlease regenerate it correctly. 
CRITICAL REQUIREMENTS:
- 'options' must be an array of exactly 4 answer choices
- 'explanation' must be an array of exactly 4 SUBSTANTIVE explanations (minimum 15 characters each)
- Each explanation must be a COMPLETE sentence explaining why that option is correct or incorrect
- NO placeholder text like "Incorrect" or "Not the answer"
- For the correct option: explain WHY it is the right answer with supporting reasoning
- For incorrect options: explain the specific misconception or error`;
    };

    // Wrap in array for the repair tool
    const { items: repairedItems } = await repairContentArray([parsed], validator, repairPrompt, 'generateInlineQuestion', userId, courseId);

    // If repair failed, try targeted rationale fix
    if (!repairedItems.length) {
      console.log('[generateInlineQuestion] Standard repair failed. Attempting targeted rationale fix.');
      const quizFormatItem = {
        question: parsed?.question || '',
        options: parsed?.options || [],
        correct_index: parsed?.answerIndex ?? 0,
        explanation: parsed?.explanation || []
      };
      const fixedQuestion = await fixMissingRationales(quizFormatItem, userId, courseId);
      if (fixedQuestion) {
        // Convert back to inline format
        parsed = {
          question: fixedQuestion.question,
          options: fixedQuestion.options,
          answerIndex: fixedQuestion.correct_index,
          explanation: fixedQuestion.explanation
        };
        // Validate the fix
        const fixValidation = validator(parsed);
        if (!fixValidation.valid) {
          console.warn('[generateInlineQuestion] Targeted rationale fix did not resolve validation issues.');
          return null;
        }
      } else {
        return null;
      }
    } else {
      parsed = repairedItems[0];
    }

    const answerIndex = parsed.answerIndex;
    const correctOption = ['A', 'B', 'C', 'D'][answerIndex];

    // Format as Markdown
    let md = `\n\n**Check Your Understanding**\n\n${parsed.question}\n\n`;
    parsed.options.forEach((opt, i) => {
      const letter = ['A', 'B', 'C', 'D'][i];
      let cleanOpt = opt.trim().replace(/^[A-D][.)]\s*/i, '').trim();
      md += `- ${letter}. ${cleanOpt}\n`;
    });

    // Build explanations list
    const explanationList = parsed.options.map((_, i) => {
      const letter = ['A', 'B', 'C', 'D'][i];
      const isCorrect = i === answerIndex;
      const icon = isCorrect ? '✅' : '❌';
      return `- **${letter}** ${icon} ${parsed.explanation[i]}`;
    }).join('\n');

    md += `\n<details><summary>Show Answer</summary>\n\n**Answer:** ${correctOption}\n\n${explanationList}\n</details>\n`;

    // --- FORMAT VALIDATION & REPAIR ---
    let validatedMd = md;
    let formatCheck = validateInlineQuestionFormat(validatedMd);

    if (!formatCheck.valid) {
      console.log(`[generateInlineQuestion] Format invalid: ${formatCheck.error}. Attempting manual repair.`);
      validatedMd = manualRepairInlineQuestion(validatedMd);
      formatCheck = validateInlineQuestionFormat(validatedMd);
    }

    if (!formatCheck.valid) {
      console.log(`[generateInlineQuestion] Manual repair failed. Attempting LLM repair.`);
      // LLM Repair Loop for Markdown
      const repairPrompt = (brokenItems, errors) => {
        return `The following inline question markdown is invalid:\n\n${brokenItems[0]}\n\nError:\n${errors[0]}\n\nPlease fix the markdown to strictly follow this format:
1. Header: **Check Your Understanding**
2. Options: - A. Text, - B. Text, etc.
3. Answer: Inside <details><summary>Show Answer</summary> block, with **Answer:** X.

Return JSON: { "repaired_markdown": "string" }`;
      };

      const validator = (item) => validateInlineQuestionFormat(item);

      // We need to adapt repairContentArray or write a simple loop here since repairContentArray expects objects/arrays
      // Let's write a simple loop here for string repair
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const response = await grokExecutor({
            model: 'x-ai/grok-4-fast',
            temperature: 0.2,
            maxTokens: 1024,
            messages: [
              { role: 'system', content: 'You are a Markdown repair assistant. Return JSON with "repaired_markdown".' },
              { role: 'user', content: repairPrompt([validatedMd], [formatCheck.error]) }
            ],
            responseFormat: { type: 'json_object' },
            reasoning: 'high',
            userId,
            source: 'inline_question_repair',
            courseId,
          });
          const raw = coerceModelText(response.content);
          const parsed = parseJsonObject(raw, 'inline_repair');
          if (parsed && parsed.repaired_markdown) {
            const check = validateInlineQuestionFormat(parsed.repaired_markdown);
            if (check.valid) {
              validatedMd = parsed.repaired_markdown;
              formatCheck = { valid: true };
              break;
            } else {
              formatCheck = check; // Update error for next try
            }
          }
        } catch (e) {
          console.warn('Inline question LLM repair failed', e);
        }
      }
    }

    if (!formatCheck.valid) {
      console.warn('[generateInlineQuestion] Failed to generate valid inline question format. Skipping.');
      return null;
    }

    // --- CONTENT VALIDATION STEP ---
    const validationContext = `Context: ${contextInfo.title || 'Unknown Lesson'} (${contextInfo.courseName || 'Unknown Course'})\nContent Snippet: ${chunkText.slice(0, 200)}...`;
    const contentValidatedMd = await validateContent('inline_question', validatedMd, validationContext, userId, courseId);

    // Verify content validation didn't break format
    const finalCheck = validateInlineQuestionFormat(contentValidatedMd);
    if (!finalCheck.valid) {
      console.warn(`[generateInlineQuestion] validateContent broke the format: ${finalCheck.error}. Reverting to pre-validation version.`);
      return validatedMd; // Fallback to the formatted but potentially unvalidated content
    }

    // --- SELF-CONSISTENCY VERIFICATION ---
    // Convert inline question back to quiz format for consistency check
    const inlineAsQuiz = {
      question: parsed.question,
      options: parsed.options,
      correct_index: parsed.answerIndex,
      explanation: parsed.explanation
    };
    
    try {
      const consistencyResult = await verifySelfConsistency(inlineAsQuiz, chunkText, userId, courseId);
      
      if (!consistencyResult.consistent) {
        console.warn(`[generateInlineQuestion] Self-consistency check FAILED. Model answered ${['A', 'B', 'C', 'D'][consistencyResult.modelAnswer]} but correct is ${['A', 'B', 'C', 'D'][parsed.answerIndex]}`);
        
        // Attempt reconciliation
        const reconciledQuestion = await reconcileAnswerDiscrepancy(inlineAsQuiz, consistencyResult, chunkText, userId, courseId);
        
        if (reconciledQuestion && reconciledQuestion.correct_index !== parsed.answerIndex) {
          console.log(`[generateInlineQuestion] Answer reconciled: changed from ${['A', 'B', 'C', 'D'][parsed.answerIndex]} to ${['A', 'B', 'C', 'D'][reconciledQuestion.correct_index]}`);
          
          // Rebuild markdown with corrected answer
          const newAnswerIndex = reconciledQuestion.correct_index;
          const newCorrectOption = ['A', 'B', 'C', 'D'][newAnswerIndex];
          const newExplanations = reconciledQuestion.explanation || parsed.explanation;
          
          let reconciledMd = `\n\n**Check Your Understanding**\n\n${parsed.question}\n\n`;
          parsed.options.forEach((opt, i) => {
            const letter = ['A', 'B', 'C', 'D'][i];
            let cleanOpt = opt.trim().replace(/^[A-D][.)]\s*/i, '').trim();
            reconciledMd += `- ${letter}. ${cleanOpt}\n`;
          });
          
          const explanationList = parsed.options.map((_, i) => {
            const letter = ['A', 'B', 'C', 'D'][i];
            const isCorrect = i === newAnswerIndex;
            const icon = isCorrect ? '✅' : '❌';
            return `- **${letter}** ${icon} ${newExplanations[i] || 'Explanation not available.'}`;
          }).join('\n');
          
          reconciledMd += `\n<details><summary>Show Answer</summary>\n\n**Answer:** ${newCorrectOption}\n\n${explanationList}\n</details>\n`;
          
          return reconciledMd;
        } else if (!reconciledQuestion) {
          console.warn(`[generateInlineQuestion] Could not reconcile answer discrepancy. Keeping original but flagging.`);
        }
      }
    } catch (scError) {
      console.error(`[generateInlineQuestion] Self-consistency check error:`, scError.message);
      // Don't fail the question, just log the error
    }

    return contentValidatedMd;
  } catch (error) {
    return null;
  }
}



/**
 * Validates Mermaid code using an LLM.
 */
async function validateMermaidBlock(code, userId, courseId) {
  try {
    const response = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0.1,
      maxTokens: 512,
      messages: [
        {
          role: 'system',
          content: `You are a strict Mermaid syntax validator. Check the following Mermaid code for syntax errors.
If valid, return JSON: { "valid": true }
If invalid, return JSON: { "valid": false, "error": "Detailed error message explaining exactly what is wrong" }
Do not fix the code, just validate it.`
        },
        { role: 'user', content: code }
      ],
      responseFormat: { type: 'json_object' },
      reasoning: 'high',
      userId,
      source: 'mermaid_validation',
      courseId,
    });

    const raw = coerceModelText(response.content);
    return parseJsonObject(raw, 'mermaid_validation');
  } catch (e) {
    // If validation fails (e.g. model error), assume valid to avoid blocking
    console.warn('Mermaid validation failed to run:', e);
    return { valid: true };
  }
}

/**
 * Repairs Mermaid code using an LLM loop.
 */
async function repairMermaidBlock(code, error, userId, courseId) {
  let currentCode = code;
  let currentError = error;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const response = await grokExecutor({
        model: 'x-ai/grok-4-fast',
        temperature: 0.2,
        maxTokens: 1024,
        messages: [
          {
            role: 'system',
            content: `You are a Mermaid code repair assistant. Fix the provided Mermaid code based on the error message.
Return JSON: { "repaired_code": "string" }
Ensure the code is valid Mermaid syntax. Do not include markdown fences in the string.`
          },
          {
            role: 'user',
            content: `Code:\n${currentCode}\n\nError:\n${currentError}`
          }
        ],
        responseFormat: { type: 'json_object' },
        reasoning: 'high',
        userId,
        source: 'mermaid_repair',
        courseId,
      });

      const raw = coerceModelText(response.content);
      const parsed = parseJsonObject(raw, 'mermaid_repair');

      if (parsed && parsed.repaired_code) {
        currentCode = parsed.repaired_code;
        // Re-validate
        const validation = await validateMermaidBlock(currentCode, userId, courseId);
        if (validation.valid) {
          return currentCode;
        }
        currentError = validation.error;
      }
    } catch (e) {
      console.warn(`Mermaid repair attempt ${attempt} failed:`, e);
    }
  }

  return null; // Failed to repair
}

export async function generateReading(title, plan, courseName, moduleName, prereqs = [], mode = 'deep', userId, courseId) {
  const contextNote = prereqs.length
    ? `Context: The student has completed lessons on [${prereqs.join(', ')}] and other prerequisites. They are now in the lesson [${title}] (this lesson). They have not yet learned topics from later lessons. Generate content accordingly.`
    : `Context: This is an introductory lesson with no prerequisites.`;

  const systemPrompt = {
    role: 'system',
    content: `You are an elite instructional designer producing concise, well-structured, easy-to-read learning content in Markdown.
You are building a reading lesson for "${title}" in module "${moduleName}" of course "${courseName}".
${contextNote}
${mode === 'cram' ? 'FOCUS: High-yield, exam-critical topics. Prioritize key definitions and concepts that appear frequently on exams.' : 'FOCUS: Comprehensive coverage. Include detailed examples, proofs (where applicable), and edge cases. Ensure deep understanding.'}

Always respond with JSON shaped exactly as:
{
  "internal_audit": "scratchpad reasoning about structure and coverage",
  "final_content": {
    "markdown": "FULL markdown content - use LaTeX inline only for math (e.g., \\(...\\)) or blocks that strictly need LaTeX"
  }
}

The internal_audit is a throwaway scratchpad — never include it inside the final markdown. Use LaTeX ONLY for math or constructs that cannot be expressed in simple Markdown. The markdown should be clean, readable, and use appropriate headings, lists, code blocks, and inline math where necessary.

CRITICAL REQUIREMENTS:
1. Prefer Markdown for all text, headings, lists and examples.
2. Use inline LaTeX (\\(...\\)) or display math (\\[...\\]) only when required. Do NOT use $ or $$.
3. Keep content clear for students — short paragraphs, helpful examples, and explicit definitions.
4. Do not include editor scratchpad text inside the markdown.
5. When examples require equations or formal notation, include LaTeX within math fences only.
6. Use consistent heading levels matching the plan (e.g., #, ##, ### as appropriate).
7. Do not reference any figure, graph, or image unless one is provided. If a visual aid is needed, describe it in text instead.
8. **Mermaid Diagrams:** You support the following Mermaid diagram types:
   - \`sequenceDiagram\` (protocols, algorithms)
   - \`classDiagram\` (OOP, data models)
   - \`stateDiagram - v2\` (finite states, UI flows)
   - \`erDiagram\` (databases)
   - \`gantt\` (timelines)
   - \`journey\` (user steps)
   - \`pie\` (distributions)
   - \`mindmap\` (concepts)
   - \`quadrantChart\` (2x2 frameworks)
   **CRITICAL:** Only generate a mermaid block if the plan EXPLICITLY requests it (e.g., "Include a sequence diagram..."). Do not generate diagrams otherwise.
   Syntax:
   \`\`\`mermaid
   graph TD;
     A-->B;
   \`\`\`
`,
  };

  const userPrompt = {
    role: 'user',
    content: `Generate a clear, student-facing Markdown reading for "${title}" following this plan:
${plan}

Return JSON ONLY. Populate final_content.markdown with the entire text. Markdown should be human-friendly, contain short, well-formatted paragraphs, headings, examples, and use LaTeX only for math or notation that cannot be expressed in Markdown.`,
  };

  const renderResponse = async (promptMessages) => {
    const { content } = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0.35,
      maxTokens: 8192,
      messages: promptMessages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 120000,
      reasoning: 'high',
      userId,
      source: 'reading_generation',
      courseId,
    });
    const raw = coerceModelText(content);
    let parsed;
    try {
      parsed = parseJsonObject(raw, 'reading');
    } catch (err) {
      throw err;
    }
    // Prefer markdown; fall back to latex extraction when markdown is not supplied
    let body = typeof parsed?.final_content?.markdown === 'string'
      ? parsed.final_content.markdown
      : typeof parsed?.final_content === 'string'
        ? parsed.final_content
        : (typeof parsed?.final_content?.latex === 'string' ? parsed.final_content.latex : '');

    if (!body) {
      throw new Error('Reading generator returned empty final_content');
    }

    // If we received LaTeX, extract the inner document text as a fallback; otherwise treat as Markdown
    if (body.includes('\\documentclass') || body.includes('\\begin{document}')) {
      // safely extract inner LaTeX content and keep as-is (student-facing) — we preserve math
      const latexOnly = extractLatexContent(body);
      return cleanupLatex(latexOnly);
    }

    let cleanedMarkdown = cleanupMarkdown(body);

    // --- MERMAID VALIDATION & REPAIR ---
    // Regex to find mermaid blocks: ```mermaid ... ```
    const mermaidRegex = /```mermaid\s*([\s\S]*?)\s*```/g;
    let match;
    const replacements = [];

    // Find all matches first
    while ((match = mermaidRegex.exec(cleanedMarkdown)) !== null) {
      replacements.push({
        fullMatch: match[0],
        code: match[1],
        index: match.index
      });
    }

    // Process sequentially to avoid overlapping replacement issues if we were doing string manipulation in place
    // But since we're replacing exact blocks, we can just do string replace.
    // However, if multiple identical blocks exist, string.replace might replace the wrong one.
    // Better to reconstruct the string or use a unique placeholder.
    // For simplicity, we'll iterate and replace.

    for (const item of replacements) {
      const validation = await validateMermaidBlock(item.code, userId, courseId);
      if (!validation.valid) {
        console.log(`Found invalid Mermaid block. Error: ${validation.error}. Attempting repair...`);
        const repairedCode = await repairMermaidBlock(item.code, validation.error, userId, courseId);
        if (repairedCode) {
          console.log('Mermaid block repaired successfully.');
          // Replace the *exact* full match with the repaired version
          // We use split/join or specific replacement to ensure we target this instance if possible,
          // but for now, simple replace is likely safe enough as identical invalid blocks are rare.
          const newBlock = `\`\`\`mermaid\n${repairedCode}\n\`\`\``;
          cleanedMarkdown = cleanedMarkdown.replace(item.fullMatch, newBlock);
        } else {
          console.warn('Failed to repair Mermaid block. Keeping original (or could comment out).');
          // Optional: Comment it out to prevent rendering errors?
          // cleanedMarkdown = cleanedMarkdown.replace(item.fullMatch, `<!-- Invalid Mermaid Diagram: ${validation.error} -->\n${item.fullMatch}`);
        }
      }
    }

    return cleanedMarkdown;
  };
  let resultText = await renderResponse([systemPrompt, userPrompt]);
  let retries = 0;

  if (!resultText || !resultText.trim()) {
    // Retry once with a clear instruction
    retries++;
    const retryAsk = {
      role: 'user',
      content: `The previous response was empty or invalid. Re-run and produce final_content.markdown containing clean Markdown (use LaTeX only for math). Do not include internal_audit in final content. Plan: ${plan}`,
    };
    resultText = await renderResponse([systemPrompt, retryAsk]);
  }

  if (!resultText || !resultText.trim()) {
    throw new Error('Reading generator returned empty content after retry');
  }

  // --- ENRICHMENT STEP ---
  try {
    const chunks = splitContentIntoChunks(resultText);
    const enrichedChunks = [];
    const MAX_ENRICHED = 5;

    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i];

      // Only enrich the first N chunks
      if (i < MAX_ENRICHED && chunk.length > 500) {
        // Generate inline question
        const questionMd = await generateInlineQuestion(chunk, { title, courseName, moduleName }, userId);
        if (questionMd) {
          chunk += questionMd;
        }
      }

      enrichedChunks.push(chunk);
    }

    resultText = enrichedChunks.join('\n\n---\n\n');
  } catch (enrichError) {
    // Fallback to original text if enrichment blows up
  }

  // --- VALIDATION STEP ---
  const validationContext = `Course: ${courseName}\nModule: ${moduleName}\nLesson: ${title}\nPlan: ${plan}`;
  const validatedText = await validateContent('reading', resultText, validationContext, userId, courseId);

  return {
    data: validatedText,
    stats: {
      total: 1,
      immediate: retries === 0 ? 1 : 0,
      repaired_llm: retries > 0 ? 1 : 0,
      failed: 0,
      retries
    }
  };
}

function cleanupMarkdown(md) {
  if (!md || typeof md !== 'string') return '';
  let out = md.trim();
  // Remove triple-backtick fences producing JSON or markdown blocks accidentally captured
  out = out.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
  // Normalize line endings and excessive blank lines
  out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  // Trim trailing spaces on each line
  out = out.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');
  return out.trim();
}

export async function generateQuiz(title, plan, courseName, moduleName, prereqs = [], mode = 'deep', userId, courseId) {
  const contextNote = prereqs.length
    ? `Context: The student has completed lessons on [${prereqs.join(', ')}]. Do not test concepts from future lessons.`
    : `Context: This is an introductory lesson.`;

  // Select a random prerequisite for cumulative review if available
  let reviewInstruction = '';
  if (prereqs.length > 0) {
    // Pick one random prereq to review
    const randomPrereq = prereqs[Math.floor(Math.random() * prereqs.length)];
    reviewInstruction = `\n- **Cumulative Review:** Include exactly one question that reviews a key concept from the prerequisite lesson "${randomPrereq}". This question should reinforce retention and be accessible.`;
  }

  const messages = [
    {
      role: 'system',
      content: `You are building a graduate-level quiz for the lesson "${title}" in module "${moduleName}" of course "${courseName}".
${contextNote}

Always respond with JSON:
{
  "internal_audit": "global scratchpad validating coverage and difficulty",
  "quiz": [
    {
      "validation_check": "Chain-of-thought ensuring only one correct option",
      "question": "Student-facing stem",
      "options": ["..."],
      "correct_index": 0,
      "explanation": ["Expl for A", "Expl for B", "Expl for C", "Expl for D"]
    }
  ]
}

Rules:
- validation_check is the ONLY place you reason about distractors
- "explanation" must be an array of 4 strings, corresponding to each option.
- For the correct option, explain WHY it is correct.
- For incorrect options, explain WHY they are incorrect.
- Do NOT give away the answer by making the correct option significantly longer or always in the same position.
- Exactly one option may be correct, enforce via validation_check.
- Ensure questions vary in difficulty (Easy, Medium, Hard).
- You MUST include one "Challenge Question" that is significantly harder, designed to stump even strong students (mark it as Hard).${reviewInstruction}
- Use inline LaTeX (\\(...\\)) or display math (\\[...\\]) only when required. Do NOT use $ or $$.
`,
    },
    {
      role: 'user',
      content: `Generate JSON with a 'quiz' array of **${mode === 'cram' ? '5-7' : (mode === 'deep' ? '12-15' : '8-12')} comprehensive multiple-choice questions** plus 1 extra "Challenge Question" (total ${mode === 'cram' ? '6-8' : (mode === 'deep' ? '13-16' : '9-13')} questions) for "${title}". 
      Follow the plan:
${plan}

Each question: 4 options, single correct_index, validation_check before finalizing, explanation array for all options. Ensure the last question is the Challenge Question.
Ensure the questions cover the ENTIRE breadth of the lesson content provided in the plan.`,
    },
  ];
  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.2,
    maxTokens: 2048, // Increased for detailed explanations
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 120000,
    reasoning: 'high',
    userId,
    source: 'quiz_generation',
    courseId,
  });
  const text = coerceModelText(content);

  let questions;
  try {
    questions = parseJsonArray(text, 'quiz');
    if (!questions.length) {
      questions = parseJsonArray(text, 'questions');
    }

    const validator = (item, index) => {
      try {
        let cleanItem = item;
        if (item && typeof item === 'object') {
          const { validation_check, step_by_step_thinking, ...rest } = item;
          cleanItem = rest;
        }
        
        // Pre-check explanations before normalization for clearer error messages
        if (!Array.isArray(cleanItem?.explanation) || cleanItem.explanation.length !== 4) {
          return { valid: false, error: `Incomplete explanations: expected array of 4, got ${Array.isArray(cleanItem?.explanation) ? cleanItem.explanation.length : 'non-array'}` };
        }
        if (cleanItem.explanation.some(ex => !ex || typeof ex !== 'string' || ex.trim().length < MIN_EXPLANATION_LENGTH)) {
          const shortIdx = cleanItem.explanation.findIndex(ex => !ex || typeof ex !== 'string' || ex.trim().length < MIN_EXPLANATION_LENGTH);
          return { valid: false, error: `Explanation for option ${shortIdx + 1} is missing or too short (need ${MIN_EXPLANATION_LENGTH}+ chars)` };
        }
        
        return { valid: true, data: normalizeQuizItem(cleanItem, index, true) };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    };

    const repairPrompt = (brokenItems, errors) => {
      return `The following quiz items are invalid:\n${JSON.stringify(brokenItems, null, 2)}\n\nErrors:\n${JSON.stringify(errors, null, 2)}\n\nPlease regenerate these items correctly. CRITICAL REQUIREMENTS:
- Each item MUST have: 'question', 'options' (array of exactly 4 strings), 'correct_index' (0-3)
- Each item MUST have 'explanation' as an array of EXACTLY 4 SUBSTANTIVE strings (minimum ${MIN_EXPLANATION_LENGTH} characters each)
- For the correct option: explain WHY it is correct with specific reasoning
- For each incorrect option: explain WHY it is wrong and what misconception it represents
- Do NOT use placeholders like "Answer rationale not provided" or "..."`;  
    };

    const { items: repairedQuestions, stats } = await repairContentArray(questions, validator, repairPrompt, 'generateQuiz', userId, courseId);

    if (!repairedQuestions.length) {
      throw new Error('Quiz generator returned no valid questions after repair');
    }

    // --- VALIDATION STEP (Per-Question) ---
    const validationContext = `Course: ${courseName}\nModule: ${moduleName}\nLesson: ${title}\nPlan: ${plan}`;
    const { validatedQuestions, stats: validationStats } = await validateQuizQuestionsIndividually(
      repairedQuestions,
      validationContext,
      userId,
      courseId
    );

    // Merge validation stats into repair stats
    stats.validation = validationStats;

    // Log warning if any questions failed validation
    if (validationStats.failedValidation > 0) {
      console.warn(`[generateQuiz] ${validationStats.failedValidation} questions could not be fully validated for "${title}"`);
    }

    return { data: validatedQuestions, stats };
  } catch (err) {
    throw err;
  }
}

/**
 * Minimum character length for a valid explanation.
 * Explanations shorter than this are considered incomplete.
 */
const MIN_EXPLANATION_LENGTH = 15;

/**
 * Validates that explanations are complete and substantive.
 * @param {Array} explanation - Array of explanation strings
 * @param {number} optionsCount - Number of options (usually 4)
 * @returns {{valid: boolean, error?: string}}
 */
function validateExplanations(explanation, optionsCount = 4) {
  if (!Array.isArray(explanation)) {
    return { valid: false, error: 'Explanation must be an array' };
  }
  if (explanation.length !== optionsCount) {
    return { valid: false, error: `Explanation must have ${optionsCount} entries, got ${explanation.length}` };
  }
  
  const placeholders = ['answer rationale not provided', 'no explanation', 'n/a', '...', 'tbd', 'todo'];
  
  for (let i = 0; i < explanation.length; i++) {
    const exp = explanation[i];
    if (!exp || typeof exp !== 'string') {
      return { valid: false, error: `Explanation for option ${i + 1} is missing` };
    }
    const trimmed = exp.trim();
    if (trimmed.length < MIN_EXPLANATION_LENGTH) {
      return { valid: false, error: `Explanation for option ${i + 1} is too short (${trimmed.length} chars, need ${MIN_EXPLANATION_LENGTH}+)` };
    }
    if (placeholders.some(p => trimmed.toLowerCase().includes(p))) {
      return { valid: false, error: `Explanation for option ${i + 1} contains placeholder text` };
    }
  }
  return { valid: true };
}

/**
 * Checks rationale consistency - ensures correct answer's explanation sounds positive
 * and incorrect answers' explanations don't accidentally support them.
 * @param {object} item - Quiz item with question, options, correct_index, explanation
 * @returns {{valid: boolean, warnings: string[]}}
 */
function checkRationaleConsistency(item) {
  const warnings = [];
  const correctIdx = item.correct_index;
  const correctExp = item.explanation[correctIdx]?.toLowerCase() || '';
  
  // Negative indicators that shouldn't appear in correct answer's rationale
  const negativeIndicators = ['incorrect', 'wrong', 'false', 'not correct', 'is not', 'cannot be'];
  // Positive indicators that shouldn't appear strongly in incorrect answers' rationales
  const positiveIndicators = ['is correct', 'is the right', 'is true', 'is accurate', 'correctly'];
  
  // Check correct answer's explanation doesn't sound negative
  for (const neg of negativeIndicators) {
    if (correctExp.includes(neg) && !correctExp.includes('not ' + neg)) {
      // Simple heuristic: if explanation for correct answer says "incorrect" without negating it
      warnings.push(`Correct answer (option ${correctIdx + 1}) explanation contains negative language: "${neg}"`);
      break;
    }
  }
  
  // Check incorrect answers' explanations don't sound too positive
  for (let i = 0; i < item.explanation.length; i++) {
    if (i === correctIdx) continue;
    const exp = item.explanation[i]?.toLowerCase() || '';
    for (const pos of positiveIndicators) {
      if (exp.includes(pos)) {
        warnings.push(`Incorrect answer (option ${i + 1}) explanation contains positive language: "${pos}"`);
        break;
      }
    }
  }
  
  return { valid: warnings.length === 0, warnings };
}

function normalizeQuizItem(item, index, strictMode = true) {
  const question = typeof item?.question === 'string' ? item.question.trim() : '';

  // Handle explanation: ensure it's an array of strings
  let explanation = [];
  if (Array.isArray(item?.explanation)) {
    explanation = item.explanation.map(e => (typeof e === 'string' ? e.trim() : String(e)));
  } else if (typeof item?.explanation === 'string') {
    // Single string - this is invalid, we need 4
    explanation = [item.explanation.trim()];
  }

  const options = Array.isArray(item?.options) ? item.options.map((opt) => (typeof opt === 'string' ? opt : String(opt))) : [];
  const correctIndex = Number.isInteger(item?.correct_index) ? item.correct_index : 0;

  if (!question || options.length < 2) {
    throw new Error(`Quiz item ${index + 1} is invalid: missing question or options`);
  }
  
  if (options.length !== 4) {
    throw new Error(`Quiz item ${index + 1} must have exactly 4 options, got ${options.length}`);
  }
  
  if (correctIndex < 0 || correctIndex >= options.length) {
    throw new Error(`Quiz item ${index + 1} has invalid correct_index: ${correctIndex}`);
  }

  // In strict mode, enforce complete explanations
  if (strictMode) {
    const expValidation = validateExplanations(explanation, options.length);
    if (!expValidation.valid) {
      throw new Error(`Quiz item ${index + 1}: ${expValidation.error}`);
    }
  } else {
    // Non-strict mode: pad with placeholder (only for intermediate processing)
    while (explanation.length < options.length) {
      explanation.push('Explanation pending.');
    }
  }
  
  const normalized = {
    question,
    options,
    correct_index: correctIndex,
    explanation,
  };
  
  // Check rationale consistency and log warnings (don't fail, just warn)
  const consistency = checkRationaleConsistency(normalized);
  if (!consistency.valid) {
    console.warn(`[normalizeQuizItem] Q${index + 1} rationale consistency warnings:`, consistency.warnings);
  }
  
  return normalized;
}

/**
 * Generates practice problems - exam-style questions with detailed rubrics and sample answers.
 * These are more complex than quiz questions and designed to replicate authentic exam conditions.
 * @param {string} title - Lesson title
 * @param {string} plan - Generation plan from lesson architect
 * @param {string} courseName - Course name
 * @param {string} moduleName - Module name
 * @param {string} userId - User ID for tracking
 * @param {string} courseId - Course ID for tracking
 * @returns {Promise<{data: Array, stats: object}>}
 */
export async function generatePracticeProblems(title, plan, courseName, moduleName, userId, courseId) {
  const messages = [
    {
      role: 'system',
      content: `You are creating exam-style practice problems for the lesson "${title}" in module "${moduleName}" of course "${courseName}".

These problems should be MORE DIFFICULT than quiz questions and replicate authentic exam conditions.
Each problem should take 10-20 minutes to solve and require multi-step reasoning.

Always respond with JSON:
{
  "internal_audit": "reasoning about problem design, difficulty calibration, and coverage",
  "practice_problems": [
    {
      "validation_check": "Scratchpad verifying the problem is solvable, the rubric is fair, and the sample answer is correct",
      "question": "Full problem statement with all necessary information. Can include subparts (a, b, c...)",
      "estimated_minutes": 15,
      "difficulty": "Hard",
      "topic_tags": ["tag1", "tag2"],
      "rubric": {
        "total_points": 10,
        "grading_criteria": [
          {"criterion": "Correct identification of...", "points": 2, "common_errors": ["Forgetting to..."]},
          {"criterion": "Proper application of...", "points": 3, "common_errors": ["Using wrong formula..."]},
          {"criterion": "Complete and correct final answer", "points": 3, "common_errors": ["Arithmetic error..."]},
          {"criterion": "Clear presentation and justification", "points": 2, "common_errors": ["Missing units..."]}
        ],
        "partial_credit_policy": "Award partial credit for correct approach even if final answer is wrong"
      },
      "sample_answer": {
        "solution_steps": ["Step 1: ...", "Step 2: ...", "Step 3: ..."],
        "final_answer": "The answer is...",
        "key_insights": ["Important concept applied here...", "Common trap avoided by..."],
        "alternative_approaches": ["Could also solve by..."]
      }
    }
  ]
}

Rules:
- validation_check is required for every problem and must audit correctness before finalizing
- Problems should test APPLICATION and ANALYSIS, not just recall
- Rubrics must be specific enough that different graders would assign the same score
- Sample answers must show complete work, not just final answers
- Include common errors to help students learn from mistakes
- Use inline LaTeX (\\(...\\)) or display math (\\[...\\]) only when required. Do NOT use $ or $$.`,
    },
    {
      role: 'user',
      content: `Generate JSON with a 'practice_problems' array of exam-style problems for "${title}".
Plan / emphasis:
${plan}

Each problem should require 10-20 minutes, test deep understanding, and include a detailed rubric and sample answer.`,
    },
  ];

  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.25,
    maxTokens: 8192,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 180000,
    reasoning: 'high',
    userId,
    source: 'practice_problems_generation',
    courseId,
  });

  const text = coerceModelText(content);

  let rawItems;
  try {
    rawItems = parseJsonArray(text, 'practice_problems');

    const validator = (item, index) => {
      try {
        let cleanItem = item;
        if (item && typeof item === 'object') {
          const { validation_check, step_by_step_thinking, ...rest } = item;
          cleanItem = rest;
        }
        return { valid: true, data: normalizePracticeProblem(cleanItem, index) };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    };

    const repairPrompt = (brokenItems, errors) => {
      return `The following practice problems are invalid:\n${JSON.stringify(brokenItems, null, 2)}\n\nErrors:\n${JSON.stringify(errors, null, 2)}\n\nPlease regenerate these items correctly. Each must have:
- 'question': Full problem statement
- 'rubric': Object with 'total_points', 'grading_criteria' (array), and 'partial_credit_policy'
- 'sample_answer': Object with 'solution_steps' (array), 'final_answer', 'key_insights' (array)
- 'estimated_minutes': Number (10-20)
- 'difficulty': "Medium" or "Hard"
- 'topic_tags': Array of relevant topic strings`;
    };

    const { items: repairedItems, stats } = await repairContentArray(rawItems, validator, repairPrompt, 'generatePracticeProblems', userId, courseId);

    if (!repairedItems.length) {
      throw new Error('Practice problems generator returned no valid problems after repair');
    }

    // --- VALIDATION STEP: Verify rubric and sample answer accuracy ---
    const validationContext = `Course: ${courseName}\nModule: ${moduleName}\nLesson: ${title}\nPlan: ${plan}`;
    const { validatedProblems, validationStats } = await validatePracticeProblemsAccuracy(
      repairedItems,
      validationContext,
      userId,
      courseId
    );

    // Merge validation stats
    stats.validation = validationStats;

    return { data: validatedProblems, stats };
  } catch (err) {
    throw err;
  }
}

/**
 * Normalizes a practice problem ensuring all required fields are present.
 */
function normalizePracticeProblem(item, index) {
  const question = typeof item?.question === 'string' ? item.question.trim() : '';
  const estimatedMinutesRaw = Number(item?.estimated_minutes);
  const estimatedMinutes = Number.isFinite(estimatedMinutesRaw) && estimatedMinutesRaw > 0
    ? Math.round(estimatedMinutesRaw)
    : 15;
  const difficulty = ['Easy', 'Medium', 'Hard'].includes(item?.difficulty) ? item.difficulty : 'Medium';
  const topicTags = Array.isArray(item?.topic_tags) ? item.topic_tags.filter(t => typeof t === 'string') : [];

  // Validate rubric structure
  let rubric = item?.rubric;
  if (!rubric || typeof rubric !== 'object') {
    throw new Error(`Practice problem ${index + 1} is missing rubric`);
  }
  
  const totalPoints = typeof rubric.total_points === 'number' ? rubric.total_points : 10;
  const gradingCriteria = Array.isArray(rubric.grading_criteria) ? rubric.grading_criteria : [];
  const partialCreditPolicy = typeof rubric.partial_credit_policy === 'string' 
    ? rubric.partial_credit_policy 
    : 'Award partial credit for correct approach.';

  if (gradingCriteria.length === 0) {
    throw new Error(`Practice problem ${index + 1} has no grading criteria`);
  }

  // Normalize grading criteria
  const normalizedCriteria = gradingCriteria.map((c, i) => ({
    criterion: typeof c.criterion === 'string' ? c.criterion.trim() : `Criterion ${i + 1}`,
    points: typeof c.points === 'number' ? c.points : 1,
    common_errors: Array.isArray(c.common_errors) ? c.common_errors : []
  }));

  // Validate sample answer structure
  let sampleAnswer = item?.sample_answer;
  if (!sampleAnswer || typeof sampleAnswer !== 'object') {
    throw new Error(`Practice problem ${index + 1} is missing sample_answer`);
  }

  const solutionSteps = Array.isArray(sampleAnswer.solution_steps) ? sampleAnswer.solution_steps : [];
  const finalAnswer = typeof sampleAnswer.final_answer === 'string' ? sampleAnswer.final_answer.trim() : '';
  const keyInsights = Array.isArray(sampleAnswer.key_insights) ? sampleAnswer.key_insights : [];
  const alternativeApproaches = Array.isArray(sampleAnswer.alternative_approaches) ? sampleAnswer.alternative_approaches : [];

  if (!question) {
    throw new Error(`Practice problem ${index + 1} is missing question`);
  }
  if (solutionSteps.length === 0) {
    throw new Error(`Practice problem ${index + 1} has no solution steps`);
  }
  if (!finalAnswer) {
    throw new Error(`Practice problem ${index + 1} is missing final answer`);
  }

  return {
    question,
    estimated_minutes: estimatedMinutes,
    difficulty,
    topic_tags: topicTags,
    rubric: {
      total_points: totalPoints,
      grading_criteria: normalizedCriteria,
      partial_credit_policy: partialCreditPolicy
    },
    sample_answer: {
      solution_steps: solutionSteps.filter(s => typeof s === 'string' && s.trim()),
      final_answer: finalAnswer,
      key_insights: keyInsights.filter(i => typeof i === 'string'),
      alternative_approaches: alternativeApproaches.filter(a => typeof a === 'string')
    }
  };
}

/**
 * Validates practice problems accuracy using a fresh worker model.
 * Independently solves each problem and verifies the rubric/sample answer are correct.
 * @param {Array} problems - Array of practice problem objects
 * @param {string} context - Validation context
 * @param {string} userId - User ID for tracking
 * @param {string} courseId - Course ID for tracking
 * @returns {Promise<{validatedProblems: Array, validationStats: object}>}
 */
async function validatePracticeProblemsAccuracy(problems, context, userId, courseId) {
  const stats = {
    total: problems.length,
    verified: 0,
    corrected: 0,
    failed: 0
  };

  const validatedProblems = [];

  for (let i = 0; i < problems.length; i++) {
    const problem = problems[i];
    console.log(`[validatePracticeProblems] Validating problem ${i + 1}/${problems.length}`);

    try {
      const validationResult = await verifyPracticeProblemAccuracy(problem, context, userId, courseId);

      if (validationResult.isCorrect) {
        stats.verified++;
        validatedProblems.push({
          ...problem,
          _validated: true,
          _validationConfidence: validationResult.confidence
        });
      } else {
        // Problem has issues - attempt to fix
        console.warn(`[validatePracticeProblems] Problem ${i + 1} has issues: ${validationResult.issues.join(', ')}`);

        const correctedProblem = await correctPracticeProblem(problem, validationResult, context, userId, courseId);
        
        if (correctedProblem) {
          stats.corrected++;
          validatedProblems.push({
            ...correctedProblem,
            _validated: true,
            _corrected: true,
            _originalIssues: validationResult.issues
          });
        } else {
          // Could not fix - include with warning
          stats.failed++;
          validatedProblems.push({
            ...problem,
            _validationFailed: true,
            _validationIssues: validationResult.issues,
            _validationNote: 'This problem could not be fully validated. Manual review recommended.'
          });
        }
      }
    } catch (error) {
      console.error(`[validatePracticeProblems] Error validating problem ${i + 1}:`, error.message);
      stats.failed++;
      validatedProblems.push({
        ...problem,
        _validationError: error.message
      });
    }
  }

  console.log(`[validatePracticeProblems] Stats: ${JSON.stringify(stats)}`);
  return { validatedProblems, validationStats: stats };
}

/**
 * Uses a fresh worker model to independently solve the problem and verify correctness.
 */
async function verifyPracticeProblemAccuracy(problem, context, userId, courseId) {
  const messages = [
    {
      role: 'system',
      content: `You are an expert educator and subject matter validator. Your task is to:
1. Independently solve the given problem WITHOUT looking at the provided solution
2. Compare your answer with the provided sample answer
3. Evaluate whether the rubric is fair and correctly structured
4. Identify any issues with the problem, rubric, or sample answer

Return JSON:
{
  "my_solution": {
    "approach": "How I would solve this",
    "steps": ["Step 1...", "Step 2..."],
    "final_answer": "My answer"
  },
  "comparison": {
    "answers_match": true/false,
    "my_answer_is_correct": true/false,
    "provided_answer_is_correct": true/false,
    "discrepancy_explanation": "If answers differ, explain why"
  },
  "rubric_evaluation": {
    "is_fair": true/false,
    "covers_all_steps": true/false,
    "points_are_reasonable": true/false,
    "issues": ["Issue 1", "Issue 2"]
  },
  "overall_assessment": {
    "is_correct": true/false,
    "confidence": "high" | "medium" | "low",
    "issues": ["List of any issues found"],
    "recommendations": ["Suggested improvements"]
  }
}`
    },
    {
      role: 'user',
      content: `Context:
${context}

Problem to validate:
Question: ${problem.question}

Provided Rubric:
${JSON.stringify(problem.rubric, null, 2)}

Provided Sample Answer:
${JSON.stringify(problem.sample_answer, null, 2)}

Please independently solve this problem and validate the provided solution and rubric.`
    }
  ];

  try {
    const { content } = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0,
      maxTokens: 4096,
      messages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 120000,
      reasoning: 'high',
      userId,
      source: 'practice_problem_validation',
      courseId,
    });

    const raw = coerceModelText(content);
    const result = parseJsonObject(raw, 'practice_problem_validation');

    if (!result || !result.overall_assessment) {
      return { isCorrect: true, confidence: 'low', issues: ['Validation response incomplete'] };
    }

    return {
      isCorrect: result.overall_assessment.is_correct,
      confidence: result.overall_assessment.confidence || 'medium',
      issues: result.overall_assessment.issues || [],
      recommendations: result.overall_assessment.recommendations || [],
      validatorSolution: result.my_solution,
      comparison: result.comparison,
      rubricEvaluation: result.rubric_evaluation
    };
  } catch (error) {
    console.error('[verifyPracticeProblemAccuracy] Error:', error.message);
    return { isCorrect: true, confidence: 'error', issues: [error.message] };
  }
}

/**
 * Attempts to correct a practice problem based on validation feedback.
 */
async function correctPracticeProblem(problem, validationResult, context, userId, courseId) {
  const messages = [
    {
      role: 'system',
      content: `You are an expert educator correcting a practice problem that has validation issues.
Based on the validator's feedback, fix the problem's solution, rubric, or question as needed.

Return the COMPLETE corrected problem in this exact JSON format:
{
  "question": "Full problem statement",
  "estimated_minutes": 15,
  "difficulty": "Hard",
  "topic_tags": ["tag1"],
  "rubric": {
    "total_points": 10,
    "grading_criteria": [{"criterion": "...", "points": 2, "common_errors": ["..."]}],
    "partial_credit_policy": "..."
  },
  "sample_answer": {
    "solution_steps": ["Step 1...", "Step 2..."],
    "final_answer": "...",
    "key_insights": ["..."],
    "alternative_approaches": ["..."]
  }
}`
    },
    {
      role: 'user',
      content: `Context:
${context}

Original Problem:
${JSON.stringify(problem, null, 2)}

Validation Issues Found:
${validationResult.issues.join('\n- ')}

Validator's Solution:
${JSON.stringify(validationResult.validatorSolution, null, 2)}

Recommendations:
${(validationResult.recommendations || []).join('\n- ')}

Please correct the problem to address these issues. Ensure the sample answer is mathematically/factually correct.`
    }
  ];

  try {
    const { content } = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0.2,
      maxTokens: 4096,
      messages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 90000,
      reasoning: 'high',
      userId,
      source: 'practice_problem_correction',
      courseId,
    });

    const raw = coerceModelText(content);
    const corrected = parseJsonObject(raw, 'practice_problem_correction');

    if (!corrected || !corrected.question || !corrected.rubric || !corrected.sample_answer) {
      return null;
    }

    // Normalize the corrected problem
    return normalizePracticeProblem(corrected, 0);
  } catch (error) {
    console.error('[correctPracticeProblem] Error:', error.message);
    return null;
  }
}

export async function generateFlashcards(title, plan, courseName, moduleName, userId, courseId) {
  const messages = [
    {
      role: 'system',
      content:
        `You are building flashcards for the lesson "${title}" in module "${moduleName}" of course "${courseName}". Adhere strictly to the generation plan.

Always respond with JSON:
{
  "internal_audit": "coverage reasoning + memorization heuristics",
  "flashcards": [
    {
      "step_by_step_thinking": "Scratchpad for mnemonic or reasoning",
      "front": "Prompt shown to learner",
      "back": "Concise, correct answer"
    }
  ]
}

Never include scratchpad text inside front/back.
Use inline LaTeX (\\(...\\)) or display math (\\[...\\]) only when required. Do NOT use $ or $$.`,
    },
    {
      role: 'user',
      content: `Generate JSON with a 'flashcards' array of 5 cards for "${title}".
Plan: ${plan}

Each card must include step_by_step_thinking (scratchpad), then final front/back wording.`,
    },
  ];
  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.25,
    maxTokens: 1024,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 120000,
    reasoning: 'high',
    userId,
    source: 'flashcards_generation',
    courseId,
  });
  const text = coerceModelText(content);

  let flashcards;
  try {
    flashcards = parseJsonArray(text, 'flashcards');

    const validator = (item, index) => {
      try {
        let cleanItem = item;
        if (item && typeof item === 'object') {
          const { step_by_step_thinking, internal_audit, ...rest } = item;
          cleanItem = rest;
        }
        return { valid: true, data: normalizeFlashcard(cleanItem, index) };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    };

    const repairPrompt = (brokenItems, errors) => {
      return `The following flashcards are invalid:\n${JSON.stringify(brokenItems, null, 2)}\n\nErrors:\n${JSON.stringify(errors, null, 2)}\n\nPlease regenerate these items correctly. Ensure each has 'front' and 'back'.`;
    };

    const { items: repairedCards, stats } = await repairContentArray(flashcards, validator, repairPrompt, 'generateFlashcards', userId, courseId);

    if (!repairedCards.length) {
      throw new Error('Flashcard generator returned no valid cards after repair');
    }

    // --- VALIDATION STEP ---
    const validationContext = `Course: ${courseName}\nModule: ${moduleName}\nLesson: ${title}\nPlan: ${plan}`;
    const validatedCards = await validateContent('flashcards', repairedCards, validationContext, userId, courseId);

    return { data: validatedCards, stats };
  } catch (err) {
    throw err;
  }
}

function normalizeFlashcard(card, index) {
  const front = typeof card?.front === 'string' ? card.front.trim() : '';
  const back = typeof card?.back === 'string' ? card.back.trim() : '';
  if (!front || !back) {
    throw new Error(`Flashcard ${index + 1} is invalid`);
  }
  return { front, back };
}

export async function regenerateReading(title, currentContent, changeInstruction, courseName, moduleName, prereqs = [], userId, courseId) {
  const contextNote = prereqs.length
    ? `Context: The student has completed lessons on [${prereqs.join(', ')}] and other prerequisites.`
    : `Context: This is an introductory lesson with no prerequisites.`;

  const systemPrompt = {
    role: 'system',
    content: `You are an elite instructional designer editing an existing reading lesson.
You are modifying the lesson "${title}" in module "${moduleName}" of course "${courseName}".
${contextNote}

Your goal is to rewrite the content based strictly on the Change Instruction.
Keep the parts that don't need changing, but ensure the flow remains coherent.

Always respond with JSON shaped exactly as:
{
  "internal_audit": "scratchpad reasoning about changes",
  "final_content": {
    "markdown": "FULL new markdown content"
  }
}

CRITICAL REQUIREMENTS:
1. Output the ENTIRE lesson content, not just the diff.
2. Prefer Markdown for all text, headings, lists and examples.
3. Use inline LaTeX (\\(...\\)) or display math (\\[...\\]) only when required. Do NOT use $ or $$.
4. Do NOT include inline questions or "Check Your Understanding" blocks; these will be generated automatically.
5. Do not include editor scratchpad text inside the markdown.
`,
  };

  const userPrompt = {
    role: 'user',
    content: `Current Content:
${currentContent}

Change Instruction:
${changeInstruction}

Return JSON ONLY. Populate final_content.markdown with the entire updated text.`,
  };

  const renderResponse = async (promptMessages) => {
    const { content } = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0.3,
      maxTokens: 8192,
      messages: promptMessages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 120000,
      reasoning: 'high',
      userId,
      source: 'reading_regeneration',
      courseId,
    });
    const raw = coerceModelText(content);
    let parsed;
    try {
      parsed = parseJsonObject(raw, 'regenerateReading');
    } catch (err) {
      throw err;
    }

    let body = typeof parsed?.final_content?.markdown === 'string'
      ? parsed.final_content.markdown
      : typeof parsed?.final_content === 'string'
        ? parsed.final_content
        : '';

    if (!body) {
      throw new Error('Reading regenerator returned empty final_content');
    }

    return cleanupMarkdown(body);
  };

  let resultText = await renderResponse([systemPrompt, userPrompt]);

  // --- ENRICHMENT STEP (Same as generateReading) ---
  try {
    const chunks = splitContentIntoChunks(resultText);
    const enrichedChunks = [];
    const MAX_ENRICHED = 5;

    for (let i = 0; i < chunks.length; i++) {
      let chunk = chunks[i];
      if (i < MAX_ENRICHED && chunk.length > 500) {
        const questionMd = await generateInlineQuestion(chunk, { title, courseName, moduleName }, userId);
        if (questionMd) {
          chunk += questionMd;
        }
      }
      enrichedChunks.push(chunk);
    }
    resultText = enrichedChunks.join('\n\n---\n\n');
  } catch (enrichError) {
    // Fallback to text without enrichment
  }

  // --- VALIDATION STEP ---
  const validationContext = `Course: ${courseName}\nModule: ${moduleName}\nLesson: ${title}\nChange Instruction: ${changeInstruction}`;
  const validatedText = await validateContent('reading', resultText, validationContext, userId, courseId);

  return {
    data: validatedText,
    stats: { total: 1, immediate: 1, repaired_llm: 0, failed: 0, retries: 0 }
  };
}

export async function regenerateQuiz(title, currentQuiz, changeInstruction, courseName, moduleName, prereqs = [], userId, courseId) {
  const contextNote = prereqs.length
    ? `Context: The student has completed lessons on [${prereqs.join(', ')}].`
    : `Context: This is an introductory lesson.`;

  const messages = [
    {
      role: 'system',
      content: `You are editing a graduate-level quiz for the lesson "${title}" in module "${moduleName}" of course "${courseName}".
${contextNote}

Current Quiz JSON:
${JSON.stringify(currentQuiz, null, 2)}

Change Instruction:
${changeInstruction}

Always respond with JSON:
{
  "internal_audit": "reasoning about changes",
  "quiz": [
    {
      "validation_check": "Chain-of-thought",
      "question": "Student-facing stem",
      "options": ["..."],
      "correct_index": 0,
      "explanation": ["Expl A", "Expl B", "Expl C", "Expl D"]
    }
  ]
}

Rules:
- Replace or modify questions as requested.
- Keep the total number of questions similar unless instructed otherwise.
- Ensure one "Challenge Question" remains.
- "explanation" must be an array of 4 strings (one per option).
- For the correct option, explain WHY it is correct.
- For incorrect options, explain WHY they are incorrect.
- Do NOT give away the answer by making the correct option significantly longer or always in the same position.
- Use inline LaTeX (\\(...\\)) or display math (\\[...\\]) only when required. Do NOT use $ or $$.
`,
    },
    {
      role: 'user',
      content: `Generate the new JSON 'quiz' array based on the changes.`,
    },
  ];

  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.2,
    maxTokens: 2048,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 120000,
    reasoning: 'high',
    userId,
    source: 'quiz_regeneration',
    courseId,
  });

  const text = coerceModelText(content);

  try {
    let questions = parseJsonArray(text, 'quiz');
    if (!questions.length) questions = parseJsonArray(text, 'questions');

    const validator = (item, index) => {
      try {
        let cleanItem = item;
        if (item && typeof item === 'object') {
          const { validation_check, step_by_step_thinking, ...rest } = item;
          cleanItem = rest;
        }
        
        // Pre-check explanations before normalization for clearer error messages
        if (!Array.isArray(cleanItem?.explanation) || cleanItem.explanation.length !== 4) {
          return { valid: false, error: `Incomplete explanations: expected array of 4, got ${Array.isArray(cleanItem?.explanation) ? cleanItem.explanation.length : 'non-array'}` };
        }
        if (cleanItem.explanation.some(ex => !ex || typeof ex !== 'string' || ex.trim().length < MIN_EXPLANATION_LENGTH)) {
          const shortIdx = cleanItem.explanation.findIndex(ex => !ex || typeof ex !== 'string' || ex.trim().length < MIN_EXPLANATION_LENGTH);
          return { valid: false, error: `Explanation for option ${shortIdx + 1} is missing or too short (need ${MIN_EXPLANATION_LENGTH}+ chars)` };
        }
        
        return { valid: true, data: normalizeQuizItem(cleanItem, index, true) };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    };

    const repairPrompt = (brokenItems, errors) => {
      return `Regenerate these invalid quiz items:\n${JSON.stringify(brokenItems)}\nErrors:\n${JSON.stringify(errors)}\n\nCRITICAL: Each 'explanation' must be an array of 4 substantive strings (${MIN_EXPLANATION_LENGTH}+ chars each). Explain WHY each option is correct or incorrect.`;
    };

    const { items: repairedQuestions, stats } = await repairContentArray(questions, validator, repairPrompt, 'regenerateQuiz', userId, courseId);

    if (!repairedQuestions.length) throw new Error('Quiz regenerator returned no valid questions');

    // --- VALIDATION STEP (Per-Question) ---
    const validationContext = `Course: ${courseName}\nModule: ${moduleName}\nLesson: ${title}\nChange Instruction: ${changeInstruction}`;
    const { validatedQuestions, stats: validationStats } = await validateQuizQuestionsIndividually(
      repairedQuestions,
      validationContext,
      userId,
      courseId
    );

    stats.validation = validationStats;

    if (validationStats.failedValidation > 0) {
      console.warn(`[regenerateQuiz] ${validationStats.failedValidation} questions could not be fully validated for "${title}"`);
    }

    return { data: validatedQuestions, stats };
  } catch (err) {
    throw err;
  }
}

export async function regenerateFlashcards(title, currentCards, changeInstruction, courseName, moduleName, userId, courseId) {
  const messages = [
    {
      role: 'system',
      content: `You are editing flashcards for the lesson "${title}" in module "${moduleName}".
Current Cards:
${JSON.stringify(currentCards, null, 2)}

Change Instruction:
${changeInstruction}

Always respond with JSON:
{
  "internal_audit": "reasoning",
  "flashcards": [
    { "step_by_step_thinking": "...", "front": "...", "back": "..." }
  ]
}
Use inline LaTeX (\\(...\\)) or display math (\\[...\\]) only when required. Do NOT use $ or $$.
`,
    },
    {
      role: 'user',
      content: `Generate the new JSON 'flashcards' array.`,
    },
  ];

  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.25,
    maxTokens: 2048,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 120000,
    reasoning: 'high',
    userId,
    source: 'flashcards_regeneration',
    courseId,
  });

  const text = coerceModelText(content);

  try {
    const flashcards = parseJsonArray(text, 'flashcards');
    const validator = (item, index) => {
      try {
        let cleanItem = item;
        if (item && typeof item === 'object') {
          const { step_by_step_thinking, internal_audit, ...rest } = item;
          cleanItem = rest;
        }
        return { valid: true, data: normalizeFlashcard(cleanItem, index) };
      } catch (e) {
        return { valid: false, error: e.message };
      }
    };

    const repairPrompt = (brokenItems, errors) => `Regenerate invalid flashcards:\n${JSON.stringify(brokenItems)}`;
    const { items: repairedCards, stats } = await repairContentArray(flashcards, validator, repairPrompt, 'regenerateFlashcards', userId, courseId);

    if (!repairedCards.length) throw new Error('Flashcard regenerator returned no valid cards');

    // --- VALIDATION STEP ---
    const validationContext = `Course: ${courseName}\nModule: ${moduleName}\nLesson: ${title}\nChange Instruction: ${changeInstruction}`;
    const validatedCards = await validateContent('flashcards', repairedCards, validationContext, userId, courseId);

    return { data: validatedCards, stats };
  } catch (err) {
    throw err;
  }
}

export async function generateVideoSelection(queries, userId, courseId) {
  const logs = [];
  const videos = [];

  if (!Array.isArray(queries) || queries.length === 0) {
    const msg = 'No queries provided for video search.';
    logs.push(msg);
    return { videos, logs };
  }

  // Use the first query as requested
  const query = queries[0];
  logs.push(`Selected query for processing: "${query}"`);

  if (customYouTubeFetcher) {
    try {
      logs.push('Using custom YouTube fetcher.');
      const res = await customYouTubeFetcher([query]);
      const fetchedVideos = Array.isArray(res) ? res : (res ? [res] : []);
      return { videos: fetchedVideos, logs };
    } catch (error) {
      const msg = `Custom YouTube fetcher failed: ${error?.message || error}`;
      logs.push(msg);
      return { videos: [], logs };
    }
  }

  let searchResults = [];
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 1. EXECUTE SEARCH MANUALLY
      logs.push(`Searching YouTube for: "${query}"`);

      const res = await yts(query);
      searchResults = res.videos.slice(0, 5).map((v, i) => ({
        index: i,
        title: v.title,
        timestamp: v.timestamp,
        author: v.author?.name,
        videoId: v.videoId,
        thumbnail: v.thumbnail,
        url: v.url
      }));

      if (searchResults.length === 0) {
        logs.push('No videos found for this query.');
        if (attempt < maxRetries) {
          break;
        }
        continue;
      }

      // 2. ASK LLM TO SELECT
      const videoListString = searchResults.map(v =>
        `[${v.index}] Title: "${v.title}" | Channel: ${v.author} | Duration: ${v.timestamp}`
      ).join('\n');

      const messages = [
        {
          role: 'system',
          content: `You are a helpful video curator. 
Your goal is to select the BEST video for the user's learning objective from the provided list.

Rules:
1. Analyze the provided video list.
2. Select the single best video based on relevance to the query: "${query}".
3. Return JSON: { "selected_index": <number> }
4. If NO videos are relevant, return { "selected_index": -1 }`
        },
        {
          role: 'user',
          content: `Search Query: "${query}"

Video Results:
${videoListString}

Select the best video index.`
        }
      ];

      const response = await grokExecutor({
        model: 'x-ai/grok-4-fast',
        temperature: 0.1,
        maxTokens: 256,
        messages,
        responseFormat: { type: 'json_object' },
        requestTimeoutMs: 30000,
        reasoning: 'high',
        userId,
        source: 'video_selection',
        courseId,
      });

      const raw = coerceModelText(response.content);
      logs.push(`LLM Response: ${raw}`);

      const result = parseJsonObject(raw, 'video_selection');
      const selectedIndex = result?.selected_index;

      if (typeof selectedIndex === 'number' && selectedIndex >= 0 && searchResults[selectedIndex]) {
        const selected = searchResults[selectedIndex];
        videos.push({
          videoId: selected.videoId,
          title: selected.title,
          thumbnail: selected.thumbnail,
          url: selected.url,
        });

        logs.push(`Selected video index ${selectedIndex}: "${selected.title}"`);

        return { videos, logs }; // Success!
      } else if (selectedIndex === -1) {
        logs.push('LLM indicated no valid videos in this batch.');
        break;
      } else {
        logs.push(`Invalid selection index: ${selectedIndex}`);
      }

    } catch (err) {
      logs.push(`Error: ${err.message}`);
    }
  }

  if (videos.length === 0) {
    logs.push('Failed to select a video after retries.');
  }

  return { videos, logs };
}

/**
 * Merges validated array items with the original array to prevent shrinking.
 * If the validator only returned fixed items, we need to keep the rest of the original.
 * @param {Array} original - The original content array
 * @param {Array} validated - The validated/fixed array (may be partial)
 * @param {string} contentType - Type of content for logging
 * @returns {Array} - The merged array preserving all original items
 */
function mergeValidatedArray(original, validated, contentType) {
  if (!Array.isArray(original) || !Array.isArray(validated)) {
    console.warn(`[mergeValidatedArray] Invalid input types for ${contentType}`);
    return original;
  }

  // If validated has same or more items, it's likely a full replacement
  if (validated.length >= original.length) {
    return validated;
  }

  // If validated is empty, return original
  if (validated.length === 0) {
    console.warn(`[mergeValidatedArray] Validator returned empty array for ${contentType}, keeping original`);
    return original;
  }

  // If validated is significantly smaller, the model likely only returned fixed items
  // Try to match and merge them with the original
  console.warn(`[mergeValidatedArray] Validator returned ${validated.length} items but original had ${original.length} for ${contentType}`);

  // Determine the key to use for matching based on content type
  const matchKey = contentType === 'flashcards' ? 'front' : 'question';

  // Create a map of validated items by their question/front text for quick lookup
  const validatedMap = new Map();
  for (const item of validated) {
    const key = item[matchKey];
    if (key) {
      // Normalize the key for matching (trim whitespace, lowercase for comparison)
      validatedMap.set(key.trim().toLowerCase(), item);
    }
  }

  // Merge: replace original items with validated versions where they match
  const merged = original.map((origItem, index) => {
    const origKey = origItem[matchKey];
    if (origKey) {
      const normalizedKey = origKey.trim().toLowerCase();
      const validatedItem = validatedMap.get(normalizedKey);
      if (validatedItem) {
        // Found a match - use the validated version
        return validatedItem;
      }
    }
    // No match found - keep the original item
    return origItem;
  });

  console.log(`[mergeValidatedArray] Merged ${validatedMap.size} validated items into ${original.length} original items for ${contentType}`);
  return merged;
}

/**
 * Validates generated content using a worker model.
 * @param {string} contentType - 'reading', 'quiz', 'flashcards', 'inline_question'
 * @param {any} content - The content to validate
 * @param {string} context - Additional context (e.g., lesson title, plan)
 * @param {object} options - Additional options
 * @param {boolean} options.throwOnFailure - If true, throw instead of returning original on failure
 * @returns {Promise<any>} - The validated (and possibly fixed) content
 */
async function validateContent(contentType, content, context, userId, courseId, options = {}) {
  const { throwOnFailure = false } = options;
  const modelConfig = pickModel(STAGES.VALIDATOR);

  let contentStr = '';
  if (typeof content === 'string') {
    contentStr = content;
  } else {
    contentStr = JSON.stringify(content, null, 2);
  }

  const isJsonContent = typeof content !== 'string';

  const systemPrompt = {
    role: 'system',
    content: `You are a strict Quality Assurance Validator for educational content.
Your job is to review the provided ${contentType} for factual correctness, answer accuracy, and clarity.

If the content is completely correct and high-quality:
${isJsonContent
        ? 'Respond with JSON: { "status": "CORRECT" }'
        : 'Respond with ONLY the single word: "CORRECT"'}

If there are ANY factual errors, incorrect answers, hallucinations, or major quality issues:
${isJsonContent
        ? 'Respond with ONLY the FIXED JSON. Do not include ANY explanatory text, markdown fences, or commentary. Just output the pure JSON object or array.'
        : 'Respond with ONLY the FIXED markdown content. Do not include explanatory text or markdown fences around the output.'}

Check for and remove any references to figures, graphs, or images that are not present (e.g., 'the graph below'). Rewrite such references as textual descriptions or remove them if they are not essential.

Also, ensure that quiz questions DO NOT test concepts that are not present in the provided context (lesson content + prerequisites). If a question asks about a topic that hasn't been taught yet, remove or replace it.

CRITICAL QUALITY REQUIREMENTS:
- Every quiz question MUST have a complete "explanation" array with 4 meaningful strings (one per option).
- If any option lacks an explanation, has a placeholder like "...", or has only trivial text, that is a MAJOR quality issue - fix it by providing a correct, substantive rationale.
- Each explanation must clearly state WHY the option is correct or incorrect.
- Missing or incomplete rationales are NEVER acceptable.

STRICT FORMATTING RULES:
${contentType === 'inline_question' ? `
- You MUST preserve the exact Markdown format:
  1. Header: **Check Your Understanding**
  2. Options: - A. Text, - B. Text, ... (must have 4 options)
  3. Answer: Inside <details><summary>Show Answer</summary> block.
  4. Answer Line: **Answer:** X (inside details)
- Do NOT remove the <details> block or the header.
` : ''}
${contentType === 'reading' ? `
- Preserve the Markdown structure (headings, paragraphs).
- Use LaTeX only for math.
` : ''}
${contentType === 'quiz' ? `
- Return a JSON ARRAY of objects.
- Each object must have: "question", "options" (array of 4 strings), "correct_index" (0-3), "explanation" (array of 4 NON-EMPTY strings explaining each option).
- Do not wrap the array in a "quiz" key.
` : ''}
${contentType === 'flashcards' ? `
- Return a JSON ARRAY of objects.
- Each object must have: "front", "back".
- Do not wrap the array in a "flashcards" key.
` : ''}

Context:
${context}`
  };

  const userPrompt = {
    role: 'user',
    content: `Review this ${contentType}:\n\n${contentStr}`
  };

  try {
    const grokOptions = {
      model: modelConfig.model,
      temperature: modelConfig.temperature,
      top_p: modelConfig.top_p,
      maxTokens: 8192, // Allow enough space for full rewrite
      messages: [systemPrompt, userPrompt],
      requestTimeoutMs: 120000,
      reasoning: 'high',
      userId,
      source: `validation_${contentType}`,
      courseId,
    };

    // For JSON content, hint that we want JSON response format
    if (isJsonContent) {
      grokOptions.responseFormat = { type: 'json_object' };
    }

    const { content: responseText } = await grokExecutor(grokOptions);

    const cleaned = responseText.trim();

    if (cleaned.toUpperCase().includes('CORRECT') && cleaned.length < 20) {
      return content;
    }

    // If we got a rewrite, try to parse it if the original was an object
    if (isJsonContent) {
      // Try to parse JSON - use the robust extraction from our utilities
      let jsonToParse = coerceModelText(cleaned);

      // Use extractJsonBlock from jsonUtils if the direct parse fails
      try {
        // First try direct parse
        const json = JSON.parse(jsonToParse);

        // Check if the validator returned a "CORRECT" status object
        if (json && (json.status === 'CORRECT' || json.review === 'CORRECT')) {
          return content;
        }

        if (json) {
          // If the original was an array (like quiz/flashcards), we might need to extract it if the model wrapped it
          if (Array.isArray(content) && !Array.isArray(json)) {
            // Check common keys
            if (Array.isArray(json.quiz)) return mergeValidatedArray(content, json.quiz, contentType);
            if (Array.isArray(json.questions)) return mergeValidatedArray(content, json.questions, contentType);
            if (Array.isArray(json.flashcards)) return mergeValidatedArray(content, json.flashcards, contentType);
            // If we can't find the array, return original to be safe
            return content;
          }
          // If original was an array, ensure we don't shrink it
          if (Array.isArray(content) && Array.isArray(json)) {
            return mergeValidatedArray(content, json, contentType);
          }
          return json;
        }
      } catch (directParseError) {
        // Direct parse failed, try the full repair pipeline
        try {
          const json = parseJsonObject(jsonToParse, `validateContent-${contentType}`);
          if (json) {
            // If the original was an array (like quiz/flashcards), we might need to extract it if the model wrapped it
            if (Array.isArray(content) && !Array.isArray(json)) {
              // Check common keys
              if (Array.isArray(json.quiz)) return mergeValidatedArray(content, json.quiz, contentType);
              if (Array.isArray(json.questions)) return mergeValidatedArray(content, json.questions, contentType);
              if (Array.isArray(json.flashcards)) return mergeValidatedArray(content, json.flashcards, contentType);
              // If we can't find the array, return original to be safe
              return content;
            }
            // If original was an array, ensure we don't shrink it
            if (Array.isArray(content) && Array.isArray(json)) {
              return mergeValidatedArray(content, json, contentType);
            }
            return json;
          }
        } catch (parseError) {
          // Log the actual response to help debug
          console.error(`[validateContent] Failed to parse JSON for ${contentType}. Raw response length: ${cleaned.length}`);
          console.error(`[validateContent] First 500 chars of response:`, cleaned.substring(0, 500));
          console.error(`[validateContent] Parse error:`, parseError.message);
          if (throwOnFailure) {
            throw new Error(`Validation parse failure for ${contentType}: ${parseError.message}`);
          }
          console.warn(`[validateContent] Returning original content due to parse failure.`);
          return content;
        }
      }
    } else {
      // For markdown/string content
      return cleanupMarkdown(cleaned);
    }

  } catch (error) {
    console.error(`[validateContent] Error validating ${contentType}:`, error);
    if (throwOnFailure) {
      throw error;
    }
    return content; // Fallback to original
  }
}

/**
 * Validates quiz questions individually for more reliable error isolation.
 * Each question is validated separately, and failures are retried or flagged.
 * @param {Array} questions - Array of quiz question objects
 * @param {string} context - Validation context
 * @param {string} userId - User ID for tracking
 * @param {string} courseId - Course ID for tracking
 * @returns {Promise<{validatedQuestions: Array, stats: object}>}
 */
async function validateQuizQuestionsIndividually(questions, context, userId, courseId, options = {}) {
  const { enableSelfConsistency = true } = options;
  
  const stats = {
    total: questions.length,
    passed: 0,
    fixed: 0,
    rationaleFixed: 0,
    failedValidation: 0,
    retried: 0,
    selfConsistencyChecked: 0,
    selfConsistencyPassed: 0,
    selfConsistencyReconciled: 0,
    selfConsistencyFailed: 0
  };

  const validatedQuestions = [];

  for (let i = 0; i < questions.length; i++) {
    const question = questions[i];
    const questionContext = `${context}\nQuestion ${i + 1} of ${questions.length}`;

    // Check explanation completeness using our validation function
    const expValidation = validateExplanations(question.explanation, 4);
    const hasIncompleteExplanation = !expValidation.valid;

    let validated = null;
    let attempts = 0;
    const maxAttempts = hasIncompleteExplanation ? 3 : 2; // More retries if we detect incomplete content

    while (attempts < maxAttempts && validated === null) {
      attempts++;
      
      // On later attempts for incomplete explanations, try targeted rationale fix
      if (attempts > 1 && hasIncompleteExplanation) {
        try {
          const fixedQuestion = await fixMissingRationales(question, userId, courseId);
          if (fixedQuestion) {
            const fixedExpValidation = validateExplanations(fixedQuestion.explanation, 4);
            if (fixedExpValidation.valid) {
              validated = fixedQuestion;
              stats.rationaleFixed++;
              continue;
            }
          }
        } catch (fixError) {
          console.warn(`[validateQuizQuestionsIndividually] Rationale fix failed for Q${i + 1}:`, fixError.message);
        }
      }
      
      try {
        // Wrap single question in array for validateContent, then unwrap
        const result = await validateContent('quiz', [question], questionContext, userId, courseId, { throwOnFailure: true });

        if (Array.isArray(result) && result.length > 0) {
          const validatedQ = result[0];

          // Verify the validated question has complete explanations using strict validation
          const resultExpValidation = validateExplanations(validatedQ.explanation, 4);
          if (resultExpValidation.valid) {
            // Also check rationale consistency
            const consistency = checkRationaleConsistency(validatedQ);
            if (!consistency.valid) {
              console.warn(`[validateQuizQuestionsIndividually] Q${i + 1} has rationale consistency issues:`, consistency.warnings);
            }
            
            validated = validatedQ;
            if (JSON.stringify(validatedQ) !== JSON.stringify(question)) {
              stats.fixed++;
            } else {
              stats.passed++;
            }
          } else if (attempts < maxAttempts) {
            // Still incomplete, will retry
            stats.retried++;
            console.warn(`[validateQuizQuestionsIndividually] Q${i + 1} still has incomplete explanations: ${resultExpValidation.error}`);
          }
        }
      } catch (error) {
        console.error(`[validateQuizQuestionsIndividually] Failed to validate Q${i + 1} (attempt ${attempts}):`, error.message);
        if (attempts < maxAttempts) {
          stats.retried++;
        }
      }
    }

    // Self-consistency check: verify the model can independently solve to the same answer
    if (validated && enableSelfConsistency) {
      stats.selfConsistencyChecked++;
      try {
        const consistencyResult = await verifySelfConsistency(validated, context, userId, courseId);
        
        if (consistencyResult.consistent) {
          stats.selfConsistencyPassed++;
          validated._selfConsistencyVerified = true;
        } else {
          // Discrepancy detected - attempt reconciliation
          console.warn(`[validateQuizQuestionsIndividually] Q${i + 1} self-consistency FAILED. Attempting reconciliation...`);
          
          const reconciledQuestion = await reconcileAnswerDiscrepancy(validated, consistencyResult, context, userId, courseId);
          
          if (reconciledQuestion) {
            stats.selfConsistencyReconciled++;
            validated = reconciledQuestion;
            validated._selfConsistencyReconciled = true;
          } else {
            // Reconciliation failed - flag the question but keep it
            stats.selfConsistencyFailed++;
            validated._selfConsistencyFailed = true;
            validated._consistencyWarning = `Model independently answered ${['A', 'B', 'C', 'D'][consistencyResult.modelAnswer]} with ${consistencyResult.confidence} confidence. Review recommended.`;
            console.error(`[validateQuizQuestionsIndividually] Q${i + 1} could not be reconciled. Flagged for review.`);
          }
        }
      } catch (scError) {
        console.error(`[validateQuizQuestionsIndividually] Self-consistency check error for Q${i + 1}:`, scError.message);
        // Don't fail the question just because consistency check errored
        validated._selfConsistencyError = scError.message;
      }
    }

    if (validated) {
      validatedQuestions.push(validated);
    } else {
      // Validation failed after retries - flag but include with warning
      console.error(`[validateQuizQuestionsIndividually] Q${i + 1} could not be validated after ${maxAttempts} attempts. Marking for review.`);
      stats.failedValidation++;
      // Add the original but flag it
      validatedQuestions.push({
        ...question,
        _validationFailed: true,
        _validationNote: 'This question could not be fully validated. Review recommended.'
      });
    }
  }

  console.log(`[validateQuizQuestionsIndividually] Stats: ${JSON.stringify(stats)}`);
  return { validatedQuestions, stats: stats };
}

/**
 * Targeted fix for questions with missing or incomplete rationales.
 * Makes a focused LLM call to generate only the missing explanations.
 * @param {object} question - Quiz question with incomplete explanations
 * @param {string} userId - User ID for tracking
 * @param {string} courseId - Course ID for tracking
 * @returns {Promise<object|null>} - Fixed question or null if fix failed
 */
async function fixMissingRationales(question, userId, courseId) {
  const letters = ['A', 'B', 'C', 'D'];
  const correctLetter = letters[question.correct_index] || 'A';
  
  // Identify which explanations are missing or inadequate
  const missingIndices = [];
  const currentExplanations = question.explanation || [];
  
  for (let i = 0; i < 4; i++) {
    const exp = currentExplanations[i];
    if (!exp || typeof exp !== 'string' || exp.trim().length < MIN_EXPLANATION_LENGTH) {
      missingIndices.push(i);
    }
  }
  
  if (missingIndices.length === 0) {
    return question; // Nothing to fix
  }
  
  const optionsText = question.options.map((opt, i) => `${letters[i]}. ${opt}`).join('\n');
  const missingLetters = missingIndices.map(i => letters[i]).join(', ');
  
  const messages = [
    {
      role: 'system',
      content: `You are an expert educator fixing incomplete quiz explanations. 
Provide ONLY the missing explanations for the specified options.
Each explanation must be substantive (at least ${MIN_EXPLANATION_LENGTH} characters) and explain WHY the option is correct or incorrect.

Return JSON in this exact format:
{
  "explanations": {
    "A": "explanation for A if needed",
    "B": "explanation for B if needed",
    ...
  }
}

Only include the options that need explanations.`
    },
    {
      role: 'user',
      content: `Question: ${question.question}

Options:
${optionsText}

Correct Answer: ${correctLetter}

Missing explanations for options: ${missingLetters}

Provide substantive explanations for each missing option. For the correct answer, explain WHY it is correct. For incorrect answers, explain WHY they are wrong and what misconception they might represent.`
    }
  ];

  try {
    const { content } = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0.3,
      maxTokens: 1024,
      messages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 30000,
      reasoning: 'medium',
      userId,
      source: 'rationale_fix',
      courseId,
    });

    const raw = coerceModelText(content);
    const parsed = parseJsonObject(raw, 'rationale_fix');
    
    if (!parsed || !parsed.explanations) {
      console.warn('[fixMissingRationales] Invalid response format');
      return null;
    }

    // Merge the fixed explanations with existing ones
    const fixedExplanations = [...currentExplanations];
    while (fixedExplanations.length < 4) {
      fixedExplanations.push('');
    }
    
    for (const [letter, explanation] of Object.entries(parsed.explanations)) {
      const idx = letters.indexOf(letter.toUpperCase());
      if (idx >= 0 && explanation && explanation.trim().length >= MIN_EXPLANATION_LENGTH) {
        fixedExplanations[idx] = explanation.trim();
      }
    }

    // Verify all explanations are now complete
    const validation = validateExplanations(fixedExplanations, 4);
    if (!validation.valid) {
      console.warn(`[fixMissingRationales] Fix incomplete: ${validation.error}`);
      return null;
    }

    return {
      ...question,
      explanation: fixedExplanations
    };
  } catch (error) {
    console.error('[fixMissingRationales] Error:', error.message);
    return null;
  }
}

/**
 * Self-consistency check: Re-ask the model to solve the question independently
 * and verify it arrives at the same answer as marked correct.
 * @param {object} question - Quiz question to verify
 * @param {string} context - Lesson context for grounding
 * @param {string} userId - User ID for tracking
 * @param {string} courseId - Course ID for tracking
 * @returns {Promise<{consistent: boolean, modelAnswer: number, confidence: string, reasoning: string, fixedQuestion?: object}>}
 */
async function verifySelfConsistency(question, context, userId, courseId) {
  const letters = ['A', 'B', 'C', 'D'];
  const optionsText = question.options.map((opt, i) => `${letters[i]}. ${opt}`).join('\n');
  
  const messages = [
    {
      role: 'system',
      content: `You are an expert educator solving a multiple-choice question. 
Analyze the question carefully and determine which option is correct.

IMPORTANT: Do NOT look at any provided answer - solve this independently based on your knowledge.

Return JSON in this exact format:
{
  "reasoning": "Step-by-step analysis of the question and each option",
  "correct_option": "A" | "B" | "C" | "D",
  "confidence": "high" | "medium" | "low",
  "explanation": "Why this option is definitively correct"
}`
    },
    {
      role: 'user',
      content: `Context (lesson material):
${context.slice(0, 1500)}

Question: ${question.question}

Options:
${optionsText}

Analyze this question and determine the correct answer. Show your reasoning.`
    }
  ];

  try {
    const { content } = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0, // Use temperature 0 for deterministic verification
      maxTokens: 1024,
      messages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 30000,
      reasoning: 'high', // High reasoning for careful analysis
      userId,
      source: 'self_consistency_check',
      courseId,
    });

    const raw = coerceModelText(content);
    const parsed = parseJsonObject(raw, 'self_consistency_check');
    
    if (!parsed || !parsed.correct_option) {
      console.warn('[verifySelfConsistency] Invalid response format');
      return { consistent: true, modelAnswer: -1, confidence: 'unknown', reasoning: 'Failed to parse response' };
    }

    const modelAnswerLetter = parsed.correct_option.toUpperCase();
    const modelAnswerIndex = letters.indexOf(modelAnswerLetter);
    const originalAnswerIndex = question.correct_index;
    const consistent = modelAnswerIndex === originalAnswerIndex;

    if (!consistent) {
      console.warn(`[verifySelfConsistency] DISCREPANCY DETECTED: Original answer=${letters[originalAnswerIndex]}, Model says=${modelAnswerLetter}`);
      console.warn(`[verifySelfConsistency] Model reasoning: ${parsed.reasoning?.slice(0, 200)}...`);
      console.warn(`[verifySelfConsistency] Model confidence: ${parsed.confidence}`);
    }

    return {
      consistent,
      modelAnswer: modelAnswerIndex,
      originalAnswer: originalAnswerIndex,
      confidence: parsed.confidence || 'unknown',
      reasoning: parsed.reasoning || '',
      modelExplanation: parsed.explanation || ''
    };
  } catch (error) {
    console.error('[verifySelfConsistency] Error:', error.message);
    // On error, assume consistent to avoid blocking
    return { consistent: true, modelAnswer: -1, confidence: 'error', reasoning: error.message };
  }
}

/**
 * Attempts to reconcile a discrepancy between original answer and model's answer.
 * Uses another LLM call to determine which answer is actually correct.
 * @param {object} question - Original quiz question
 * @param {object} consistencyResult - Result from verifySelfConsistency
 * @param {string} context - Lesson context
 * @param {string} userId - User ID for tracking
 * @param {string} courseId - Course ID for tracking
 * @returns {Promise<object|null>} - Fixed question or null if reconciliation failed
 */
async function reconcileAnswerDiscrepancy(question, consistencyResult, context, userId, courseId) {
  const letters = ['A', 'B', 'C', 'D'];
  const originalLetter = letters[question.correct_index];
  const modelLetter = letters[consistencyResult.modelAnswer];
  const optionsText = question.options.map((opt, i) => `${letters[i]}. ${opt}`).join('\n');
  
  const messages = [
    {
      role: 'system',
      content: `You are an expert fact-checker resolving a disputed multiple-choice answer.

Two analyses have reached different conclusions about the correct answer.

Your task: Determine which answer is ACTUALLY correct based on facts and logic.

Return JSON:
{
  "analysis": "Detailed analysis of both proposed answers",
  "correct_option": "A" | "B" | "C" | "D",
  "certainty": "definite" | "probable" | "uncertain",
  "explanation": ["Explanation for A", "Explanation for B", "Explanation for C", "Explanation for D"]
}`
    },
    {
      role: 'user',
      content: `Context (lesson material):
${context.slice(0, 1200)}

Question: ${question.question}

Options:
${optionsText}

DISPUTE:
- Original marked answer: ${originalLetter}
- Alternative analysis suggests: ${modelLetter}
- Alternative reasoning: ${consistencyResult.reasoning.slice(0, 500)}

Carefully analyze this dispute and determine the definitively correct answer. Provide explanations for ALL options.`
    }
  ];

  try {
    const { content } = await grokExecutor({
      model: 'x-ai/grok-4-fast',
      temperature: 0,
      maxTokens: 1500,
      messages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 45000,
      reasoning: 'high',
      userId,
      source: 'answer_reconciliation',
      courseId,
    });

    const raw = coerceModelText(content);
    const parsed = parseJsonObject(raw, 'answer_reconciliation');
    
    if (!parsed || !parsed.correct_option) {
      console.warn('[reconcileAnswerDiscrepancy] Invalid response format');
      return null;
    }

    const reconciledLetter = parsed.correct_option.toUpperCase();
    const reconciledIndex = letters.indexOf(reconciledLetter);
    
    if (reconciledIndex < 0) {
      console.warn('[reconcileAnswerDiscrepancy] Invalid reconciled answer letter');
      return null;
    }

    // Build the fixed question
    let explanation = parsed.explanation;
    if (!Array.isArray(explanation) || explanation.length !== 4) {
      // Try to preserve original explanations if new ones are invalid
      explanation = question.explanation || [];
      while (explanation.length < 4) {
        explanation.push('Explanation pending reconciliation.');
      }
    }

    const fixedQuestion = {
      ...question,
      correct_index: reconciledIndex,
      explanation: explanation.map(e => typeof e === 'string' ? e.trim() : String(e)),
      _reconciled: true,
      _originalAnswer: question.correct_index,
      _reconciliationCertainty: parsed.certainty || 'unknown'
    };

    // Log the change
    if (reconciledIndex !== question.correct_index) {
      console.log(`[reconcileAnswerDiscrepancy] Answer CHANGED from ${originalLetter} to ${reconciledLetter} (certainty: ${parsed.certainty})`);
    } else {
      console.log(`[reconcileAnswerDiscrepancy] Original answer ${originalLetter} CONFIRMED (certainty: ${parsed.certainty})`);
    }

    return fixedQuestion;
  } catch (error) {
    console.error('[reconcileAnswerDiscrepancy] Error:', error.message);
    return null;
  }
}
