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
  console.log(`[examGrader] Starting exam grading process`, {
    courseId,
    userId,
    examTag,
    inputPdfSize: inputPdfBuffer.length
  });

  // 1. Fetch blank exam URL
  console.log(`[examGrader] Fetching blank exam template for tag: ${examTag}`);
  const blankExamUrl = await getBlankExam(examTag);
  if (!blankExamUrl) {
    console.error(`[examGrader] Blank exam template not found for tag: ${examTag}`);
    throw new Error(`Blank exam template not found for tag: ${examTag}`);
  }
  console.log(`[examGrader] Successfully fetched blank exam URL:`, blankExamUrl);

  // 2. Prepare attachments (Answered Exam + Blank Exam)
  console.log(`[examGrader] Preparing attachments for LLM call`);
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
  console.log(`[examGrader] Prepared ${attachments.length} attachments`);

  // 3. Construct Prompt
  console.log(`[examGrader] Constructing grading prompt`);
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
  console.log(`[examGrader] Calling LLM with EXAM_GRADER stage`);
  const { result } = await deps.callStageLLM({
    stage: STAGES.EXAM_GRADER,
    messages,
    attachments,
    responseFormat: 'json' // Hint to the LLM wrapper to expect JSON
  });
  console.log(`[examGrader] Received LLM response, content length: ${result.content?.length || 0}`);

  // 5. Parse Response
  console.log(`[examGrader] Parsing LLM response`);
  let parsedResult;
  try {
    // The result.content might be a string containing JSON code block
    const content = result.content;
    const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/) || content.match(/\{[\s\S]*\}/);
    const jsonStr = jsonMatch ? jsonMatch[1] || jsonMatch[0] : content;
    parsedResult = JSON.parse(jsonStr);
    console.log(`[examGrader] Successfully parsed grading result`, {
      topicCount: parsedResult.topic_list?.length || 0,
      overallScore: parsedResult.overall_score
    });
  } catch (e) {
    console.error('[examGrader] Failed to parse LLM response:', e);
    console.error('[examGrader] Raw content:', result.content);
    throw new Error('Failed to parse grading result from LLM.');
  }

  console.log(`[examGrader] Grading process completed successfully`);
  return parsedResult;
}
