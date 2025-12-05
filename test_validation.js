
import { validateCourseContent, __setGrokExecutor } from './src/services/questionValidation.js';

// Mock data
const mockContent = [
  {
    nodeId: 'lesson-1',
    payload: {
      title: 'Lesson 1',
      quiz: [
        { question: 'Q1', options: ['A', 'B'], correct_index: 0, explanation: ['Exp A', 'Exp B'] }
      ]
    }
  },
  {
    nodeId: 'module-quiz-1',
    payload: {
      title: 'Module Quiz',
      practice_problems: [
        { question: 'P1', rubric: {}, sample_answer: {} }
      ]
    }
  }
];

// Mock executor
const mockExecutor = async ({ messages }) => {
  console.log('Mock executor called.');
  return {
    content: JSON.stringify({
      results: {
        'quiz_lesson-1_0': { status: 'valid', data: null },
        'practice_module-quiz-1_0': { 
          status: 'fixed', 
          data: { question: 'P1 Fixed', rubric: { fixed: true }, sample_answer: {} } 
        }
      }
    })
  };
};

__setGrokExecutor(mockExecutor);

async function runTest() {
  console.log('Running validation test...');
  const result = await validateCourseContent(mockContent, 'user1', 'course1');
  
  // Assertions
  const q1 = result[0].payload.quiz[0];
  if (q1.question !== 'Q1') throw new Error('Q1 should remain unchanged');
  
  const p1 = result[1].payload.practice_problems[0];
  if (p1.question !== 'P1 Fixed') throw new Error('P1 should be fixed');
  
  console.log('Test Passed!');
}

runTest().catch(console.error);
