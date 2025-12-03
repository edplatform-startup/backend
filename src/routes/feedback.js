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

// GET /feedback
router.get('/', async (req, res) => {
  const { userId, type, limit = 50, offset = 0 } = req.query;

  try {
    const supabase = getSupabase();
    let query = supabase
      .schema('api')
      .from('feedback')
      .select('*', { count: 'exact' });

    if (userId) {
      query = query.eq('user_id', userId);
    }

    if (type) {
      query = query.eq('type', type);
    }

    query = query
      .order('created_at', { ascending: false })
      .range(Number(offset), Number(offset) + Number(limit) - 1);

    const { data, error, count } = await query;

    if (error) {
      console.error('Error fetching feedback:', error);
      return res.status(500).json({
        error: 'Failed to fetch feedback',
        details: error.message
      });
    }

    return res.status(200).json({
      success: true,
      feedback: data,
      count
    });
  } catch (error) {
    console.error('Unexpected error fetching feedback:', error);
    return res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

export default router;
