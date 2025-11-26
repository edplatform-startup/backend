import { getSupabase } from '../supabaseClient.js';
import { executeOpenRouterChat } from './grokClient.js';
import { tryParseJson } from '../utils/jsonUtils.js';

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
    .select('id, title, content_payload, metadata, module_ref')
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
  const { data: courseData } = await supabase.schema('api').from('courses').select('title').eq('id', courseId).single();
  const courseTitle = courseData?.title || 'Unknown Course';

  const results = await runWithConcurrency(pendingNodes, limit, async (node) => {
    try {
      await processNode(node, supabase, courseTitle);
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
  await updateCourseStatus(supabase, courseId, courseStatus);

  return { ...summary, status: courseStatus, failures: failures.map((f) => f.reason?.message || 'Unknown error') };
}

async function processNode(node, supabase, courseTitle) {
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

  // Wrap each generator in a try-catch to prevent one failure from blocking the whole node
  const safeGenerate = async (promise, label) => {
    try {
      return await promise;
    } catch (error) {
      console.error(`[generateCourseContent] ${label} generation failed for node ${node.id}:`, error);
      return null; // Return null to indicate failure but allow other content to proceed
    }
  };

  const readingPromise = plans.reading 
    ? safeGenerate(generateReading(lessonName, plans.reading, courseTitle, moduleName), 'Reading')
    : Promise.resolve(null);
    
  const quizPromise = plans.quiz 
    ? safeGenerate(generateQuiz(lessonName, plans.quiz, courseTitle, moduleName), 'Quiz')
    : Promise.resolve(null);
    
  const flashcardsPromise = plans.flashcards 
    ? safeGenerate(generateFlashcards(lessonName, plans.flashcards, courseTitle, moduleName), 'Flashcards')
    : Promise.resolve(null);
    
  const practiceExamPlan = plans.practice_exam ?? plans.practiceExam;
  const practiceExamPromise = practiceExamPlan
    ? safeGenerate(generatePracticeExam(lessonName, practiceExamPlan, courseTitle, moduleName), 'Practice Exam')
    : Promise.resolve(null);
    
  const videoPromise = plans.video 
    ? safeGenerate(fetchVideoResource(plans.video), 'Video')
    : Promise.resolve({ videos: [], logs: [] });

  const [reading, quiz, flashcards, videoResult, practiceExam] = await Promise.all([
    readingPromise,
    quizPromise,
    flashcardsPromise,
    videoPromise,
    practiceExamPromise,
  ]);

  const videos = videoResult?.videos || [];
  const videoLogs = videoResult?.logs || [];
  const videoUrls = Array.isArray(videos) ? videos.map(v => `https://www.youtube.com/watch?v=${v.videoId}`).join(', ') : '';

  const finalPayload = {
    reading,
    quiz,
    flashcards,
    practice_exam: practiceExam,
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


async function generateReading(title, plan, courseName, moduleName) {
  const systemPrompt = {
    role: 'system',
    content: `You are an elite instructional designer producing concise, well-structured, easy-to-read learning content in Markdown.
You are building a reading lesson for "${title}" in module "${moduleName}" of course "${courseName}".

Always respond with JSON shaped exactly as:
{
  "internal_audit": "scratchpad reasoning about structure and coverage",
  "final_content": {
    "markdown": "FULL markdown content - use LaTeX inline only for math (e.g., $...$) or blocks that strictly need LaTeX"
  }
}

The internal_audit is a throwaway scratchpad — never include it inside the final markdown. Use LaTeX ONLY for math or constructs that cannot be expressed in simple Markdown. The markdown should be clean, readable, and use appropriate headings, lists, code blocks, and inline math where necessary.

CRITICAL REQUIREMENTS:
1. Prefer Markdown for all text, headings, lists and examples.
2. Use inline LaTeX ($...$) or display math ($$...$$) only when required.
3. Keep content clear for students — short paragraphs, helpful examples, and explicit definitions.
4. Do not include editor scratchpad text inside the markdown.
5. When examples require equations or formal notation, include LaTeX within math fences only.
6. Use consistent heading levels matching the plan (e.g., #, ##, ### as appropriate).
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
      maxTokens: 1800,
      messages: promptMessages,
      responseFormat: { type: 'json_object' },
      requestTimeoutMs: 120000,
    });
    const raw = coerceModelText(content);
    const parsed = parseJsonObject(raw, 'reading');
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

    return cleanupMarkdown(body);
  };
  let resultText = await renderResponse([systemPrompt, userPrompt]);

  if (!resultText || !resultText.trim()) {
    // Retry once with a clear instruction
    const retryAsk = {
      role: 'user',
      content: `The previous response was empty or invalid. Re-run and produce final_content.markdown containing clean Markdown (use LaTeX only for math). Do not include internal_audit in final content. Plan: ${plan}`,
    };
    resultText = await renderResponse([systemPrompt, retryAsk]);
  }

  if (!resultText || !resultText.trim()) {
    throw new Error('Reading generator returned empty content after retry');
  }

  return resultText;
}

function cleanupMarkdown(md) {
  if (!md || typeof md !== 'string') return '';
  let out = md.trim();
  // Remove triple-backtick fences producing JSON or markdown blocks accidentally captured
  out = out.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '');
  // Normalize line endings and excessive blank lines
  out = out.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  // Trim trailing spaces on each line
  out = out.split('\n').map((l) => l.replace(/\s+$/,'' )).join('\n');
  return out.trim();
}

async function generateQuiz(title, plan, courseName, moduleName) {
  const messages = [
    {
      role: 'system',
      content: `You are building a graduate-level quiz for the lesson "${title}" in module "${moduleName}" of course "${courseName}".

Always respond with JSON:
{
  "internal_audit": "global scratchpad validating coverage and difficulty",
  "quiz": [
    {
      "validation_check": "Chain-of-thought ensuring only one correct option",
      "question": "Student-facing stem",
      "options": ["..."],
      "correct_index": 0,
      "explanation": "Clean rationale with no meta-commentary"
    }
  ]
}

Rules:
- validation_check is the ONLY place you reason about distractors
- Explanation must be concise feedback for students (no scratchpad)
- Exactly one option may be correct, enforce via validation_check.
`,
    },
    {
      role: 'user',
      content: `Generate JSON with a 'quiz' array of 3 multiple-choice questions for "${title}". Follow the plan:
${plan}

Each question: 4 options, single correct_index, validation_check before finalizing, explanation strictly for students.`,
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
  let questions = parseJsonArray(text, 'quiz');
  if (!questions.length) {
    questions = parseJsonArray(text, 'questions');
  }
  if (!questions.length) {
    throw new Error('Quiz generator returned no questions');
  }
  const cleaned = questions.map((item) => {
    if (item && typeof item === 'object') {
      const { validation_check, step_by_step_thinking, ...rest } = item;
      return rest;
    }
    return item;
  });
  return cleaned.map((item, index) => normalizeQuizItem(item, index));
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

async function generatePracticeExam(title, plan, courseName, moduleName) {
  const messages = [
    {
      role: 'system',
      content: `You are creating a high-stakes practice exam for the lesson "${title}" in module "${moduleName}" of course "${courseName}".

Always respond with JSON:
{
  "internal_audit": "overall reasoning about coverage, pacing, and fairness",
  "practice_exam": [
    {
      "validation_check": "Scratchpad ensuring rubric matches answer and only one resolution path earns full credit",
      "question": "Student-facing prompt (can include multi-part instructions)",
      "answer_key": "Model solution in instructor voice",
      "rubric": "Bulleted scoring rubric tied to sub-parts",
      "estimated_minutes": 20
    }
  ]
}

Rules:
- validation_check is required for every item and must audit completeness before final answers
- answer_key must stay solution-focused, no meta-commentary
- rubric should reference the same subparts mentioned in the question.`,
    },
    {
      role: 'user',
      content: `Produce JSON with a 'practice_exam' array of 2 rigorous free-response problems for "${title}".
Plan / emphasis:
${plan}

Each problem should require 15-25 minutes, may include labeled subparts (a, b, ...), and must capture authentic exam difficulty.`,
    },
  ];

  const { content } = await grokExecutor({
    model: 'x-ai/grok-4-fast',
    temperature: 0.25,
    maxTokens: 1400,
    messages,
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 120000,
  });

  const text = coerceModelText(content);
  const rawItems = parseJsonArray(text, 'practice_exam');
  if (!rawItems.length) {
    throw new Error('Practice exam generator returned no problems');
  }

  const cleaned = rawItems.map((item) => {
    if (item && typeof item === 'object') {
      const { validation_check, step_by_step_thinking, ...rest } = item;
      return rest;
    }
    return item;
  });

  return cleaned.map((item, index) => normalizePracticeExamItem(item, index));
}

function normalizePracticeExamItem(item, index) {
  const question = typeof item?.question === 'string' ? item.question.trim() : '';
  const answerKey = typeof item?.answer_key === 'string' ? item.answer_key.trim() : '';
  const rubric = typeof item?.rubric === 'string' ? item.rubric.trim() : '';
  const estimatedMinutesRaw = Number(item?.estimated_minutes);
  const estimatedMinutes = Number.isFinite(estimatedMinutesRaw) && estimatedMinutesRaw > 0
    ? Math.round(estimatedMinutesRaw)
    : 20;

  if (!question || !answerKey) {
    throw new Error(`Practice exam item ${index + 1} is invalid`);
  }

  return {
    question,
    answer_key: answerKey,
    rubric: rubric || 'Award full credit only when every subpart is justified with correct reasoning.',
    estimated_minutes: estimatedMinutes,
  };
}

async function generateFlashcards(title, plan, courseName, moduleName) {
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

Never include scratchpad text inside front/back.`,
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
  const cleaned = flashcards.map((card) => {
    if (card && typeof card === 'object') {
      const { step_by_step_thinking, internal_audit, ...rest } = card;
      return rest;
    }
    return card;
  });
  return cleaned.map((card, index) => normalizeFlashcard(card, index));
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
  const logs = [];
  const videos = [];

  if (!Array.isArray(queries) || queries.length === 0) {
    logs.push('No queries provided for video search.');
    return { videos, logs };
  }

  if (customYouTubeFetcher) {
    try {
      logs.push('Using custom YouTube fetcher.');
      // Expect custom fetcher to return an array or single object, normalize to array
      const res = await customYouTubeFetcher(queries);
      const fetchedVideos = Array.isArray(res) ? res : (res ? [res] : []);
      logs.push(`Custom fetcher returned ${fetchedVideos.length} videos.`);
      return { videos: fetchedVideos, logs };
    } catch (error) {
      const msg = `Custom YouTube fetcher failed: ${error?.message || error}`;
      console.warn('[generateCourseContent]', msg);
      logs.push(msg);
      return { videos: [], logs };
    }
  }

  const apiKey = process.env.YOUTUBE_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    logs.push('No YouTube/Google API key found in environment variables.');
    return { videos, logs };
  }

  for (const query of queries) {
    try {
      logs.push(`Searching YouTube for query: "${query}"`);
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
        const errorBody = await response.text();
        const msg = `YouTube API error: ${response.status} ${response.statusText} - ${errorBody}`;
        logs.push(msg);
        continue;
      }

      const data = await response.json();
      const first = Array.isArray(data?.items) ? data.items[0] : null;
      if (!first?.id?.videoId) {
        logs.push(`No video found for query: "${query}"`);
        continue;
      }

      videos.push({
        videoId: first.id.videoId,
        title: first.snippet?.title || 'Unknown title',
        thumbnail: first.snippet?.thumbnails?.high?.url || first.snippet?.thumbnails?.default?.url || null,
      });
      logs.push(`Found video for query "${query}": ${first.id.videoId}`);

    } catch (error) {
      const msg = `YouTube search exception for query "${query}": ${error?.message || error}`;
      console.warn('[generateCourseContent]', msg);
      logs.push(msg);
    }
  }
  return { videos, logs };
}
