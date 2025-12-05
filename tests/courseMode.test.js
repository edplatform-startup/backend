
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateHierarchicalTopics, __setCourseV2LLMCaller, __resetCourseV2LLMCaller } from '../src/services/courseV2.js';
import { generateLessonGraph, __setLLMCaller, __resetLLMCaller } from '../src/services/courseGenerator.js';
import { generateQuiz, generateReading, __setGrokExecutor, __resetGrokExecutor } from '../src/services/courseContent.js';

describe('Course Mode Logic', () => {

    describe('Topic Generation (courseV2.js)', () => {
        let mockLLM;

        beforeEach(() => {
            mockLLM = vi.fn().mockImplementation(async ({ stage }) => {
                if (stage === 'PLANNER') {
                    return {
                        result: {
                            content: JSON.stringify({
                                course_structure_type: 'Week-based',
                                skeleton: [
                                    { title: 'Unit 1', sequence_order: 1 },
                                    { title: 'Unit 2', sequence_order: 2 }
                                ]
                            })
                        }
                    };
                }
                if (stage === 'TOPICS') {
                    return {
                        result: {
                            content: JSON.stringify({
                                overviewTopics: [{
                                    title: 'Topic 1',
                                    original_skeleton_ref: 'Unit 1',
                                    subtopics: [{
                                        title: 'Subtopic 1',
                                        bloom_level: 'Understand',
                                        exam_relevance_reasoning: 'Reason',
                                        yield: 'High'
                                    }]
                                }]
                            })
                        },
                        model: 'mock-model'
                    };
                }
                return { result: {} };
            });
            __setCourseV2LLMCaller(mockLLM);
        });

        afterEach(() => {
            __resetCourseV2LLMCaller();
        });

        it('should include Cram Mode instructions in system prompt', async () => {
            await generateHierarchicalTopics({ mode: 'cram' }, 'user-123');
            const callArgs = mockLLM.mock.calls[1][0];
            const systemPrompt = callArgs.messages.find(m => m.role === 'system').content;

            expect(systemPrompt).toContain('MODE: CRAM');
            expect(systemPrompt).toContain('MAXIMIZE EXAM VALUE');
        });

        it('should include Deep Mode instructions in system prompt', async () => {
            await generateHierarchicalTopics({ mode: 'deep' }, 'user-123');
            const callArgs = mockLLM.mock.calls[1][0];
            const systemPrompt = callArgs.messages.find(m => m.role === 'system').content;

            expect(systemPrompt).toContain('MODE: DEEP');
            expect(systemPrompt).toContain('MAXIMAL UNDERSTANDING AND DEEP RETENTION');
        });
    });

    describe('Lesson Architect (courseGenerator.js)', () => {
        let mockLLM;

        beforeEach(() => {
            mockLLM = vi.fn().mockResolvedValue({
                result: { content: JSON.stringify({ lessons: [] }) }
            });
            __setLLMCaller(mockLLM);
        });

        afterEach(() => {
            __resetLLMCaller();
        });

        it('should include Cram Mode instructions in system prompt', async () => {
            await generateLessonGraph({}, {}, 'user-123', 'cram');
            const callArgs = mockLLM.mock.calls[0][0];
            const systemPrompt = callArgs.messages.find(m => m.role === 'system').content;

            expect(systemPrompt).toContain('MODE: CRAM');
            expect(systemPrompt).toContain('MAXIMIZE EXAM VALUE');
            expect(systemPrompt).toContain('laser-focused on exam-critical concepts'); // Reading plan instruction
            expect(systemPrompt).toContain('Only include if absolutely essential'); // Video plan instruction
        });

        it('should include Deep Mode instructions in system prompt', async () => {
            await generateLessonGraph({}, {}, 'user-123', 'deep');
            const callArgs = mockLLM.mock.calls[0][0];
            const systemPrompt = callArgs.messages.find(m => m.role === 'system').content;

            expect(systemPrompt).toContain('MODE: DEEP');
            expect(systemPrompt).toContain('MAXIMIZE UNDERSTANDING AND DEEP RETENTION');
            expect(systemPrompt).toContain('explore all nuances'); // Reading plan instruction
        });
    });

    describe('Content Generation (courseContent.js)', () => {
        let mockExecutor;

        beforeEach(() => {
            mockExecutor = vi.fn().mockResolvedValue({
                content: JSON.stringify({
                    quiz: [{
                        question: "Test Question?",
                        options: ["A", "B", "C", "D"],
                        correct_index: 0,
                        explanation: ["Exp A", "Exp B", "Exp C", "Exp D"]
                    }],
                    final_content: { markdown: 'test' }
                })
            });
            __setGrokExecutor(mockExecutor);
        });

        afterEach(() => {
            __resetGrokExecutor();
        });

        it('should request 5-7 questions for Cram Mode quiz', async () => {
            await generateQuiz('Test Lesson', 'Plan', 'Course', 'Module', [], 'cram');
            const callArgs = mockExecutor.mock.calls[0][0];
            const userPrompt = callArgs.messages.find(m => m.role === 'user').content;

            expect(userPrompt).toContain('5-7 comprehensive multiple-choice questions');
        });

        it('should request 12-15 questions for Deep Mode quiz', async () => {
            await generateQuiz('Test Lesson', 'Plan', 'Course', 'Module', [], 'deep');
            const callArgs = mockExecutor.mock.calls[0][0];
            const userPrompt = callArgs.messages.find(m => m.role === 'user').content;

            expect(userPrompt).toContain('12-15 comprehensive multiple-choice questions');
        });

        it('should include high-yield focus for Cram Mode reading', async () => {
            await generateReading('Test Lesson', 'Plan', 'Course', 'Module', [], 'cram');
            const callArgs = mockExecutor.mock.calls[0][0];
            const systemPrompt = callArgs.messages.find(m => m.role === 'system').content;

            expect(systemPrompt).toContain('MAXIMIZE EXAM VALUE');
        });

        it('should include comprehensive focus for Deep Mode reading', async () => {
            await generateReading('Test Lesson', 'Plan', 'Course', 'Module', [], 'deep');
            const callArgs = mockExecutor.mock.calls[0][0];
            const systemPrompt = callArgs.messages.find(m => m.role === 'system').content;

            expect(systemPrompt).toContain('MAXIMIZE UNDERSTANDING AND DEEP RETENTION');
        });
    });
});
