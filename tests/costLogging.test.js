
import { test, describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import * as courseContent from '../src/services/courseContent.js';

// Mock dependencies
const originalGrokExecutor = courseContent.__getGrokExecutor ? courseContent.__getGrokExecutor() : null;

let capturedCalls = [];
const mockGrokExecutor = async (options) => {
    capturedCalls.push(options);
    // Return a dummy response structure that satisfies the functions
    if (options.responseFormat?.type === 'json_object') {
        return {
            content: JSON.stringify({
                final_content: { markdown: "Mock markdown content" },
                quiz: [],
                flashcards: [],
                repaired_items: [], // for repairContentArray
                valid: true // for validation
            })
        };
    }
    return { content: "Mock content" };
};

describe('Cost Logging (userId propagation)', () => {
    before(() => {
        // We need to expose a way to mock grokExecutor in courseContent.js if not already exposed
        // Looking at courseContent.js, there is __setGrokExecutor
        courseContent.__setGrokExecutor(mockGrokExecutor);
    });

    after(() => {
        courseContent.__resetGrokExecutor();
    });

    beforeEach(() => {
        capturedCalls = [];
    });

    it('generateReading should pass userId to grokExecutor', async () => {
        const userId = 'test-user-123';
        await courseContent.generateReading(
            'Test Lesson',
            'Test Plan',
            'Test Course',
            'Test Module',
            [],
            'deep',
            userId // This is what we want to add
        );

        // Check if any call to grokExecutor had the userId
        const hasUserId = capturedCalls.some(call => call.userId === userId);
        assert.strictEqual(hasUserId, true, 'userId should be passed to grokExecutor');
        console.log('Test passed: userId was passed to grokExecutor');
    });
});
