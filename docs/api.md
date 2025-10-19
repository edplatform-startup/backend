# EdTech Backend API – Specification

Base URL (production): https://edtech-backend-api.onrender.com

- Protocols: HTTPS (production), HTTP (local dev)
- Media type: application/json; charset=utf-8
- Authentication: None (public)
- CORS: Enabled for all origins
- Versioning: None (single, unversioned API)
- Rate limiting: Not implemented

## Endpoints

### GET /
- Purpose: Basic service info.
- Request: No params.
- Responses:
  - 200 OK → `{ "name": "edtech-backend-api", "ok": true }`

### GET /health
- Purpose: Liveness check.
- Request: No params.
- Responses:
  - 200 OK → `{ "ok": true, "ts": "2025-01-01T12:34:56.789Z" }`

### GET /courses
- Purpose: Retrieve generated study plans saved for a user or fetch a specific plan.
- Query parameters (at least `userId` or both `userId` and `courseId`):
  - `userId` (string, required unless `courseId` supplied but still required when `courseId` is present): UUID identifying the owner.
  - `courseId` (string, optional): UUID of a specific course. Must belong to the same `userId`.
- Behavior:
  - When only `userId` is supplied, returns all of that user's courses ordered by `created_at` descending.
  - When both `userId` and `courseId` are supplied, returns that single course if it belongs to the user; otherwise 404.
- Success responses share the `Course` shape below.
  - 200 OK (collection)
    ```json
    {
      "success": true,
      "count": 2,
      "courses": [Course, Course]
    }
    ```
  - 200 OK (single)
    ```json
    {
      "success": true,
      "course": Course
    }
    ```
- Error responses:
  - 400 Bad Request → Missing params, invalid UUID formats, or `courseId` without `userId`.
  - 404 Not Found → Course not found for that user.
  - 500 Internal Server Error → Database read failure or unexpected exception.

`Course` object fields
- `id` (string) – Course record UUID.
- `user_uuid` (string) – Owner UUID.
- `course_json` (object) – Structured course syllabus stored from `ml_course.json`.
- `created_at` (string) – ISO timestamp when the record was created.
- `finish_by_date` (string|null) – Optional target completion date (ISO 8601).
- `course_selection` (object|null) – Selected source course `{ code, title }`.
- `syllabus_text` (string|null) – Raw syllabus text provided by the user.
- `syllabus_files` (FileMeta[]) – Uploaded syllabus file metadata.
- `exam_format_details` (string|null) – Free-form exam format notes.
- `exam_files` (FileMeta[]) – Uploaded exam reference files.

`FileMeta` object fields
- `name` (string) – File display name.
- `url` (string, optional) – Location where the file can be fetched.
- `size` (number, optional) – File size in bytes.
- `type` (string, optional) – MIME type.

### POST /courses
- Purpose: Persist a generated course plan for a user alongside intake metadata.
- Request body (JSON):
  ```json
  {
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "finishByDate": "2025-12-01T00:00:00.000Z",
    "courseSelection": { "code": "CSE142", "title": "Foundations of CS" },
    "syllabusText": "Optional syllabus text...",
    "syllabusFiles": [ { "name": "syllabus.pdf", "url": "https://...", "size": 12345, "type": "application/pdf" } ],
    "examFormatDetails": "2 midterms + 1 final",
    "examFiles": []
  }
  ```
- Field requirements:
  - `userId` (string, required) – UUID; rejects non-UUID values.
  - `finishByDate` (string, optional) – ISO 8601 date/time.
  - `courseSelection` (object|null, optional) – Must include non-empty `code` and `title` strings.
  - `syllabusText` (string, optional).
  - `syllabusFiles` (FileMeta[], optional) – Each entry validated as above.
  - `examFormatDetails` (string, optional).
  - `examFiles` (FileMeta[], optional).
- Behavior:
  - Loads the template at `resources/ml_course.json`.
  - Validates the template structure.
  - Inserts a new row into `api.courses` with `course_json` set to the template and metadata stored in dedicated columns.
- Responses:
  - 201 Created →
    ```json
    {
      "success": true,
      "message": "Course created successfully",
      "course": Course
    }
    ```
  - 400 Bad Request → Missing `userId`, invalid UUID/date formats, bad `courseSelection`, or malformed file metadata.
  - 500 Internal Server Error → Insert failure or unexpected exception.

## Errors (generic)
- 404 Not Found → Unknown route or unsupported HTTP verb.
- 500 Internal Server Error → Fallback error handler; body `{ "error": "Internal Server Error: <message>" }`.

## Notes
- Every response uses JSON and includes `success` for happy-path course endpoints.
- Readers should supply their own authentication/authorization in front of this API; it trusts the provided UUIDs.
- Supabase schema: reads and writes target `api.courses`; `course_json` currently seeded from a static template but can be swapped for dynamic generation later.

## Examples
- Health check → `GET https://edtech-backend-api.onrender.com/health`
  - Response: `{ "ok": true, "ts": "<ISO8601>" }`
- List user courses → `GET https://edtech-backend-api.onrender.com/courses?userId=...`
  - Response: `{ "success": true, "count": 1, "courses": [Course] }`
- Fetch specific course → `GET https://edtech-backend-api.onrender.com/courses?userId=...&courseId=...`
  - Response: `{ "success": true, "course": Course }`
- Create course → `POST https://edtech-backend-api.onrender.com/courses`
  - Body: see example above.
  - Response: `{ "success": true, "message": "Course created successfully", "course": Course }`