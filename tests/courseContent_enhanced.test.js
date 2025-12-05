import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCourseContent, __setGrokExecutor, __resetGrokExecutor } from '../src/services/courseContent.js';
import { setSupabaseClient, clearSupabaseClient } from '../src/supabaseClient.js';
import { createSupabaseStub } from './helpers/supabaseStub.js';

test('Course Content Enrichment Tests', async (t) => {
  await t.test('generateReading enriches content with images and questions', async () => {
    // Setup Supabase stub
    const pendingNodes = [
      {
        id: 'node-reading-1',
        title: 'Enhanced Lesson',
        content_payload: {
          status: 'pending',
          generation_plans: {
            reading: 'Explain the water cycle.',
          },
        },
        module_ref: 'Module 1',
      },
    ];

    const nodeUpdates = [];
    const stub = createSupabaseStub({
      listResponses: [
        { data: pendingNodes, error: null },  // Initial pending nodes fetch
        { data: pendingNodes, error: null },  // All nodes fetch for prereq map
        { data: [], error: null },            // All edges fetch for prereq map
      ],
      updateResponses: [
        { data: { id: 'node-reading-1' }, error: null, onUpdate: (payload) => nodeUpdates.push(payload) },
        { data: { id: 'course-1' }, error: null },
      ],
      singleResponses: [
         { data: { title: 'Science Course', metadata: { mode: 'deep' }, user_id: 'user-test' }, error: null } // for course title fetch
      ]
    });
    setSupabaseClient(stub);

    // Mock Grok Executor
    __setGrokExecutor(async ({ messages }) => {
      const lastMessage = messages[messages.length - 1].content;
      const systemMessage = messages.find(m => m.role === 'system')?.content || '';
      
      // Handle validation calls (validator model)
      if (systemMessage.includes('Quality Assurance Validator')) {
        return { content: 'CORRECT' };
      }

      // 1. Batched Reading Generation
      if (systemMessage.includes('Generate readings for ALL') || lastMessage.includes('Generate a clear, student-facing Markdown reading')) {
        // Return batched format with lesson delimiter
        return {
          content: `===LESSON:node-reading-1===
# The Water Cycle

Water moves around the earth. It is a continuous process that sustains life on our planet. The water cycle involves several key stages including evaporation, condensation, and precipitation. This cycle has been happening for billions of years.

## Evaporation

Sun heats water. The energy from the sun causes water molecules to become excited and turn into water vapor. This vapor rises into the atmosphere. Evaporation happens from oceans, lakes, and rivers. It is the primary way water moves from the surface to the air.

## Condensation

Clouds form. As water vapor rises, it cools down and turns back into liquid water droplets. These droplets cluster together to form clouds. Condensation is crucial for the formation of rain and snow. It is the opposite of evaporation.

## Precipitation

Rain falls. When clouds become heavy with water droplets, gravity pulls them down to earth. This can happen as rain, snow, sleet, or hail. Precipitation replenishes fresh water sources on the ground.`
        };
      }

      // 2. Batched Inline Question Generation (CSV format)
      if (systemMessage.includes('Check Your Understanding') || systemMessage.includes('inline MCQs for EACH')) {
        return {
          content: `lesson_id,chunk_index,question,optionA,optionB,optionC,optionD,correct_index,expA,expB,expC,expD,confidence
node-reading-1,0,"What drives evaporation?","The Moon","The Sun","Wind","Magic",1,"The moon does not provide energy for evaporation.","The sun provides the heat energy that causes water to evaporate.","Wind helps with evaporation but is not the primary driver.","Magic is not a scientific explanation.",0.85`
        };
      }

      // Legacy per-chunk Inline Question Generation (CSV format)
      if (systemMessage.includes('Generate a deep-understanding MCQ') || systemMessage.includes('deep-understanding MCQ')) {
        return {
          content: `"What drives evaporation?","The Moon","The Sun","Wind","Magic",1,"The moon does not provide energy for evaporation.","The sun provides the heat energy that causes water to evaporate.","Wind helps with evaporation but is not the primary driver.","Magic is not a scientific explanation.",0.85`
        };
      }

      return { content: '{}' };
    });

    // Note: Image search is no longer used in reading generation

    try {
      const result = await generateCourseContent('course-1', { concurrency: 1 });
      
      assert.equal(result.status, 'ready');
      assert.equal(nodeUpdates.length, 1);
      
      const reading = nodeUpdates[0].content_payload.reading;
      
      // Check for questions (inline questions are still generated)
      assert.ok(reading.includes('**Check Your Understanding**'), 'Should contain inline question');
      assert.ok(reading.includes('<details><summary>Show Answer</summary>'), 'Should contain answer reveal');
      
      // Check that content contains the original reading
      assert.ok(reading.includes('The Water Cycle'), 'Should contain original content');

    } finally {
      __resetGrokExecutor();
      clearSupabaseClient();
    }
  });

  await t.test('generateReading handles enrichment failures gracefully', async () => {
     // Setup Supabase stub
     const pendingNodes = [
      {
        id: 'node-reading-2',
        title: 'Resilient Lesson',
        content_payload: {
          status: 'pending',
          generation_plans: {
            reading: 'Simple topic.',
          },
        },
      },
    ];

    const nodeUpdates = [];
    const stub = createSupabaseStub({
      listResponses: [
        { data: pendingNodes, error: null },  // Initial pending nodes fetch
        { data: pendingNodes, error: null },  // All nodes fetch for prereq map
        { data: [], error: null },            // All edges fetch for prereq map
      ],
      updateResponses: [
        { data: { id: 'node-reading-2' }, error: null, onUpdate: (payload) => nodeUpdates.push(payload) },
        { data: { id: 'course-1' }, error: null },
      ],
      singleResponses: [
          { data: { title: 'Course', metadata: { mode: 'deep' }, user_id: 'user-test' }, error: null }
      ]
    });
    setSupabaseClient(stub);

    // Mock Grok to return reading but FAIL on questions
    __setGrokExecutor(async ({ messages }) => {
      const lastMessage = messages[messages.length - 1].content;
      if (lastMessage.includes('Generate a clear')) {
        return {
          content: JSON.stringify({
            final_content: { markdown: '# Heading\nContent.' }
          })
        };
      }
      // Fail question generation
      throw new Error('Grok failed');
    });

    // Note: Image search is no longer used

    try {
      await generateCourseContent('course-1', { concurrency: 1 });
      
      const reading = nodeUpdates[0].content_payload.reading;
      
      // Should still have the original text
      assert.ok(reading.includes('# Heading'), 'Should contain heading');
      assert.ok(reading.includes('Content.'), 'Should contain content');
      
      // Should NOT have images or questions (but shouldn't crash)
      assert.ok(!reading.includes('![Illustration]'), 'Should not have images');
      assert.ok(!reading.includes('**Question:**'), 'Should not have questions');

    } finally {
      __resetGrokExecutor();
      clearSupabaseClient();
    }
  });
});
