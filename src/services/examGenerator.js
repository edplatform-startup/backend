// examGenerator.js

import latex from 'node-latex';
import { Readable } from 'stream';
import { createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getCourseExamFiles, uploadExamFile } from './storage.js';
import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';

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

function buildExamDocument(examType, questionsBlock) {
  const examDisplayName =
    examType === 'midterm' ? 'Midterm Practice Examination' : 'Final Practice Examination';

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
 * Run one pdflatex pass using node-latex.
 * Keeps the .aux and .log files so that a second pass can use them.
 */
function runLatexOnce(latexCode, outputPath, logPath) {
  return new Promise((resolve, reject) => {
    const input = Readable.from([Buffer.from(latexCode)]);
    const output = createWriteStream(outputPath);

    const pdf = latex(input, { errorLogs: logPath });
    pdf.pipe(output);

    pdf.on('error', (err) => {
      reject(err);
    });

    pdf.on('finish', () => {
      resolve();
    });
  });
}

/**
 * Compiles LaTeX to PDF using two pdflatex passes so that exam.cls
 * can resolve \gradetable, \numpages, etc.
 * @param {string} latexCode
 * @returns {Promise<Buffer>} PDF buffer
 */
async function compileLatexToPdf(latexCode) {
  const timestamp = Date.now();
  const outputPath = join(tmpdir(), `exam_${timestamp}.pdf`);
  const logPath = join(tmpdir(), `exam_${timestamp}.log`);

  try {
    // Pass 1: Generate .aux and initial layout
    console.log('[examGenerator] Starting LaTeX compilation pass 1/3...');
    await runLatexOnce(latexCode, outputPath, logPath);

    // Pass 2: Resolve references, page numbers, and basic tables
    console.log('[examGenerator] Starting LaTeX compilation pass 2/3...');
    await runLatexOnce(latexCode, outputPath, logPath);

    // Pass 3: Finalize layout, grade tables, and complex references
    console.log('[examGenerator] Starting LaTeX compilation pass 3/3...');
    await runLatexOnce(latexCode, outputPath, logPath);

    const fs = await import('fs/promises');
    const buffer = await fs.readFile(outputPath);

    // Cleanup
    await fs.unlink(outputPath).catch(() => { });
    await fs.unlink(logPath).catch(() => { });

    return buffer;
  } catch (err) {
    // On error, try to extract a useful message from the log file
    let detailedError = err.message;
    try {
      const fs = await import('fs/promises');
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

      await fs.unlink(outputPath).catch(() => { });
      await fs.unlink(logPath).catch(() => { });
    } catch (readErr) {
      console.warn('[examGenerator] Could not read LaTeX log file:', readErr.message);
    }

    throw new Error(detailedError);
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
 * @returns {Promise<{ url: string, name: string }>}
 */
export async function generatePracticeExam(courseId, userId, lessons, examType) {
  if (!Array.isArray(lessons) || lessons.length === 0) {
    throw new Error('Lessons list is required and cannot be empty');
  }

  if (!['midterm', 'final'].includes(examType)) {
    throw new Error('Exam type must be either "midterm" or "final"');
  }

  // 1. Fetch existing practice exams as style references
  const existingExams = await getCourseExamFiles(courseId, userId);
  const attachments = existingExams.map((exam) => ({
    url: exam.url,
    name: exam.name,
    mimeType: 'application/pdf',
  }));

  // 2. System & user prompts (LLM outputs ONLY the questions block)
  const systemPrompt = `
You are an expert academic exam creator. Your task is to create a high-quality ${examType} practice exam in LaTeX for an undergraduate course.

${LATEX_ENV_SPEC}

${QUESTION_BLOCK_INSTRUCTIONS}
`;

  const userPrompt = `Lessons to cover:
${lessons.map((l) => `- ${l}`).join('\n')}

Generate the ${examType} exam questions now. Remember:
- ONLY output the LaTeX for the questions block (no preamble, no \\documentclass, no \\begin{document}).
- Use \\question and optional \\begin{parts}...\\part...\\end{parts}.
- No TikZ, no graphics, only basic LaTeX constructs.
`;

  // 3. Initial generation: questions block only
  let { result } = await callStageLLM({
    stage: STAGES.EXAM_GENERATOR,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    attachments,
    maxTokens: 8192,
    allowWeb: true,
    requestTimeoutMs: 600000, // 10m
  });

  let questionsBlock = sanitizeQuestionBlock(result.content);
  let fullExam = buildExamDocument(examType, questionsBlock);

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

    const repairResult = await callStageLLM({
      stage: STAGES.EXAM_GENERATOR,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: result.content },
        { role: 'user', content: repairPrompt },
      ],
      maxTokens: 8192,
      requestTimeoutMs: 600000,
    });

    questionsBlock = sanitizeQuestionBlock(repairResult.result.content);
    fullExam = buildExamDocument(examType, questionsBlock);

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
      const latexToCompile = buildExamDocument(examType, safeQuestionsBlock);

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
          const currentFullExam = buildExamDocument(examType, questionsBlock);
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

        const fixResult = await callStageLLM({
          stage: STAGES.EXAM_GENERATOR,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: questionsBlock }, // context: previous questions block
            { role: 'user', content: errorPrompt },
          ],
          maxTokens: 8192,
          requestTimeoutMs: 600000,
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

  // 6. Save PDF
  const fileName = `${examType}_exam.pdf`;
  const url = await uploadExamFile(courseId, userId, pdfBuffer, fileName, 'application/pdf');

  return { url, name: fileName };
}
