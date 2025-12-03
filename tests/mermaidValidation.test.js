import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReading, __setGrokExecutor, __resetGrokExecutor } from '../src/services/courseContent.js';

test('generateReading validates and repairs mermaid blocks', async () => {
    let callCount = 0;
    const mockGrok = async ({ messages }) => {
        callCount++;
        const lastMsg = messages[messages.length - 1].content;
        const systemMsg = messages.find(m => m.role === 'system')?.content || '';

        // 1. Initial Reading Generation
        if (systemMsg.includes('elite instructional designer')) {
            return {
                content: JSON.stringify({
                    final_content: {
                        markdown: `
# Lesson
Here is a diagram:
\`\`\`mermaid
graph TD
  A-->B
  Invalid Syntax Here
\`\`\`
End of lesson.
`
                    }
                })
            };
        }

        // 2. Mermaid Validation
        if (systemMsg.includes('strict Mermaid syntax validator')) {
            if (lastMsg.includes('Invalid Syntax Here')) {
                return {
                    content: JSON.stringify({
                        valid: false,
                        error: 'Syntax error: Invalid Syntax Here'
                    })
                };
            }
            return { content: JSON.stringify({ valid: true }) };
        }

        // 3. Mermaid Repair
        if (systemMsg.includes('Mermaid code repair assistant')) {
            return {
                content: JSON.stringify({
                    repaired_code: `graph TD
  A-->B
  C-->D`
                })
            };
        }

        // 4. Content Validation
        if (systemMsg.includes('Quality Assurance Validator')) {
            return {
                content: 'CORRECT'
            };
        }

        return { content: '' };
    };

    __setGrokExecutor(mockGrok);

    try {
        const result = await generateReading('Test Lesson', 'Plan', 'Course', 'Module');


        assert.ok(result.data.includes('graph TD'), 'Should contain mermaid graph');
        assert.ok(result.data.includes('C-->D'), 'Should contain repaired code');
        assert.ok(!result.data.includes('Invalid Syntax Here'), 'Should not contain invalid code');

    } finally {
        __resetGrokExecutor();
    }
});
