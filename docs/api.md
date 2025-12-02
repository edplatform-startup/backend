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
- Purpose: Health check / Root.
- Responses:
  - 200 OK → `{ "name": "edtech-backend-api", "ok": true }`

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

### GET /courses/data
- **Purpose**: Fetch course metadata (title, syllabus, dates, status) without lesson DAG.
- **Query parameters**:
  - `userId` (string, required)
  - `courseId` (string, required)
- **Response (200)**:
  ```json
  {
    "success": true,
    "course": {
      "id": "...",
      "user_id": "...",
      "title": "Discrete Mathematics",
      "syllabus_text": "...",
      "exam_details": "...",

      "status": "ready"
    }
  }
  ```

### DELETE /courses
- Purpose: Delete a stored course row and its linked assets (including object storage files) for a user.
- Query parameters:
  - `userId` (string, required)
  - `courseId` (string, required)
- Responses:
  - 200 OK → `{ "success": true, "courseId": "...", "storageFilesDeleted": 0 }`
  - 400 Bad Request → Missing parameters or invalid UUID formats.
  - 404 Not Found → Course absent or belongs to another user.
  - 500 Internal Server Error → Supabase delete failure.

### PATCH /courses/:courseId/settings
- Purpose: Update course settings, specifically `seconds_to_complete`.
- Path parameters:
  - `courseId` (string, required) – UUID of the course.
- Request body (JSON):
  - `userId` (string, required) – UUID of the course owner.
  - `seconds_to_complete` (number, optional) – Non-negative integer representing the time limit in seconds.
- Responses:
  - 200 OK →
    ```json
    {
      "success": true,
      "settings": {
        "id": "...",
        "seconds_to_complete": 3600,
        "updated_at": "..."
      }
    }
    ```
  - 400 Bad Request → Missing `userId`, invalid UUIDs, or invalid `seconds_to_complete`.
  - 404 Not Found → Course not found or access denied.
  - 500 Internal Server Error → Database error.

### PATCH /courses/:courseId/nodes/:nodeId/progress
- Purpose: Update user progress (mastery status and familiarity score) for a specific lesson.
- Path parameters:
  - `courseId` (string, required) – UUID of the course.
  - `nodeId` (string, required) – UUID of the lesson/node.
- Request body (JSON):
  - `userId` (string, required) – UUID of the user.
  - `mastery_status` (string, optional) – One of `"pending"`, `"mastered"`, `"needs_review"`.
  - `familiarity_score` (number, optional) – Float between 0 and 1.
- Responses:
  - 200 OK →
    ```json
    {
      "success": true,
      "progress": {
        "user_id": "...",
        "node_id": "...",
        "mastery_status": "mastered",
        "familiarity_score": 0.8,
        "updated_at": "..."
      }
    }
    ```
  - 400 Bad Request → Missing parameters or invalid values.
  - 404 Not Found → Course or lesson not found.
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
    "user_confidence_map": { "slug_id": 0.4 },
    "seconds_to_complete": 3600,
    "syllabusText": "string (optional)",
    "syllabusFiles": [ { "name": "...", "url": "..." } ],
    "examFormatDetails": "string (optional)",
    "examFiles": [ { "name": "...", "url": "..." } ]
  }
  ```
  - `userId` (string, required) – UUID of the course owner.
  - `courseId` (string, optional) – Supply to reuse/update an existing course row; otherwise a UUID is generated.
  - `courseMetadata` (object, optional) – Used to populate `title`, `syllabus_text`, and `exam_details` in `api.courses`.
  - `grok_draft` (object, required) – Raw "Lesson Architect" draft JSON produced by Gemini/Grok.
  - `user_confidence_map` (object, optional) – Map of `original_source_id -> confidence score (0-1)` used when averaging `confidence_score` per node.
  - `seconds_to_complete` (number, optional) – Time limit in seconds for the course.
  - `syllabusText` (string, optional) – Raw text of the syllabus.
  - `syllabusFiles` (array, optional) – Array of file objects for the syllabus.
  - `examFormatDetails` (string, optional) – Raw text of exam details.
  - `examFiles` (array, optional) – Array of file objects for exam details.
- Behavior:
  1. Validates UUID fields and ensures `grok_draft` is an object.
  2. Calls `generateLessonGraph` (Gemini) to convert the draft into normalized nodes/edges.
  3. Inserts or updates `api.courses` with the derived title, optional syllabus/exam context, and sets `status: "pending"` for downstream progress tracking.
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

### GET /courses/:id/plan
- **Purpose**: Generate an optimized, personalized study plan for a course based on available time. Returns a learning path optimized for either comprehensive mastery (Deep Study) or high-yield exam preparation (Cram Mode).
- **Path parameters**:
  - `id` (string, required) – UUID of the course.
- **Query parameters**:
  - `userId` (string, required) – UUID of the user.
- **Algorithm**:
  1. **Data Fetching**: Loads course nodes, dependencies, user state, and course settings (specifically `seconds_to_complete`) from database.
  2. **Graph Construction**: Builds in-memory DAG with parent/child relationships.
  3. **Effective Cost Calculation**: `effective_cost = estimated_minutes × (1 - familiarity_score)`
  4. **Mode Selection**:
     - **Deep Study**: Selected when `(seconds_to_complete / 60) ≥ total_time_needed × 1.5`
       - Returns all non-mastered nodes in topological order
       - Ensures comprehensive understanding of the entire course
     - **Cram Mode**: Selected when time is limited
       - Identifies high-value target nodes (`intrinsic_exam_value ≥ 7`)
       - Fallback: If no targets, selects top 20% by value
       - Builds prerequisite chains for each target
       - Dynamic greedy selection with shared ancestor optimization
       - Maximizes exam value within time constraint
  5. **Output Formatting**: Groups nodes by module, calculates lock status, determines content type.
- **Responses**:
  - `200 OK` → See example below
  - `400 Bad Request` → Missing or invalid parameters
  - `500 Internal Server Error` → Database failure or algorithm error
- **Response Fields**:
  - `mode` (string) – "Deep Study" or "Cram"
  - `total_minutes` (number) – Sum of all lesson durations
  - `modules` (array) – Mixed array containing lesson modules and practice exam modules
    - **Lesson Module**:
      - `title` (string) – Module name
      - `lessons` (array) – Ordered lessons in dependency order
        - `id`, `title`, `type`, `duration`, `is_locked`, `status`
    - **Practice Exam Module** (standalone):
      - `title` (string) – Exam title (e.g., "Mid-Course Practice Exam")
      - `type` (string) – Always `"practice_exam"`
      - `is_practice_exam_module` (boolean) – Always `true`
      - `exam` (object) – Exam details
        - `id`, `title`, `duration`, `is_locked`, `status`, `preceding_lessons`
- **Example**:
  ```bash
  GET /courses/1cb57cda-a88d-41b6-ad77-4f022f12f7de/plan?userId=e6e04dbb
  ```
  Response:
  ```json
  {
    "mode": "Deep Study",
    "total_minutes": 162,
    "modules": [
      {
        "title": "Module 1: Logic",
        "lessons": [
          {
            "id": "0503d602-85ef",
            "title": "Basic Inference Rules",
            "type": "reading",
            "duration": 27,
            "is_locked": false,
            "status": "pending"
          }
        ]
      },
      {
        "title": "Mid-Course Practice Exam",
        "type": "practice_exam",
        "is_practice_exam_module": true,
        "exam": {
          "id": "practice-exam-mid",
          "title": "Mid-Course Practice Exam",
          "duration": 45,
          "is_locked": false,
          "status": "pending",
          "preceding_lessons": ["0503d602-85ef", "..."]
        }
      },
      {
        "title": "Module 2: Proofs",
        "lessons": [...]
      },
      {
        "title": "Final Practice Exam",
        "type": "practice_exam",
        "is_practice_exam_module": true,
        "exam": {
          "id": "practice-exam-final",
          "title": "Final Practice Exam",
          "duration": 60,
          "is_locked": false,
          "status": "pending",
          "preceding_lessons": ["...", "all-lesson-ids"]
        }
      }
    ]
  }
  ```

### GET /courses/:courseId/nodes/:nodeId
- **Purpose**: Fetch complete lesson content including reading materials, quizzes, flashcards, and video information.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
  - `nodeId` (string, required) – UUID of the lesson/node
- **Query parameters**:
  - `userId` (string, required) – UUID of the user (for access verification)
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "lesson": {
        "id": "0503d602-85ef-4f25-8dcd-d6494cefa869",
        "course_id": "1cb57cda-a88d-41b6-ad77-4f022f12f7de",
        "title": "Basic Inference Rules",
        "module_ref": "Module 2: Formal Inference",
        "estimated_minutes": 30,
        "bloom_level": "Apply",
        "intrinsic_exam_value": 7,
        "confidence_score": 0.5,
        "metadata": {
          "original_source_ids": ["sub3-1", "sub3-3", "sub3-5"],
          "architectural_reasoning": "Merged sub3-1, sub3-3, sub3-5..."
        },
        "content_payload": {
          "status": "ready",
          "reading": "# Basic Inference Rules\n\n## Introduction\n...",
          "video": {
            "videoId": "xyz123",
            "title": "Modus Ponens Explained",
            "thumbnail": "https://..."
          },
          "flashcards": [
            {
              "front": "Modus Ponens Formula",
              "back": "p → q, p, therefore q."
            },
            {
              "front": "Modus Tollens Formula", 
              "back": "p → q, ~q, therefore ~p."
            }
          ],
          "quiz": [
            {
              "question": "Consider the argument: (P → Q) ∧ P ∴ Q. Which rule is this?",
              "options": ["Modus Ponens", "Affirming Consequent", "Denying Antecedent"],
              "correct_index": 0,
              "explanation": "This is Modus Ponens, affirming the antecedent..."
            }
          ],
          "generation_plans": {
            "quiz": "Present 3 argument forms...",
            "video": ["rules of inference discrete math"],
            "reading": "List the standard inference rules...",
            "flashcards": "Front: Modus Tollens Formula..."
          }
        }
      }
    }
    ```
  - `400 Bad Request` → Missing or invalid parameters
  - `404 Not Found` → Course or lesson not found, or user doesn't have access
  - `500 Internal Server Error` → Database error
- **Security**: Verifies that the user owns the course before returning lesson data.
- **Use Cases**:
  - Display reading material for a lesson
  - Load quiz questions for student assessment
  - Show flashcards for memorization
  - Embed recommended YouTube video
- **Example**:
  ```bash
  GET /courses/1cb57cda-a88d/nodes/0503d602-85ef?userId=e6e04dbb
  ```

### POST /courses/:courseId/exams/generate
- **Purpose**: Generate a new practice exam (midterm or final) in LaTeX format based on specific lessons and existing exam examples.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Request body (JSON)**:
  - `userId` (string, required) – UUID of the user
  - `lessons` (string[], required) – List of lesson titles or descriptions to cover in the exam
  - `type` (string, required) – Type of exam: `"midterm"` or `"final"`
- **Behavior**:
  1. Fetches existing practice exams from storage to use as style/format references.
  2. Determines the next exam number (e.g., if `midterm_exam_1.pdf` exists, creates `midterm_exam_2.pdf`).
  3. Calls Gemini 1.5 Pro to generate a LaTeX exam covering the specified lessons.
  4. Sanitizes and checks the LaTeX for semantic issues (repairing via LLM if needed).
  5. Compiles the LaTeX to PDF (retrying via LLM if compilation fails).
  6. Saves the generated PDF file to storage.
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "url": "https://...",
      "name": "midterm_exam_2.pdf",
      "number": 2
    }
    ```
  - `400 Bad Request` → Missing parameters or invalid values
  - `500 Internal Server Error` → Generation or storage failure

### GET /courses/:courseId/exams/:type
- **Purpose**: Fetch the list of generated practice exams for a specific type.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
  - `type` (string, required) – Type of exam: `"midterm"` or `"final"`
- **Query parameters**:
  - `userId` (string, required) – UUID of the user
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "exams": [
        {
          "name": "midterm_exam_1.pdf",
          "url": "https://...",
          "number": 1,
          "grade": {
            "score": 85,
            "feedback": "Good job...",
            "topic_grades": [...],
            "created_at": "2023-..."
          }
        },
        {
          "name": "midterm_exam_2.pdf",
          "url": "https://...",
          "number": 2,
          "grade": null
        }
      ]
    }
    ```
  - `500 Internal Server Error` → Storage error

### POST /courses/:courseId/grade-exam
- **Purpose**: Grade an answered exam PDF against a blank exam template using Gemini.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Request body (Multipart/Form-Data)**:
  - `userId` (string, required) – UUID of the user
  - `exam_type` (string, required) – Type of the exam (e.g., `"midterm"`, `"final"`)
  - `exam_number` (number, required) – The number of the exam to grade (e.g., `1`, `2`)
  - `input_pdf` (file, required) – The answered exam PDF file
- **Behavior**:
  1. Fetches the blank exam template from storage based on `exam_type` and `exam_number`.
  2. Sends both the answered exam and the blank template to Gemini 3 Pro.
  3. Returns a standardized grading report with topic-level scores and feedback.
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "topic_list": [
        {
          "topic": "Calculus",
          "grade": 3,
          "explanation": "Correctly applied the chain rule..."
        }
      ],
      "overall_score": 88,
      "overall_feedback": "Great job on the core concepts..."
    }
    ```
  - `400 Bad Request` → Missing parameters or file
  - `500 Internal Server Error` → Grading failure

### POST /courses/:courseId/review-modules
- **Purpose**: Generate a new review module (set of lessons) for a specific exam type (midterm/final) based on a list of weak topics.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Request body (JSON)**:
  - `userId` (string, required) – UUID of the user
  - `examType` (string, required) – Type of review: `"midterm"` or `"final"`
  - `topics` (object[], required) – List of topics with performance data
    - `topic` (string) – Name of the topic
    - `grade` (number) – Score (e.g., 1-5)
    - `explanation` (string) – Why the student received this grade
    - `feedback` (object, optional) – Additional feedback details
- **Behavior**:
  1. Calls the Lesson Architect (LLM) to generate a DAG of review lessons based on the provided graded topics, prioritizing weak areas.
  2. Persists the new lessons to `api.course_nodes` with `metadata.review_type` set to the provided type.
  3. Triggers the content worker to generate reading, quizzes, etc., for the new lessons.
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "nodeCount": 5,
      "contentStatus": "ready"
    }
    ```
  - `400 Bad Request` → Missing parameters or invalid type
  - `500 Internal Server Error` → Generation or persistence failure

### GET /courses/:courseId/review-modules
- **Purpose**: Fetch existing review modules for a course, optionally filtered by exam type.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Query parameters**:
  - `userId` (string, required) – UUID of the user
  - `type` (string, optional) – Filter by review type (`"midterm"` or `"final"`). If omitted, returns all review modules.
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "modules": [
        {
          "id": "...",
          "title": "Review: Calculus Limits",
          "module_ref": "Midterm Review",
          "metadata": { "review_type": "midterm" },
          ...
        }
      ]
    }
    ```
  - `400 Bad Request` → Missing userId
  - `500 Internal Server Error` → Database error

### POST /courses/:courseId/restructure
- **Purpose**: Restructure or modify specific lessons in a course based on a user prompt.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Request body (JSON)**:
  - `userId` (string, required) – UUID of the user
  - `prompt` (string, required) – The instruction for what to change (e.g., "Change the analogy in the limits lesson to use speedometers").
  - `lessonIds` (string[], optional) – Specific lesson IDs to target if known. If omitted, the system identifies affected lessons automatically.
- **Behavior**:
  1. Uses an LLM (Lesson Architect) to identify which lessons need modification based on the prompt and course structure.
  2. Generates specific change instructions for each content type (reading, quiz, etc.) in the affected lessons.
  3. Regenerates the content using the new instructions while preserving the overall structure.
  4. Updates the database with the new content.
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "affected_lessons": ["lesson-uuid-1", "lesson-uuid-2"],
      "results": [
        { "id": "lesson-uuid-1", "status": "updated" },
        { "id": "lesson-uuid-2", "status": "skipped" }
      ]
    }
    ```
  - `400 Bad Request` → Missing parameters
  - `500 Internal Server Error` → Restructuring failure

### GET /courses/:courseId/questions
- **Purpose**: Fetch individual quiz questions for a course, with optional filtering.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Query parameters**:
  - `userId` (string, required) – UUID of the user
  - `correctness` (string, optional) – Filter by status: `"correct"`, `"incorrect"`, or `"unattempted"`
  - `attempted` (boolean, optional) – If `true`, returns only questions that are NOT `"unattempted"`
  - `lessons` (string, optional) – Comma-separated list of lesson UUIDs to filter by
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "questions": [
        {
          "id": "...",
          "question": "...",
          "options": ["..."],
          "correct_index": 0,
          "status": "unattempted",
          "explanation": "..."
        }
      ]
    }
    ```
  - `400 Bad Request` → Missing userId
  - `500 Internal Server Error` → Database error

### PATCH /courses/:courseId/questions
- **Purpose**: Bulk update the status (correct/incorrect) of quiz questions.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Request body (JSON)**:
  - `userId` (string, required) – UUID of the user
  - `updates` (object[], required) – List of updates
    - `id` (string, required) – UUID of the quiz question
    - `status` (string, required) – New status (`"correct"`, `"incorrect"`, `"unattempted"`)
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "updated": 5,
      "errors": []
    }
    ```
  - `400 Bad Request` → Missing parameters
  - `403 Forbidden` → Access denied
  - `500 Internal Server Error` → Database error

### GET /courses/:courseId/flashcards
- **Purpose**: Fetch flashcards for a course, with optional filtering for spaced repetition.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Query parameters**:
  - `userId` (string, required) – UUID of the user
  - `current_timestamp` (string, optional ISO date) – If provided, returns only cards with `next_show_timestamp` < `current_timestamp`
  - `lessons` (string, optional) – Comma-separated list of lesson UUIDs to filter by
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "flashcards": [
        {
          "id": "...",
          "front": "...",
          "back": "...",
          "next_show_timestamp": "2023-..."
        }
      ]
    }
    ```
  - `400 Bad Request` → Missing userId
  - `500 Internal Server Error` → Database error

### PATCH /courses/:courseId/flashcards
- **Purpose**: Bulk update the scheduling of flashcards.
- **Path parameters**:
  - `courseId` (string, required) – UUID of the course
- **Request body (JSON)**:
  - `userId` (string, required) – UUID of the user
  - `updates` (object[], required) – List of updates
    - `id` (string, required) – UUID of the flashcard
    - `next_show_timestamp` (string, required ISO date) – New scheduled time
- **Responses**:
  - `200 OK` →
    ```json
    {
      "success": true,
      "updated": 3,
      "errors": []
    }
    ```
  - `400 Bad Request` → Missing parameters
  - `403 Forbidden` → Access denied
  - `500 Internal Server Error` → Database error

### GET /analytics/usage
- Purpose: Retrieve raw AI model usage logs (token counts, costs, models used).
- Query parameters:
  - `userId` (string, optional) – Filter by user UUID.
  - `limit` (number, optional) – Number of records to return (default: 100).
- Responses:
  - 200 OK →
    ```json
    {
      "success": true,
      "data": [
        {
          "id": "...",
          "user_id": "...",
          "model": "x-ai/grok-4-fast",
          "prompt_tokens": 150,
          "completion_tokens": 50,
          "total_tokens": 200,
          "cost_usd": 0.0004,
          "source": "chat",
          "created_at": "..."
        }
      ]
    }
    ```
  - 500 Internal Server Error → Database error.

### GET /analytics/usage/summary
- Purpose: Retrieve aggregated AI usage statistics (total spend, total tokens, etc.).
- Query parameters:
  - `userId` (string, optional) – Filter by user UUID.
- Responses:
  - 200 OK →
    ```json
    {
      "success": true,
      "summary": {
        "total_spend": 1.25,
        "total_calls": 50,
        "total_tokens": 15000,
        "average_spend_per_user": 0.025,
        "unique_users": 5
      }
    }
    ```
  - 500 Internal Server Error → Database error.

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
- Generate topics → `POST https://api.kognolearn.com/courses/topics`
  - Body: see `/courses/topics` section.
  - Response: `{ "success": true, "overviewTopics": [{"id":"overview_1","title":"...","subtopics":[...]}], "model": "x-ai/grok-4-fast" }`
- Persist course → `POST https://api.kognolearn.com/courses`
  - Body: include `topics`, optional `topicFamiliarity`, and shared context fields.
  - Response: `{ "courseId": "<uuid>" }`
