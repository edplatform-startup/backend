import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { getBlankExam } from './storage.js';

// Export dependencies for testing
export const deps = {
  callStageLLM
};

/**
 * Grades an answered exam PDF against a blank exam template using Gemini.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @param {string} examTag - The exam tag (e.g., 'midterm', 'final')
 * @param {Buffer} inputPdfBuffer - The buffer of the answered exam PDF
 * @returns {Promise<object>} The grading result
 */
export async function gradeExam(courseId, userId, examTag, inputPdfBuffer) {
  // 1. Fetch blank exam URL
  const blankExamUrl = await getBlankExam(examTag);
  if (!blankExamUrl) {
    throw new Error(`Blank exam template not found for tag: ${examTag}`);
  }

  // 2. Prepare attachments (Answered Exam + Blank Exam)
  // Note: callStageLLM supports attachments with 'url' or 'data' (base64)
  // We'll send the input PDF as base64 and the blank exam as a URL (if supported by the model/wrapper)
  // Or better, since we have the buffer, let's send both as base64 if needed, 
  // but `callStageLLM` usually handles URLs for some providers. 
  // However, for Gemini via OpenRouter/Vertex, passing the file content is often safer if we want to be sure.
  // Let's assume `callStageLLM` handles `url` correctly for the model, or we can fetch the blank exam content.
  // To be safe and consistent with `inputPdfBuffer`, let's try to pass the blank exam URL directly if the underlying `grokClient` supports it.
  // Looking at `grokClient.js` (which I haven't fully read but `llmCall.js` uses it), it supports attachments.
  
  const attachments = [
    {
      type: 'application/pdf',
      mimeType: 'application/pdf',
      data: inputPdfBuffer.toString('base64'),
      name: 'answered_exam.pdf'
    },
    {
      type: 'application/pdf',
      mimeType: 'application/pdf',
      url: blankExamUrl,
      name: 'blank_exam_template.pdf'
    }
  ];

  // 3. Construct Prompt
  const systemPrompt = `You are an expert academic grader. Your task is to grade a student's answered exam against the provided blank exam template.
  
  Inputs:
  1. 'answered_exam.pdf': The student's completed exam.
  2. 'blank_exam_template.pdf': The original blank exam containing questions and total marks.

  Instructions:
  - Analyze the student's answers in 'answered_exam.pdf'.
  - Compare them with the questions in 'blank_exam_template.pdf'.
  - Evaluate the correctness of each answer.
  - Assign a grade for each topic covered in the exam.
  - Provide a standardized JSON output.

  Output Format (JSON):
  {
    "topic_list": [
      {
        "topic": "Topic Name",
        "grade": 1, // 1 (Poor), 2 (Average), 3 (Good)
        "explanation": "Reasoning for the grade..."
      },
      ...
    ],
    "overall_score": 85, // 0-100
    "overall_feedback": "General feedback..."
  }
  
  Ensure the 'grade' is strictly 1, 2, or 3.
  `;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Please grade this exam.' }
  ];

  // 4. Call LLM
  const { result } = await deps.callStageLLM({
    stage: STAGES.EXAM_GRADER,
    messages,
    attachments,
    responseFormat: 'json' // Hint to the LLM wrapper to expect JSON
  });

  // 5. Parse Response
  let parsedResult;
  try {
    // The result.content might be a string containing JSON code block
    const content = result.content;
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
    parsedResult = JSON.parse(jsonStr);
  } catch (e) {
    console.error('[examGrader] Failed to parse LLM response:', e);
    throw new Error('Failed to parse grading result from LLM.');
  }

  return parsedResult;
}
