import { getSupabase } from '../supabaseClient.js';

const CHEATSHEET_BUCKET = 'cheatsheets';

/**
 * Uploads a cheatsheet PDF to Supabase Storage.
 * 
 * @param {string} courseId - The course ID associated with the file
 * @param {string} userId - The user ID (for path organization)
 * @param {Uint8Array|Buffer} fileBuffer - The file content
 * @param {string} fileName - The name of the file
 * @param {string} contentType - MIME type (default: application/pdf)
 * @returns {Promise<string>} The signed URL of the uploaded file
 */
export async function uploadCheatsheetFile(courseId, userId, fileBuffer, fileName, contentType = 'application/pdf') {
  const supabase = getSupabase();

  // Sanitize filename
  const safeFileName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const filePath = `${userId}/${courseId}/${Date.now()}_${safeFileName}`;

  const { data, error } = await supabase
    .storage
    .from(CHEATSHEET_BUCKET)
    .upload(filePath, fileBuffer, {
      contentType,
      upsert: true
    });

  if (error) {
    console.error('[cheatsheetStorage] Upload failed:', error);
    throw new Error(`Failed to upload cheatsheet file: ${error.message}`);
  }

  // Get signed URL (valid for 1 year to support persistent links)
  const { data: urlData, error: urlError } = await supabase
    .storage
    .from(CHEATSHEET_BUCKET)
    .createSignedUrl(filePath, 31536000);

  if (urlError) {
    console.error('[cheatsheetStorage] Failed to create signed URL:', urlError);
    throw new Error(`Failed to create signed URL: ${urlError.message}`);
  }

  return urlData.signedUrl;
}

/**
 * Lists all cheatsheet files for a course.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @returns {Promise<Array<{name: string, url: string}>>} List of files
 */
export async function getCourseCheatsheetFiles(courseId, userId) {
  const supabase = getSupabase();
  const folderPath = `${userId}/${courseId}`;

  const { data: files, error } = await supabase
    .storage
    .from(CHEATSHEET_BUCKET)
    .list(folderPath);

  if (error) {
    console.error('[cheatsheetStorage] Failed to list files:', error);
    return [];
  }

  if (!files || files.length === 0) {
    return [];
  }

  // Generate signed URLs for each file
  const filePromises = files.map(async f => {
    const { data, error } = await supabase
      .storage
      .from(CHEATSHEET_BUCKET)
      .createSignedUrl(`${folderPath}/${f.name}`, 60 * 60 * 24); // 24 hours

    if (error) {
      console.error(`[cheatsheetStorage] Failed to create signed URL for ${f.name}:`, error);
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
 * Downloads a cheatsheet file's content as a Buffer.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @param {number} cheatsheetNumber - The number of the cheatsheet (e.g., 1, 2)
 * @returns {Promise<{buffer: Buffer, fileName: string}|null>} The file buffer and name, or null if not found
 */
export async function downloadCheatsheetFile(courseId, userId, cheatsheetNumber) {
  const supabase = getSupabase();
  const folderPath = `${userId}/${courseId}`;

  // List all files in the course folder
  const { data: files, error: listError } = await supabase
    .storage
    .from(CHEATSHEET_BUCKET)
    .list(folderPath);

  if (listError) {
    console.error(`[cheatsheetStorage] Failed to list files for download (number: ${cheatsheetNumber}):`, listError);
    return null;
  }

  if (!files || files.length === 0) {
    console.warn(`[cheatsheetStorage] No files found in folder ${folderPath}`);
    return null;
  }

  // Find a file that matches the cheatsheet number
  // Expected format: [timestamp]_cheatsheet_[number].pdf
  const cheatsheetRegex = /_cheatsheet_(\d+)\.pdf$/;

  const matchingFile = files.find(f => {
    const match = f.name.match(cheatsheetRegex);
    if (!match) return false;
    return parseInt(match[1], 10) === cheatsheetNumber;
  });

  if (!matchingFile) {
    console.warn(`[cheatsheetStorage] No matching cheatsheet found for number '${cheatsheetNumber}' in ${folderPath}`);
    return null;
  }

  const filePath = `${folderPath}/${matchingFile.name}`;
  console.log(`[cheatsheetStorage] Downloading cheatsheet file: ${filePath}`);

  const { data, error } = await supabase
    .storage
    .from(CHEATSHEET_BUCKET)
    .download(filePath);

  if (error) {
    console.error(`[cheatsheetStorage] Failed to download cheatsheet file ${filePath}:`, error);
    return null;
  }

  // Convert Blob to Buffer
  const arrayBuffer = await data.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  return { buffer, fileName: matchingFile.name };
}

/**
 * Deletes a specific cheatsheet file from Supabase Storage.
 * 
 * @param {string} courseId - The course ID
 * @param {string} userId - The user ID
 * @param {number} cheatsheetNumber - The number of the cheatsheet (e.g., 1, 2)
 * @returns {Promise<{success: boolean, error?: string}>} Deletion result
 */
export async function deleteCheatsheetFile(courseId, userId, cheatsheetNumber) {
  const supabase = getSupabase();
  const folderPath = `${userId}/${courseId}`;

  // List all files in the course folder
  const { data: files, error: listError } = await supabase
    .storage
    .from(CHEATSHEET_BUCKET)
    .list(folderPath);

  if (listError) {
    console.error(`[cheatsheetStorage] Failed to list files for deletion (number: ${cheatsheetNumber}):`, listError);
    return { success: false, error: listError.message };
  }

  if (!files || files.length === 0) {
    return { success: false, error: 'No files found' };
  }

  // Find a file that matches the cheatsheet number
  const cheatsheetRegex = /_cheatsheet_(\d+)\.pdf$/;

  const matchingFile = files.find(f => {
    const match = f.name.match(cheatsheetRegex);
    if (!match) return false;
    return parseInt(match[1], 10) === cheatsheetNumber;
  });

  if (!matchingFile) {
    return { success: false, error: `No matching cheatsheet found for number '${cheatsheetNumber}'` };
  }

  const filePath = `${folderPath}/${matchingFile.name}`;
  console.log(`[cheatsheetStorage] Deleting cheatsheet file: ${filePath}`);

  const { error: deleteError } = await supabase
    .storage
    .from(CHEATSHEET_BUCKET)
    .remove([filePath]);

  if (deleteError) {
    console.error(`[cheatsheetStorage] Failed to delete cheatsheet file ${filePath}:`, deleteError);
    return { success: false, error: deleteError.message };
  }

  console.log(`[cheatsheetStorage] Successfully deleted cheatsheet file: ${filePath}`);
  return { success: true };
}
