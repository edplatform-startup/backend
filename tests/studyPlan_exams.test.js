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
    
    // Flatten lessons from modules
    const allLessons = plan.modules.flatMap(m => m.lessons);
    
    const midExam = allLessons.find(l => l.id === 'practice-exam-mid');
    const finalExam = allLessons.find(l => l.id === 'practice-exam-final');

    assert.ok(midExam, 'Mid-course exam should exist');
    assert.ok(finalExam, 'Final exam should exist');
    
    // Check placement (roughly)
    const midIndex = allLessons.indexOf(midExam);
    assert.ok(midIndex > 0 && midIndex < allLessons.length - 1, 'Mid exam should be in the middle');
    
    // Check preceding lessons
    assert.ok(midExam.preceding_lessons.length > 0, 'Mid exam should have preceding lessons');
    assert.ok(midExam.preceding_lessons.includes('1'), 'Mid exam should include Lesson 1');
    
    assert.ok(finalExam.preceding_lessons.length > midExam.preceding_lessons.length, 'Final exam should have more preceding lessons');
    assert.ok(finalExam.preceding_lessons.includes('4'), 'Final exam should include Lesson 4');
    
    clearSupabaseClient();
  });
});
