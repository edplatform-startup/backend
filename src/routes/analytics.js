import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';

const router = Router();

// GET /analytics/usage
// Query params: userId (optional), limit (optional, default 100)
router.get('/usage', async (req, res) => {
  const { userId, limit = 100 } = req.query;
  const supabase = getSupabase();

  let query = supabase
    .schema('api')
    .from('usage_stats')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(Number(limit));

  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching usage stats:', error);
    return res.status(500).json({ error: 'Failed to fetch usage data', details: error.message });
  }

  return res.json({ success: true, usage: data });
});

// GET /analytics/usage/summary
// Query params: userId (optional) - if provided, summary for that user. If not, global summary (if allowed).
// For now, we'll just return global summary or per-user summary.
router.get('/usage/summary', async (req, res) => {
  const { userId } = req.query;
  const supabase = getSupabase();

  let query = supabase
    .schema('api')
    .from('usage_stats')
    .select('user_id, cost_usd, total_tokens, model');

  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching usage summary:', error);
    return res.status(500).json({ error: 'Failed to fetch usage summary', details: error.message });
  }

  const totalSpend = data.reduce((sum, record) => sum + (record.cost_usd || 0), 0);
  const totalTokens = data.reduce((sum, record) => sum + (record.total_tokens || 0), 0);
  const totalCalls = data.length;
  
  // Calculate unique users if no userId filter
  const uniqueUsers = new Set(data.map(r => r.user_id)).size;
  const avgSpendPerUser = uniqueUsers > 0 ? totalSpend / uniqueUsers : 0;

  return res.json({
    success: true,
    total_spend: Number(totalSpend.toFixed(4)),
    total_calls: totalCalls,
    total_tokens: totalTokens,
    average_spend_per_user: Number(avgSpendPerUser.toFixed(4)),
    unique_users: uniqueUsers
  });
});

export default router;
