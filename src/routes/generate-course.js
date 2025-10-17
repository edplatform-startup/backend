import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { readFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = Router();

/**
 * Validates that the course JSON matches the expected schema structure
 * Expected format:
 * {
 *   "Topic/Subtopic": [
 *     { "Format": "video|reading|mini quiz|flashcards|practice exam", "content": "string" },
 *     ...
 *   ],
 *   ...
 * }
 */
function validateCourseSchema(courseJson) {
  // Check if courseJson is an object
  if (!courseJson || typeof courseJson !== 'object' || Array.isArray(courseJson)) {
    return { valid: false, error: 'Course must be an object with topic keys' };
  }

  // Check if there's at least one topic
  const topics = Object.keys(courseJson);
  if (topics.length === 0) {
    return { valid: false, error: 'Course must contain at least one topic' };
  }

  // Valid content formats
  const validFormats = ['video', 'reading', 'mini quiz', 'flashcards', 'practice exam'];

  // Validate each topic
  for (const topic of topics) {
    // Topic key should be a non-empty string with format "Topic/Subtopic"
    if (typeof topic !== 'string' || !topic.includes('/')) {
      return { 
        valid: false, 
        error: `Invalid topic key: "${topic}". Expected format: "Topic/Subtopic"` 
      };
    }

    const content = courseJson[topic];

    // Each topic should map to an array
    if (!Array.isArray(content)) {
      return { 
        valid: false, 
        error: `Topic "${topic}" must contain an array of content items` 
      };
    }

    // Each topic should have at least one content item
    if (content.length === 0) {
      return { 
        valid: false, 
        error: `Topic "${topic}" must contain at least one content item` 
      };
    }

    // Validate each content item
    for (let i = 0; i < content.length; i++) {
      const item = content[i];

      // Each item must be an object
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return { 
          valid: false, 
          error: `Topic "${topic}": item ${i} must be an object` 
        };
      }

      // Each item must have Format and content fields
      if (!item.Format || !item.content) {
        return { 
          valid: false, 
          error: `Topic "${topic}": item ${i} missing required fields "Format" or "content"` 
        };
      }

      // Format must be a valid type
      if (!validFormats.includes(item.Format)) {
        return { 
          valid: false, 
          error: `Topic "${topic}": item ${i} has invalid Format "${item.Format}". Must be one of: ${validFormats.join(', ')}` 
        };
      }

      // Content must be a non-empty string
      if (typeof item.content !== 'string' || item.content.trim().length === 0) {
        return { 
          valid: false, 
          error: `Topic "${topic}": item ${i} must have non-empty string content` 
        };
      }
    }
  }

  return { valid: true };
}

// POST /generate-course
// Body: { userId: "user-uuid-string" }
router.post('/', async (req, res) => {
  const { userId } = req.body;
  
  if (!userId) {
    return res.status(400).json({ error: 'Missing required field: userId' });
  }

  // Validate UUID format (basic validation)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(userId)) {
    return res.status(400).json({ error: 'Invalid userId format. Must be a valid UUID.' });
  }

  try {
    // Read the ml_course.json file
    const coursePath = join(__dirname, '../../resources/ml_course.json');
    const courseData = await readFile(coursePath, 'utf-8');
    const courseJson = JSON.parse(courseData);

    // Validate the course schema
    const validation = validateCourseSchema(courseJson);
    if (!validation.valid) {
      return res.status(400).json({ 
        error: 'Invalid course format', 
        details: validation.error 
      });
    }

    // Insert into the courses table in the api schema
    const supabase = getSupabase();
    const { data, error } = await supabase
      .from('courses')
      .insert({
        user_uuid: userId,
        course_json: courseJson
      })
      .select()
      .single();

    if (error) {
      console.error('Supabase error inserting course:', error);
      return res.status(500).json({ error: 'Failed to insert course', details: error.message });
    }

    return res.status(201).json({
      success: true,
      message: 'Course created successfully',
      course: {
        id: data.id,
        user_uuid: data.user_uuid,
        created_at: data.created_at
      }
    });
  } catch (e) {
    console.error('Unhandled error creating course:', e);
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

export default router;
