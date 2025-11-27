
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVideoSelection, __setGrokExecutor, __resetGrokExecutor } from '../src/services/courseContent.js';

test('generateVideoSelection integration test', async (t) => {
    // We will mock the LLM to orchestrate the tool call, but we will let the tool call the REAL yt-search.
    // This verifies if yt-search is working on this machine.

    let toolCallResult = null;

    const mockExecutor = async ({ messages, tools }) => {
        // 1. Simulate LLM deciding to call the search tool
        // We assume the first call is the initial prompt.
        // We will manually execute the tool handler to see if it works.

        const searchTool = tools.find(t => t.name === 'search_youtube');
        if (!searchTool) {
            throw new Error('search_youtube tool not passed to executor');
        }

        // Extract query from user message
        const userMsg = messages.find(m => m.role === 'user');
        const queryMatch = userMsg.content.match(/"([^"]+)"/);
        const query = queryMatch ? queryMatch[1] : 'test query';

        console.log(`[Test] Manually executing tool for query: ${query}`);
        try {
            // EXECUTE THE REAL TOOL
            const result = await searchTool.handler({ query });
            toolCallResult = result;
            console.log('[Test] Tool result length:', result.length);

            // If search failed, return a failure response
            if (result === 'Search failed.') {
                return { content: JSON.stringify({ selected_index: -1 }) };
            }

            // 2. Simulate LLM selecting the first video
            return { content: JSON.stringify({ selected_index: 0 }) };

        } catch (err) {
            console.error('[Test] Tool execution failed:', err);
            return { content: JSON.stringify({ selected_index: -1 }) };
        }
    };

    __setGrokExecutor(mockExecutor);

    try {
        console.log('--- Starting Video Selection Test ---');
        const queries = ['introduction to photosynthesis'];
        const result = await generateVideoSelection(queries);

        console.log('--- Test Finished ---');
        console.log('Logs:', result.logs);
        console.log('Videos:', result.videos);

        // Assertions
        assert.ok(result.logs.length > 0, 'Should have logs');

        if (result.videos.length > 0) {
            console.log('✅ Video found:', result.videos[0]);
            assert.equal(result.videos.length, 1);
            assert.ok(result.videos[0].videoId, 'Video should have an ID');
            assert.ok(result.videos[0].title, 'Video should have a title');
        } else {
            console.warn('⚠️ No video found. Check logs for yt-search errors.');
            // If yt-search fails (e.g. network), this might be expected, but we want to know.
            const searchFailed = result.logs.some(l => l.includes('Search failed') || l.includes('LLM did not select'));
            assert.ok(searchFailed, 'If no video, logs should indicate failure');
        }

        // Check if tool actually returned data
        if (toolCallResult) {
            console.log('Tool Output Preview:', toolCallResult.slice(0, 200) + '...');
        }

    } finally {
        __resetGrokExecutor();
    }
});

test('generateVideoSelection handles LLM failure gracefully', async (t) => {
    const mockExecutor = async () => {
        // Simulate LLM returning valid JSON but indicating no video found
        return { content: JSON.stringify({ selected_index: -1 }) };
    };

    __setGrokExecutor(mockExecutor);

    try {
        console.log('\n--- Starting Video Selection Failure Test ---');
        const result = await generateVideoSelection(['weird query']);

        console.log('Logs:', result.logs);
        assert.equal(result.videos.length, 0);
        assert.ok(result.logs.some(l => l.includes('LLM did not select')), 'Should log failure message');
        assert.ok(result.logs.some(l => l.includes('LLM Response:')), 'Should log raw response');

    } finally {
        __resetGrokExecutor();
    }
});

test('generateVideoSelection logs invalid JSON response', async (t) => {
    const mockExecutor = async () => {
        return { content: "This is not JSON." };
    };

    __setGrokExecutor(mockExecutor);

    try {
        console.log('\n--- Starting Video Selection Invalid JSON Test ---');
        const result = await generateVideoSelection(['query']);

        console.log('Logs:', result.logs);
        assert.equal(result.videos.length, 0);
        assert.ok(result.logs.some(l => l.includes('Video selection LLM failed')), 'Should log failure');
        assert.ok(result.logs.some(l => l.includes('Raw content: This is not JSON.')), 'Should log raw content');

    } finally {
        __resetGrokExecutor();
    }
});
