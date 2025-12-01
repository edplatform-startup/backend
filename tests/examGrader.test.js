import { describe, it, mock, before, after } from 'node:test';
import assert from 'node:assert';
import { gradeExam, deps } from '../src/services/examGrader.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';

describe('Exam Grading Service', () => {
  let mockSupabase;

  before(() => {
    mockSupabase = {
      storage: {
        from: (bucket) => ({
          list: async (path) => {
            if (path === 'user123/course123') {
              return { 
                data: [
                  { name: '123456_midterm_exam.pdf' },
                  { name: 'other_file.txt' }
                ], 
                error: null 
              };
            }
            return { data: [], error: null };
          },
          createSignedUrl: async (path) => {
            // console.log('Mock createSignedUrl called with path:', path);
            if (path.includes('midterm_exam.pdf')) {
              return { data: { signedUrl: 'https://example.com/templates/midterm.pdf' }, error: null };
            }
            return { data: null, error: { message: 'Not found' } };
          }
        })
      }
    };
    setSupabaseClient(mockSupabase);
  });

  after(() => {
    clearSupabaseClient();
  });

  it('should grade an exam successfully', async () => {
    // Mock LLM call
    const mockLlmResponse = {
      result: {
        content: JSON.stringify({
          topic_list: [
            { topic: 'Math', grade: 3, explanation: 'Good job' }
          ],
          overall_score: 90,
          overall_feedback: 'Excellent'
        })
      }
    };
    
    mock.method(deps, 'callStageLLM', async () => mockLlmResponse);

    const inputPdfBuffer = Buffer.from('fake pdf content');
    const result = await gradeExam('course123', 'user123', 'midterm', inputPdfBuffer);

    assert.strictEqual(result.overall_score, 90);
    assert.strictEqual(result.topic_list.length, 1);
    assert.strictEqual(result.topic_list[0].topic, 'Math');
  });

  it('should throw error if blank exam not found', async () => {
    await assert.rejects(
      async () => {
        await gradeExam('course123', 'user123', 'nonexistent', Buffer.from(''));
      },
      /Blank exam template not found/
    );
  });
});
