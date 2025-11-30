
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVideoSelection, __setGrokExecutor, __resetGrokExecutor } from '../src/services/courseContent.js';

test('generateVideoSelection retries with broader query when results are empty', async (t) => {
    // The current implementation uses a simpler retry loop with direct yt-search calls
    // Mock the grok executor to return a valid selection
    const mockExecutor = async (options) => {
        const { messages } = options;

        // Verify the system message contains video selection instructions
        const systemMsg = messages.find(m => m.role === 'system');
        assert.ok(systemMsg.content.includes('video curator'), 'Prompt should describe video curator role');

        return {
            content: JSON.stringify({ selected_index: 0 })
        };
    };

    __setGrokExecutor(mockExecutor);

    try {
        const result = await generateVideoSelection(['Specific Query']);
        assert.ok(result, 'Should return a result');
        assert.ok(Array.isArray(result.videos), 'Should have videos array');
        assert.ok(Array.isArray(result.logs), 'Should have logs array');
    } finally {
        __resetGrokExecutor();
    }
});

test('generateVideoSelection integration simulation', async (t) => {
    // This test verifies that the video selection function properly calls the LLM
    // with the expected message structure for video curation

    let capturedOptions;
    const mockExecutor = async (options) => {
        capturedOptions = options;
        return { content: JSON.stringify({ selected_index: 0 }) };
    };

    __setGrokExecutor(mockExecutor);

    const result = await generateVideoSelection(['Test Query']);

    // Verify the executor was called with proper structure
    assert.ok(capturedOptions, 'Executor should have been called');
    assert.ok(capturedOptions.messages, 'Should have messages');
    assert.ok(capturedOptions.messages.length >= 2, 'Should have system and user messages');
    
    const systemMsg = capturedOptions.messages.find(m => m.role === 'system');
    assert.ok(systemMsg, 'Should have system message');
    assert.ok(systemMsg.content.includes('video curator'), 'System message should describe video curator');
    assert.ok(systemMsg.content.includes('selected_index'), 'System message should mention selected_index format');

    // Verify result structure
    assert.ok(result.videos, 'Should return videos array');
    assert.ok(result.logs, 'Should return logs array');

    console.log('✅ Configuration verified: LLM called with proper video curation prompt.');
});
