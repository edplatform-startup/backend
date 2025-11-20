# EdTech Backend API – Specification

Base URL (production): https://api.kognolearn.com

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
- Purpose: List stored courses for a user or fetch a specific course row (title/status/timeline metadata stored in `api.courses`).
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

- Purpose: Fetch just the stored course metadata row for a given `courseId`, verifying ownership.
- Query parameters:
  - `userId` (string, required)
  - `courseId` (string, required)
- Responses:
  - 200 OK → `{ "success": true, "course": CourseRow }`
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

- Purpose: Fetch the stored per-format content JSON by format and id.
- Query parameters:
  - `format` (string, required) – One of `video`, `reading`, `flashcards`, `mini_quiz`, `practice_exam`.
  - `id` (string, required) – UUID of the content row (matches the `course_nodes.id`).
  - `userId` (string, required) – UUID of the requesting user; must own the content.
- Responses:
  - 200 OK → `{ "id": "...", "format": "...", "data": { ... } }`
  - 400 Bad Request → Invalid format or id.
  - 404 Not Found → No content with that id in the specified format.
  - 500 Internal Server Error → Database error.

### POST /courses/topics
- Purpose: Generate a hierarchical, exam-oriented topic map (overview topics + competency-based subtopics with Deep/Cram metadata) before full course generation.
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
  - Runs the CourseV2 `synthesizeSyllabus` stage (same pipeline as full course generation) to obtain an exam-aligned skeleton.
  - Summarizes skeleton units and prompts the `TOPICS` LLM stage to expand them into 8–16 overview topics, each with 4–8 competency-based “Atomic Concepts.”
  - Each concept includes `focus` (Conceptual/Computational/Memorization), `bloom_level`, `estimated_study_time_minutes`, `importance_score` (1–10), `exam_relevance_reasoning`, and `yield` (High/Medium/Low) to power Deep vs. Cram study modes.
  - Normalizes IDs, fills in missing metadata, enforces `overviewId` relationships, and logs usage via Grok cost tracking as `[topicsV2]`.
- Responses:
  - 200 OK →
    ```json
    {
      "success": true,
      "overviewTopics": [
        {
          "id": "overview_1",
          "title": "Module 1: Algorithm Foundations",
          "original_skeleton_ref": "Week 1",
          "subtopics": [
            {
              "id": "overview_1_sub_1",
              "overviewId": "overview_1",
              "title": "Proving Big-O bounds via limit comparison",
              "focus": "Conceptual",
              "bloom_level": "Analyze",
              "estimated_study_time_minutes": 45,
              "importance_score": 9,
              "exam_relevance_reasoning": "Midterm rubric emphasizes limit-form proofs.",
              "yield": "High"
            }
          ]
        }
      ],
      "model": "x-ai/grok-4-fast"
    }
    ```
  - 400 Bad Request → Missing `userId`, invalid UUID/date, or invalid file metadata.
  - 502 Bad Gateway → Model failure or unusable response.

### POST /courses
- Purpose: Generate a lesson DAG from a Gemini draft, persist it to Supabase, and synchronously run the content worker that fills every node with reading/quiz/flashcard/video assets.
- Request body (JSON):
  ```json
  {
    "userId": "uuid-required",
    "courseId": "uuid-optional",
    "courseMetadata": { "title": "optional structured metadata" },
    "grok_draft": { "lessonGraph": { "rough": "gemini output" } },
    "user_confidence_map": { "slug_id": 0.4 }
  }
  ```
  - `userId` (string, required) – UUID of the course owner.
  - `courseId` (string, optional) – Supply to reuse/update an existing course row; otherwise a UUID is generated.
  - `courseMetadata` (object, optional) – Used to populate `title`, `syllabus_text`, `exam_details`, and start/end dates in `api.courses`.
  - `grok_draft` (object, required) – Raw "Lesson Architect" draft JSON produced by Gemini/Grok.
  - `user_confidence_map` (object, optional) – Map of `original_source_id -> confidence score (0-1)` used when averaging `confidence_score` per node.
- Behavior:
  1. Validates UUID fields and ensures `grok_draft` is an object.
  2. Calls `generateLessonGraph` (Gemini) to convert the draft into normalized nodes/edges.
  3. Inserts or updates `api.courses` with the derived title, optional syllabus/exam context, normalized start/end dates, and sets `status: "pending"` for downstream progress tracking.
  4. Executes `saveCourseStructure(courseId, userId, lessonGraph)` which bulk-inserts `api.course_nodes`, `api.node_dependencies`, and `api.user_node_state`, storing `generation_plans` + metadata inside each node's `content_payload` with `status: "pending"`.
  5. Runs `generateCourseContent(courseId)` immediately. The worker batches pending nodes (≤20 → all at once, otherwise concurrency=5) and, per node:
     - Calls `x-ai/grok-4-fast` three times (reading Markdown, quiz JSON, flashcards JSON) using strict JSON mode for assessments.
     - Searches the YouTube Data API (`YOUTUBE_API_KEY` env var) with the provided video queries; failures are logged and stored as `null`.
     - Updates each node's `content_payload` to `{ reading, quiz, flashcards, video, generation_plans, metadata, status: "ready" }` without overwriting existing metadata or lineage fields.
    - Marks nodes with failed generations as `status: "error"` and records the message; the parent course row's `status` becomes `"needs_attention"` when any failures occur, otherwise `"ready"`.
- Responses:
  - `201 Created` →
    ```json
    {
      "success": true,
      "courseId": "72b1...",
      "nodeCount": 24,
      "edgeCount": 32,
      "worker": { "processed": 24, "failed": 0, "status": "ready" },
      "course_structure": { "nodes": [...], "edges": [...] }
    }
    ```
  - `400 Bad Request` → Missing/invalid `userId`, `courseId`, or `grok_draft`.
  - `500 Internal Server Error` → Supabase write failures or upstream model/worker exceptions (details included in response for debugging).
- Notes:
  - Set `YOUTUBE_API_KEY` (or `GOOGLE_API_KEY`) to enable video recommendations; if absent, `video` is returned as `null` but other assets continue.
  - The worker output is synchronous; responses include the final DAG plus the worker summary so clients can immediately show generated content.

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
  - 504 Gateway Timeout → Grok request exceeded 120 seconds.

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
- Every response uses JSON.
- Readers should supply their own authentication/authorization in front of this API; it trusts the provided UUIDs.
- Supabase schema: reads from and writes to `api.courses` (title/status/timeline metadata) plus `api.course_nodes`, `api.node_dependencies`, and `api.user_node_state` for DAG persistence.

## Examples
- List user courses → `GET https://api.kognolearn.com/courses?userId=...`
  - Response: `{ "success": true, "count": 1, "courses": [Course] }`
- Fetch specific course → `GET https://api.kognolearn.com/courses?userId=...&courseId=...`
  - Response: `{ "success": true, "course": Course }`
- Search catalog → `GET https://api.kognolearn.com/college-courses?query=cs50`
  - Response: `{ "query": "cs50", "count": 1, "items": [{"code":"CS50","title":"Introduction to CS"}] }`
- Generate topics → `POST https://api.kognolearn.com/courses/topics`
  - Body: see `/courses/topics` section.
  - Response: `{ "success": true, "overviewTopics": [{"id":"overview_1","title":"...","subtopics":[...]}], "model": "x-ai/grok-4-fast" }`
- Persist course → `POST https://api.kognolearn.com/courses`
  - Body: include `topics`, optional `topicFamiliarity`, and shared context fields.
  - Response: `{ "courseId": "<uuid>" }`