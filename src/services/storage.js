import { getSupabase } from '../supabaseClient.js';

const BUCKET_NAME = 'practice_exams';

/**
 * Uploads a file buffer to Supabase Storage.
 * 
 * @param {string} courseId - The course ID associated with the file
 * @param {string} userId - The user ID (for path organization)
 * @param {Uint8Array|Buffer} fileBuffer - The file content
 * @param {string} fileName - The name of the file
 * @returns {Promise<string>} The public URL of the uploaded file
 */
export async function uploadExamFile(courseId, userId, fileBuffer, fileName) {
  const supabase = getSupabase();
  
  // Sanitize filename
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const filePath = `${userId}/${courseId}/${Date.now()}_${safeFileName}`;

  const { data, error } = await supabase
    .storage
    .from(BUCKET_NAME)
    .upload(filePath, fileBuffer, {
      contentType: 'application/pdf',
      upsert: true
    });

  if (error) {
    console.error('[storage] Upload failed:', error);
    throw new Error(`Failed to upload exam file: ${error.message}`);
  }

  // Get public URL
  const { data: { publicUrl } } = supabase
    .storage
    .from(BUCKET_NAME)
    .getPublicUrl(filePath);

  return publicUrl;
}
