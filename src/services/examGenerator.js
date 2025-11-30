import latex from 'node-latex';
import { Readable } from 'stream';
import { createReadStream, createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlink, writeFile } from 'fs/promises';
import { getCourseExamFiles, uploadExamFile } from './storage.js';
import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';

import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const LATEX_ENV_SPEC = `
LATEX ENVIRONMENT SPECIFICATION:
- Engine: pdfLaTeX only.
- Classes: article, exam.
- Packages available: amsmath, amssymb, amsthm, mathtools, geometry, hyperref, xcolor, enumitem, array, tabularx, multirow, multicol, booktabs, float, caption, exam.
- STRICTLY FORBIDDEN: tikz, circuitikz, minted, shell-escape, external files (\\\\includegraphics, \\\\input), custom graphics libraries, XeLaTeX/LuaLaTeX features.
- CONSTRAINTS: Use only exam class + basic math/tabular environments. NO advanced graphics, NO custom TikZ keys, NO start chain or similar constructs.
- Keep diagrams and graphics to simple text-based representations or tables. If a visual is essential, describe it in text instead.
`;

const FORBIDDEN_PACKAGES = ['tikz', 'circuitikz', 'minted', 'pgfplots', 'graphicx'];
const FORBIDDEN_CONSTRUCTS = [
  /\\\\usetikzlibrary/gi,
  /\\\\tikz/gi,
  /\\\\begin\{tikzpicture\}/gi,
  /\\\\begin\{circuitikz\}/gi,
  /tikz\/start\s+chain/gi,
  /\\\\includegraphics/gi,
  /\\\\input\{/gi,
  /shell-escape/gi,
];

/**
 * Checks if pdflatex is available in the environment.
 */
async function checkPdfLatexAvailability() {
  try {
    await execAsync('pdflatex --version');
    console.log('[examGenerator] pdflatex is available.');
  } catch (error) {
    console.warn('[examGenerator] WARNING: pdflatex NOT found. LaTeX compilation will likely fail.', error.message);
  }
}

// Run sanity check on module load (or could be on first request)
checkPdfLatexAvailability();

/**
 * Strips forbidden TikZ and other unsupported LaTeX constructs.
 * @param {string} code 
 * @returns {string}
 */
function stripUnsupportedConstructs(code) {
  let cleaned = code;
  
  // Remove forbidden package imports
  for (const pkg of FORBIDDEN_PACKAGES) {
    const regex = new RegExp(`\\\\usepackage(?:\\[[^\\]]*\\])?\\{${pkg}\\}`, 'gi');
    cleaned = cleaned.replace(regex, `% REMOVED: unsupported package ${pkg}`);
  }
  
  // Remove forbidden constructs
  for (const pattern of FORBIDDEN_CONSTRUCTS) {
    cleaned = cleaned.replace(pattern, '% REMOVED: unsupported construct');
  }
  
  // Remove entire tikzpicture and circuitikz environments
  cleaned = cleaned.replace(/\\begin\{tikzpicture\}[\s\S]*?\\end\{tikzpicture\}/gi, '% REMOVED: tikzpicture environment not supported');
  cleaned = cleaned.replace(/\\begin\{circuitikz\}[\s\S]*?\\end\{circuitikz\}/gi, '% REMOVED: circuitikz environment not supported');
  
  return cleaned;
}

/**
 * Sanitizes LaTeX code by removing markdown blocks and common syntax errors.
 * @param {string} code 
 * @returns {string}
 */
function sanitizeLatex(code) {
  let clean = code
    .replace(/^```latex\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  // Strip unsupported constructs first
  clean = stripUnsupportedConstructs(clean);

  // Basic fixes
  // Ensure documentclass exists
  if (!clean.includes('\\documentclass')) {
    clean = '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{geometry}\n\\geometry{a4paper, margin=1in}\n\\begin{document}\n' + clean + '\n\\end{document}';
  }

  return clean;
}

/**
 * Checks for specific environment matching (ensures each environment type has matching begin/end).
 * @param {string} code 
 * @returns {string[]} List of mismatched environments
 */
function checkEnvironmentMatching(code) {
  const mismatches = [];
  
  // Extract all environment names
  const beginMatches = [...code.matchAll(/\\begin\{([^}]+)\}/g)];
  const endMatches = [...code.matchAll(/\\end\{([^}]+)\}/g)];
  
  // Count each environment type
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
  
  // Check for mismatches
  const allEnvs = new Set([...Object.keys(beginCounts), ...Object.keys(endCounts)]);
  for (const env of allEnvs) {
    const beginCount = beginCounts[env] || 0;
    const endCount = endCounts[env] || 0;
    if (beginCount !== endCount) {
      mismatches.push(`Environment '${env}': ${beginCount} begin, ${endCount} end`);
    }
  }
  
  return mismatches;
}

/**
 * Checks for semantic issues in LaTeX code.
 * @param {string} code 
 * @returns {string[]} List of issues found
 */
function checkSemanticIssues(code) {
  const issues = [];
  
  // Check for placeholders
  if (code.includes('[INSERT')) issues.push('Found placeholder like [INSERT...]');
  if (code.includes('TODO:')) issues.push('Found TODO comment');
  
  // Check for forbidden packages or constructs that slipped through
  for (const pkg of FORBIDDEN_PACKAGES) {
    if (code.includes(`\\usepackage{${pkg}}`)) {
      issues.push(`Forbidden package detected: ${pkg}`);
    }
  }
  
  // Check for overall begin/end count
  const beginCount = (code.match(/\\begin\{/g) || []).length;
  const endCount = (code.match(/\\end\{/g) || []).length;
  if (beginCount !== endCount) {
    issues.push(`Mismatched begin/end count (${beginCount} begin vs ${endCount} end)`);
  }
  
  // Check per-environment matching
  const envMismatches = checkEnvironmentMatching(code);
  if (envMismatches.length > 0) {
    issues.push(...envMismatches.map(m => `Environment mismatch: ${m}`));
  }
  
  return issues;
}

/**
 * Extracts relevant error info from LaTeX log/error message.
 * @param {Error} error 
 * @returns {string}
 */
function extractLatexError(error) {
  const message = error.message || String(error);
  
  // Truncate very long messages
  const MAX_ERROR_LENGTH = 500;
  if (message.length > MAX_ERROR_LENGTH) {
    return message.substring(0, MAX_ERROR_LENGTH) + '\n...[truncated]';
  }
  
  return message;
}

/**
 * Compiles LaTeX to PDF using node-latex.
 * @param {string} latexCode 
 * @returns {Promise<Buffer>} PDF buffer
 */
async function compileLatexToPdf(latexCode) {
  return new Promise((resolve, reject) => {
    const input = Readable.from([Buffer.from(latexCode)]);
    const outputPath = join(tmpdir(), `exam_${Date.now()}.pdf`);
    const output = createWriteStream(outputPath);
    const pdf = latex(input);

    pdf.pipe(output);
    pdf.on('error', (err) => {
      reject(err);
    });
    pdf.on('finish', async () => {
      try {
        // Read the file back into a buffer
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(outputPath);
        // Cleanup
        await fs.unlink(outputPath).catch(() => {});
        resolve(buffer);
      } catch (e) {
        reject(e);
      }
    });
  });
}

/**
 * Generates a practice exam for a course based on provided lessons and existing exam examples.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @param {string[]} lessons - List of lesson titles/descriptions to cover
 * @param {'midterm' | 'final'} examType - The type of exam to generate
 * @returns {Promise<{ url: string, name: string }>} The URL and name of the generated exam file
 */
export async function generatePracticeExam(courseId, userId, lessons, examType) {
  if (!lessons || !Array.isArray(lessons) || lessons.length === 0) {
    throw new Error('Lessons list is required and cannot be empty');
  }

  if (!['midterm', 'final'].includes(examType)) {
    throw new Error('Exam type must be either "midterm" or "final"');
  }

  // 1. Fetch existing practice exams
  const existingExams = await getCourseExamFiles(courseId, userId);
  
  const attachments = existingExams.map(exam => ({
    url: exam.url,
    name: exam.name,
    mimeType: 'application/pdf'
  }));
  
  // 2. Construct the prompt with strict constraints
  const systemPrompt = `You are an expert academic exam creator. Your task is to create a high-quality ${examType} exam in LaTeX format.
  
  ${LATEX_ENV_SPEC}
  
  CRITICAL CONSTRAINTS - MUST FOLLOW:
  - DO NOT use TikZ, circuitikz, or any graphics packages
  - DO NOT use \\includegraphics or external file references
  - DO NOT use custom libraries or advanced constructs
  - ONLY use basic exam class with mathematical and tabular environments
  - If diagrams are needed, describe them in text or use simple ASCII art/tables
  
  INPUTS:
  1. A list of lessons to cover.
  2. Attached existing practice exams (use these as strict references for FORMAT, STYLE, DIFFICULTY, and QUESTION TYPES).
  
  INSTRUCTIONS:
  - Create a complete ${examType} exam covering the specified lessons.
  - STRICTLY ADHERE to the formatting and style of the attached existing exams.
  - Output ONLY the raw LaTeX code.
  - Ensure the LaTeX is compilable with pdfLaTeX (include preamble, document class, etc.).
  - Do NOT use placeholders like [INSERT IMAGE] or TODOs.
  - Use only the allowed packages listed in the specification.
  `;

  const userPrompt = `Lessons to cover:
  ${lessons.map(l => `- ${l}`).join('\n')}
  
  Generate the ${examType} exam now. Remember: NO TikZ, NO graphics, only basic LaTeX constructs.`;

  // 3. Call LLM with strict constraints
  let { result } = await callStageLLM({
    stage: STAGES.EXAM_GENERATOR,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    attachments,
    maxTokens: 8192,
    allowWeb: true,
    requestTimeoutMs: 600000, // 10 minutes for exam generation
  });

  let latexContent = sanitizeLatex(result.content);

  // 4. Semantic Repair Loop (one attempt only)
  let semanticIssues = checkSemanticIssues(latexContent);
  if (semanticIssues.length > 0) {
    console.log('[examGenerator] Found semantic issues, attempting repair:', semanticIssues);
    
    const repairPrompt = `The generated LaTeX has the following issues:
${semanticIssues.join('\n')}

Please fix these issues and regenerate the full valid LaTeX code.

CRITICAL REMINDERS:
${LATEX_ENV_SPEC}

- NO TikZ, circuitikz, or graphics packages
- NO \\includegraphics or \\input commands
- ONLY use exam class + basic math/tabular environments
- Ensure all \\begin{...} have matching \\end{...} for each environment type

Return the FULL corrected LaTeX code.`;
    
    const repairResult = await callStageLLM({
      stage: STAGES.EXAM_GENERATOR,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: result.content },
        { role: 'user', content: repairPrompt }
      ],
      maxTokens: 8192,
      requestTimeoutMs: 600000, // 10 minutes for repair call
    });
    latexContent = sanitizeLatex(repairResult.result.content);
    
    // Re-check after repair
    semanticIssues = checkSemanticIssues(latexContent);
    if (semanticIssues.length > 0) {
      console.warn('[examGenerator] Semantic issues persist after repair:', semanticIssues);
      // Continue anyway - compilation will be the final arbiter
    }
  }

  // 5. Compilation & Retry Loop (limited to 2 retries max)
  const MAX_COMPILE_RETRIES = 2;
  let pdfBuffer = null;
  let lastError = null;
  let compilationErrors = [];

  for (let i = 0; i <= MAX_COMPILE_RETRIES; i++) {
    try {
      console.log(`[examGenerator] Compiling LaTeX (attempt ${i + 1}/${MAX_COMPILE_RETRIES + 1})...`);
      pdfBuffer = await compileLatexToPdf(latexContent);
      console.log('[examGenerator] Compilation successful!');
      break; // Success
    } catch (err) {
      const errorSummary = extractLatexError(err);
      console.error(`[examGenerator] Compilation failed (attempt ${i + 1}):`, errorSummary);
      lastError = err;
      compilationErrors.push({ attempt: i + 1, error: errorSummary });

      if (i < MAX_COMPILE_RETRIES) {
        // Ask LLM to fix the LaTeX based on the error (with constraints reminder)
        const errorPrompt = `The LaTeX compilation failed with the following error:

${errorSummary}

Please fix the LaTeX code to make it compilable. Return the FULL corrected LaTeX code.

CRITICAL REMINDERS:
${LATEX_ENV_SPEC}

- NO TikZ, circuitikz, or graphics packages
- NO \\includegraphics or \\input commands  
- ONLY use exam class + basic math/tabular environments
- Ensure all \\begin{...} have matching \\end{...}

Focus on fixing the specific compilation error while maintaining all constraints.`;
        
        const fixResult = await callStageLLM({
          stage: STAGES.EXAM_GENERATOR,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: latexContent }, // Context of what failed
            { role: 'user', content: errorPrompt }
          ],
          maxTokens: 8192,
          requestTimeoutMs: 600000, // 10 minutes for compilation fix
        });
        latexContent = sanitizeLatex(fixResult.result.content);
      }
    }
  }

  if (!pdfBuffer) {
    // Build detailed error report
    const errorReport = {
      message: `Failed to compile exam after ${MAX_COMPILE_RETRIES + 1} attempts`,
      attempts: compilationErrors,
      lastError: lastError?.message,
      suggestion: 'The LaTeX code could not be compiled. This may be due to unsupported constructs or syntax errors. Please try regenerating the exam or contact support.'
    };
    
    console.error('[examGenerator] Final error report:', JSON.stringify(errorReport, null, 2));
    throw new Error(`${errorReport.message}. Last error: ${errorReport.lastError || 'Unknown error'}`);
  }

  // 6. Save the PDF
  const fileName = `${examType}_exam.pdf`;
  const url = await uploadExamFile(courseId, userId, pdfBuffer, fileName, 'application/pdf');

  return { url, name: fileName };
}
