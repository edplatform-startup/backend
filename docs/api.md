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

### GET /healthz
- Purpose: Health check endpoint for monitoring and deployment systems.
- Request: No params.
- Responses:
  - 200 OK → `{ "status": "ok" }`

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
- Purpose: Generate study topics with Grok 4 Fast Reasoning (via OpenRouter) and return them to the caller (no persistence yet).
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
  - Sends the provided context to the Grok 4 Fast Reasoning model via OpenRouter, enabling the `web_search` tool so the model can research missing course information before answering.
  - Parses the model result into a normalized topics array.
  - Responds with the generated topics; data is not yet saved to Supabase.
- Responses:
  - 200 OK →
    ```json
    {
      "success": true,
      "topics": ["Topic A", "Topic B", "Topic C"],
      "rawTopicsText": "Topic A, Topic B, Topic C",
      "model": "x-ai/grok-4-fast"
    }
    ```
  - 400 Bad Request → Missing `userId`, invalid UUID/date formats, bad `courseSelection`, or malformed file metadata.
  - 500 Internal Server Error → Unexpected exception calling OpenRouter.
  - 502 Bad Gateway → Model call failed or returned no topics.

### POST /flashcards
- Purpose: Generate flashcards for a topic via Grok-4-Fast (OpenRouter).
- Request body (JSON):
  ```json
  {
    "topic": "Operating systems caching",
    "count": 5
  }
  ```
  - `topic` (string, required) – Subject to cover. Trims whitespace.
  - `count` (integer, optional) – Number of flashcards to request (1–20). Defaults to 5.
- Behavior:
  - Sends a structured prompt to Grok-4-Fast via OpenRouter demanding a strict JSON object response.
  - Validates the returned structure (keys "1".."n" with arrays of `[question, answer, explanation]`).
  - Returns the flashcards object directly to the client.
- Responses:
  - 200 OK →
    ```json
    {
      "1": [
        "Define cache hit rate and how it’s computed.",
        "Hit rate = hits / total accesses.",
        "Often computed over a trace; miss rate = 1 - hit rate."
      ],
      "2": [
        "What is virtual memory?",
        "Illusion of contiguous address space via paging.",
        "Enables isolation, protection; page tables + TLB."
      ],
      "3": [
        "Explain TLB misses.",
        "A miss in the translation cache requiring a page table walk.",
        "Can trigger page faults if mapping absent."
      ]
    }
    ```
  - 400 Bad Request → Missing or empty `topic`, invalid `count`.
  - 500 Internal Server Error → Flashcard generator not configured or unexpected exception.
  - 502 Bad Gateway → Grok returned a non-OK response or malformed JSON.
  - 504 Gateway Timeout → Grok request exceeded 30 seconds.

## Errors (generic)
- 404 Not Found → Unknown route or unsupported HTTP verb.
- 500 Internal Server Error → Fallback error handler; body `{ "error": "Internal Server Error: <message>" }`.

## Notes
- Every response uses JSON and includes `success` for happy-path course endpoints.
- Readers should supply their own authentication/authorization in front of this API; it trusts the provided UUIDs.
- Supabase schema: reads from `api.courses` for GET requests; POST currently does not persist data.

## Examples
- List user courses → `GET https://edtech-backend-api.onrender.com/courses?userId=...`
  - Response: `{ "success": true, "count": 1, "courses": [Course] }`
- Fetch specific course → `GET https://edtech-backend-api.onrender.com/courses?userId=...&courseId=...`
  - Response: `{ "success": true, "course": Course }`
- Create topics → `POST https://edtech-backend-api.onrender.com/courses`
  - Body: see example above.
  - Response: `{ "success": true, "topics": ["Topic A", "Topic B"], "rawTopicsText": "Topic A, Topic B", "model": "x-ai/grok-4-fast" }`