// cheatsheetGenerator.js

import { join } from 'path';
import { tmpdir } from 'os';
import {
  uploadCheatsheetFile,
  getCourseCheatsheetFiles,
  downloadCheatsheetFile,
  deleteCheatsheetFile
} from './cheatsheetStorage.js';
import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { getSupabase } from '../supabaseClient.js';

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

// Exported dependencies for testing
export const deps = {
  callStageLLM,
};

/* -------------------------------------------------------------------------- */
/*  LaTeX environment specification for cheatsheets                           */
/* -------------------------------------------------------------------------- */

const CHEATSHEET_LATEX_SPEC = `
LATEX ENVIRONMENT SPECIFICATION:
- Engine: pdfLaTeX only.
- Document class: article with 10pt font.
- Packages available: amsmath, amssymb, amsthm, mathtools, geometry, hyperref,
  xcolor, enumitem, array, tabularx, multirow, multicol, booktabs, float.
- STRICTLY FORBIDDEN: tikz, circuitikz, minted, shell-escape, external files
  (\\\\includegraphics, \\\\input), custom graphics libraries, XeLaTeX/LuaLaTeX features.
- CONSTRAINTS: Use only basic math/tabular environments. NO advanced graphics.
- Diagrams or figures must be described in text or simple tables only.
`;

const CHEATSHEET_CONTENT_INSTRUCTIONS = `
OUTPUT REQUIREMENTS (CRITICAL):

You MUST output ONLY the LaTeX content that goes inside the multicols environment.
Do NOT output:
  * \\\\documentclass, \\\\usepackage, \\\\begin{document}, \\\\end{document}
  * \\\\begin{multicols} or \\\\end{multicols}
  * Any preamble or document wrappers.

We will wrap your output inside a fixed compact two-column LaTeX template.

CONTENT STYLE RULES:

1. Use \\\\textbf{Topic Name} for section headings (NOT \\\\section{}).
2. Keep content extremely compact - this must fit on 2 pages (front and back).
3. Use itemize/enumerate with minimal spacing for lists.
4. Focus on:
   - Key definitions and formulas
   - Important theorems and their conditions
   - Quick worked examples (1-2 lines each)
   - Common mistakes to avoid
   - High-yield exam tips
5. Avoid verbose explanations - use telegraphic style.
6. Use math mode ($ or \\\\[ \\\\]) for all formulas.
7. Group related concepts together logically.

Return ONLY the raw LaTeX content block, with no Markdown code fences and no explanation.
`;

const FORBIDDEN_PACKAGES = ['tikz', 'circuitikz', 'minted', 'pgfplots', 'graphicx'];
const FORBIDDEN_CONSTRUCTS = [
  /\\usetikzlibrary/gi,
  /\\tikz/gi,
  /\\begin\{tikzpicture\}/gi,
  /\\begin\{circuitikz\}/gi,
  /tikz\/start\s+chain/gi,
  /\\includegraphics/gi,
  /\\input\{/gi,
  /shell-escape/gi,
];

/* -------------------------------------------------------------------------- */
/*  Helpers: sanitize / strip unsupported constructs                          */
/* -------------------------------------------------------------------------- */

function stripUnsupportedConstructs(code) {
  let cleaned = code;

  for (const pkg of FORBIDDEN_PACKAGES) {
    const regex = new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{${pkg}\\}`, 'gi');
    cleaned = cleaned.replace(regex, `% REMOVED: unsupported package ${pkg}`);
  }

  for (const pattern of FORBIDDEN_CONSTRUCTS) {
    cleaned = cleaned.replace(pattern, '% REMOVED: unsupported construct');
  }

  cleaned = cleaned.replace(
    /\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/gi,
    '% REMOVED: tikzpicture environment not supported',
  );
  cleaned = cleaned.replace(
    /\\begin\{circuitikz\}[\s\S]*?\\end\{circuitikz\}/gi,
    '% REMOVED: circuitikz environment not supported',
  );

  return cleaned;
}

/**
 * Sanitizes LLM output, removing markdown fences and document wrappers.
 */
function sanitizeCheatsheetContent(raw) {
  let content = raw || '';

  // Strip markdown code fences
  content = content.replace(/^```(?:latex|tex)?\s*/i, '');
  content = content.replace(/```\s*$/i, '');

  // Remove document class, usepackage, begin/end document
  content = content.replace(/\\documentclass[^}]*\}/gi, '');
  content = content.replace(/\\usepackage[^}]*\}/gi, '');
  content = content.replace(/\\begin\{document\}/gi, '');
  content = content.replace(/\\end\{document\}/gi, '');
  content = content.replace(/\\begin\{multicols\}\{\d+\}/gi, '');
  content = content.replace(/\\end\{multicols\}/gi, '');

  content = stripUnsupportedConstructs(content);

  return content.trim();
}

/* -------------------------------------------------------------------------- */
/*  Build full cheatsheet document from content block                         */
/* -------------------------------------------------------------------------- */

function buildCheatsheetDocument(courseTitle, contentBlock) {
  const safeTitle = (courseTitle || 'Course').replace(/[#$%&_{}~^\\]/g, ' ');

  return `
\\documentclass[10pt]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=0.5in]{geometry}
\\usepackage{amsmath,amssymb,amsthm,mathtools}
\\usepackage{multicol}
\\usepackage{enumitem}
\\usepackage{array,tabularx,booktabs}
\\usepackage{xcolor}
\\usepackage{fancyhdr}

% Compact spacing
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{2pt}
\\setlength{\\columnsep}{12pt}

% Compact lists
\\setlist{noitemsep,topsep=2pt,parsep=0pt,partopsep=0pt,leftmargin=*}

% Minimal header
\\pagestyle{fancy}
\\fancyhf{}
\\fancyhead[C]{\\small\\textbf{${safeTitle} -- Cheat Sheet}}
\\renewcommand{\\headrulewidth}{0.4pt}
\\fancyfoot[C]{\\tiny\\thepage}

\\begin{document}

\\begin{multicols}{2}
${contentBlock}
\\end{multicols}

\\end{document}
`;
}

/* -------------------------------------------------------------------------- */
/*  LaTeX Compilation                                                         */
/* -------------------------------------------------------------------------- */

async function compileLatexToPdf(latexCode) {
  const fs = await import('fs/promises');
  
  const timestamp = Date.now();
  const workDir = join(tmpdir(), `cheatsheet_workdir_${timestamp}`);
  const texPath = join(workDir, 'cheatsheet.tex');
  const pdfPath = join(workDir, 'cheatsheet.pdf');
  const logPath = join(workDir, 'cheatsheet.log');

  try {
    await fs.mkdir(workDir, { recursive: true });
    await fs.writeFile(texPath, latexCode, 'utf8');

    const pdflatexCmd = `pdflatex -interaction=nonstopmode -output-directory="${workDir}" "${texPath}"`;
    
    // Run pdflatex twice for proper formatting
    for (let pass = 1; pass <= 2; pass++) {
      console.log(`[cheatsheetGenerator] Starting LaTeX compilation pass ${pass}/2...`);
      try {
        await execAsync(pdflatexCmd, { 
          cwd: workDir,
          timeout: 60000,
        });
      } catch (passError) {
        const pdfExists = await fs.access(pdfPath).then(() => true).catch(() => false);
        if (!pdfExists && pass === 2) {
          throw passError;
        }
        console.log(`[cheatsheetGenerator] Pass ${pass} completed with warnings`);
      }
    }

    const pdfExists = await fs.access(pdfPath).then(() => true).catch(() => false);
    if (!pdfExists) {
      throw new Error('PDF file was not generated after compilation');
    }

    const buffer = await fs.readFile(pdfPath);
    console.log('[cheatsheetGenerator] Compilation successful!');

    // Cleanup
    await cleanupDir(workDir);

    return buffer;
  } catch (err) {
    let detailedError = err.message;
    try {
      const logContent = await fs.readFile(logPath, 'utf8');
      const lines = logContent.split('\n');
      const errorLines = [];

      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('!')) {
          errorLines.push(lines[i]);
          if (lines[i + 1]) errorLines.push(lines[i + 1]);
          if (lines[i + 2]) errorLines.push(lines[i + 2]);
        }
      }

      if (errorLines.length > 0) {
        detailedError = `LaTeX Syntax Error\n${errorLines.join('\n')}`;
      } else {
        detailedError = `LaTeX Compilation Failed\n${logContent.slice(-1000)}`;
      }
    } catch (readErr) {
      console.warn('[cheatsheetGenerator] Could not read LaTeX log file:', readErr.message);
    }
    
    await cleanupDir(workDir);
    throw new Error(detailedError);
  }
}

async function cleanupDir(dirPath) {
  const fs = await import('fs/promises');
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[cheatsheetGenerator] Failed to cleanup temp directory ${dirPath}:`, e.message);
  }
}

function extractLatexError(error) {
  const message = error.message || String(error);
  const MAX_ERROR_LENGTH = 500;
  if (message.length > MAX_ERROR_LENGTH) {
    return message.substring(0, MAX_ERROR_LENGTH) + '\n...[truncated]';
  }
  return message;
}

/* -------------------------------------------------------------------------- */
/*  Public API: generateCheatsheet                                            */
/* -------------------------------------------------------------------------- */

/**
 * Generates a cheatsheet for a course based on user prompt.
 *
 * @param {string} courseId
 * @param {string} userId
 * @param {string} userPrompt - User's instructions for what to include
 * @param {Object} options - Additional options
 * @param {string[]} options.lessonIds - Specific lessons to focus on
 * @param {boolean} options.includeWeakTopics - Include user's weak areas
 * @param {Array} options.attachments - File attachments (PDFs, images, etc.) to include for context
 * @returns {Promise<{ url: string, name: string, number: number }>}
 */
export async function generateCheatsheet(courseId, userId, userPrompt, options = {}) {
  const { lessonIds, includeWeakTopics = true, attachments = [] } = options;

  // 1. Fetch course info and lessons
  const supabase = getSupabase();
  
  const { data: courseData, error: courseError } = await supabase
    .schema('api')
    .from('courses')
    .select('title, syllabus_text, exam_details')
    .eq('id', courseId)
    .eq('user_id', userId)
    .single();

  if (courseError || !courseData) {
    throw new Error(`Course not found: ${courseError?.message || 'Unknown error'}`);
  }

  // 2. Fetch lesson content
  let lessonsQuery = supabase
    .schema('api')
    .from('course_nodes')
    .select('id, title, content_payload, module_ref')
    .eq('course_id', courseId)
    .eq('user_id', userId);

  if (lessonIds && lessonIds.length > 0) {
    lessonsQuery = lessonsQuery.in('id', lessonIds);
  }

  const { data: lessons, error: lessonsError } = await lessonsQuery;

  if (lessonsError) {
    console.warn('[cheatsheetGenerator] Failed to fetch lessons:', lessonsError);
  }

  // 3. Optionally fetch weak topics from quiz performance
  let weakTopicsContext = '';
  if (includeWeakTopics) {
    try {
      const { data: incorrectQuestions } = await supabase
        .schema('api')
        .from('quiz_questions')
        .select('question, selected_answer')
        .eq('course_id', courseId)
        .eq('user_id', userId)
        .eq('status', 'incorrect')
        .limit(20);

      if (incorrectQuestions && incorrectQuestions.length > 0) {
        weakTopicsContext = `\n\nUSER'S WEAK AREAS (based on incorrect quiz answers):\n${incorrectQuestions.map(q => `- ${q.question}`).join('\n')}`;
      }
    } catch (err) {
      console.warn('[cheatsheetGenerator] Failed to fetch weak topics:', err.message);
    }
  }

  // 4. Build lesson content summary
  const lessonSummaries = (lessons || []).map(lesson => {
    const reading = lesson.content_payload?.reading || '';
    // Truncate long readings
    const truncatedReading = reading.length > 500 
      ? reading.substring(0, 500) + '...' 
      : reading;
    return `### ${lesson.title} (${lesson.module_ref || 'Module'})\n${truncatedReading}`;
  }).join('\n\n');

  // 5. Determine next cheatsheet number
  const existingFiles = await getCourseCheatsheetFiles(courseId, userId);
  const cheatsheetRegex = /_cheatsheet_(\d+)\.pdf$/;
  let maxNumber = 0;
  existingFiles.forEach(file => {
    const match = file.name.match(cheatsheetRegex);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNumber) maxNumber = num;
    }
  });
  const nextNumber = maxNumber + 1;

  // 6. Build prompts for LLM
  const systemPrompt = `
You are an expert study-guide creator. Your task is to create a highly compact, print-friendly cheat sheet for an undergraduate course.

${CHEATSHEET_LATEX_SPEC}

${CHEATSHEET_CONTENT_INSTRUCTIONS}

The cheat sheet should fit on 2 pages (front and back) in two-column format with 10pt font and 0.5in margins.
Prioritize high-yield content that would help a student quickly review before an exam.
`;

  const userPromptFull = `
COURSE: ${courseData.title}

USER'S INSTRUCTIONS:
${userPrompt}
${weakTopicsContext}

COURSE CONTENT TO SUMMARIZE:
${lessonSummaries || 'No specific lesson content available - create a general cheat sheet for the course topics.'}

${courseData.exam_details ? `\nEXAM FORMAT INFO:\n${courseData.exam_details}` : ''}

Generate the cheat sheet content now. Remember to output ONLY the LaTeX content block (no preamble, no document wrappers).
`;

  // 7. Call LLM to generate content (include any user-provided attachments)
  let { result } = await deps.callStageLLM({
    stage: STAGES.CHEATSHEET_GENERATOR,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPromptFull },
    ],
    attachments,
    maxTokens: 8192,
    requestTimeoutMs: 300000,
    userId,
    source: 'cheatsheet_generator',
    courseId,
    reasoning: { enabled: true, effort: 'medium' },
  });

  let contentBlock = sanitizeCheatsheetContent(result.content);
  let fullDocument = buildCheatsheetDocument(courseData.title, contentBlock);

  // 8. Compile to PDF with retry
  const MAX_COMPILE_RETRIES = 2;
  let pdfBuffer = null;
  let lastError = null;

  for (let i = 0; i <= MAX_COMPILE_RETRIES; i++) {
    try {
      console.log(`[cheatsheetGenerator] Compiling LaTeX (attempt ${i + 1}/${MAX_COMPILE_RETRIES + 1})...`);
      pdfBuffer = await compileLatexToPdf(fullDocument);
      console.log('[cheatsheetGenerator] Compilation successful!');
      break;
    } catch (err) {
      const errorSummary = extractLatexError(err);
      console.error(`[cheatsheetGenerator] Compilation failed (attempt ${i + 1}):`, errorSummary);
      lastError = err;

      if (i < MAX_COMPILE_RETRIES) {
        const fixPrompt = `The LaTeX compilation failed with this error:\n\n${errorSummary}\n\nPlease fix the content and regenerate. Remember to output ONLY valid LaTeX content for the cheat sheet body.`;

        const fixResult = await deps.callStageLLM({
          stage: STAGES.CHEATSHEET_GENERATOR,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPromptFull },
            { role: 'assistant', content: result.content },
            { role: 'user', content: fixPrompt },
          ],
          maxTokens: 8192,
          requestTimeoutMs: 300000,
          userId,
          source: 'cheatsheet_generator_fix',
          courseId,
          reasoning: { enabled: true, effort: 'medium' },
        });

        contentBlock = sanitizeCheatsheetContent(fixResult.result.content);
        fullDocument = buildCheatsheetDocument(courseData.title, contentBlock);
      }
    }
  }

  if (!pdfBuffer) {
    throw new Error(`Failed to compile cheatsheet after ${MAX_COMPILE_RETRIES + 1} attempts. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  // 9. Upload to storage
  const fileName = `cheatsheet_${nextNumber}.pdf`;
  const url = await uploadCheatsheetFile(courseId, userId, pdfBuffer, fileName, 'application/pdf');

  return { url, name: fileName, number: nextNumber };
}

/* -------------------------------------------------------------------------- */
/*  Public API: modifyCheatsheet                                              */
/* -------------------------------------------------------------------------- */

/**
 * Modifies an existing cheatsheet based on user prompt.
 *
 * @param {string} courseId
 * @param {string} userId
 * @param {number} cheatsheetNumber
 * @param {string} prompt - User's modification instructions
 * @param {Object} options - Additional options
 * @param {Array} options.attachments - Additional file attachments to include for context
 * @returns {Promise<{ url: string, name: string, number: number }>}
 */
export async function modifyCheatsheet(courseId, userId, cheatsheetNumber, prompt, options = {}) {
  const { attachments: userAttachments = [] } = options;

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('Modification prompt is required');
  }

  // 1. Download existing cheatsheet
  console.log(`[cheatsheetGenerator] Fetching existing cheatsheet #${cheatsheetNumber} for modification...`);
  const cheatsheetData = await downloadCheatsheetFile(courseId, userId, cheatsheetNumber);

  if (!cheatsheetData) {
    throw new Error(`Cheatsheet not found: cheatsheet #${cheatsheetNumber}`);
  }

  console.log(`[cheatsheetGenerator] Found cheatsheet: ${cheatsheetData.fileName}`);

  // 2. Fetch course info
  const supabase = getSupabase();
  
  const { data: courseData, error: courseError } = await supabase
    .schema('api')
    .from('courses')
    .select('title')
    .eq('id', courseId)
    .eq('user_id', userId)
    .single();

  if (courseError || !courseData) {
    throw new Error(`Course not found: ${courseError?.message || 'Unknown error'}`);
  }

  // 3. Build prompts for LLM
  const systemPrompt = `
You are an expert study-guide editor. Your task is to MODIFY an existing cheat sheet based on user instructions.

${CHEATSHEET_LATEX_SPEC}

${CHEATSHEET_CONTENT_INSTRUCTIONS}

IMPORTANT MODIFICATION RULES:
- You will receive the existing cheatsheet PDF as an attachment. Analyze its current content.
- Apply the user's requested modifications while preserving the overall structure.
- Keep the cheat sheet compact enough to fit on 2 pages (front and back).
- If the user asks to add content, you may need to condense other sections.
- If the user asks to remove content, expand remaining sections to fill space appropriately.
`;

  const userPromptFull = `
COURSE: ${courseData.title}
CHEATSHEET: #${cheatsheetNumber}

USER'S MODIFICATION REQUEST:
${prompt}

Analyze the attached PDF of the current cheatsheet and apply the requested modifications.
Generate the MODIFIED cheat sheet content now.
Remember to output ONLY the LaTeX content block (no preamble, no document wrappers).
`;

  // 4. Prepare attachments: existing PDF + any user-provided attachments
  const attachments = [
    {
      type: 'file',
      mimeType: 'application/pdf',
      data: cheatsheetData.buffer.toString('base64'),
      name: cheatsheetData.fileName,
    },
    ...userAttachments,
  ];

  // 5. Call LLM to generate modified content
  let { result } = await deps.callStageLLM({
    stage: STAGES.CHEATSHEET_GENERATOR,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPromptFull },
    ],
    attachments,
    maxTokens: 8192,
    requestTimeoutMs: 300000,
    userId,
    source: 'cheatsheet_modifier',
    courseId,
    reasoning: { enabled: true, effort: 'medium' },
  });

  let contentBlock = sanitizeCheatsheetContent(result.content);
  let fullDocument = buildCheatsheetDocument(courseData.title, contentBlock);

  // 6. Compile to PDF with retry
  const MAX_COMPILE_RETRIES = 2;
  let pdfBuffer = null;
  let lastError = null;

  for (let i = 0; i <= MAX_COMPILE_RETRIES; i++) {
    try {
      console.log(`[cheatsheetGenerator] Compiling modified LaTeX (attempt ${i + 1}/${MAX_COMPILE_RETRIES + 1})...`);
      pdfBuffer = await compileLatexToPdf(fullDocument);
      console.log('[cheatsheetGenerator] Compilation successful!');
      break;
    } catch (err) {
      const errorSummary = extractLatexError(err);
      console.error(`[cheatsheetGenerator] Compilation failed (attempt ${i + 1}):`, errorSummary);
      lastError = err;

      if (i < MAX_COMPILE_RETRIES) {
        const fixPrompt = `The LaTeX compilation failed with this error:\n\n${errorSummary}\n\nPlease fix the content and regenerate. Remember to output ONLY valid LaTeX content for the cheat sheet body.`;

        const fixResult = await deps.callStageLLM({
          stage: STAGES.CHEATSHEET_GENERATOR,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPromptFull },
            { role: 'assistant', content: result.content },
            { role: 'user', content: fixPrompt },
          ],
          attachments,
          maxTokens: 8192,
          requestTimeoutMs: 300000,
          userId,
          source: 'cheatsheet_modifier_fix',
          courseId,
          reasoning: { enabled: true, effort: 'medium' },
        });

        contentBlock = sanitizeCheatsheetContent(fixResult.result.content);
        fullDocument = buildCheatsheetDocument(courseData.title, contentBlock);
      }
    }
  }

  if (!pdfBuffer) {
    throw new Error(`Failed to compile modified cheatsheet after ${MAX_COMPILE_RETRIES + 1} attempts. Last error: ${lastError?.message || 'Unknown error'}`);
  }

  // 7. Delete old cheatsheet and upload new one
  console.log(`[cheatsheetGenerator] Deleting old cheatsheet: ${cheatsheetData.fileName}`);
  const deleteResult = await deleteCheatsheetFile(courseId, userId, cheatsheetNumber);
  if (!deleteResult.success) {
    console.warn(`[cheatsheetGenerator] Warning: Failed to delete old cheatsheet: ${deleteResult.error}`);
  }

  // 8. Upload modified PDF
  const fileName = `cheatsheet_${cheatsheetNumber}.pdf`;
  const url = await uploadCheatsheetFile(courseId, userId, pdfBuffer, fileName, 'application/pdf');

  console.log(`[cheatsheetGenerator] Modified cheatsheet saved: ${fileName}`);
  return { url, name: fileName, number: cheatsheetNumber };
}
