import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { validateUuid } from '../utils/validation.js';

const router = Router();

const VALID_FEEDBACK_TYPES = ['bug', 'feature', 'content', 'other'];

// POST /feedback
router.post('/', async (req, res) => {
  const { userId, userEmail, type, message, context } = req.body;

  // Validate required fields
  if (!userId) {
    return res.status(400).json({ error: 'userId is required' });
  }

  const userValidation = validateUuid(userId, 'userId');
  if (!userValidation.valid) {
    return res.status(400).json({ error: userValidation.error });
  }

  if (!type) {
    return res.status(400).json({ error: 'type is required' });
  }

  if (!VALID_FEEDBACK_TYPES.includes(type)) {
    return res.status(400).json({ 
      error: `type must be one of: ${VALID_FEEDBACK_TYPES.join(', ')}` 
    });
  }

  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'message is required and must be a non-empty string' });
  }

  try {
    const supabase = getSupabase();

    const { data, error } = await supabase
      .schema('api')
      .from('feedback')
      .insert({
        user_id: userId,
        user_email: userEmail || null,
        type,
        message: message.trim(),
        context: context || {},
        created_at: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.error('Error saving feedback:', error);
      return res.status(500).json({ 
        error: 'Failed to save feedback', 
        details: error.message 
      });
    }

    return res.status(201).json({
      success: true,
      feedback: {
        id: data.id,
        created_at: data.created_at
      }
    });
  } catch (error) {
    console.error('Unexpected error saving feedback:', error);
    return res.status(500).json({ 
      error: 'Internal server error', 
      details: error.message 
    });
  }
});

export default router;
