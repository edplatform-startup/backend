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

  // Get signed URL (valid for 1 year to support persistent links)
  const { data: urlData, error: urlError } = await supabase
    .storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, 31536000);

  if (urlError) {
    console.error('[storage] Failed to create signed URL:', urlError);
    throw new Error(`Failed to create signed URL: ${urlError.message}`);
  }

  return urlData.signedUrl;
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

  // Generate signed URLs for each file
  const filePromises = files.map(async f => {
    const { data, error } = await supabase
      .storage
      .from(BUCKET_NAME)
      .createSignedUrl(`${folderPath}/${f.name}`, 60 * 60 * 24); // 24 hours

    if (error) {
      console.error(`[storage] Failed to create signed URL for ${f.name}:`, error);
      return null;
    }

    return {
      name: f.name,
      url: data.signedUrl
    };
  });

  const results = await Promise.all(filePromises);
  return results.filter(r => r !== null);
}

/**
 * Fetches the signed URL for a blank exam template.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @param {string} examType - The type of the exam (e.g., 'midterm', 'final')
 * @param {number} examNumber - The number of the exam (e.g., 1, 2)
 * @returns {Promise<string|null>} The signed URL or null if not found
 */
export async function getBlankExam(courseId, userId, examType, examNumber) {
  const supabase = getSupabase();
  const folderPath = `${userId}/${courseId}`;

  // List all files in the course folder
  const { data: files, error: listError } = await supabase
    .storage
    .from(BUCKET_NAME)
    .list(folderPath);

  if (listError) {
    console.error(`[storage] Failed to list files for blank exam search (type: ${examType}, number: ${examNumber}):`, listError);
    return null;
  }

  if (!files || files.length === 0) {
    console.warn(`[storage] No files found in folder ${folderPath}`);
    return null;
  }

  // Find a file that matches the type and number
  // Expected format: [timestamp]_[type]_exam_[number].pdf
  // Legacy format: [timestamp]_[type]_exam.pdf (treat as #1)

  const typeRegex = new RegExp(`_${examType}_exam(?:_(\\d+))?\\.pdf$`);

  const matchingFile = files.find(f => {
    const match = f.name.match(typeRegex);
    if (!match) return false;

    const num = match[1] ? parseInt(match[1], 10) : 1;
    return num === examNumber;
  });

  if (!matchingFile) {
    console.warn(`[storage] No matching blank exam found for type '${examType}' number '${examNumber}' in ${folderPath}`);
    return null;
  }

  const filePath = `${folderPath}/${matchingFile.name}`;
  console.log(`[storage] Found matching blank exam: ${filePath}`);

  const { data, error } = await supabase
    .storage
    .from(BUCKET_NAME)
    .createSignedUrl(filePath, 60 * 60); // 1 hour

  if (error) {
    console.error(`[storage] Failed to get signed URL for blank exam ${filePath}:`, error);
    return null;
  }

  return data.signedUrl;
}
