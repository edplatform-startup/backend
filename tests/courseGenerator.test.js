import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { generateLessonGraph, __setLLMCaller } from '../src/services/courseGenerator.js';

// Mock LLM Caller
const mockLLMCaller = async ({ messages }) => {
  const lastMessage = messages[messages.length - 1].content;
  
  // Check if it's the repair call
  if (lastMessage.includes('Return a JSON map correcting the Bad Slugs')) {
    return {
      result: {
        content: JSON.stringify({
          "bad-slug": "good-slug",
          "unfixable-slug": null
        })
      }
    };
  }

  // Default response (Architect Call)
  return {
    result: {
      content: JSON.stringify({
        lessons: [
          {
            slug_id: "good-slug",
            title: "Good Lesson",
            module_group: "Module 1",
            estimated_minutes: 30,
            bloom_level: "Understand",
            intrinsic_exam_value: 5,
            architectural_reasoning: "Reasoning for good lesson",
            worker_prompt: "Prompt",
            content_types: ["reading"],
            dependencies: [],
            original_source_ids: ["st1_1"] // Source with high confidence
          },
          {
            slug_id: "merged-lesson",
            title: "Merged Lesson",
            module_group: "Module 1",
            estimated_minutes: 45,
            bloom_level: "Apply",
            intrinsic_exam_value: 8,
            architectural_reasoning: "Reasoning for merged lesson",
            worker_prompt: "Prompt",
            content_types: ["reading"],
            dependencies: ["good-slug"],
            original_source_ids: ["st1_1", "st1_2"] // Mixed confidence
          },
          {
            slug_id: "new-lesson",
            title: "New Lesson",
            module_group: "Module 1",
            estimated_minutes: 20,
            bloom_level: "Remember",
            intrinsic_exam_value: 3,
            architectural_reasoning: "Reasoning for new lesson",
            worker_prompt: "Prompt",
            content_types: ["reading"],
            dependencies: ["merged-lesson"],
            original_source_ids: [] // No source -> default confidence
          }
        ]
      })
    }
  };
};

describe('generateLessonGraph', () => {
  // Setup mock
  __setLLMCaller(mockLLMCaller);

  it('should calculate confidence scores and include architectural reasoning', async () => {
    const grokDraft = { topic: "Math" };
    const userConfidenceMap = {
      "st1_1": 0.9,
      "st1_2": 0.5
    };

    const { finalNodes, finalEdges } = await generateLessonGraph(grokDraft, userConfidenceMap);

    assert.strictEqual(finalNodes.length, 3);
    
    // 1. Good Lesson (Source: st1_1 -> 0.9)
    const goodNode = finalNodes.find(n => n.title === "Good Lesson");
    assert.strictEqual(goodNode.confidence_score, 0.9);
    assert.deepStrictEqual(goodNode.metadata.original_source_ids, ["st1_1"]);
    assert.strictEqual(goodNode.metadata.architectural_reasoning, "Reasoning for good lesson");

    // 2. Merged Lesson (Sources: st1_1 (0.9), st1_2 (0.5) -> Avg 0.7)
    const mergedNode = finalNodes.find(n => n.title === "Merged Lesson");
    assert.strictEqual(mergedNode.confidence_score, 0.7);
    assert.deepStrictEqual(mergedNode.metadata.original_source_ids, ["st1_1", "st1_2"]);
    assert.strictEqual(mergedNode.metadata.architectural_reasoning, "Reasoning for merged lesson");

    // 3. New Lesson (No sources -> Default 0.1)
    const newNode = finalNodes.find(n => n.title === "New Lesson");
    assert.strictEqual(newNode.confidence_score, 0.1);
    assert.deepStrictEqual(newNode.metadata.original_source_ids, []);
    assert.strictEqual(newNode.metadata.architectural_reasoning, "Reasoning for new lesson");
  });
});
