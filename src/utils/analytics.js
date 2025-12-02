import { getSupabase } from '../supabaseClient.js';

/**
 * Logs a usage event to the analytics_events table.
 * 
 * @param {string} userId - The UUID of the user.
 * @param {string} eventType - The type of event (e.g., 'course_created', 'lesson_opened').
 * @param {object} details - Additional details about the event.
 */
export async function logUsageEvent(userId, eventType, details = {}) {
  if (!userId) {
    console.warn('[Analytics] Skipping log: No userId provided for event', eventType);
    return;
  }

  try {
    const supabase = getSupabase();
    // Fire and forget - we don't await the result to avoid blocking the main thread significantly,
    // but we do catch errors to prevent unhandled rejections if we were to await.
    // However, since we want to be safe, we'll just trigger it.
    
    // Note: In a high-throughput system, we might want to batch these or use a queue.
    // For now, direct insert is fine as per requirements.
    
    supabase
      .schema('api')
      .from('analytics_events')
      .insert({
        user_id: userId,
        event_type: eventType,
        details,
        created_at: new Date().toISOString()
      })
      .then(({ error }) => {
        if (error) {
          console.error(`[Analytics] Failed to log event ${eventType}:`, error.message);
        }
      })
      .catch(err => {
        console.error(`[Analytics] Unexpected error logging event ${eventType}:`, err);
      });

  } catch (error) {
    console.error('[Analytics] Failed to initialize Supabase or log event:', error);
  }
}
