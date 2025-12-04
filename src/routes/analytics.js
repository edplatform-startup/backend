import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { validateUuid } from '../utils/validation.js';

const router = Router();

// GET /analytics/usage
// Query params: userId (optional), courseId (optional), source (optional), limit (optional, default 100)
router.get('/usage', async (req, res) => {
  const { userId, courseId, source, limit = 100 } = req.query;
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

  if (courseId) {
    query = query.eq('course_id', courseId);
  }

  if (source) {
    query = query.eq('source', source);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching usage stats:', error);
    return res.status(500).json({ error: 'Failed to fetch usage data', details: error.message });
  }

  return res.json({ success: true, usage: data });
});

// GET /analytics/usage/summary
// Query params: userId (optional), courseId (optional) - filters for specific user/course
router.get('/usage/summary', async (req, res) => {
  const { userId, courseId } = req.query;
  const supabase = getSupabase();

  let query = supabase
    .schema('api')
    .from('usage_stats')
    .select('user_id, course_id, cost_usd, total_tokens, model, source');

  if (userId) {
    query = query.eq('user_id', userId);
  }

  if (courseId) {
    query = query.eq('course_id', courseId);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching usage summary:', error);
    return res.status(500).json({ error: 'Failed to fetch usage summary', details: error.message });
  }

  const totalSpend = data.reduce((sum, record) => sum + (record.cost_usd || 0), 0);
  const totalTokens = data.reduce((sum, record) => sum + (record.total_tokens || 0), 0);
  const totalCalls = data.length;

  // Calculate unique users and courses
  const uniqueUsers = new Set(data.map(r => r.user_id)).size;
  const uniqueCourses = new Set(data.filter(r => r.course_id).map(r => r.course_id)).size;
  const avgSpendPerUser = uniqueUsers > 0 ? totalSpend / uniqueUsers : 0;

  // Group by source for breakdown
  const bySource = {};
  data.forEach(record => {
    const src = record.source || 'unknown';
    if (!bySource[src]) {
      bySource[src] = { calls: 0, tokens: 0, cost: 0 };
    }
    bySource[src].calls++;
    bySource[src].tokens += record.total_tokens || 0;
    bySource[src].cost += record.cost_usd || 0;
  });

  // Round costs in bySource
  Object.keys(bySource).forEach(src => {
    bySource[src].cost = Number(bySource[src].cost.toFixed(6));
  });

  return res.json({
    success: true,
    summary: {
      total_spend: Number(totalSpend.toFixed(4)),
      total_calls: totalCalls,
      total_tokens: totalTokens,
      average_spend_per_user: Number(avgSpendPerUser.toFixed(4)),
      unique_users: uniqueUsers,
      unique_courses: uniqueCourses,
      by_source: bySource
    }
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

/**
 * GET /analytics/lookup
 * Get user email and course name for given userId and/or courseId
 * Query params: userId, courseId (at least one required)
 */
router.get('/lookup', async (req, res) => {
  const { userId, courseId } = req.query;

  if (!userId && !courseId) {
    return res.status(400).json({ error: 'At least one of userId or courseId is required' });
  }

  const supabase = getSupabase();
  const result = {
    success: true,
    user: null,
    course: null
  };

  // Get course info if courseId provided
  if (courseId) {
    const { data: course, error: courseError } = await supabase
      .schema('api')
      .from('courses')
      .select('id, title, user_id, created_at')
      .eq('id', courseId)
      .single();

    if (courseError && courseError.code !== 'PGRST116') {
      console.error('Error fetching course:', courseError);
      return res.status(500).json({ error: 'Failed to fetch course', details: courseError.message });
    }

    if (course) {
      result.course = {
        id: course.id,
        title: course.title,
        userId: course.user_id,
        createdAt: course.created_at
      };
    }
  }

  // Get user info if userId provided
  if (userId) {
    // Try to get email from feedback table (most recent submission with email)
    const { data: feedback, error: feedbackError } = await supabase
      .schema('api')
      .from('feedback')
      .select('user_email, created_at')
      .eq('user_id', userId)
      .not('user_email', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (feedbackError && feedbackError.code !== 'PGRST116') {
      console.error('Error fetching user email from feedback:', feedbackError);
    }

    if (feedback && feedback.user_email) {
      result.user = {
        id: userId,
        email: feedback.user_email,
        emailSource: 'feedback'
      };
    } else {
      // Try to get email from Supabase auth.users via admin API
      try {
        const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(userId);
        
        if (!authError && authUser && authUser.user) {
          result.user = {
            id: userId,
            email: authUser.user.email,
            emailSource: 'auth'
          };
        } else {
          result.user = {
            id: userId,
            email: null,
            emailSource: null,
            note: 'Email not found - user may not have submitted feedback or auth access unavailable'
          };
        }
      } catch (authErr) {
        console.error('Error fetching user from auth:', authErr);
        result.user = {
          id: userId,
          email: null,
          emailSource: null,
          note: 'Email not found - auth admin access may not be configured'
        };
      }
    }
  }

  return res.json(result);
});

/**
 * GET /analytics/usage-by-user
 * Get aggregated API usage stats grouped by user with optional course info
 * Query params: startDate, endDate, includeEmail (boolean)
 */
router.get('/usage-by-user', async (req, res) => {
  const { startDate, endDate, includeEmail } = req.query;

  const supabase = getSupabase();

  let query = supabase
    .schema('api')
    .from('usage_stats')
    .select('user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, source, course_id, created_at');

  if (startDate) {
    query = query.gte('created_at', startDate);
  }

  if (endDate) {
    query = query.lte('created_at', endDate);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching usage by user:', error);
    return res.status(500).json({ error: 'Failed to fetch usage by user', details: error.message });
  }

  // Aggregate by user
  const userStats = {};
  for (const row of data) {
    const uid = row.user_id || 'anonymous';
    if (!userStats[uid]) {
      userStats[uid] = {
        userId: uid,
        totalCost: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        courses: new Set(),
        sources: new Set()
      };
    }
    userStats[uid].totalCost += row.cost_usd || 0;
    userStats[uid].totalPromptTokens += row.prompt_tokens || 0;
    userStats[uid].totalCompletionTokens += row.completion_tokens || 0;
    userStats[uid].totalTokens += row.total_tokens || 0;
    userStats[uid].requestCount++;
    if (row.course_id) userStats[uid].courses.add(row.course_id);
    if (row.source) userStats[uid].sources.add(row.source);
  }

  // Convert Sets to arrays for JSON serialization
  const result = Object.values(userStats).map(u => ({
    ...u,
    courses: Array.from(u.courses),
    sources: Array.from(u.sources)
  }));

  // Optionally fetch emails
  if (includeEmail === 'true') {
    for (const user of result) {
      if (user.userId !== 'anonymous') {
        const { data: feedback } = await supabase
          .schema('api')
          .from('feedback')
          .select('user_email')
          .eq('user_id', user.userId)
          .not('user_email', 'is', null)
          .limit(1)
          .single();
        
        user.email = feedback?.user_email || null;
      }
    }
  }

  return res.json({ success: true, users: result });
});

export default router;
