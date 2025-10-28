import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { validateUuid } from '../utils/validation.js';

const router = Router();

const TABLE_BY_FORMAT = new Map([
  ['video', 'video_items'],
  ['reading', 'reading_articles'],
  ['flashcards', 'flashcard_sets'],
  ['mini quiz', 'mini_quizzes'],
  ['mini_quiz', 'mini_quizzes'],
  ['practice exam', 'practice_exams'],
  ['practice_exam', 'practice_exams'],
]);

function resolveTable(format) {
  if (!format || typeof format !== 'string') return null;
  const key = format.toLowerCase();
  return TABLE_BY_FORMAT.get(key) || null;
}

// GET /content?format=video|reading|flashcards|mini_quiz|practice_exam&id=<uuid>
router.get('/', async (req, res) => {
  const { format, id } = req.query;

  const table = resolveTable(format);
  if (!table) return res.status(400).json({ error: 'Invalid format' });

  const v = validateUuid(id, 'id');
  if (!v.valid) return res.status(400).json({ error: v.error });

  try {
    const supabase = getSupabase();
    const { data, error } = await supabase
      .schema('api')
      .from(table)
      .select('id, data')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ error: 'Content not found' });
      console.error('Supabase error fetching content:', error);
      return res.status(500).json({ error: 'Failed to fetch content', details: error.message });
    }

    return res.json({ id: data.id, format, data: data.data });
  } catch (e) {
    console.error('Unhandled error fetching content:', e);
    return res.status(500).json({ error: 'Internal server error', details: e.message });
  }
});

export default router;
