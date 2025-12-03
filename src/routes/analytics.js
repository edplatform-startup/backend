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

// GET /analytics/events
// Query params:
// - userId (required)
// - eventTypes (optional, comma-separated)
// - courseId (optional)
// - startDate (optional ISO)
// - endDate (optional ISO)
// - limit (optional, default 50)
// - offset (optional, default 0)
router.get('/events', async (req, res) => {
  const { userId, eventTypes, courseId, startDate, endDate, limit = 50, offset = 0 } = req.query;

  const supabase = getSupabase();
  let query = supabase
    .schema('api')
    .from('analytics_events')
    .select('*', { count: 'exact' });

  if (userId) {
    query = query.eq('user_id', userId);
  }

  query = query
    .order('created_at', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (eventTypes) {
    const types = eventTypes.split(',').map(t => t.trim());
    query = query.in('event_type', types);
  }

  if (courseId) {
    // Filter by details->>courseId
    query = query.eq('details->>courseId', courseId);
  }

  if (startDate) {
    query = query.gte('created_at', startDate);
  }

  if (endDate) {
    query = query.lte('created_at', endDate);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('Error fetching analytics events:', error);
    return res.status(500).json({ error: 'Failed to fetch analytics events', details: error.message });
  }

  return res.json({ success: true, events: data, count });
});

// GET /analytics/events/summary
// Query params:
// - userId (required)
// - groupBy (optional: 'event_type' | 'date', default 'event_type')
// - courseId (optional)
// - startDate (optional ISO)
// - endDate (optional ISO)
router.get('/events/summary', async (req, res) => {
  const { userId, groupBy = 'event_type', courseId, startDate, endDate } = req.query;

  const supabase = getSupabase();

  // We fetch relevant data and aggregate in memory for flexibility
  let query = supabase
    .schema('api')
    .from('analytics_events')
    .select('event_type, created_at, details');

  if (userId) {
    query = query.eq('user_id', userId);
  }

  if (courseId) {
    query = query.eq('details->>courseId', courseId);
  }

  if (startDate) {
    query = query.gte('created_at', startDate);
  }

  if (endDate) {
    query = query.lte('created_at', endDate);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching analytics summary:', error);
    return res.status(500).json({ error: 'Failed to fetch analytics summary', details: error.message });
  }

  const summary = {};

  if (groupBy === 'date') {
    // Group by YYYY-MM-DD
    data.forEach(event => {
      const date = new Date(event.created_at).toISOString().split('T')[0];
      if (!summary[date]) summary[date] = 0;
      summary[date]++;
    });
  } else {
    // Group by event_type (default)
    data.forEach(event => {
      const type = event.event_type;
      if (!summary[type]) summary[type] = 0;
      summary[type]++;
    });
  }

  return res.json({ success: true, summary });
});

export default router;
