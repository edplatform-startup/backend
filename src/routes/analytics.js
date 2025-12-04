import { Router } from 'express';
import { getSupabase } from '../supabaseClient.js';
import { validateUuid } from '../utils/validation.js';

const router = Router();

/**
 * Helper function to verify admin status from Authorization header token
 * @param {object} supabase - Supabase client
 * @param {string} authHeader - Authorization header value (e.g., "Bearer <token>")
 * @returns {Promise<{isAdmin: boolean, userId: string|null, email: string|null}>}
 */
async function verifyAdminFromToken(supabase, authHeader) {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { isAdmin: false, userId: null, email: null };
  }

  const token = authHeader.replace('Bearer ', '');

  // Verify the token and get the user
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  
  if (authError || !user) {
    console.error('Error verifying token:', authError);
    return { isAdmin: false, userId: null, email: null };
  }

  const userEmail = user.email;
  if (!userEmail) {
    return { isAdmin: false, userId: user.id, email: null };
  }

  // Check if email is in the admins table
  const { data: adminRecord, error: adminError } = await supabase
    .schema('public')
    .from('admins')
    .select('email')
    .eq('email', userEmail.toLowerCase())
    .single();

  if (adminError && adminError.code !== 'PGRST116') {
    console.error('Error checking admin status:', adminError);
  }

  return { isAdmin: !!adminRecord, userId: user.id, email: userEmail };
}

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
 * GET /analytics/usage-by-course
 * Get aggregated API usage stats grouped by course
 * Query params: admin (boolean), startDate, endDate, limit, includeCourseName (boolean)
 * Must provide either (startDate AND endDate) OR limit, but not both
 * When admin=true, verifies Authorization header token and returns all courses data
 */
router.get('/usage-by-course', async (req, res) => {
  const { admin, startDate, endDate, limit, includeCourseName } = req.query;

  // Validate: must have (startDate AND endDate) XOR limit
  const hasDateRange = startDate && endDate;
  const hasLimit = limit !== undefined;
  
  if (!hasDateRange && !hasLimit) {
    return res.status(400).json({ error: 'Must provide either (startDate and endDate) or limit' });
  }
  if (hasDateRange && hasLimit) {
    return res.status(400).json({ error: 'Cannot provide both date range and limit. Use one or the other.' });
  }
  if ((startDate && !endDate) || (!startDate && endDate)) {
    return res.status(400).json({ error: 'Both startDate and endDate are required when using date range' });
  }

  const supabase = getSupabase();

  // If admin=true, verify admin status from Authorization header
  if (admin === 'true') {
    const authHeader = req.headers.authorization;
    const { isAdmin, email } = await verifyAdminFromToken(supabase, authHeader);
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }
  }

  let query = supabase
    .schema('api')
    .from('usage_stats')
    .select('course_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, source, created_at')
    .not('course_id', 'is', null)
    .order('created_at', { ascending: false });

  if (hasDateRange) {
    query = query.gte('created_at', startDate).lte('created_at', endDate);
  } else if (hasLimit) {
    query = query.limit(Number(limit));
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error fetching usage by course:', error);
    return res.status(500).json({ error: 'Failed to fetch usage by course', details: error.message });
  }

  // Aggregate by course
  const courseStats = {};
  for (const row of data) {
    const cid = row.course_id;
    if (!courseStats[cid]) {
      courseStats[cid] = {
        courseId: cid,
        totalCost: 0,
        totalPromptTokens: 0,
        totalCompletionTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        sources: new Set()
      };
    }
    courseStats[cid].totalCost += row.cost_usd || 0;
    courseStats[cid].totalPromptTokens += row.prompt_tokens || 0;
    courseStats[cid].totalCompletionTokens += row.completion_tokens || 0;
    courseStats[cid].totalTokens += row.total_tokens || 0;
    courseStats[cid].requestCount++;
    if (row.source) courseStats[cid].sources.add(row.source);
  }

  // Convert Sets to arrays for JSON serialization
  const result = Object.values(courseStats).map(c => ({
    ...c,
    sources: Array.from(c.sources)
  }));

  // Optionally fetch course names (only when admin=true)
  if (includeCourseName === 'true' && admin === 'true') {
    const courseIds = result.map(c => c.courseId);
    if (courseIds.length > 0) {
      const { data: courses, error: coursesError } = await supabase
        .schema('api')
        .from('courses')
        .select('id, title')
        .in('id', courseIds);

      if (!coursesError && courses) {
        const courseNameMap = {};
        for (const course of courses) {
          courseNameMap[course.id] = course.title;
        }
        for (const course of result) {
          course.courseName = courseNameMap[course.courseId] || null;
        }
      } else {
        // If fetch fails, set courseName to null
        for (const course of result) {
          course.courseName = null;
        }
      }
    }
  }

  return res.json({ success: true, courses: result });
});

/**
 * GET /analytics/usage-by-user
 * Get aggregated API usage stats grouped by user with optional course info
 * Query params: admin (boolean), startDate, endDate, limit, includeEmail (boolean)
 * Must provide either (startDate AND endDate) OR limit, but not both
 * When admin=true, verifies Authorization header token and returns all users data with emails
 */
router.get('/usage-by-user', async (req, res) => {
  const { admin, startDate, endDate, limit, includeEmail } = req.query;

  // Validate: must have (startDate AND endDate) XOR limit
  const hasDateRange = startDate && endDate;
  const hasLimit = limit !== undefined;
  
  if (!hasDateRange && !hasLimit) {
    return res.status(400).json({ error: 'Must provide either (startDate and endDate) or limit' });
  }
  if (hasDateRange && hasLimit) {
    return res.status(400).json({ error: 'Cannot provide both date range and limit. Use one or the other.' });
  }
  if ((startDate && !endDate) || (!startDate && endDate)) {
    return res.status(400).json({ error: 'Both startDate and endDate are required when using date range' });
  }

  const supabase = getSupabase();

  // If admin=true, verify admin status from Authorization header
  if (admin === 'true') {
    const authHeader = req.headers.authorization;
    const { isAdmin, email } = await verifyAdminFromToken(supabase, authHeader);
    
    if (!isAdmin) {
      return res.status(403).json({ error: 'Access denied. Admin privileges required.' });
    }
  }

  let query = supabase
    .schema('api')
    .from('usage_stats')
    .select('user_id, model, prompt_tokens, completion_tokens, total_tokens, cost_usd, source, course_id, created_at')
    .order('created_at', { ascending: false });

  if (hasDateRange) {
    query = query.gte('created_at', startDate).lte('created_at', endDate);
  } else if (hasLimit) {
    query = query.limit(Number(limit));
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

  // Fetch emails for all users (only when admin=true)
  if (includeEmail === 'true' && admin === 'true') {
    for (const user of result) {
      if (user.userId !== 'anonymous') {
        // First try auth admin API for definitive email
        try {
          const { data: authUser, error: authError } = await supabase.auth.admin.getUserById(user.userId);
          if (!authError && authUser && authUser.user && authUser.user.email) {
            user.email = authUser.user.email;
            continue;
          }
        } catch (authErr) {
          // Fall through to feedback lookup
        }

        // Fallback to feedback table
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
