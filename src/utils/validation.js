export function validateUuid(value, fieldName = 'value') {
  if (typeof value !== 'string') {
    return {
      valid: false,
      error: `${fieldName} must be a string`,
    };
  }

  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(value)) {
    return {
      valid: false,
      error: `${fieldName} must be a valid UUID`,
    };
  }

  return { valid: true };
}

export function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

export function normalizeIsoDate(value) {
  if (!isValidIsoDate(value)) return null;
  return new Date(value).toISOString();
}

export function validateFileArray(files, fieldName) {
  if (files == null) return { valid: true, value: [] };
  if (!Array.isArray(files)) {
    return { valid: false, error: `${fieldName} must be an array of file metadata objects` };
  }

  const sanitized = [];
  for (let i = 0; i < files.length; i++) {
    const entry = files[i];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return { valid: false, error: `${fieldName}[${i}] must be an object` };
    }

    const { name, url, size, type, content } = entry;

    if (typeof name !== 'string' || !name.trim()) {
      return { valid: false, error: `${fieldName}[${i}] must include a non-empty "name" string` };
    }

    if (url != null && (typeof url !== 'string' || !url.trim())) {
      return { valid: false, error: `${fieldName}[${i}] "url" must be a non-empty string when provided` };
    }

    if (size != null && (typeof size !== 'number' || Number.isNaN(size) || size < 0)) {
      return { valid: false, error: `${fieldName}[${i}] "size" must be a non-negative number when provided` };
    }

    if (type != null && typeof type !== 'string') {
      return { valid: false, error: `${fieldName}[${i}] "type" must be a string when provided` };
    }

    if (content != null && typeof content !== 'string') {
      return { valid: false, error: `${fieldName}[${i}] "content" must be a base64 string when provided` };
    }

    const sanitizedEntry = { name: name.trim() };
    if (url != null) sanitizedEntry.url = url.trim();
    if (size != null) sanitizedEntry.size = size;
    if (type != null) sanitizedEntry.type = type;
    if (content != null) sanitizedEntry.content = content;
    sanitized.push(sanitizedEntry);
  }

  return { valid: true, value: sanitized };
}
