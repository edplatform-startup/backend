import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { generateLessonGraph, __setLLMCaller } from '../src/services/courseGenerator.js';
import { callStageLLM } from '../src/services/llmCall.js';

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

    // assert.strictEqual(finalNodes.length, 3); // Removed, we now expect 5
    
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

    // --- Verify Practice Exams ---
    // Expect 3 original + 2 exams = 5 nodes
    assert.strictEqual(finalNodes.length, 5);

    const midTerm = finalNodes.find(n => n.title === 'Mid-Term Practice Exam');
    const finalExam = finalNodes.find(n => n.title === 'Final Practice Exam');

    assert.ok(midTerm, 'Mid-Term Exam should exist');
    assert.ok(finalExam, 'Final Exam should exist');

    // Verify Mid-Term placement
    // In a 3-node chain (Good->Merged->New), midIndex is 1.
    // Preceding: [Good] (index 0)
    // Edge: Good -> MidTerm
    // Edge: MidTerm -> Merged
    assert.strictEqual(midTerm.metadata.preceding_lessons.length, 1);
    assert.strictEqual(midTerm.metadata.preceding_lessons[0].title, 'Good Lesson');
    
    // Verify Final Exam placement
    // Preceding: All 3 original nodes
    assert.strictEqual(finalExam.metadata.preceding_lessons.length, 3);
    
    // Verify Edges
    // Good -> MidTerm
    const goodToMid = finalEdges.find(e => e.parent_id === goodNode.id && e.child_id === midTerm.id);
    assert.ok(goodToMid, 'Edge from Good Lesson to Mid-Term should exist');

    // MidTerm -> Merged
    const midToMerged = finalEdges.find(e => e.parent_id === midTerm.id && e.child_id === mergedNode.id);
    assert.ok(midToMerged, 'Edge from Mid-Term to Merged Lesson should exist');

    // New -> Final
    const newToFinal = finalEdges.find(e => e.parent_id === newNode.id && e.child_id === finalExam.id);
    assert.ok(newToFinal, 'Edge from New Lesson to Final Exam should exist');
  });
});

after(() => {
  __setLLMCaller(callStageLLM);
});
