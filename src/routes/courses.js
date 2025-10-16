import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';

const router = Router();

// GET /courses?query=cs50
router.get('/', async (req, res) => {
  const q = (req.query.query || '').toString().trim();
  if (!q) {
    return res.status(400).json({ error: 'Missing required query parameter: query' });
  }

  // Basic sanitation: limit length
  const term = q.slice(0, 100);

  // Strategy:
  // - Use ilike for case-insensitive matching on code and title
  // - Support partial matches anywhere using %term%
  // - Select only needed columns
  try {
    // Courses table resides in the 'api' schema
    const supabase = getSupabase().schema('api');
    const pattern = `%${term}%`;
    const { data, error } = await supabase
      .from('courses')
      .select('code,title')
      .or(`code.ilike.${pattern},title.ilike.${pattern}`)
      .limit(50);

    if (error) {
      console.error('Supabase error:', error);
      return res.status(500).json({ error: 'Failed to fetch courses' });
    }

    // Normalize output shape
    const items = (data || []).map((row) => ({
      code: row.code,
      title: row.title,
    }));

    return res.json({ query: term, count: items.length, items });
  } catch (e) {
    console.error('Unhandled error fetching courses:', e);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
