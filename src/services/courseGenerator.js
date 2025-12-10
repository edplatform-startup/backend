import { v4 as uuidv4 } from 'uuid';
import stringSimilarity from 'string-similarity';
import { callStageLLM as defaultLLMCaller } from './llmCall.js';
import { retrieveContext } from '../rag/index.js';
import { createWebSearchTool, createBrowsePageTool } from './grokClient.js';

// RAG configuration
const RAG_TOP_K = parseInt(process.env.RAG_TOP_K, 10) || 5;
const RAG_MAX_CONTEXT_CHARS = parseInt(process.env.RAG_MAX_CONTEXT_CHARS, 10) || 4000;

let llmCaller = defaultLLMCaller;

export function __setLLMCaller(fn) {
  llmCaller = fn;
}

export function __resetLLMCaller() {
  llmCaller = defaultLLMCaller;
}
import { STAGES } from './modelRouter.js';
import { tryParseJson } from '../utils/jsonUtils.js';

/**
 * Extract topic titles from grok draft for RAG retrieval query
 */
function extractTopicTitles(grokDraft) {
  const titles = [];
  if (!grokDraft || typeof grokDraft !== 'object') return titles;

  // Handle various draft structures
  if (grokDraft.course_title) titles.push(grokDraft.course_title);
  if (grokDraft.title) titles.push(grokDraft.title);

  const topics = grokDraft.topics || grokDraft.overviewTopics || grokDraft.modules || [];
  for (const topic of topics) {
    if (typeof topic === 'string') {
      titles.push(topic);
    } else if (topic?.title) {
      titles.push(topic.title);
    }
    // Extract subtopic titles too
    const subtopics = topic?.subtopics || topic?.lessons || [];
    for (const st of subtopics) {
      if (typeof st === 'string') {
        titles.push(st);
      } else if (st?.title) {
        titles.push(st.title);
      }
    }
  }
  return titles.slice(0, 20); // Limit to avoid overly long query
}

/**
 * @typedef {Object} ContentPlans
 * @property {string} [reading] - Prompt for reading generation
 * @property {string[]} [video] - Search queries for video
 * @property {string} [quiz] - Prompt for quiz generation
 * @property {string} [flashcards] - Prompt for flashcard generation
 */

/**
 * @typedef {Object} LessonNode
 * @property {string} slug_id
 * @property {string} title
 * @property {string} module_group
 * @property {number} estimated_minutes
 * @property {"Remember" | "Understand" | "Apply" | "Analyze" | "Evaluate"} bloom_level
 * @property {number} intrinsic_exam_value
 * @property {string} architectural_reasoning
 * @property {ContentPlans} content_plans
 * @property {string[]} dependencies
 * @property {string[]} [original_source_ids]
 */

/**
 * @typedef {Object} LessonGraph
 * @property {LessonNode[]} lessons
 */

// RAG context retriever override for testing
let customRagContextRetriever = null;

export function __setRagContextRetriever(fn) {
  customRagContextRetriever = typeof fn === 'function' ? fn : null;
}

export function __clearRagContextRetriever() {
  customRagContextRetriever = null;
}

async function retrieveContextWrapper(opts) {
  return customRagContextRetriever ? customRagContextRetriever(opts) : retrieveContext(opts);
}

/**
 * Verify the course plan using Gemini with web search.
 * @param {Object} lessonGraph - The generated lesson graph
 * @param {Object} grokDraftJson - Original course draft
 * @param {string} ragContext - RAG context if available
 * @param {string} userId - User ID
 * @param {string} courseId - Course ID
 * @returns {Promise<{approved: boolean, reasoning: string, suggested_changes: Array}>}
 */
async function verifyCoursePlan(lessonGraph, grokDraftJson, ragContext, userId, courseId) {
  const lessonsSummary = lessonGraph.lessons.map(l => 
    `- ${l.title} (${l.module_group}): ${(l.content_plans?.reading || '').slice(0, 100)}...`
  ).join('\n');

  const systemPrompt = `You are a Course Plan Verifier. Your role is to verify a course plan for accuracy.

You have access to web search tools. Use them to verify:
1. The lesson topics are factually accurate for the subject
2. Prerequisites/dependencies are in the correct order
3. Content is appropriate for the course level
4. No critical topics are missing based on the original draft

OUTPUT FORMAT (JSON):
{
  "approved": true/false,
  "reasoning": "Your analysis of the plan",
  "suggested_changes": [
    {
      "lesson_slug": "slug-id",
      "change_type": "modify|add|remove",
      "description": "What to change and why"
    }
  ]
}

If approved=true, suggested_changes should be empty.`;

  const userPrompt = `## Original Course Draft:
${JSON.stringify(grokDraftJson, null, 2)}

${ragContext ? `## Reference Materials:\n${ragContext}\n` : ''}
## Generated Lesson Plan:
${lessonsSummary}

Full plan: ${JSON.stringify(lessonGraph.lessons.map(l => ({
  slug_id: l.slug_id, title: l.title, module_group: l.module_group,
  dependencies: l.dependencies, bloom_level: l.bloom_level
})), null, 2)}

Verify this plan. Use web search if needed to check accuracy.`;

  const { result } = await llmCaller({
    stage: STAGES.PLAN_VERIFIER,
    maxTokens: 100000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    responseFormat: { type: 'json_object' },
    allowWeb: true,
    maxToolIterations: 8,
    requestTimeoutMs: 600000,
    reasoning: { enabled: true, effort: 'high' },
    userId,
    courseId,
    source: 'plan_verifier',
  });

  return tryParseJson(result.content, 'PlanVerifier');
}

/**
 * Apply suggested repairs from the verifier.
 * @param {Object} lessonGraph - Current lesson graph
 * @param {Array} suggestedChanges - Suggested changes from verifier
 * @param {Object} grokDraftJson - Original draft
 * @param {string} ragContext - RAG context
 * @param {string} userId - User ID
 * @param {string} courseId - Course ID
 * @returns {Promise<Object>} - Repaired lesson graph
 */
async function applyPlanRepairs(lessonGraph, suggestedChanges, grokDraftJson, ragContext, userId, courseId) {
  const repairPrompt = `You are the Lesson Architect. A verifier has identified issues with your plan.

## Suggested Changes:
${JSON.stringify(suggestedChanges, null, 2)}

## Current Plan:
${JSON.stringify(lessonGraph.lessons, null, 2)}

Apply these changes to fix the plan. Return the corrected JSON:
{ "lessons": [...] }

IMPORTANT: Maintain all existing fields and structure. Only modify what's needed.`;

  const { result } = await llmCaller({
    stage: STAGES.LESSON_ARCHITECT,
    maxTokens: 100000,
    messages: [{ role: 'user', content: repairPrompt }],
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 1800000,
    userId,
    courseId,
    source: 'lesson_architect_verification_repair',
  });

  return tryParseJson(result.content, 'LessonArchitect Verification Repair');
}

/**
 * Generates a DAG of atomic lessons from a rough course draft.
 * @param {Object} grokDraftJson - The rough draft JSON from Grok.
 * @param {Object} userConfidenceMap - Map of slug_id -> confidence_score (0-1).
 * @param {string} userId - The user ID for tracking.
 * @param {string} mode - 'deep' or 'cram' mode.
 * @param {string} courseId - The course ID for usage tracking.
 * @param {string} [ragSessionId] - Optional RAG session ID to retrieve context.
 * @returns {Promise<{ finalNodes: any[], finalEdges: any[] }>}
 */
export async function generateLessonGraph(grokDraftJson, userConfidenceMap = {}, userId, mode = 'deep', courseId = null, ragSessionId = null, secondsToComplete = null) {

  // Retrieve RAG context if session ID provided
  let ragContext = '';
  if (ragSessionId) {
    try {
      const topicTitles = extractTopicTitles(grokDraftJson);
      const retrievalQuery = topicTitles.join(' | ');
      ragContext = await retrieveContextWrapper({
        sessionId: ragSessionId,
        queryText: retrievalQuery,
        topK: RAG_TOP_K,
        maxChars: RAG_MAX_CONTEXT_CHARS,
      });
      if (ragContext) {
        console.log(`[courseGenerator] RAG context retrieved: ${ragContext.length} chars`);
      }
    } catch (ragError) {
      console.warn('[courseGenerator] RAG context retrieval failed:', ragError.message);
    }
  }

  // Step 1: The Architect Call
  const systemPrompt = `You are the Lesson Architect. Your goal is to transform a rough course outline into a high-quality Directed Acyclic Graph (DAG) of Atomic Lessons.

INPUT: A rough course draft (JSON) generated by a junior process.
OUTPUT: A structured JSON object containing a list of lessons with dependencies.

CRITICAL RULES:
1. **Granularity:** "Atomic" means a lesson that takes 15-45 minutes to complete. Split broad topics. Merge tiny fragments (unless foundational).
2. **TIME BUDGET CONSTRAINT:** ${secondsToComplete ? `The student has **${Math.floor(secondsToComplete / 3600)} hours and ${Math.floor((secondsToComplete % 3600) / 60)} minutes** total study time available. The SUM of all lesson estimated_minutes MUST NOT exceed ${Math.floor(secondsToComplete / 60)} minutes. Plan accordingly—prioritize high-value content and be aggressive about merging or pruning low-value lessons to fit within this budget.` : 'No specific time constraint provided.'}
3. **Lineage:** You MUST track the 'original_source_ids' from the input. If you merge topics, list ALL their IDs. This preserves user data.
4. **No Cycles:** The graph must be strictly Acyclic.
5. **Module Organization:** Aim for modules with MORE than 2 lessons whenever possible to keep content properly chunked and modularized. Single-lesson or two-lesson modules should only be used when the topic is genuinely standalone or foundational. Well-organized modules (3-6 lessons) improve learning flow and coherence.
6. **Content Per Lesson:** Each lesson may have AT MOST ONE of each standard content type:
   - ONE reading (comprehensive, covers all aspects needed)
   - ONE video (optional, for visual explanation)
   - ONE quiz (assessing lesson comprehension)
   - ONE set of flashcards (key concepts to memorize)
   - NOTE: Do NOT include practice_problems in individual lessons. Practice problems are automatically added to Module Quizzes.
7. **Interactive Practice Problems:** A lesson may include MULTIPLE interactive practice problems of various types. These are optional and should be included when the topic benefits from hands-on manipulation:
   - **parsons**: Ranking/sorting problems where students reorder scrambled items. Use for: algorithm steps, code lines, complexity ordering, historical sequences, process steps.
   - **skeleton**: Fill-in-the-gap problems with a partially complete solution. Use for: formulas, code completion, proofs, mathematical derivations, template patterns.
   - **matching**: Many-to-many connection problems between two columns. Use for: term↔definition, cause↔effect, concept↔example, function↔output mappings.
   - **blackbox**: Input/output inference problems to deduce hidden rules. Use for: functions, algorithms, pattern recognition, transformations.
   You may include multiple problems of the same type AND multiple different types per lesson.
   ${secondsToComplete ? `**Time-aware:** With ${Math.floor(secondsToComplete / 60)} minutes available, be conservative—limit interactive problems to 1-2 types per lesson when time is tight.` : ''}
8. **Lesson-End Quizzes:** IMPORTANT: Always include a quiz as the LAST content type in each lesson. This quiz should assess understanding of the material covered in THAT lesson (and prior lessons if needed). Do not include questions on topics that haven't been taught yet. For the final lesson of a module, the quiz can be cumulative for that module.
9. **Specific Generation Plans:** For each content type you include, provide detailed, specific prompts:
   - **reading:** ${mode === 'cram' ? 'MAXIMIZE EXAM VALUE. Concise, laser-focused on exam-critical concepts only. Omit background context and nice-to-know details. Every sentence should directly support exam preparation.' : 'MAXIMIZE UNDERSTANDING AND RETENTION. Provide highly detailed prompts for a writer that explore all nuances, edge cases, intuitive explanations, real-world analogies (e.g., "Use a gear analogy," "Focus on formal proofs"), and interconnections between concepts. Build deep, lasting comprehension.'} **Mermaid Diagrams:** If a visual aid is helpful, explicitly request a specific Mermaid diagram type (e.g., "Include a sequence diagram for the handshake protocol" or "Use a class diagram to show the inheritance hierarchy"). Supported types: sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, journey, pie, mindmap, quadrantChart.
   - **video:** ${mode === 'cram' ? 'MINIMIZE VIDEO COUNT. Only include if absolutely essential for a concept that cannot be understood through text. Maximum 1 high-yield search query.' : '2-3 general, high-level YouTube search queries for broad concepts (e.g., "Introduction to Photosynthesis" rather than "Calvin Cycle Step 3"). Include videos that deepen understanding beyond text. Only include if the concept benefits from visual/dynamic explanation.'}
   - **quiz:** Detailed prompt for an examiner. Explicitly enumerate the main topics/subsections of the lesson and ensure the quiz has at least one question per major topic. Request varying difficulty levels (Easy, Medium, Hard) and ensure at least one "Challenge Question" that integrates multiple concepts to test deep understanding. **CRITICAL:** Ensure quiz topics align strictly with the reading and prerequisites.
   - **flashcards:** Prompt focusing on what to memorize (definitions vs. procedural steps).
   - **interactive_practice:** (optional) An object with prompts for each problem type to generate. Only include types that fit the lesson topic:
     * **parsons:** Prompt describing what items to reorder and the learning goal.
     * **skeleton:** Prompt describing the template with gaps and what students should learn by filling them.
     * **matching:** Prompt describing the two columns and what connections students should make.
     * **blackbox:** Prompt describing the hidden rule and what patterns students should recognize.
10. **IDs:** Use "Semantic Slugs" (kebab-case) for IDs.
11. **Reasoning:** The 'architectural_reasoning' field must explain your grouping logic, why you assigned the specific exam value (1-10), and why you chose the specific content mix.${secondsToComplete ? ' Also explain how you fit within the time budget.' : ''}
12. **Naming:** NEVER number modules or lessons in the title or module_group (e.g., 'Limits', not 'Week 1: Limits').
13. **MODE: ${mode.toUpperCase()}**:
    ${mode === 'cram' ? '- MAXIMIZE EXAM VALUE. Structure for speed. Aggressively merge and prune lessons. Generate FEWER lessons overall. Eliminate nice-to-know content. Every lesson must directly contribute to exam performance.' : '- MAXIMIZE UNDERSTANDING AND DEEP RETENTION. Create granular, detailed lessons that explore all nuances. Ensure comprehensive coverage of edge cases, exceptions, and interconnections. Build deep, lasting knowledge that transfers beyond the exam.'}
14. **GROUNDING:** When authoritative excerpts from syllabus/exam materials are provided, use them to ground lesson structure and exam value assignments. Reference specific details in your architectural_reasoning.
15. **CONFIDENCE-BASED PRIORITIZATION:** The student has rated their confidence on source topics. Use this to allocate study time efficiently:
    - **LOW CONFIDENCE (0.0-0.4) + HIGH EXAM VALUE (7-10):** MAXIMUM content depth. These are knowledge gaps that will cost them points. Create detailed, granular lessons with multiple content types.
    - **LOW CONFIDENCE (0.0-0.4) + LOW EXAM VALUE (1-4):** Moderate coverage. Include but keep concise since exam ROI is lower.
    - **HIGH CONFIDENCE (0.7-1.0) + HIGH EXAM VALUE (7-10):** Light review only. The student already knows this—just include a brief refresher or skip if time-constrained.
    - **HIGH CONFIDENCE (0.7-1.0) + LOW EXAM VALUE (1-4):** MINIMAL or SKIP. Do not waste time on content the student already knows AND won't be tested on.
    - In cram mode, be even MORE aggressive about skipping high-confidence content to focus on knowledge gaps.
16. **CREATIVE FREEDOM:** The input skeleton/modules are SUGGESTIONS, not constraints. You have full authority to:
    - Restructure, rename, merge, or split modules as you see fit for optimal learning
    - Reorder topics if a different sequence makes more pedagogical sense
    - Add foundational lessons the skeleton missed but are critical for understanding
    - Remove or deprioritize topics that are peripheral or redundant
    - Choose your own teaching style and approach (e.g., theory-first vs. example-driven, spiral curriculum vs. linear)
    - USE WEB SEARCH to research the subject matter thoroughly—look up the course, textbook, and topic to ensure comprehensive, accurate coverage
    - Your goal is the BEST possible learning experience, not faithfulness to a rough draft

Output STRICT VALID JSON format (no markdown, no comments):
{
  "lessons": [
    {
      "slug_id": "chain-rule-application",
      "title": "Mastering the Chain Rule",
      "module_group": "Limits",
      "estimated_minutes": 30,
      "bloom_level": "Apply",
      "intrinsic_exam_value": 8,
      "architectural_reasoning": "Merged st1_1 and st1_2 to create a cohesive 30-min lesson. Rated 8/10 because the syllabus highlights this for the midterm.",
      "dependencies": ["limits-intro"],
      "original_source_ids": ["st1_1", "st1_2"],
      
      "content_plans": {
         "reading": "Explain the chain rule using a 'peeling the onion' analogy. Focus on identifying inner vs outer functions.",
         "video": ["chain rule calculus intuition"],
         "quiz": "Generate 3-5 multiple-choice questions. Question 1 on Chain Rule intuition, Question 2 on identifying inner/outer functions, Question 3 on applying the formula. Include a Challenge Question involving a trigonometric function inside a polynomial.",
         "flashcards": "Focus on the formula f'(g(x))g'(x) and recognizing composite functions.",
         "interactive_practice": {
           "parsons": "Create a problem where students order the 5 steps of applying the chain rule to differentiate a nested function like sin(x^2).",
           "skeleton": "Create a problem with gaps in the chain rule formula: d/dx[f(g(x))] = {{gap_1}} * {{gap_2}}. Include 3 distractors per gap.",
           "matching": "Create a problem matching 4 composite functions to their derivatives.",
           "blackbox": "Create a problem where students see input/output pairs and must deduce the derivative rule being applied."
         }
      }
    }
  ]
}`;

  // Build RAG context section for prompt if available
  const ragContextSection = ragContext
    ? `\n\n### Authoritative Excerpts (from student's syllabus/exam materials):\nUse these excerpts to ground lesson structure and exam value assignments.\n\n${ragContext}`
    : '';

  // Build confidence map section if available
  const confidenceEntries = Object.entries(userConfidenceMap || {});
  const confidenceSection = confidenceEntries.length > 0
    ? `\n\n### Student Confidence Ratings (0=no knowledge, 1=mastered):\nUse these to prioritize content—focus on LOW confidence + HIGH exam value topics.\n${confidenceEntries.map(([id, score]) => `- ${id}: ${score}`).join('\n')}`
    : '';

  const userPrompt = `Rough Draft: ${JSON.stringify(grokDraftJson)}${ragContextSection}${confidenceSection}`;

  const { result } = await llmCaller({
    stage: STAGES.LESSON_ARCHITECT,
    maxTokens: 100000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 1800000, // 30 minutes for long-running course generation
    allowWeb: true,
    maxToolIterations: 8, // Web research for course content
    userId,
    courseId,
    source: 'lesson_architect',
  });

  let lessonGraph;
  try {
    const cleanJson = result.content
      .replace(/^```json\s*/, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '')
      .replace(/\\'/g, "'");

    lessonGraph = tryParseJson(cleanJson, 'LessonArchitect');
  } catch (e) {
    throw new Error('Invalid JSON response from Lesson Architect');
  }

  if (!lessonGraph || !Array.isArray(lessonGraph.lessons)) {
    throw new Error('Invalid response structure: missing lessons array');
  }

  // Step 1.25: Time Budget Validation
  // Check if total estimated_minutes exceeds the user's available time
  if (secondsToComplete) {
    const budgetMinutes = Math.floor(secondsToComplete / 60);
    const totalEstimatedMinutes = lessonGraph.lessons.reduce(
      (sum, lesson) => sum + (lesson.estimated_minutes || 30), 0
    );
    
    console.log(`[courseGenerator] Time budget check: ${totalEstimatedMinutes} min generated vs ${budgetMinutes} min available`);
    
    if (totalEstimatedMinutes > budgetMinutes) {
      console.log(`[courseGenerator] Plan exceeds time budget by ${totalEstimatedMinutes - budgetMinutes} minutes. Asking Grok to fix...`);
      
      const hours = Math.floor(budgetMinutes / 60);
      const mins = budgetMinutes % 60;
      const repairPrompt = `Your generated course plan has a total of ${totalEstimatedMinutes} minutes, but the student only has ${hours} hours and ${mins} minutes (${budgetMinutes} minutes total) available.

You MUST reduce the total estimated time to fit within ${budgetMinutes} minutes.

Current lessons (${lessonGraph.lessons.length} lessons, ${totalEstimatedMinutes} minutes total):
${lessonGraph.lessons.map(l => `- ${l.title}: ${l.estimated_minutes || 30} min`).join('\n')}

Strategies to reduce time:
1. Merge related lessons into single, more efficient lessons
2. Remove low-value lessons (intrinsic_exam_value < 5)
3. Reduce estimated_minutes for lessons that are currently overestimated
4. In cram mode: aggressively cut nice-to-know content

Return the FIXED lesson graph JSON with reduced total time. Maintain all required fields.
{ "lessons": [...] }`;

      try {
        const { result: repairResult } = await llmCaller({
          stage: STAGES.LESSON_ARCHITECT,
          maxTokens: 100000,
          messages: [{ role: 'user', content: repairPrompt }],
          responseFormat: { type: 'json_object' },
          requestTimeoutMs: 600000,
          userId,
          courseId,
          source: 'lesson_architect_time_budget_repair',
        });

        const repairedGraph = tryParseJson(repairResult.content, 'LessonArchitect Time Repair');
        if (repairedGraph?.lessons) {
          const newTotal = repairedGraph.lessons.reduce(
            (sum, lesson) => sum + (lesson.estimated_minutes || 30), 0
          );
          console.log(`[courseGenerator] Repaired plan: ${newTotal} min (was ${totalEstimatedMinutes} min)`);
          
          if (newTotal <= budgetMinutes) {
            lessonGraph = repairedGraph;
            console.log('[courseGenerator] Time budget repair successful');
          } else {
            console.warn(`[courseGenerator] Repair still exceeds budget (${newTotal} > ${budgetMinutes}), using original`);
          }
        }
      } catch (repairError) {
        console.warn('[courseGenerator] Time budget repair failed:', repairError.message);
      }
    } else {
      console.log('[courseGenerator] Plan within time budget');
    }
  }

  // Note: Verification step removed - Gemini is now the Lesson Architect itself

  // Step 2: Self-Healing Validation Logic
  const validSlugs = new Set(lessonGraph.lessons.map((l) => l.slug_id));
  const brokenDependenciesMap = new Map(); // lesson_slug -> [bad_deps]

  // Pre-compute the array once to avoid O(n) conversion on each iteration
  const validSlugsArray = Array.from(validSlugs);

  // Helper to yield to event loop and prevent CPU blocking
  const yieldToEventLoop = () => new Promise(resolve => setImmediate(resolve));

  // Stage 1: Fuzzy Repair & Identification
  let similarityChecksCount = 0;
  for (const lesson of lessonGraph.lessons) {
    const newDependencies = [];
    const badDepsForLesson = [];

    for (const dep of lesson.dependencies || []) {
      if (validSlugs.has(dep)) {
        newDependencies.push(dep);
      } else {
        // Use pre-computed array instead of creating new one each time
        const matches = stringSimilarity.findBestMatch(dep, validSlugsArray);
        similarityChecksCount++;
        
        // Yield to event loop every 10 similarity checks to prevent CPU blocking
        if (similarityChecksCount % 10 === 0) {
          await yieldToEventLoop();
        }
        
        if (matches.bestMatch.rating > 0.9) {
          newDependencies.push(matches.bestMatch.target);
        } else {
          // Keep it for Stage 2, but track it as broken
          newDependencies.push(dep);
          badDepsForLesson.push(dep);
        }
      }
    }
    lesson.dependencies = newDependencies;
    if (badDepsForLesson.length > 0) {
      brokenDependenciesMap.set(lesson.slug_id, badDepsForLesson);
    }
  }

  // Stage 2: Targeted Regeneration
  if (brokenDependenciesMap.size > 0) {

    const allBadSlugs = new Set();
    for (const deps of brokenDependenciesMap.values()) {
      deps.forEach(d => allBadSlugs.add(d));
    }

    const repairPrompt = `You generated these nodes: ${JSON.stringify(Array.from(validSlugs))}.
You referenced these non-existent dependencies: ${JSON.stringify(Array.from(allBadSlugs))}.
Return a JSON map correcting the Bad Slugs to existing ones, or map to null to remove.
Example: { "bad-slug": "good-slug", "another-bad": null }`;

    try {
      const { result: repairResult } = await llmCaller({
        stage: STAGES.LESSON_ARCHITECT, // Re-use same stage/model
        maxTokens: 100000,
        messages: [{ role: 'user', content: repairPrompt }],
        responseFormat: { type: 'json_object' },
        requestTimeoutMs: 1800000, // 30 minutes for repair call as well
        userId,
        courseId,
        source: 'lesson_architect_repair',
      });

      const corrections = tryParseJson(repairResult.content, 'LessonArchitect Repair');

      // Apply corrections
      for (const [slug, badDeps] of brokenDependenciesMap.entries()) {
        const lesson = lessonGraph.lessons.find(l => l.slug_id === slug);
        if (!lesson) continue;

        const finalDeps = [];
        for (const dep of lesson.dependencies) {
          if (badDeps.includes(dep)) {
            const correction = corrections[dep];
            if (correction && validSlugs.has(correction)) {
              finalDeps.push(correction);
            } else {
              // Stage 3: Orphan Fallback
            }
          } else {
            finalDeps.push(dep);
          }
        }
        lesson.dependencies = [...new Set(finalDeps)]; // Dedupe
      }

    } catch (e) {
      // Fallback to dropping all bad deps (Stage 3) implicitly since we didn't add them back
    }
  }

  // Step 2.4: Safeguard - Remove practice_problems from individual lessons
  // Practice problems should ONLY be in Module Quizzes
  for (const lesson of lessonGraph.lessons) {
    if (lesson.content_plans && lesson.content_plans.practice_problems) {
      // If it's not a module quiz (which shouldn't exist yet, but just in case)
      if (lesson.title !== 'Module Quiz' && !lesson.slug_id.startsWith('module-quiz-')) {
        delete lesson.content_plans.practice_problems;
      }
    }
  }

  // Step 2.5: Inject Module Quizzes
  // Group lessons by module
  const moduleMap = new Map();
  lessonGraph.lessons.forEach(l => {
    if (!moduleMap.has(l.module_group)) {
      moduleMap.set(l.module_group, []);
    }
    moduleMap.get(l.module_group).push(l);
  });

  // Create Module Quiz for each module
  for (const [moduleName, lessons] of moduleMap.entries()) {
    // Skip if module already has a module quiz (unlikely but safe)
    if (lessons.some(l => l.title === 'Module Quiz')) continue;

    const moduleSlug = moduleName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    const quizSlug = `module-quiz-${moduleSlug}`;

    // Gather context from lessons in this module
    const lessonSummaries = lessons.map(l => {
      // Use title and reading prompt to give context
      const readingPrompt = l.content_plans?.reading || '';
      // Truncate reading prompt to avoid excessive context, just get the gist
      const gist = readingPrompt.length > 150 ? readingPrompt.substring(0, 150) + '...' : readingPrompt;
      return `- Lesson: "${l.title}" (Focus: ${gist})`;
    }).join('\n');

    const quizPrompt = `Create a comprehensive Module Quiz for the module "${moduleName}".
The quiz should cover the key concepts from the following lessons:
${lessonSummaries}

Requirements:
1. This is a cumulative review quiz for the entire module.
2. Only include questions that are DIFFICULT and SUMMATIVE in nature — i.e., questions that require problem-solving, application, analysis, or evaluation rather than simple recall of facts or definitions.
3. Aim for questions that integrate multiple concepts or require reasoning across lessons; include challenge-style problems where appropriate.
4. Include at least 6-7 questions in the quiz.
5. Provide a balanced mix of difficulty levels among those difficult questions where applicable (e.g., several multi-step application problems and at least one integrative challenge).
6. Provide detailed explanations for every answer (correct and incorrect), explaining the reasoning and common misconceptions.
7. Use proper LaTeX formatting for any math.
8. Do NOT include content from outside this module.`;

    const practiceProblemsPrompt = `Create 2-3 exam-style practice problems for the module "${moduleName}".
These problems should cover the key concepts from the following lessons:
${lessonSummaries}

Requirements:
1. Each problem should take 10-20 minutes to complete.
2. Problems should be MORE DIFFICULT than the quiz questions and replicate authentic exam conditions.
3. Include multi-step problems that integrate concepts across multiple lessons in this module.
4. For each problem, provide:
   - A detailed rubric with point allocations for each step
   - Common exam traps and errors students might make
   - A complete sample answer with step-by-step solution
5. Focus on application, analysis, and evaluation (Bloom's higher levels).
6. Use proper LaTeX formatting for any math.
7. Do NOT include content from outside this module.`;

    const moduleQuizLesson = {
      slug_id: quizSlug,
      title: 'Module Quiz',
      module_group: moduleName,
      estimated_minutes: 30,
      bloom_level: 'Evaluate',
      intrinsic_exam_value: 10,
      architectural_reasoning: 'Automatically generated comprehensive review quiz with practice problems for the module.',
      dependencies: lessons.map(l => l.slug_id), // Depend on ALL lessons in the module
      original_source_ids: [],
      content_plans: {
        quiz: quizPrompt,
        practice_problems: practiceProblemsPrompt
      }
    };

    lessonGraph.lessons.push(moduleQuizLesson);
  }

  // Step 3: Normalization & Output
  const slugToUuid = new Map();
  lessonGraph.lessons.forEach(l => slugToUuid.set(l.slug_id, uuidv4()));

  const finalNodes = lessonGraph.lessons.map(l => {
    // Calculate Confidence Score
    let confidenceSum = 0;
    let sourceCount = 0;
    const sources = l.original_source_ids || [];

    if (sources.length > 0) {
      sources.forEach(sid => {
        if (typeof userConfidenceMap[sid] === 'number') {
          confidenceSum += userConfidenceMap[sid];
          sourceCount++;
        }
      });
    }

    // Default to 0.1 if no sources or no matching scores
    const confidenceScore = sourceCount > 0 ? Number((confidenceSum / sourceCount).toFixed(2)) : 0.1;

    return {
      id: slugToUuid.get(l.slug_id),
      title: l.title,
      description: null,
      intrinsic_exam_value: l.intrinsic_exam_value,
      bloom_level: l.bloom_level,
      yield_tag: 'Medium',
      estimated_minutes: l.estimated_minutes,
      is_checkpoint: false,
      in_degree: 0,
      out_degree: 0,

      // Store the plans inside content_payload so the Worker can access them later
      content_payload: {
        // This preserves the 'content_plans' object (reading prompt, video queries, etc.)
        generation_plans: l.content_plans || {}
      },

      module_ref: l.module_group,
      created_at: new Date().toISOString(),
      confidence_score: confidenceScore,
      metadata: {
        original_source_ids: sources,
        architectural_reasoning: l.architectural_reasoning
      }
    };
  });

  const finalEdges = [];

  // Calculate degrees and build edges
  lessonGraph.lessons.forEach(l => {
    const childId = slugToUuid.get(l.slug_id);
    l.dependencies.forEach(parentSlug => {
      const parentId = slugToUuid.get(parentSlug);
      if (parentId) {
        finalEdges.push({
          parent_id: parentId,
          child_id: childId
        });

        // Update degrees
        const childNode = finalNodes.find(n => n.id === childId);
        const parentNode = finalNodes.find(n => n.id === parentId);
        if (childNode) childNode.in_degree = (childNode.in_degree || 0) + 1;
        if (parentNode) parentNode.out_degree = (parentNode.out_degree || 0) + 1;
      }
    });
  });

  return { finalNodes, finalEdges };
}

/**
 * Generates a Review Module based on a list of graded topics.
 * @param {Array<{topic: string, grade: number, explanation: string}>} topics - List of topics with grades and feedback.
 * @param {string} type - 'midterm' or 'final'.
 * @param {string} userId - The user ID for tracking.
 * @param {string} courseId - The course ID for usage tracking.
 * @returns {Promise<{ finalNodes: any[], finalEdges: any[] }>}
 */
export async function generateReviewModule(topics, type, userId, courseId = null) {
  const systemPrompt = `You are the Lesson Architect. Your goal is to create a Review Module for a ${type} exam based on the provided graded topics.

INPUT: A list of topics with student grades (1-5 scale) and explanations of their performance.
OUTPUT: A structured JSON object containing a list of lessons.

CRITICAL RULES:
1. **Prioritize Weaknesses:** Focus heavily on topics where the grade is low (1-3). You can group strong topics (4-5) into a quick summary lesson or omit them if the list is long.
2. **Granularity:** Create lessons that take 15-30 minutes. Group related weak topics into cohesive lessons.
3. **Module Group:** ALL lessons must have "module_group" set to "${type} Review".
4. **Content Type Diversity:** You may include MULTIPLE instances of each content type per lesson if appropriate for learning:
   - A lesson can have multiple readings (e.g., theory + examples + edge cases)
   - A lesson can have multiple videos (e.g., intro + deep dive + worked examples)
   - A lesson can have multiple quizzes (e.g., conceptual check + application problems)
   - A lesson can include flashcards for memorization
   - ALL content should flow in a logical learning order for maximum comprehension
   - NOTE: Do NOT include practice_problems in individual lessons. Practice problems are automatically added to the final Review Quiz.
5. **Specific Generation Plans:** For each content type you include, provide detailed, specific prompts:
   - **reading:** Concise review/summary focusing on exam-critical concepts. Address the specific weaknesses mentioned in the student's performance.
   - **video:** 1-2 high-yield search queries. Only include if the concept is exceptionally difficult or visual.
   - **quiz:** Detailed prompt for an examiner. Request varying difficulty levels (Easy, Medium, Hard) and ensure at least one "Challenge Question."
   - **flashcards:** Prompt focusing on what to memorize (definitions, formulas, key procedural steps).
6. **IDs:** Use kebab-case slug_ids.
7. **Reasoning:** Explain why you grouped topics this way and how you addressed the specific weaknesses mentioned in the input.

Output STRICT VALID JSON format (no markdown, no comments):
{
  "lessons": [
    {
      "slug_id": "topic-review",
      "title": "Review: Topic Name",
      "module_group": "${type} Review",
      "estimated_minutes": 30,
      "bloom_level": "Analyze",
      "intrinsic_exam_value": 10,
      "architectural_reasoning": "Focused on this because the student scored 1/5 due to...",
      "dependencies": [],
      "content_plans": {
         "reading": "Review the key concepts of...",
         "video": ["topic explanation"],
         "quiz": "Create review questions covering...",
         "flashcards": "Focus on key formulas and definitions for..."
      }
    }
  ]
}`;

  const userPrompt = `Student Performance Report: ${JSON.stringify(topics)}`;

  const { result } = await llmCaller({
    stage: STAGES.LESSON_ARCHITECT,
    maxTokens: 100000,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    responseFormat: { type: 'json_object' },
    requestTimeoutMs: 600000,
    userId,
    courseId,
    source: 'review_module_architect',
  });

  let lessonGraph;
  try {
    const cleanJson = result.content
      .replace(/^```json\s*/, '')
      .replace(/^```\s*/, '')
      .replace(/\s*```$/, '')
      .replace(/\\'/g, "'");

    lessonGraph = tryParseJson(cleanJson, 'ReviewModuleArchitect');
  } catch (e) {
    throw new Error('Invalid JSON response from Lesson Architect for Review Module');
  }

  if (!lessonGraph || !Array.isArray(lessonGraph.lessons)) {
    throw new Error('Invalid response structure: missing lessons array');
  }

  // Inject Review Quiz with practice problems at the end
  const lessonSummaries = lessonGraph.lessons.map(l => {
    const readingPrompt = l.content_plans?.reading || '';
    const gist = readingPrompt.length > 150 ? readingPrompt.substring(0, 150) + '...' : readingPrompt;
    return `- Lesson: "${l.title}" (Focus: ${gist})`;
  }).join('\n');

  const reviewQuizPrompt = `Create a comprehensive Review Quiz for the "${type} Review" module.
The quiz should cover the key concepts from the following lessons:
${lessonSummaries}

Requirements:
1. This is a cumulative review quiz for all the review material.
2. Only include questions that are DIFFICULT and SUMMATIVE in nature — i.e., questions that require problem-solving, application, analysis, or evaluation rather than simple recall.
3. Include at least 6-7 questions in the quiz.
4. Provide detailed explanations for every answer (correct and incorrect).
5. Use proper LaTeX formatting for any math.`;

  const practiceProblemsPrompt = `Create 2-3 exam-style practice problems for the "${type} Review" module.
These problems should cover the key concepts from the following lessons:
${lessonSummaries}

Requirements:
1. Each problem should take 10-20 minutes to complete.
2. Problems should be MORE DIFFICULT than the quiz questions and replicate authentic exam conditions.
3. Include multi-step problems that integrate concepts across multiple lessons.
4. For each problem, provide:
   - A detailed rubric with point allocations for each step
   - Common exam traps and errors students might make
   - A complete sample answer with step-by-step solution
5. Focus on application, analysis, and evaluation (Bloom's higher levels).
6. Use proper LaTeX formatting for any math.`;

  const reviewQuizSlug = `review-quiz-${type}`;
  const reviewQuizLesson = {
    slug_id: reviewQuizSlug,
    title: `${type.charAt(0).toUpperCase() + type.slice(1)} Review Quiz`,
    module_group: `${type} Review`,
    estimated_minutes: 30,
    bloom_level: 'Evaluate',
    intrinsic_exam_value: 10,
    architectural_reasoning: 'Automatically generated comprehensive review quiz with practice problems.',
    dependencies: lessonGraph.lessons.map(l => l.slug_id),
    content_plans: {
      quiz: reviewQuizPrompt,
      practice_problems: practiceProblemsPrompt
    }
  };

  lessonGraph.lessons.push(reviewQuizLesson);

  // Normalization & Output
  const slugToUuid = new Map();
  lessonGraph.lessons.forEach(l => slugToUuid.set(l.slug_id, uuidv4()));

  const finalNodes = lessonGraph.lessons.map(l => {
    return {
      id: slugToUuid.get(l.slug_id),
      title: l.title,
      description: null,
      intrinsic_exam_value: l.intrinsic_exam_value,
      bloom_level: l.bloom_level,
      yield_tag: 'High', // Review modules are usually high yield
      estimated_minutes: l.estimated_minutes,
      is_checkpoint: false,
      in_degree: 0,
      out_degree: 0,
      content_payload: {
        generation_plans: l.content_plans || {}
      },
      module_ref: l.module_group,
      created_at: new Date().toISOString(),
      confidence_score: 1.0, // Generated from known topics
      metadata: {
        architectural_reasoning: l.architectural_reasoning,
        review_type: type // Tag for fetching later
      }
    };
  });

  const finalEdges = [];
  // We assume review lessons are mostly independent or linear, but if the LLM outputs dependencies, we respect them.
  lessonGraph.lessons.forEach(l => {
    const childId = slugToUuid.get(l.slug_id);
    if (l.dependencies) {
      l.dependencies.forEach(parentSlug => {
        const parentId = slugToUuid.get(parentSlug);
        if (parentId) {
          finalEdges.push({
            parent_id: parentId,
            child_id: childId
          });
          const childNode = finalNodes.find(n => n.id === childId);
          const parentNode = finalNodes.find(n => n.id === parentId);
          if (childNode) childNode.in_degree = (childNode.in_degree || 0) + 1;
          if (parentNode) parentNode.out_degree = (parentNode.out_degree || 0) + 1;
        }
      });
    }
  });

  return { finalNodes, finalEdges };
}
