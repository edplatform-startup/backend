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
export async function uploadExamFile(courseId, userId, fileBuffer, fileName, contentType = 'application/pdf') {
  const supabase = getSupabase();
  
  // Sanitize filename
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const filePath = `${userId}/${courseId}/${Date.now()}_${safeFileName}`;

  const { data, error } = await supabase
    .storage
    .from(BUCKET_NAME)
    .upload(filePath, fileBuffer, {
      contentType,
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

/**
 * Deletes all files for a course from Supabase Storage.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @returns {Promise<{deleted: number, errors: string[]}>} Deletion result
 */
export async function deleteCourseFiles(courseId, userId) {
  const supabase = getSupabase();
  const folderPath = `${userId}/${courseId}`;

  // List all files in the course folder
  const { data: files, error: listError } = await supabase
    .storage
    .from(BUCKET_NAME)
    .list(folderPath);

  if (listError) {
    console.error('[storage] Failed to list files for deletion:', listError);
    return { deleted: 0, errors: [listError.message] };
  }

  if (!files || files.length === 0) {
    return { deleted: 0, errors: [] };
  }

  // Build full paths for deletion
  const filePaths = files.map(f => `${folderPath}/${f.name}`);

  const { data, error: deleteError } = await supabase
    .storage
    .from(BUCKET_NAME)
    .remove(filePaths);

  if (deleteError) {
    console.error('[storage] Failed to delete files:', deleteError);
    return { deleted: 0, errors: [deleteError.message] };
  }

  return { deleted: data?.length || filePaths.length, errors: [] };
}

/**
 * Lists all exam files for a course.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @returns {Promise<Array<{name: string, url: string}>>} List of files
 */
export async function getCourseExamFiles(courseId, userId) {
  const supabase = getSupabase();
  const folderPath = `${userId}/${courseId}`;

  const { data: files, error } = await supabase
    .storage
    .from(BUCKET_NAME)
    .list(folderPath);

  if (error) {
    console.error('[storage] Failed to list files:', error);
    return [];
  }

  if (!files || files.length === 0) {
    return [];
  }

  // Generate public URLs for each file
  return files.map(f => {
    const { data: { publicUrl } } = supabase
      .storage
      .from(BUCKET_NAME)
      .getPublicUrl(`${folderPath}/${f.name}`);
    
    return {
      name: f.name,
      url: publicUrl
    };
  });
}
