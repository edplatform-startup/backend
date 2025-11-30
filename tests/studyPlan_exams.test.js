import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { generateStudyPlan } from '../src/services/studyPlan.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';

describe('Study Plan Practice Exams', () => {
  it('should insert mid-course and final practice exams', async () => {
    // Mock Supabase
    const mockNodes = [
      { id: '1', title: 'Lesson 1', estimated_minutes: 30, module_ref: 'Mod1' },
      { id: '2', title: 'Lesson 2', estimated_minutes: 30, module_ref: 'Mod1' },
      { id: '3', title: 'Lesson 3', estimated_minutes: 30, module_ref: 'Mod2' },
      { id: '4', title: 'Lesson 4', estimated_minutes: 30, module_ref: 'Mod2' },
    ];
    
    const mockSupabase = {
      schema: () => ({
        from: (table) => ({
          select: () => ({
            eq: () => {
              if (table === 'course_nodes') return { data: mockNodes, error: null };
              if (table === 'node_dependencies') return { data: [], error: null };
              if (table === 'user_node_state') return { eq: () => ({ data: [], error: null }) }; // user_id check
              return { single: () => ({ data: { seconds_to_complete: 100000 }, error: null }) }; // courses check
            },
            single: () => ({ data: { seconds_to_complete: 100000 }, error: null })
          })
        })
      })
    };
    
    setSupabaseClient(mockSupabase);

    const plan = await generateStudyPlan('course1', 'user1');
    
    // Practice exams are now standalone modules
    const examModules = plan.modules.filter(m => m.is_practice_exam_module);
    const midExamModule = examModules.find(m => m.exam?.id === 'practice-exam-mid');
    const finalExamModule = examModules.find(m => m.exam?.id === 'practice-exam-final');

    assert.ok(midExamModule, 'Mid-course exam module should exist');
    assert.ok(finalExamModule, 'Final exam module should exist');
    assert.equal(midExamModule.type, 'practice_exam', 'Mid exam module should have type practice_exam');
    assert.equal(finalExamModule.type, 'practice_exam', 'Final exam module should have type practice_exam');
    
    // Check module position (mid exam should be between content modules)
    const midIndex = plan.modules.indexOf(midExamModule);
    assert.ok(midIndex > 0 && midIndex < plan.modules.length - 1, 'Mid exam module should be in the middle');
    
    // Check preceding lessons
    const midExam = midExamModule.exam;
    const finalExam = finalExamModule.exam;
    assert.ok(midExam.preceding_lessons.length > 0, 'Mid exam should have preceding lessons');
    assert.ok(midExam.preceding_lessons.includes('1'), 'Mid exam should include Lesson 1');
    
    assert.ok(finalExam.preceding_lessons.length > midExam.preceding_lessons.length, 'Final exam should have more preceding lessons');
    assert.ok(finalExam.preceding_lessons.includes('4'), 'Final exam should include Lesson 4');
    
    clearSupabaseClient();
  });
});
