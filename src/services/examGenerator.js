// examGenerator.js

import { join } from 'path';
import { tmpdir } from 'os';
import { getCourseExamFiles, uploadExamFile, downloadExamFile, deleteExamFile } from './storage.js';
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
/*  LaTeX environment + generation constraints                                */
/* -------------------------------------------------------------------------- */

const LATEX_ENV_SPEC = `
LATEX ENVIRONMENT SPECIFICATION:
- Engine: pdfLaTeX only.
- Document class: exam (we supply the preamble and document skeleton).
- Packages available: amsmath, amssymb, amsthm, mathtools, geometry, hyperref,
  xcolor, enumitem, array, tabularx, multirow, multicol, booktabs, float,
  caption, exam.
- STRICTLY FORBIDDEN: tikz, circuitikz, minted, shell-escape, external files
  (\\\\includegraphics, \\\\input), custom graphics libraries, XeLaTeX/LuaLaTeX features.
- CONSTRAINTS: Use only exam class + basic math/tabular environments.
  NO advanced graphics, NO custom TikZ keys, NO "start chain" or similar constructs.
- Diagrams or figures must be described in text or simple tables only.
`;

const QUESTION_BLOCK_INSTRUCTIONS = `
OUTPUT SHAPE (CRITICAL):

- You MUST output ONLY the LaTeX that belongs INSIDE an exam's questions block.
- Do NOT output:
  * \\\\documentclass, \\\\usepackage, \\\\begin{document}, \\\\end{document}
  * \\\\begin{questions} or \\\\end{questions}
  * Headers, title pages, or any preamble.
- We will wrap your output inside a fixed LaTeX template using the "exam" class.

QUESTION & LIST STRUCTURE:

- Use \\\\question for EVERY main question.
- If a question has subparts, wrap them as:

  \\\\begin{parts}
    \\\\part[points] ...
    \\\\part[points] ...
  \\\\end{parts}

- For enumerate/itemize/description environments:
  * ALWAYS include at least one \\\\item.
  * Do NOT place plain text directly in the environment before the first \\\\item.
  * Do NOT leave these environments empty.

- For the exam class:
  * Inside \\\\begin{parts}...\\\\end{parts}, ALWAYS use \\\\part; do not leave it empty.
  * Do not put plain text directly inside "parts" without \\\\part.

Return ONLY the raw LaTeX question block, with no Markdown code fences and no explanation.
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
/*  Sanity check: pdflatex availability                                       */
/* -------------------------------------------------------------------------- */

async function checkPdfLatexAvailability() {
  try {
    await execAsync('pdflatex --version');
    console.log('[examGenerator] pdflatex is available.');
  } catch (error) {
    console.warn(
      '[examGenerator] WARNING: pdflatex NOT found. LaTeX compilation will likely fail.',
      error.message,
    );
  }
}

// Run sanity check on module load
checkPdfLatexAvailability();

/* -------------------------------------------------------------------------- */
/*  Helpers: sanitize / strip unsupported constructs                          */
/* -------------------------------------------------------------------------- */

function stripUnsupportedConstructs(code) {
  let cleaned = code;

  // Remove forbidden \usepackage imports
  for (const pkg of FORBIDDEN_PACKAGES) {
    const regex = new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{${pkg}\\}`, 'gi');
    cleaned = cleaned.replace(regex, `% REMOVED: unsupported package ${pkg}`);
  }

  // Remove forbidden constructs
  for (const pattern of FORBIDDEN_CONSTRUCTS) {
    cleaned = cleaned.replace(pattern, '% REMOVED: unsupported construct');
  }

  // Remove tikzpicture / circuitikz environments entirely
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
 * Sanitize the LLM output that is supposed to be ONLY the questions block.
 */
function sanitizeQuestionBlock(raw) {
  let text = raw;

  // If some model returns content as array parts, flatten
  if (Array.isArray(text)) {
    text = text
      .map((part) => (typeof part === 'string' ? part : part?.text || ''))
      .join('\n');
  }

  let clean = (text || '')
    .replace(/^```latex\s*/i, '')
    .replace(/^```tex\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  clean = stripUnsupportedConstructs(clean);
  return clean;
}

/* -------------------------------------------------------------------------- */
/*  Semantic checks: environment matching + list/parts checks                 */
/* -------------------------------------------------------------------------- */

function checkEnvironmentMatching(code) {
  const mismatches = [];

  const beginMatches = [...code.matchAll(/\\begin\{([^}]+)\}/g)];
  const endMatches = [...code.matchAll(/\\end\{([^}]+)\}/g)];

  const beginCounts = {};
  const endCounts = {};

  for (const match of beginMatches) {
    const env = match[1];
    beginCounts[env] = (beginCounts[env] || 0) + 1;
  }
  for (const match of endMatches) {
    const env = match[1];
    endCounts[env] = (endCounts[env] || 0) + 1;
  }

  const allEnvs = new Set([...Object.keys(beginCounts), ...Object.keys(endCounts)]);
  for (const env of allEnvs) {
    const b = beginCounts[env] || 0;
    const e = endCounts[env] || 0;
    if (b !== e) {
      mismatches.push(`Environment '${env}': ${b} begin, ${e} end`);
    }
  }

  return mismatches;
}

/**
 * Check list-like environments for missing \item / \part / \question.
 */
function checkListEnvs(code) {
  const issues = [];

  const envBlock = (name) => new RegExp(`\\\\begin\\{${name}\\}([\\s\\S]*?)\\\\end\\{${name}\\}`, 'g');

  // enumerate/itemize/description -> expect \item
  for (const env of ['enumerate', 'itemize', 'description']) {
    const re = envBlock(env);
    let m;
    while ((m = re.exec(code)) !== null) {
      const body = m[1] || '';
      if (!/\\item\b/.test(body)) {
        issues.push(
          `Environment '${env}' has no \\item; LaTeX will raise "Something's wrong--perhaps a missing \\item".`,
        );
      }
    }
  }

  // exam class: parts -> expect \part
  {
    const re = envBlock('parts');
    let m;
    while ((m = re.exec(code)) !== null) {
      const body = m[1] || '';
      if (!/\\part\b/.test(body)) {
        issues.push(
          `Environment 'parts' has no \\part; LaTeX will raise a "missing \\item" style error.`,
        );
      }
    }
  }

  // exam class: questions -> expect \question
  {
    const re = envBlock('questions');
    let m;
    while ((m = re.exec(code)) !== null) {
      const body = m[1] || '';
      if (!/\\question\b/.test(body)) {
        issues.push(
          `Environment 'questions' has no \\question; this is likely invalid exam LaTeX.`,
        );
      }
    }
  }

  return issues;
}

/**
 * High-level semantic checks on the full LaTeX document.
 */
function checkSemanticIssues(code) {
  const issues = [];

  // Simple placeholder checks
  if (code.includes('[INSERT')) issues.push('Found placeholder like [INSERT...].');
  if (code.includes('TODO:')) issues.push('Found TODO comment.');

  // Forbidden packages that slipped through
  for (const pkg of FORBIDDEN_PACKAGES) {
    const regex = new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{${pkg}\\}`, 'i');
    if (regex.test(code)) {
      issues.push(`Forbidden package detected in preamble: ${pkg}.`);
    }
  }

  // Overall begin/end count
  const beginCount = (code.match(/\\begin\{/g) || []).length;
  const endCount = (code.match(/\\end\{/g) || []).length;
  if (beginCount !== endCount) {
    issues.push(`Mismatched begin/end count (${beginCount} begin vs ${endCount} end).`);
  }

  // Per-environment matching
  const envMismatches = checkEnvironmentMatching(code);
  if (envMismatches.length > 0) {
    issues.push(...envMismatches.map((m) => `Environment mismatch: ${m}`));
  }

  // List/parts specific checks
  issues.push(...checkListEnvs(code));

  return issues;
}

/**
 * Optional auto-patch: fill empty list/parts environments with a dummy item,
 * so LaTeX doesn't crash with "missing \item".
 */
function autoFillEmptyLists(questionsBlock) {
  let out = questionsBlock;

  // enumerate/itemize/description
  out = out.replace(
    /\\begin\{(enumerate|itemize|description)\}([\s\S]*?)\\end\{\1\}/g,
    (match, envName, body) => {
      if (/\\item\b/.test(body)) return match;
      return `\\begin{${envName}}
\\item [Placeholder] Auto-inserted item because the environment was empty.
\\end{${envName}}`;
    },
  );

  // parts
  out = out.replace(/\\begin\{parts\}([\s\S]*?)\\end\{parts\}/g, (match, body) => {
    if (/\\part\b/.test(body)) return match;
    return `\\begin{parts}
\\part[0] Placeholder part auto-inserted to avoid LaTeX errors.
\\end{parts}`;
  });

  return out;
}

/* -------------------------------------------------------------------------- */
/*  Build full exam document from questions block                             */
/* -------------------------------------------------------------------------- */

function buildExamDocument(examType, questionsBlock, customExamName) {
  const examDisplayName = customExamName ||
    (examType === 'midterm' ? 'Midterm Practice Examination' : 'Final Practice Examination');

  return `
\\documentclass[11pt,addpoints]{exam}
\\usepackage[utf8]{inputenc}
\\usepackage[margin=1in]{geometry}
\\usepackage{amsmath,amssymb,amsthm}
\\usepackage{enumitem}
\\usepackage{array}
\\usepackage{booktabs}

% Course information macros (override if desired)
\\newcommand{\\courseName}{Practice Course}
\\newcommand{\\examName}{${examDisplayName}}
\\newcommand{\\term}{Practice Term}
\\newcommand{\\profName}{Generated Exam}

% Header and footer
\\pagestyle{headandfoot}
\\firstpageheader{\\courseName}{\\examName}{\\term}
\\runningheader{\\courseName}{\\examName}{\\term}
\\firstpagefooter{}{Page \\thepage\\ of \\numpages}{}
\\runningfooter{}{Page \\thepage\\ of \\numpages}{}

\\begin{document}

\\begin{center}
  \\fbox{\\fbox{\\parbox{5.5in}{\\centering
  \\textbf{\\Large \\examName} \\\\
  \\vspace{0.1in}
  \\textbf{Instructions:}
  \\begin{itemize}[leftmargin=*]
    \\item Answer all questions in the space provided.
    \\item Show all work for full credit.
    \\item This is a practice exam generated automatically.
  \\end{itemize}
  }}}
\\end{center}

\\vspace{0.2in}
\\makebox[0.5\\textwidth]{Name:\\enspace\\hrulefill}
\\hfill
\\makebox[0.4\\textwidth]{Student ID:\\enspace\\hrulefill}

\\vspace{0.2in}
\\begin{center}
  \\gradetable[h][questions]
\\end{center}
\\vspace{0.2in}
\\hrule
\\vspace{0.2in}

\\begin{questions}
${questionsBlock}
\\end{questions}

\\end{document}
`;
}

/* -------------------------------------------------------------------------- */
/*  Error extraction from LaTeX log                                           */
/* -------------------------------------------------------------------------- */

function extractLatexError(error) {
  const message = error.message || String(error);
  const MAX_ERROR_LENGTH = 500;
  if (message.length > MAX_ERROR_LENGTH) {
    return message.substring(0, MAX_ERROR_LENGTH) + '\n...[truncated]';
  }
  return message;
}

/* -------------------------------------------------------------------------- */
/*  Compilation via node-latex                                                */
/* -------------------------------------------------------------------------- */

/**
 * Compiles LaTeX to PDF using multiple pdflatex passes in a persistent temp directory
 * so that exam.cls can resolve \gradetable, \numpages, etc.
 * 
 * The key insight: node-latex creates isolated temp directories for each run, which
 * prevents .aux file reuse between passes. We use pdflatex directly with a persistent
 * working directory to ensure auxiliary files are shared across all passes.
 * 
 * @param {string} latexCode
 * @returns {Promise<Buffer>} PDF buffer
 */
async function compileLatexToPdf(latexCode) {
  const fs = await import('fs/promises');
  const path = await import('path');
  
  const timestamp = Date.now();
  const workDir = join(tmpdir(), `exam_workdir_${timestamp}`);
  const texPath = join(workDir, 'exam.tex');
  const pdfPath = join(workDir, 'exam.pdf');
  const logPath = join(workDir, 'exam.log');

  try {
    // Create persistent working directory
    await fs.mkdir(workDir, { recursive: true });
    
    // Write the .tex file
    await fs.writeFile(texPath, latexCode, 'utf8');

    // Run pdflatex 3 times in the same directory to resolve all references
    // -interaction=nonstopmode prevents pdflatex from stopping on errors
    // -halt-on-error exits with error code on compilation failure
    const pdflatexCmd = `pdflatex -interaction=nonstopmode -output-directory="${workDir}" "${texPath}"`;
    
    for (let pass = 1; pass <= 3; pass++) {
      console.log(`[examGenerator] Starting LaTeX compilation pass ${pass}/3...`);
      try {
        await execAsync(pdflatexCmd, { 
          cwd: workDir,
          timeout: 60000, // 60 second timeout per pass
        });
      } catch (passError) {
        // pdflatex may exit with error code even for warnings; check if PDF was created
        const pdfExists = await fs.access(pdfPath).then(() => true).catch(() => false);
        if (!pdfExists && pass === 3) {
          // Only throw on final pass if no PDF was generated
          throw passError;
        }
        console.log(`[examGenerator] Pass ${pass} completed with warnings (PDF may still be valid)`);
      }
    }

    // Check if PDF was successfully created
    const pdfExists = await fs.access(pdfPath).then(() => true).catch(() => false);
    if (!pdfExists) {
      throw new Error('PDF file was not generated after all compilation passes');
    }

    const buffer = await fs.readFile(pdfPath);
    console.log('[examGenerator] Compilation successful!');

    // Cleanup working directory
    await cleanupDir(workDir);

    return buffer;
  } catch (err) {
    // On error, try to extract a useful message from the log file
    let detailedError = err.message;
    try {
      const logContent = await fs.readFile(logPath, 'utf8');
      const lines = logContent.split('\n');
      const errorLines = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.startsWith('!')) {
          errorLines.push(line);
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
      console.warn('[examGenerator] Could not read LaTeX log file:', readErr.message);
    }
    
    // Cleanup working directory even on error
    await cleanupDir(workDir);

    throw new Error(detailedError);
  }
}

/**
 * Helper to recursively clean up a directory
 */
async function cleanupDir(dirPath) {
  const fs = await import('fs/promises');
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[examGenerator] Failed to cleanup temp directory ${dirPath}:`, e.message);
  }
}

/* -------------------------------------------------------------------------- */
/*  Public API: generatePracticeExam                                          */
/* -------------------------------------------------------------------------- */

/**
 * Generates a practice exam for a course based on provided lessons and existing exam examples.
 *
 * @param {string} courseId
 * @param {string} userId
 * @param {string[]} lessons
 * @param {'midterm' | 'final'} examType
 * @returns {Promise<{ url: string, name: string, number: number }>}
 */
export async function generatePracticeExam(courseId, userId, lessons, examType) {
  if (!Array.isArray(lessons) || lessons.length === 0) {
    throw new Error('Lessons list is required and cannot be empty');
  }

  if (!['midterm', 'final'].includes(examType)) {
    throw new Error('Exam type must be either "midterm" or "final"');
  }

  // 1. Fetch existing practice exams to determine the next number
  const existingExams = await getCourseExamFiles(courseId, userId);

  // 1b. Fetch exam details from the database
  const supabase = getSupabase();
  let examDetails = '';
  try {
    const { data: courseData, error: courseError } = await supabase
      .schema('api')
      .from('courses')
      .select('exam_details, title')
      .eq('id', courseId)
      .eq('user_id', userId)
      .single();

    if (!courseError && courseData?.exam_details) {
      examDetails = courseData.exam_details;
      console.log(`[examGenerator] Found exam details for course "${courseData.title}": ${examDetails.length} chars`);
    }
  } catch (err) {
    console.warn('[examGenerator] Failed to fetch exam details from database:', err.message);
  }

  // Filter for exams of the same type and find the max number
  // Expected format: [timestamp]_[type]_exam_[number].pdf
  // But we also need to support the legacy format: [timestamp]_[type]_exam.pdf (treat as #1)

  let maxNumber = 0;
  const typeRegex = new RegExp(`_${examType}_exam(?:_(\\d+))?\\.pdf$`);

  existingExams.forEach(file => {
    const match = file.name.match(typeRegex);
    if (match) {
      const num = match[1] ? parseInt(match[1], 10) : 1;
      if (num > maxNumber) maxNumber = num;
    }
  });

  const nextNumber = maxNumber + 1;
  const examDisplayName =
    examType === 'midterm'
      ? `Midterm Practice Examination ${nextNumber}`
      : `Final Practice Examination ${nextNumber}`;

  // Attachments for style reference (use all previous exams of this type)
  const attachments = existingExams
    .filter(e => e.name.includes(`${examType}_exam`))
    .map((exam) => ({
      url: exam.url,
      name: exam.name,
      mimeType: 'application/pdf',
    }));

  // Build exam format context from database if available
  const examFormatContext = examDetails
    ? `\n\nEXAM FORMAT DETAILS (from professor/syllabus - MATCH THIS STYLE):\n${examDetails}\n`
    : '';

  // 2. System & user prompts (LLM outputs ONLY the questions block)
  const systemPrompt = `
You are an expert academic exam creator. Your task is to create a high-quality ${examType} practice exam (Exam #${nextNumber}) in LaTeX for an undergraduate course.
${examFormatContext}
${LATEX_ENV_SPEC}

${QUESTION_BLOCK_INSTRUCTIONS}
`;

  const userPrompt = `Lessons to cover:
${lessons.map((l) => `- ${l}`).join('\n')}

Generate the ${examType} exam questions now. Remember:
- ONLY output the LaTeX for the questions block (no preamble, no \\documentclass, no \\begin{document}).
- Use \\question and optional \\begin{parts}...\\part...\\end{parts}.
- No TikZ, no graphics, only basic LaTeX constructs.${examDetails ? '\n- Follow the exam format details provided above (time limit, question types, point distribution, etc.).' : ''}
`;

  // 3. Initial generation: questions block only
  let { result } = await deps.callStageLLM({
    stage: STAGES.EXAM_GENERATOR,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    attachments,
    maxTokens: 8192,
    allowWeb: true,
    requestTimeoutMs: 600000, // 10m
    userId,
    source: 'exam_generator',
    courseId,
    reasoning: { enabled: true, effort: 'high' },
  });

  let questionsBlock = sanitizeQuestionBlock(result.content);
  // Pass the specific display name to the builder
  let fullExam = buildExamDocument(examType, questionsBlock, examDisplayName);

  // 4. Pre-compile semantic repair (one pass)
  let semanticIssues = checkSemanticIssues(fullExam);
  if (semanticIssues.length > 0) {
    console.log('[examGenerator] Found semantic issues, attempting repair:', semanticIssues);

    const repairPrompt = `The generated LaTeX QUESTIONS BLOCK has the following issues:
${semanticIssues.join('\n')}

Please fix these issues and regenerate ONLY the valid LaTeX QUESTIONS BLOCK (content that goes inside \\begin{questions}...\\end{questions}).

CRITICAL REMINDERS:
${LATEX_ENV_SPEC}

${QUESTION_BLOCK_INSTRUCTIONS}

Return the FULL corrected questions block, with no preamble or document wrappers.`;

    const repairResult = await deps.callStageLLM({
      stage: STAGES.EXAM_GENERATOR,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: result.content },
        { role: 'user', content: repairPrompt },
      ],
      maxTokens: 8192,
      requestTimeoutMs: 600000,
      userId,
      source: 'exam_generator_repair',
      courseId,
      reasoning: { enabled: true, effort: 'high' },
    });

    questionsBlock = sanitizeQuestionBlock(repairResult.result.content);
    fullExam = buildExamDocument(examType, questionsBlock, examDisplayName);

    semanticIssues = checkSemanticIssues(fullExam);
    if (semanticIssues.length > 0) {
      console.warn('[examGenerator] Semantic issues persist after repair:', semanticIssues);
      // continue; compilation + repair loop will be final arbiter
    }
  }

  // 5. Compilation & repair loop
  const MAX_COMPILE_RETRIES = 2;
  let pdfBuffer = null;
  let lastError = null;
  const compilationErrors = [];

  for (let i = 0; i <= MAX_COMPILE_RETRIES; i++) {
    try {
      const safeQuestionsBlock = autoFillEmptyLists(questionsBlock);
      const latexToCompile = buildExamDocument(examType, safeQuestionsBlock, examDisplayName);

      console.log(
        `[examGenerator] Compiling LaTeX (attempt ${i + 1}/${MAX_COMPILE_RETRIES + 1})...`,
      );
      pdfBuffer = await compileLatexToPdf(latexToCompile);
      console.log('[examGenerator] Compilation successful!');
      break;
    } catch (err) {
      const errorSummary = extractLatexError(err);
      console.error(`[examGenerator] Compilation failed (attempt ${i + 1}):`, errorSummary);
      lastError = err;
      compilationErrors.push({ attempt: i + 1, error: errorSummary });

      if (i < MAX_COMPILE_RETRIES) {
        // Build a targeted repair prompt
        let errorPrompt = `The LaTeX compilation failed with the following error:

${errorSummary}

You must FIX the QUESTIONS BLOCK so that, when inserted inside the exam template, the document compiles.

CRITICAL REMINDERS:
${LATEX_ENV_SPEC}

${QUESTION_BLOCK_INSTRUCTIONS}
`;

        // If it's the classic "missing \item" error, give extra hints and static findings
        if (/perhaps a missing \\item/i.test(errorSummary)) {
          const currentFullExam = buildExamDocument(examType, questionsBlock, examDisplayName);
          const listIssues = checkListEnvs(currentFullExam);

          errorPrompt += `

HINT: This error usually means a list-like environment is malformed:
- An enumerate/itemize/description without any \\\\item, or
- A parts environment without any \\\\part, or
- A questions environment without any \\\\question.

Detected potential list/parts issues:
${listIssues.length ? listIssues.join('\n') : '(none detected by static check)'}

Carefully inspect ALL 'enumerate', 'itemize', 'description', 'parts', and 'questions' environments in your QUESTIONS BLOCK.
Ensure each contains the proper commands and no environment is left empty.
`;
        }

        const fixResult = await deps.callStageLLM({
          stage: STAGES.EXAM_GENERATOR,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: questionsBlock }, // context: previous questions block
            { role: 'user', content: errorPrompt },
          ],
          maxTokens: 8192,
          requestTimeoutMs: 600000,
          userId,
          source: 'exam_generator_fix',
          courseId,
          reasoning: { enabled: true, effort: 'high' },
        });

        questionsBlock = sanitizeQuestionBlock(fixResult.result.content);
        // loop continues; autoFillEmptyLists + compile will run again
      }
    }
  }

  if (!pdfBuffer) {
    const errorReport = {
      message: `Failed to compile exam after ${MAX_COMPILE_RETRIES + 1} attempts`,
      attempts: compilationErrors,
      lastError: lastError?.message,
      suggestion:
        'The LaTeX code could not be compiled. This may be due to unsupported constructs or syntax errors. Please try regenerating the exam or contact support.',
    };

    console.error('[examGenerator] Final error report:', JSON.stringify(errorReport, null, 2));
    throw new Error(
      `${errorReport.message}. Last error: ${errorReport.lastError || 'Unknown error'}`,
    );
  }

  // 6. Save PDF with numbered filename
  const fileName = `${examType}_exam_${nextNumber}.pdf`;
  const url = await uploadExamFile(courseId, userId, pdfBuffer, fileName, 'application/pdf');

  return { url, name: fileName, number: nextNumber };
}

/* -------------------------------------------------------------------------- */
/*  Public API: modifyPracticeExam                                            */
/* -------------------------------------------------------------------------- */

/**
 * Modifies an existing practice exam based on a user prompt.
 *
 * @param {string} courseId
 * @param {string} userId
 * @param {'midterm' | 'final'} examType
 * @param {number} examNumber
 * @param {string} prompt - User's modification instructions
 * @returns {Promise<{ url: string, name: string, number: number }>}
 */
export async function modifyPracticeExam(courseId, userId, examType, examNumber, prompt) {
  if (!['midterm', 'final'].includes(examType)) {
    throw new Error('Exam type must be either "midterm" or "final"');
  }

  if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
    throw new Error('Modification prompt is required');
  }

  // 1. Download the existing exam PDF
  console.log(`[examGenerator] Fetching existing ${examType} exam #${examNumber} for modification...`);
  const examData = await downloadExamFile(courseId, userId, examType, examNumber);

  if (!examData) {
    throw new Error(`Exam not found: ${examType} exam #${examNumber}`);
  }

  console.log(`[examGenerator] Found exam file: ${examData.fileName} (${(examData.buffer.length / 1024).toFixed(2)} KB)`);

  // 1b. Fetch exam details from the database for context
  const supabase = getSupabase();
  let examDetails = '';
  try {
    const { data: courseData, error: courseError } = await supabase
      .schema('api')
      .from('courses')
      .select('exam_details, title')
      .eq('id', courseId)
      .eq('user_id', userId)
      .single();

    if (!courseError && courseData?.exam_details) {
      examDetails = courseData.exam_details;
      console.log(`[examGenerator] Found exam details for course "${courseData.title}": ${examDetails.length} chars`);
    }
  } catch (err) {
    console.warn('[examGenerator] Failed to fetch exam details from database:', err.message);
  }

  const examDisplayName =
    examType === 'midterm'
      ? `Midterm Practice Examination ${examNumber}`
      : `Final Practice Examination ${examNumber}`;

  // Build exam format context from database if available
  const examFormatContext = examDetails
    ? `\n\nEXAM FORMAT DETAILS (from professor/syllabus - maintain this style):\n${examDetails}\n`
    : '';

  // 2. Create prompt for modification
  const systemPrompt = `
You are an expert academic exam editor. Your task is to MODIFY an existing ${examType} practice exam (Exam #${examNumber}) based on user instructions.
${examFormatContext}
${LATEX_ENV_SPEC}

${QUESTION_BLOCK_INSTRUCTIONS}

IMPORTANT MODIFICATION RULES:
- You will receive the existing exam PDF as an attachment. Analyze its current content.
- Apply the user's requested modifications while preserving the overall exam structure.
- Maintain the same general difficulty level unless the user explicitly requests a change.
- Keep the same topic coverage unless the user explicitly requests changes.
- If the user asks to make questions "easier" or "harder", adjust complexity appropriately.
- If the user asks to add/remove questions, do so while maintaining exam coherence.
`;

  const userPrompt = `Current exam: "${examDisplayName}"

USER'S MODIFICATION REQUEST:
${prompt}

Analyze the attached PDF of the current exam and apply the requested modifications.
Generate the MODIFIED questions block that incorporates these changes.
Remember:
- ONLY output the LaTeX for the questions block (no preamble, no \\documentclass, no \\begin{document}).
- Use \\question and optional \\begin{parts}...\\part...\\end{parts}.
- No TikZ, no graphics, only basic LaTeX constructs.
`;

  // Prepare attachment with the existing exam PDF
  const attachments = [
    {
      type: 'file',
      mimeType: 'application/pdf',
      data: examData.buffer.toString('base64'),
      name: examData.fileName,
    },
  ];

  // 3. Call LLM to generate modified exam content
  let { result } = await deps.callStageLLM({
    stage: STAGES.EXAM_GENERATOR,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    attachments,
    maxTokens: 8192,
    allowWeb: false,
    requestTimeoutMs: 600000, // 10m
    userId,
    source: 'exam_modifier',
    courseId,
    reasoning: { enabled: true, effort: 'high' },
  });

  let questionsBlock = sanitizeQuestionBlock(result.content);
  let fullExam = buildExamDocument(examType, questionsBlock, examDisplayName);

  // 4. Pre-compile semantic repair (one pass)
  let semanticIssues = checkSemanticIssues(fullExam);
  if (semanticIssues.length > 0) {
    console.log('[examGenerator] Found semantic issues in modified exam, attempting repair:', semanticIssues);

    const repairPrompt = `The modified LaTeX QUESTIONS BLOCK has the following issues:
${semanticIssues.join('\n')}

Please fix these issues and regenerate ONLY the valid LaTeX QUESTIONS BLOCK (content that goes inside \\begin{questions}...\\end{questions}).

CRITICAL REMINDERS:
${LATEX_ENV_SPEC}

${QUESTION_BLOCK_INSTRUCTIONS}

Return the FULL corrected questions block, with no preamble or document wrappers.`;

    const repairResult = await deps.callStageLLM({
      stage: STAGES.EXAM_GENERATOR,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: result.content },
        { role: 'user', content: repairPrompt },
      ],
      maxTokens: 8192,
      requestTimeoutMs: 600000,
      userId,
      source: 'exam_modifier_repair',
      courseId,
      reasoning: { enabled: true, effort: 'high' },
    });

    questionsBlock = sanitizeQuestionBlock(repairResult.result.content);
    fullExam = buildExamDocument(examType, questionsBlock, examDisplayName);

    semanticIssues = checkSemanticIssues(fullExam);
    if (semanticIssues.length > 0) {
      console.warn('[examGenerator] Semantic issues persist after repair:', semanticIssues);
    }
  }

  // 5. Compilation & repair loop
  const MAX_COMPILE_RETRIES = 2;
  let pdfBuffer = null;
  let lastError = null;
  const compilationErrors = [];

  for (let i = 0; i <= MAX_COMPILE_RETRIES; i++) {
    try {
      const safeQuestionsBlock = autoFillEmptyLists(questionsBlock);
      const latexToCompile = buildExamDocument(examType, safeQuestionsBlock, examDisplayName);

      console.log(
        `[examGenerator] Compiling modified LaTeX (attempt ${i + 1}/${MAX_COMPILE_RETRIES + 1})...`,
      );
      pdfBuffer = await compileLatexToPdf(latexToCompile);
      console.log('[examGenerator] Compilation successful!');
      break;
    } catch (err) {
      const errorSummary = extractLatexError(err);
      console.error(`[examGenerator] Compilation failed (attempt ${i + 1}):`, errorSummary);
      lastError = err;
      compilationErrors.push({ attempt: i + 1, error: errorSummary });

      if (i < MAX_COMPILE_RETRIES) {
        let errorPrompt = `The LaTeX compilation failed with the following error:

${errorSummary}

You must FIX the QUESTIONS BLOCK so that, when inserted inside the exam template, the document compiles.

CRITICAL REMINDERS:
${LATEX_ENV_SPEC}

${QUESTION_BLOCK_INSTRUCTIONS}
`;

        if (/perhaps a missing \\item/i.test(errorSummary)) {
          const currentFullExam = buildExamDocument(examType, questionsBlock, examDisplayName);
          const listIssues = checkListEnvs(currentFullExam);

          errorPrompt += `

HINT: This error usually means a list-like environment is malformed:
- An enumerate/itemize/description without any \\\\item, or
- A parts environment without any \\\\part, or
- A questions environment without any \\\\question.

Detected potential list/parts issues:
${listIssues.length ? listIssues.join('\n') : '(none detected by static check)'}

Carefully inspect ALL 'enumerate', 'itemize', 'description', 'parts', and 'questions' environments in your QUESTIONS BLOCK.
Ensure each contains the proper commands and no environment is left empty.
`;
        }

        const fixResult = await deps.callStageLLM({
          stage: STAGES.EXAM_GENERATOR,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: questionsBlock },
            { role: 'user', content: errorPrompt },
          ],
          maxTokens: 8192,
          requestTimeoutMs: 600000,
          userId,
          source: 'exam_modifier_fix',
          courseId,
          reasoning: { enabled: true, effort: 'high' },
        });

        questionsBlock = sanitizeQuestionBlock(fixResult.result.content);
      }
    }
  }

  if (!pdfBuffer) {
    const errorReport = {
      message: `Failed to compile modified exam after ${MAX_COMPILE_RETRIES + 1} attempts`,
      attempts: compilationErrors,
      lastError: lastError?.message,
      suggestion:
        'The modified LaTeX code could not be compiled. Please try a simpler modification or contact support.',
    };

    console.error('[examGenerator] Final error report:', JSON.stringify(errorReport, null, 2));
    throw new Error(
      `${errorReport.message}. Last error: ${errorReport.lastError || 'Unknown error'}`,
    );
  }

  // 6. Delete the old exam file
  console.log(`[examGenerator] Deleting old exam file: ${examData.fileName}`);
  const deleteResult = await deleteExamFile(courseId, userId, examType, examNumber);
  if (!deleteResult.success) {
    console.warn(`[examGenerator] Warning: Failed to delete old exam file: ${deleteResult.error}`);
    // Continue anyway - we'll upload with a new timestamp which effectively replaces it
  }

  // 7. Save the modified PDF with the same exam number
  const fileName = `${examType}_exam_${examNumber}.pdf`;
  const url = await uploadExamFile(courseId, userId, pdfBuffer, fileName, 'application/pdf');

  console.log(`[examGenerator] Modified exam saved: ${fileName}`);
  return { url, name: fileName, number: examNumber };
}
