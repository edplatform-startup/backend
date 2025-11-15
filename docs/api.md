# EdTech Backend API – Specification

Base URL (production): https://edtech-backend-api.onrender.com

- Protocols: HTTPS (production), HTTP (local dev)
- Media type: application/json; charset=utf-8
- Authentication: None (public)
- CORS: Enabled for all origins
- Versioning: None (single, unversioned API)
- Rate limiting: Not implemented

## Request size limits

- Default maximum request body size: 150mb (configurable via `REQUEST_BODY_LIMIT`, e.g., `20mb`).
- If exceeded, the server responds with HTTP 413 Payload Too Large:
  ```json
  { "error": "Payload too large", "details": "The request body exceeded the allowed size...", "maxAllowed": "150mb" }
  ```
- Recommendations for large inputs:
  - Prefer providing `url` for files instead of large base64 `content`.
  - If sending base64 `content`, keep individual files reasonably small (a few MB) and avoid bundling many files in a single request.
  - For Grok models (which do not accept file streams), the server will inline text content from files when possible; non-textual binaries should be provided by URL.

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
  - `responseFormat` (optional) – `"text"` (default) returns a plain text string; `"json"` requests a JSON object response when supported. When `useWebSearch` is true the backend skips strict JSON enforcement due to OpenRouter limitations, so the model is prompted—but not forced—to return JSON.
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

### GET /courses
- Purpose: List stored courses for a user or fetch a specific course row (including persisted `course_data`).
- Query parameters:
  - `userId` (string, required) – UUID of the caller.
  - `courseId` (string, optional) – UUID of a specific course owned by the caller.
- Responses:
  - 200 OK →
    - With `courseId`: `{ "success": true, "course": CourseRow }`
    - Without `courseId`: `{ "success": true, "count": n, "courses": [CourseRow, ...] }`
  - 400 Bad Request → Missing `userId` or invalid UUID(s).
  - 404 Not Found → `courseId` not found for that user.
  - 500 Internal Server Error → Supabase failure.

### GET /courses/ids
- Purpose: Return only the ordered list of course IDs for a user.
- Query parameters:
  - `userId` (string, required) – UUID of the user.
- Responses:
  - 200 OK → `{ "userId": "...", "count": n, "courseIds": ["uuid", ...] }`
  - 400 Bad Request → Missing/invalid `userId`.
  - 500 Internal Server Error → Database error.

### GET /courses/data
- Purpose: Fetch just the `course_data` JSON for a given `courseId`, verifying ownership.
- Query parameters:
  - `userId` (string, required)
  - `courseId` (string, required)
- Responses:
  - 200 OK → `{ "courseId": "...", "userId": "...", "course_data": { ... } }`
  - 400 Bad Request → Missing parameters or invalid UUID formats.
  - 404 Not Found → No matching record for the user.
  - 500 Internal Server Error → Supabase query failure.

### DELETE /courses
- Purpose: Delete a stored course row (and its linked assets) for a user.
- Query parameters:
  - `userId` (string, required)
  - `courseId` (string, required)
- Responses:
  - 200 OK → `{ "success": true, "courseId": "..." }`
  - 400 Bad Request → Missing parameters or invalid UUID formats.
  - 404 Not Found → Course absent or belongs to another user.
  - 500 Internal Server Error → Supabase delete failure.

### GET /content
- Purpose: Fetch the stored per-format content JSON by format and id.
- Query parameters:
  - `format` (string, required) – One of `video`, `reading`, `flashcards`, `mini_quiz`, `practice_exam`.
  - `id` (string, required) – UUID of the content row (matches `asset.id` in `course_data`).
  - `userId` (string, required) – UUID of the requesting user; must own the content.
- Responses:
  - 200 OK → `{ "id": "...", "format": "...", "data": { ... } }`
  - 400 Bad Request → Invalid format or id.
  - 404 Not Found → No content with that id in the specified format.
  - 500 Internal Server Error → Database error.

### POST /courses/topics
- Purpose: Fast topic discovery endpoint. Extracts a high-quality topic list from syllabus/exam signals before full course generation.
- Request body (JSON):
  - `userId` (string, required)
  - `finishByDate` (string, optional ISO date)
  - `university`, `courseTitle`, or `courseSelection` (optional) – any combination used to describe the class
  - `syllabusText` (string, optional)
  - `syllabusFiles` (FileMeta[], optional) – `{ name, type?, url? | data? }`, validated server-side
  - `examFormatDetails` (string, optional)
  - `examFiles` (FileMeta[], optional)
- Behavior:
  - Validates user/file metadata and normalizes course selection fields.
  - Invokes the CourseV2 `synthesizeSyllabus` stage (the same engine used for full course generation) to build an exam-aligned syllabus + topic graph.
  - Extracts topic labels from `topic_graph.nodes`, filters meta/logistics entries (e.g., “Exam Review”), deduplicates while preserving order, and caps to ~30 items.
  - Logs usage via Grok client cost tracking and returns topics plus a comma-separated string for legacy consumers.
- Responses:
  - 200 OK → `{ "success": true, "topics": ["Topic A", ...], "rawTopicsText": "Topic A, ...", "model": "courseV2/syllabus" }`
  - 400 Bad Request → Missing `userId`, invalid UUID/date, or invalid file metadata.
  - 502 Bad Gateway → Model failure or unusable response.

### POST /courses
- Purpose: Persist a full Course V2 package (syllabus, modules, lessons, assessments) plus per-format study assets after the user submits curated topics/familiarity.
- Request body (JSON):
  - `userId` (string, required)
  - `topics` (string[], required) – trimmed, non-empty topics from `/courses/topics`
  - `topicFamiliarity` (object or `{ topic, familiarity }[]`, optional) – levels such as `beginner`, `expert`; entries outside `topics` are rejected
  - `className` (string, optional) – overrides course title stored in Supabase
  - Shared fields from `/courses/topics`: `finishByDate`, `courseSelection`/`university`/`courseTitle`, `syllabusText`, `syllabusFiles`, `examFormatDetails`, `examFiles`, `userPrefs`
- Behavior:
  1. Validates payload and inserts a placeholder `api.courses` row containing `title`, `topics`, and normalized `topic_familiarity`.
  2. Runs `generateCoursePackageWithAssets`, which orchestrates the Course V2 pipeline and the new asset builder:
     - `package` – structured syllabus/modules/lessons/assessments + study time estimates.
     - `assets` – generated JSON for `video`, `reading`, `flashcards`, `mini quiz`, and `practice exam` per module (also persisted in their respective tables, with IDs stored in `course_data.assets`).
      - Module planning keeps the 6-10 module target as a soft guideline; if the model proposes zero modules, the backend deterministically builds a fallback plan from the topic graph so module count alone never triggers a server error.
      - Lesson design enforces strict JSON (quoted URLs, no trailing text) and, if parsing/validation fails or produces <6 lessons, it deterministically builds a compliant fallback plan so every module keeps 2–4 lessons.
      - Assessment generation similarly falls back to deterministic weekly quizzes, capstone, and exam blueprint whenever LLM output cannot be repaired, so the full course package is always returned.
    - Tool calls originating from OpenRouter plugins (e.g., xAI web search) are intercepted server-side and resolved without redefining the same tools in the payload, so Anthropic and xAI runs both succeed.
  3. Updates the stored course row with `{ version: "2.0", model: "openai/gpt-5.1-codex", generated_at, inputs, package, assets }`.
  4. On failure the placeholder row is deleted so retries can reuse the inputs.
- Responses:
  - 201 Created → `{ "courseId": "<uuid>" }`
  - 400 Bad Request → Missing `topics`, invalid familiarity map, or invalid shared fields.
  - 502 Bad Gateway → LLM orchestration or Supabase persistence failed.
  - 500 Internal Server Error → Unexpected exception.

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
- Every response uses JSON. Successful `POST /courses` requests return only the persisted `courseId`.
- Readers should supply their own authentication/authorization in front of this API; it trusts the provided UUIDs.
- Supabase schema: reads from and writes to `api.courses`. `course_data` is the canonical JSON column for stored syllabi.

## Examples
- List user courses → `GET https://edtech-backend-api.onrender.com/courses?userId=...`
  - Response: `{ "success": true, "count": 1, "courses": [Course] }`
- Fetch specific course → `GET https://edtech-backend-api.onrender.com/courses?userId=...&courseId=...`
  - Response: `{ "success": true, "course": Course }`
- Search catalog → `GET https://edtech-backend-api.onrender.com/college-courses?query=cs50`
  - Response: `{ "query": "cs50", "count": 1, "items": [{"code":"CS50","title":"Introduction to CS"}] }`
- Generate topics → `POST https://edtech-backend-api.onrender.com/courses/topics`
  - Body: see `/courses/topics` section.
  - Response: `{ "success": true, "topics": ["Topic A", "Topic B"], "rawTopicsText": "Topic A, Topic B", "model": "openai/gpt-5.1-codex" }`
- Persist course → `POST https://edtech-backend-api.onrender.com/courses`
  - Body: include `topics`, optional `topicFamiliarity`, and shared context fields.
  - Response: `{ "courseId": "<uuid>" }`