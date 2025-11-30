import latex from 'node-latex';
import { createReadStream, createWriteStream } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { unlink, writeFile } from 'fs/promises';
import { getCourseExamFiles, uploadExamFile } from './storage.js';
import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';

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

  // Basic fixes
  // Ensure documentclass exists
  if (!clean.includes('\\documentclass')) {
    clean = '\\documentclass{article}\n\\usepackage{amsmath}\n\\usepackage{amssymb}\n\\usepackage{geometry}\n\\geometry{a4paper, margin=1in}\n\\begin{document}\n' + clean + '\n\\end{document}';
  }
  
  // Fix common unescaped characters if they look like text (this is risky, so we do minimal regex)
  // e.g. % in text mode should be \%
  // But hard to distinguish from comments. Skipping risky regexes.

  return clean;
}

/**
 * Checks for semantic issues in LaTeX code.
 * @param {string} code 
 * @returns {string[]} List of issues found
 */
function checkSemanticIssues(code) {
  const issues = [];
  if (code.includes('[INSERT')) issues.push('Found placeholder like [INSERT...]');
  if (code.includes('TODO:')) issues.push('Found TODO comment');
  // Check for missing environments
  const beginCount = (code.match(/\\begin\{/g) || []).length;
  const endCount = (code.match(/\\end\{/g) || []).length;
  if (beginCount !== endCount) issues.push(`Mismatched begin/end environments (${beginCount} vs ${endCount})`);
  
  return issues;
}

/**
 * Compiles LaTeX to PDF using node-latex.
 * @param {string} latexCode 
 * @returns {Promise<Buffer>} PDF buffer
 */
async function compileLatexToPdf(latexCode) {
  return new Promise((resolve, reject) => {
    const input = createReadStream(Buffer.from(latexCode));
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

  // 2. Construct the prompt
  const systemPrompt = `You are an expert academic exam creator. Your task is to create a high-quality ${examType} exam in LaTeX format.
  
  INPUTS:
  1. A list of lessons to cover.
  2. Attached existing practice exams (use these as strict references for FORMAT, STYLE, DIFFICULTY, and QUESTION TYPES).
  
  INSTRUCTIONS:
  - Create a complete ${examType} exam covering the specified lessons.
  - STRICTLY ADHERE to the formatting and style of the attached existing exams.
  - Output ONLY the raw LaTeX code.
  - Ensure the LaTeX is compilable (include preamble, document class, etc.).
  - Do NOT use placeholders like [INSERT IMAGE] or TODOs.
  `;

  const userPrompt = `Lessons to cover:
  ${lessons.map(l => `- ${l}`).join('\n')}
  
  Generate the ${examType} exam now.`;

  // 3. Call LLM
  let { result } = await callStageLLM({
    stage: STAGES.EXAM_GENERATOR,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    attachments,
    maxTokens: 8192,
    allowWeb: true,
  });

  let latexContent = sanitizeLatex(result.content);

  // 4. Semantic Repair Loop
  let semanticIssues = checkSemanticIssues(latexContent);
  if (semanticIssues.length > 0) {
    console.log('[examGenerator] Found semantic issues, repairing:', semanticIssues);
    const repairPrompt = `The generated LaTeX has the following issues:\n${semanticIssues.join('\n')}\n\nPlease fix these issues and regenerate the full valid LaTeX code.`;
    
    const repairResult = await callStageLLM({
      stage: STAGES.EXAM_GENERATOR,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: result.content },
        { role: 'user', content: repairPrompt }
      ],
      maxTokens: 8192,
    });
    latexContent = sanitizeLatex(repairResult.result.content);
  }

  // 5. Compilation & Retry Loop
  const MAX_RETRIES = 2;
  let pdfBuffer = null;
  let lastError = null;

  for (let i = 0; i <= MAX_RETRIES; i++) {
    try {
      console.log(`[examGenerator] Compiling LaTeX (attempt ${i + 1}/${MAX_RETRIES + 1})...`);
      pdfBuffer = await compileLatexToPdf(latexContent);
      break; // Success
    } catch (err) {
      console.error(`[examGenerator] Compilation failed (attempt ${i + 1}):`, err.message);
      lastError = err;

      if (i < MAX_RETRIES) {
        // Ask LLM to fix the LaTeX based on the error
        const errorPrompt = `The LaTeX compilation failed with the following error:\n${err.message}\n\nPlease fix the LaTeX code to make it compilable. Return the FULL corrected LaTeX code.`;
        
        const fixResult = await callStageLLM({
          stage: STAGES.EXAM_GENERATOR,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
            { role: 'assistant', content: latexContent }, // Context of what failed
            { role: 'user', content: errorPrompt }
          ],
          maxTokens: 8192,
        });
        latexContent = sanitizeLatex(fixResult.result.content);
      }
    }
  }

  if (!pdfBuffer) {
    throw new Error(`Failed to compile exam after ${MAX_RETRIES + 1} attempts. Last error: ${lastError?.message}`);
  }

  // 6. Save the PDF
  const fileName = `${examType}_exam.pdf`;
  const url = await uploadExamFile(courseId, userId, pdfBuffer, fileName, 'application/pdf');

  return { url, name: fileName };
}
