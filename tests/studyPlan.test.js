import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateStudyPlan } from '../src/services/studyPlan.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';

// Mock Supabase client
let mockData = {};

const getSupabaseMock = () => {
    const supabase = {
        schema() {
            return supabase;
        },
        from(table) {
            const result = mockData[table] || { data: [], error: null };
            const chain = Promise.resolve(result);
            chain.select = () => chain;
            chain.eq = () => chain;
            chain.single = () => Promise.resolve(result);
            return chain;
        }
    };
    return supabase;
};

describe('Study Plan Generator', () => {
    const mockNodes = [
        { id: 'A', title: 'Node A', estimated_minutes: 30, intrinsic_exam_value: 5, module_ref: 'M1', content_payload: { reading: 'content' } },
        { id: 'B', title: 'Node B', estimated_minutes: 30, intrinsic_exam_value: 5, module_ref: 'M1', content_payload: { reading: 'content' } },
        { id: 'C', title: 'Node C', estimated_minutes: 30, intrinsic_exam_value: 8, module_ref: 'M2', content_payload: { reading: 'content' } },
        { id: 'D', title: 'Node D', estimated_minutes: 30, intrinsic_exam_value: 8, module_ref: 'M2', content_payload: { reading: 'content' } },
    ];

    const mockEdges = [
        { parent_id: 'A', child_id: 'B', course_id: 'course1' },
        { parent_id: 'B', child_id: 'C', course_id: 'course1' },
        { parent_id: 'B', child_id: 'D', course_id: 'course1' },
    ];

    const mockUserState = [
        { node_id: 'A', familiarity_score: 0.1, mastery_status: 'pending' },
        { node_id: 'B', familiarity_score: 0.1, mastery_status: 'pending' },
        { node_id: 'C', familiarity_score: 0.1, mastery_status: 'pending' },
        { node_id: 'D', familiarity_score: 0.1, mastery_status: 'pending' },
    ];

    beforeEach(() => {
        mockData = {
            course_nodes: { data: mockNodes, error: null },
            node_dependencies: { data: mockEdges, error: null },
            user_node_state: { data: mockUserState, error: null }
        };
        setSupabaseClient(getSupabaseMock());
    });

    afterEach(() => {
        clearSupabaseClient();
    });

    it('Deep Study Mode: Returns all non-mastered nodes in topological order', async () => {
        mockData.courses = { data: { seconds_to_complete: 3 * 3600 }, error: null };
        const plan = await generateStudyPlan('course1', 'user1');

        assert.equal(plan.mode, 'Deep Study');
        assert.ok(plan.modules.length > 0);

        // Filter out practice exam modules (they have is_practice_exam_module: true)
        const contentModules = plan.modules.filter(m => !m.is_practice_exam_module);
        const examModules = plan.modules.filter(m => m.is_practice_exam_module);
        
        const lessons = contentModules.flatMap(m => m.lessons);
        assert.equal(lessons[0].id, 'A'); // A must be first
        assert.equal(lessons[1].id, 'B'); // B must be second
        assert.equal(lessons.length, 4); // 4 content nodes
        // Plan includes 2 practice exam modules (mid + final)
        assert.equal(examModules.length, 2);
    });

    it('Cram Mode: Returns empty when no chains fit', async () => {
        mockData.courses = { data: { seconds_to_complete: 1 * 3600 }, error: null };
        const plan = await generateStudyPlan('course1', 'user1');
        assert.equal(plan.mode, 'Cram');
        assert.equal(plan.total_minutes, 0);
    });

    it('Cram Mode: Shared Ancestor Logic', async () => {
        mockData.courses = { data: { seconds_to_complete: 1.84 * 3600 }, error: null };
        const plan = await generateStudyPlan('course1', 'user1');
        assert.equal(plan.mode, 'Cram');
        
        // Filter out practice exam modules
        const contentModules = plan.modules.filter(m => !m.is_practice_exam_module);
        const examModules = plan.modules.filter(m => m.is_practice_exam_module);
        
        const lessons = contentModules.flatMap(m => m.lessons);
        assert.equal(lessons.length, 4); // A, B, C, D
        // Plan includes 2 practice exam modules (mid + final)
        assert.equal(examModules.length, 2);
    });

    it('Cram Mode: Zero Target Fallback', async () => {
        const lowValueNodes = mockNodes.map(n => ({ ...n, intrinsic_exam_value: 5 }));
        lowValueNodes[2].intrinsic_exam_value = 6; // C slightly higher
        mockData.course_nodes = { data: lowValueNodes, error: null };
        mockData.courses = { data: { seconds_to_complete: 1.5 * 3600 }, error: null };

        const plan = await generateStudyPlan('course1', 'user1');
        assert.equal(plan.mode, 'Cram');
        const lessons = plan.modules.flatMap(m => m.lessons);
        assert.ok(lessons.length > 0); // Should have some nodes
    });
});
