
import { describe, it } from 'node:test';
import assert from 'node:assert';

// --- LOGIC TO BE MOVED TO courseContent.js ---

function validateInlineQuestionFormat(markdown) {
    if (!markdown) return { valid: false, error: 'Empty content' };

    // 1. Header Check
    // Matches: Question:, **Question:**, **Check Your Understanding**
    const headerRegex = /(?:^Question:|^[\*]{0,2}Question:[\*]{0,2}|^[\*]{0,2}Check Your Understanding[\*]{0,2})/mi;
    if (!headerRegex.test(markdown)) {
        return { valid: false, error: 'Missing or invalid header' };
    }

    // 2. Options Check
    // Must have 4 options labeled A, B, C, D
    // Regex: start of line, optional - or *, optional space, A-D, . or ), space
    const optionRegex = /^[-*]?\s*[A-D][.)]\s+/gm;
    const options = markdown.match(optionRegex);
    if (!options || options.length < 4) {
        return { valid: false, error: 'Must have at least 4 options (A-D)' };
    }

    // Check for unique A, B, C, D
    const letters = options.map(o => o.match(/[A-D]/i)[0].toUpperCase());
    const uniqueLetters = new Set(letters);
    if (!uniqueLetters.has('A') || !uniqueLetters.has('B') || !uniqueLetters.has('C') || !uniqueLetters.has('D')) {
        return { valid: false, error: 'Missing one or more options A-D' };
    }

    // 3. Answer Section Check
    // Must be inside <details> and have **Answer:** X
    const detailsRegex = /<details>[\s\S]*?<\/details>/i;
    const detailsMatch = markdown.match(detailsRegex);
    if (!detailsMatch) {
        return { valid: false, error: 'Missing <details> block for answer' };
    }

    const answerRegex = /\*\*Answer:\*\*\s*[A-D]/i;
    if (!answerRegex.test(detailsMatch[0])) {
        return { valid: false, error: 'Missing or invalid **Answer:** format inside details' };
    }

    return { valid: true };
}

function manualRepairInlineQuestion(markdown) {
    let repaired = markdown;

    // 1. Repair Header
    // If no header but looks like a question, add one.
    // Heuristic: if it starts with text and has options later.
    const headerRegex = /(?:^Question:|^[\*]{0,2}Question:[\*]{0,2}|^[\*]{0,2}Check Your Understanding[\*]{0,2})/mi;
    if (!headerRegex.test(repaired)) {
        repaired = `**Check Your Understanding**\n\n${repaired}`;
    }

    // 2. Repair Options
    // If options exist but are malformed (e.g. missing bullets), try to standardize them.
    // This is hard to do safely with regex alone without risking content damage.
    // But we can ensure they start with newlines if they are bunched up.
    // For now, let's assume the LLM does a decent job on options or we use LLM repair for complex cases.

    // 3. Repair Answer Section
    // If Answer exists but not in details, wrap it.
    const answerRegex = /(\*\*Answer:\*\*\s*[A-D][\s\S]*)/i;
    const detailsRegex = /<details>[\s\S]*?<\/details>/i;

    if (answerRegex.test(repaired) && !detailsRegex.test(repaired)) {
        // Find the answer section
        const match = repaired.match(answerRegex);
        if (match) {
            const answerBlock = match[0];
            // Remove the answer block from the original text
            repaired = repaired.replace(answerBlock, '');
            // Append it wrapped in details
            repaired = repaired.trim() + `\n\n<details><summary>Show Answer</summary>\n\n${answerBlock.trim()}\n</details>`;
        }
    }

    return repaired;
}

// --- TESTS ---

describe('Inline Question Validation', () => {
    it('should validate a correct inline question', () => {
        const validQ = `
**Check Your Understanding**

What is 2 + 2?

- A. 3
- B. 4
- C. 5
- D. 6

<details><summary>Show Answer</summary>

**Answer:** B

- **A** ❌ Incorrect
- **B** ✅ Correct
</details>
`;
        const result = validateInlineQuestionFormat(validQ);
        assert.strictEqual(result.valid, true);
    });

    it('should fail if header is missing', () => {
        const invalidQ = `
What is 2 + 2?
- A. 3
- B. 4
- C. 5
- D. 6
<details><summary>Show Answer</summary>
**Answer:** B
</details>
`;
        const result = validateInlineQuestionFormat(invalidQ);
        assert.strictEqual(result.valid, false);
        assert.match(result.error, /header/);
    });

    it('should fail if options are missing', () => {
        const invalidQ = `
**Check Your Understanding**
What is 2 + 2?
<details><summary>Show Answer</summary>
**Answer:** B
</details>
`;
        const result = validateInlineQuestionFormat(invalidQ);
        assert.strictEqual(result.valid, false);
        assert.match(result.error, /options/);
    });

    it('should fail if answer details are missing', () => {
        const invalidQ = `
**Check Your Understanding**
What is 2 + 2?
- A. 3
- B. 4
- C. 5
- D. 6

**Answer:** B
`;
        const result = validateInlineQuestionFormat(invalidQ);
        assert.strictEqual(result.valid, false);
        assert.match(result.error, /<details>/);
    });

    it('should fail if Answer line is missing inside details', () => {
        const invalidQ = `
**Check Your Understanding**
What is 2 + 2?
- A. 3
- B. 4
- C. 5
- D. 6
<details><summary>Show Answer</summary>
Here is the explanation.
</details>
`;
        const result = validateInlineQuestionFormat(invalidQ);
        assert.strictEqual(result.valid, false);
        assert.match(result.error, /\*\*Answer:\*\*/);
    });
});

describe('Manual Repair', () => {
    it('should add header if missing', () => {
        const input = `
What is 2 + 2?
- A. 3
- B. 4
- C. 5
- D. 6
<details><summary>Show Answer</summary>
**Answer:** B
</details>
`;
        const repaired = manualRepairInlineQuestion(input);
        assert.match(repaired, /\*\*Check Your Understanding\*\*/);
        assert.strictEqual(validateInlineQuestionFormat(repaired).valid, true);
    });

    it('should wrap answer in details if missing', () => {
        const input = `
**Check Your Understanding**
What is 2 + 2?
- A. 3
- B. 4
- C. 5
- D. 6

**Answer:** B
Explanation here.
`;
        const repaired = manualRepairInlineQuestion(input);
        assert.match(repaired, /<details><summary>Show Answer<\/summary>/);
        assert.match(repaired, /\*\*Answer:\*\* B/);
        assert.strictEqual(validateInlineQuestionFormat(repaired).valid, true);
    });
});
