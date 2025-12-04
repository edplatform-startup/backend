import { callStageLLM } from './llmCall.js';
import { STAGES } from './modelRouter.js';
import { getBlankExam, uploadExamFile } from './storage.js';

// Export dependencies for testing
export const deps = {
  callStageLLM
};

/**
 * Grades an answered exam PDF against a blank exam template using Gemini.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @param {string} examType - The exam type (e.g., 'midterm', 'final')
 * @param {number} examNumber - The exam number (e.g., 1, 2)
 * @param {Buffer} inputPdfBuffer - The buffer of the answered exam PDF
 * @returns {Promise<object>} The grading result
 */
export async function gradeExam(courseId, userId, examType, examNumber, inputPdfBuffer) {
  console.log(`[examGrader] Starting exam grading process`, {
    courseId,
    userId,
    examType,
    examNumber,
    inputPdfSize: inputPdfBuffer.length
  });

  // 1. Fetch blank exam URL
  console.log(`[examGrader] Fetching blank exam template for type: ${examType}, number: ${examNumber}`);
  const blankExamUrl = await getBlankExam(courseId, userId, examType, examNumber);
  if (!blankExamUrl) {
    console.error(`[examGrader] Blank exam template not found for type: ${examType}, number: ${examNumber}`);
    throw new Error(`Blank exam template not found for type: ${examType}, number: ${examNumber}`);
  }
  console.log(`[examGrader] Successfully fetched blank exam URL:`, blankExamUrl);

  // 2. Upload student submission to get public URL
  console.log(`[examGrader] Uploading student submission to storage`);
  const studentSubmissionUrl = await uploadExamFile(courseId, userId, inputPdfBuffer, 'student_submission.pdf');
  console.log(`[examGrader] Student submission uploaded:`, studentSubmissionUrl);

  // 3. Construct Multimodal Prompt
  console.log(`[examGrader] Constructing multimodal grading prompt`);
  const systemPrompt = `You are an expert academic grader. Your task is to grade a student's answered exam against the provided blank exam template.
  
  You will be provided with two PDFs: one is the original blank exam (questions) and one is the student's completed exam (answers). You must read and interpret these PDFs and grade based on what is written in the student's exam, not based on the example output in this prompt.

  Inputs:
  1. 'blank_exam.pdf': The original blank exam containing questions and total marks.
  2. 'student_submission.pdf': The student's completed exam.

  Instructions:
  - Analyze the student's answers in 'student_submission.pdf'.
  - Compare them with the questions in 'blank_exam.pdf'.
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
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Grade this exam using the attached PDFs. Read the blank exam questions from blank_exam.pdf and the student answers from student_submission.pdf.'
        },
        {
          type: 'file',
          file: {
            filename: 'blank_exam.pdf',
            file_data: blankExamUrl,      // <-- change here
          },
        },
        {
          type: 'file',
          file: {
            filename: 'student_submission.pdf',
            file_data: studentSubmissionUrl,  // <-- and here
          },
        },
      ],
    },
  ];


  // 4. Call LLM
  console.log(`[examGrader] Calling LLM with EXAM_GRADER stage (multimodal)`);
  const { result } = await deps.callStageLLM({
    stage: STAGES.EXAM_GRADER,
    messages,
    attachments: [], // No legacy attachments
    maxTokens: 10000,
    responseFormat: { type: 'json_object' },
    plugins: [
      {
        id: 'file-parser',
        pdf: { engine: 'mistral-ocr' }
      }
    ],
    requestTimeoutMs: 300000, // 5 minutes
    userId,
    source: 'exam_grader',
    courseId,
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
