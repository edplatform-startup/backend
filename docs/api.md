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
 POST `/chat` — general-purpose chat endpoint for Grok 4 Fast
  - 200 OK → `{ "status": "ok" }`

### POST /chat
- Purpose: General-purpose chat endpoint for Grok 4 Fast (OpenRouter). Accepts a system prompt and a user message, plus optional context, attachments, and model controls. Returns the model's response.
- Request body (JSON):
  ```json
  {
    "system": "string (required)",
    "user": "string (required)",
    "userId": "string (required, UUID)",
    "context": "string | object | array (optional)",
    "useWebSearch": "boolean (optional, default: false)",
    "responseFormat": "text | json (optional, default: \"text\")",
    "temperature": "number (optional, default: 0.5)",
    "maxTokens": "number (optional, default: 600)",
    "attachments": [
      { "type": "string", "mimeType": "string", "data": "string (base64)", "url": "string", "name": "string" }
    ],
    "reasoning": "boolean | string | object (optional)"
  }
  ```
- Field requirements:
  - `system` (string, required) – System prompt / instructions for the model.
  - `user` (string, required) – The user's message or question.
  - `userId` (string, required) – Caller identity; must be a valid UUID (validated server-side).
  - `context` (optional) – Additional context to include with the system prompt. May be a string or any JSON-serializable object/array.
  - `useWebSearch` (optional) – When true, the server enables a web search tool for the model.
  - `responseFormat` (optional) – `"text"` (default) returns a plain text string; `"json"` requests a JSON object response when supported.
  - `temperature` (optional) – Floating number controlling randomness; default `0.5`.
  - `maxTokens` (optional) – Maximum tokens to allow in model output; default `600`.
  - `attachments` (optional) – Array of file-like objects; each may include inline base64 `data` or a `url`.
  - `reasoning` (optional) – Enable or configure model reasoning (boolean or structured object).
- Responses:
  - 200 OK → Model response (JSON):
    ```json
    {
      "model": "x-ai/grok-4-fast",
      "content": "<string>" // normalized model output (text) or serialized JSON depending on responseFormat
    }
    ```
  - 400 Bad Request → Missing or invalid `system`, `user`, or `userId` (invalid UUID) or un-serializable `context`.
  - 500 Internal Server Error → Unexpected exception calling the model or server-side error. The body may include `details` and a `debug` block for troubleshooting (not recommended to rely on in production).
- Examples:
  - Request:
    ```json
    {
      "system": "You are a helpful tutor.",
      "user": "Explain the difference between supervised and unsupervised learning.",
      "userId": "550e8400-e29b-41d4-a716-446655440000",
      "context": { "course": "Machine Learning" },
      "useWebSearch": true,
      "responseFormat": "text"
    }
    ```
  - Response (200):
    ```json
    {
      "model": "x-ai/grok-4-fast",
      "content": "Supervised learning uses labeled data to train models, while unsupervised learning finds patterns in unlabeled data."
    }
    ```

-### GET /courses
  - `userId` (string) – Required to list a user's courses. Also required when requesting a specific `courseId`.
  - `courseId` (string, optional) – UUID of a specific course. Must belong to the provided `userId`.
  - When only `userId` is supplied, returns all of that user's courses ordered by `created_at` descending.
  - When both `userId` and `courseId` are supplied, returns that single course if it belongs to the user; otherwise 404.
      "success": true,
      "count": 2,
      "courses": [Course, Course]
    }
    ```
  - 200 OK (single)
      "success": true,
    - Requires `userId` query param (UUID).
    ```
  - 400 Bad Request → Missing params, invalid UUID formats, or `courseId` without `userId`.
  - 404 Not Found → Course not found for that user.

### GET /courses/ids
- Purpose: Return all course IDs for a given user.
  - `userId` (string, required) – UUID of the user.
- Responses:
  - 200 OK → `{ "userId": "...", "count": n, "courseIds": ["uuid", ...] }`
  - 400 Bad Request → Missing/invalid `userId`.
  - 500 Internal Server Error → Database error.

### GET /courses/data
- Purpose: Return only the `course_data` JSON for a specific course, verifying the owner.
- Query parameters:
- Responses:
  - 200 OK → `{ "courseId": "...", "userId": "...", "course_data": { ... } }`
    - Requires `userId` query param (UUID) and enforces ownership.
  - 404 Not Found → Course not found for the user.
  - 500 Internal Server Error → Database error.

### GET /content
- Purpose: Fetch the stored per-format content JSON by format and id.
- Query parameters:
  - `format` (string, required) – One of `video`, `reading`, `flashcards`, `mini_quiz`, `practice_exam`.
  - `id` (string, required) – UUID of the content row (matches `asset.id` in `course_data`).
- Responses:
  - 200 OK → `{ "id": "...", "format": "...", "data": { ... } }`
  - 400 Bad Request → Invalid format or id.
  - 404 Not Found → No content with that id in the specified format.
  - 500 Internal Server Error → Database error.
   Query params:
   - `format`: one of `video`, `reading`, `flashcards`, `mini_quiz`, `practice_exam`
   - `id`: UUID of the content item
   - `userId`: UUID of the requesting user; must own the content

   Returns `{ id, format, data }`.
- `id` (string) – Course record UUID.
- `user_id` (string) – Owner UUID.
- `course_json` (object|null) – Alias of `course_data` retained for backward compatibility.
- `created_at` (string) – ISO timestamp when the record was created.
    - `userId` (string, required, UUID): caller identity (validated format)
- `finish_by_date` (string|null) – Optional target completion date (ISO 8601).
- `course_selection` (object|null) – Selected source course `{ code, title }`.
- `syllabus_text` (string|null) – Raw syllabus text provided by the user.
- `syllabus_files` (FileMeta[]) – Uploaded syllabus file metadata.
- `exam_format_details` (string|null) – Free-form exam format notes.
- `exam_files` (FileMeta[]) – Uploaded exam reference files.

`FileMeta` object fields
- `url` (string, optional) – Location where the file can be fetched.
- `size` (number, optional) – File size in bytes.
- `type` (string, optional) – MIME type.
- `content` (string, optional) – Base64-encoded file payload when the file is uploaded inline.
    "userId": "22222222-2222-2222-2222-222222222222",

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

### POST /course-structure
- Purpose: Generate and persist a full course learning plan leveraging xAI Grok 4 Fast via OpenRouter.
- Request body (JSON):
  ```json
  {
    "topics": ["Supervised Learning", "Optimization"],
    "topicFamiliarity": {
      "Supervised Learning": "confident",
      "Optimization": "needs review"
    },
    "className": "Machine Learning Final",
    "startDate": "2025-10-01T00:00:00.000Z",
    "endDate": "2025-12-15T00:00:00.000Z",
    "userId": "550e8400-e29b-41d4-a716-446655440000",
    "syllabusText": "Optional free-form syllabus overview",
    "syllabusFiles": [
      { "name": "syllabus.pdf", "url": "https://example.com/syllabus.pdf", "type": "application/pdf" }
    ],
    "examStructureText": "Optional description of exam structure",
    "examStructureFiles": [
      { "name": "exam-guide.pdf", "content": "<base64>", "type": "application/pdf" }
    ]
  }
  ```
- Field requirements:
  - `topics` (string[], required) – Non-empty array of topic names.
  - `topicFamiliarity` (object | array, optional) – Learner self-assessed familiarity per topic. Provide either an object map (`{ "topic": "beginner" }`) or array of `{ topic, familiarity }`. Topics outside the `topics` list are rejected.
  - `className` (string, required) – Name of the class or exam being prepared for.
  - `startDate` & `endDate` (string, required) – ISO 8601 timestamps; `startDate` must be before `endDate`.
  - `userId` (string, required) – UUID of the learner the course belongs to.
  - `syllabusText` (string, optional) – Additional syllabus description.
  - `syllabusFiles` (FileMetaWithContent[], optional) – Uploaded syllabus documents. Each file may include either a `url` or `content` (base64 payload).
  - `examStructureText` (string, optional) – Description of the exam format.
  - `examStructureFiles` (FileMetaWithContent[], optional) – Exam references with optional `url` or `content`.
- Behavior:
  - Validates inputs and forwards contextual data, including file attachments, to Grok 4 Fast with reasoning and optional web search.
  - Incorporates the learner's familiarity levels to tailor pacing and depth for each topic.
  - The model produces a concise plan parsed into the course structure: top-level object keyed by `Module/Submodule` with arrays of `{ "Format", "content" }`.
  - Supported formats: `video`, `reading`, `flashcards`, `mini quiz`, `practice exam`. `project` and `lab` are ignored if present.
  - For each asset, the backend calls the model again to generate format-specific JSON content, persists it into dedicated tables, and attaches the inserted row id to the asset as `asset.id`.
    - Tables: `api.video_items`, `api.reading_articles`, `api.flashcard_sets`, `api.mini_quizzes`, `api.practice_exams`.
    - Each row includes: `course_id`, `user_id`, `module_key`, `content_prompt` (the asset `content`), and `data` (the JSON returned by the model).
    - Data shapes:
      - `video_items.data`: a single YouTube video object `{ "title": string, "description": string, "url": string }` (the model uses web_search to pick the best video)
      - `flashcard_sets.data`: a single card `{ "question": string, "answer": string, "explanation": string }`
      - Other formats remain unchanged from earlier behavior (readings/articles, mini_quizzes with questions[], practice_exams with mcq[]/frq[]).
  - Finally, the augmented `course_data` (now with per-asset `id` fields) is saved into `api.courses` using the same `courseId` that ties all content rows together.
- Responses:
  - 201 Created → `{ "courseId": "<uuid>" }`
  - 400 Bad Request → Invalid inputs (missing topics/userId, bad dates, malformed file metadata, etc.).
  - 502 Bad Gateway → Model returned empty/invalid JSON structure or persistence failed.
  - 500 Internal Server Error → Unexpected failure calling OpenRouter.

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

### GET /college-courses
- Purpose: Search real-time college course catalogs across 750+ U.S. institutions (via Ellucian Banner systems) by college name and course query. Uses fuzzy string matching to return the top 50 most relevant courses from the latest available term.
- External API Used: `https://api.collegeplanner.io/v1` (unofficial, public, no auth required)
- Query parameters:
  - `college` (string, **required**) – Name of the college (e.g., `"University of Washington"`, `"Stanford"`, `"MIT"`). Fuzzy-matched against known institutions.
  - `course` (string, **required**) – Course code or title keyword (e.g., `"cs50"`, `"intro to machine learning"`). Used for similarity scoring across `code` and `title`.
- Behavior:
  1. Fuzzy-matches the `college` name to the closest known institution (minimum similarity threshold: 0.5).
  2. Fetches the **latest term** (e.g., `202508`) for that college.
  3. Retrieves **all subjects** and **all courses** in that term.
  4. Computes **string similarity** between the `course` query and each course’s `code + title`.
  5. Returns the **top 50 most similar courses**, sorted by relevance.
- Responses:
  - 200 OK →
    ```json
    {
      "college": "University of Washington",
      "query": "cs50",
      "count": 10,
      "items": [
        {
          "code": "CSE 142",
          "title": "Computer Programming I"
        },
        {
          "code": "INFO 201",
          "title": "Technical Foundations of Informatics"
        },
        {
          "code": "CSE 143",
          "title": "Computer Programming II"
        }
        // ... up to 50 results
      ]
    }

## Errors (generic)
- 404 Not Found → Unknown route or unsupported HTTP verb.
- 500 Internal Server Error → Fallback error handler; body `{ "error": "Internal Server Error: <message>" }`.

## Notes
- Every response uses JSON. Successful `POST /course-structure` requests return only the persisted `courseId`.
- Readers should supply their own authentication/authorization in front of this API; it trusts the provided UUIDs.
- Supabase schema: reads from and writes to `api.courses`. `course_data` is the canonical JSON column for stored syllabi.

## Examples
- List user courses → `GET https://edtech-backend-api.onrender.com/courses?userId=...`
  - Response: `{ "success": true, "count": 1, "courses": [Course] }`
- Fetch specific course → `GET https://edtech-backend-api.onrender.com/courses?userId=...&courseId=...`
  - Response: `{ "success": true, "course": Course }`
- Search catalog → `GET https://edtech-backend-api.onrender.com/college-courses?query=cs50`
  - Response: `{ "query": "cs50", "count": 1, "items": [{"code":"CS50","title":"Introduction to CS"}] }`
- Create topics → `POST https://edtech-backend-api.onrender.com/courses`
  - Body: see example above.
  - Response: `{ "success": true, "topics": ["Topic A", "Topic B"], "rawTopicsText": "Topic A, Topic B", "model": "x-ai/grok-4-fast" }`