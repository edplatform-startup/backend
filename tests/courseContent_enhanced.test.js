import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCourseContent, __setGrokExecutor, __resetGrokExecutor, __setImageSearch, __resetImageSearch } from '../src/services/courseContent.js';
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
      listResponses: [{ data: pendingNodes, error: null }],
      updateResponses: [
        { data: { id: 'node-reading-1' }, error: null, onUpdate: (payload) => nodeUpdates.push(payload) },
        { data: { id: 'course-1' }, error: null },
      ],
      singleResponses: [
         { data: { title: 'Science Course' }, error: null } // for course title fetch
      ]
    });
    setSupabaseClient(stub);

    // Mock Grok Executor
    __setGrokExecutor(async ({ messages }) => {
      const lastMessage = messages[messages.length - 1].content;
      
      // 1. Reading Generation
      if (lastMessage.includes('Generate a clear, student-facing Markdown reading')) {
        return {
          content: JSON.stringify({
            internal_audit: 'audit',
            final_content: {
              markdown: `# The Water Cycle\n\nWater moves around the earth. It is a continuous process that sustains life on our planet. The water cycle involves several key stages including evaporation, condensation, and precipitation. This cycle has been happening for billions of years.\n\n## Evaporation\n\nSun heats water. The energy from the sun causes water molecules to become excited and turn into water vapor. This vapor rises into the atmosphere. Evaporation happens from oceans, lakes, and rivers. It is the primary way water moves from the surface to the air.\n\n## Condensation\n\nClouds form. As water vapor rises, it cools down and turns back into liquid water droplets. These droplets cluster together to form clouds. Condensation is crucial for the formation of rain and snow. It is the opposite of evaporation.\n\n## Precipitation\n\nRain falls. When clouds become heavy with water droplets, gravity pulls them down to earth. This can happen as rain, snow, sleet, or hail. Precipitation replenishes fresh water sources on the ground.`
            }
          })
        };
      }

      // 2. Question Generation
      if (lastMessage.includes('Create one multiple-choice question')) {
        return {
          content: JSON.stringify({
            question: 'What drives evaporation?',
            options: ['The Moon', 'The Sun', 'Wind', 'Magic'],
            answerIndex: 1,
            explanation: 'The sun provides energy.'
          })
        };
      }

      return { content: '{}' };
    });

    // Mock Image Search
    __setImageSearch(async (query) => {
      if (query.includes('Evaporation')) return 'http://img.com/evap.jpg';
      if (query.includes('Condensation')) return 'http://img.com/cond.jpg';
      return null;
    });

    try {
      const result = await generateCourseContent('course-1', { concurrency: 1 });
      
      assert.equal(result.status, 'ready');
      assert.equal(nodeUpdates.length, 1);
      
      const reading = nodeUpdates[0].content_payload.reading;
      
      // Check for images
      assert.ok(reading.includes('![Illustration](http://img.com/evap.jpg)'), 'Should contain evaporation image');
      assert.ok(reading.includes('![Illustration](http://img.com/cond.jpg)'), 'Should contain condensation image');
      
      // Check for questions
      assert.ok(reading.includes('**Question:** What drives evaporation?'), 'Should contain question');
      assert.ok(reading.includes('<details><summary>Show Answer</summary>'), 'Should contain answer reveal');
      
      // Check structure (chunks joined by separator)
      assert.ok(reading.includes('\n\n---\n\n'), 'Chunks should be separated');

    } finally {
      __resetGrokExecutor();
      __resetImageSearch();
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
      listResponses: [{ data: pendingNodes, error: null }],
      updateResponses: [
        { data: { id: 'node-reading-2' }, error: null, onUpdate: (payload) => nodeUpdates.push(payload) },
        { data: { id: 'course-1' }, error: null },
      ],
      singleResponses: [
          { data: { title: 'Course' }, error: null }
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

    // Mock Image Search to fail
    __setImageSearch(async () => {
      throw new Error('Image search failed');
    });

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
      __resetImageSearch();
      clearSupabaseClient();
    }
  });
});
