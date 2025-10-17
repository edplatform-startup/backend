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
  - 200 OK
    - Body:
      {
        "name": "edtech-backend-api",
        "ok": true
      }

### GET /health
- Purpose: Liveness check.
- Request: No params.
- Responses:
  - 200 OK
    - Body:
      {
        "ok": true,
        "ts": "2025-01-01T12:34:56.789Z"
      }

### GET /college-courses
- Purpose: Search for college courses by code or title (case-insensitive, partial match).
- Query parameters:
  - query (string, required)
    - Will be trimmed, spaces removed (e.g., "CSE 123" -> "CSE123"), and truncated to max 100 chars.
- Behavior:
  - Matches if course code OR title contains the term (case-insensitive).
  - Returns up to 50 results.
- Responses:
  - 200 OK
    - Body:
      {
        "query": "cs",
        "count": 2,
        "items": [
          { "code": "CS101", "title": "Intro to Computer Science" },
          { "code": "CS50",  "title": "Computer Science" }
        ]
      }
    - Schema:
      - query: string (the sanitized search term used)
      - count: integer (number of items returned)
      - items: Course[]
      - Course: { code: string, title: string }
  - 400 Bad Request
    - Body: { "error": "Missing required query parameter: query" }
  - 500 Internal Server Error
    - Body: { "error": "Failed to fetch courses" } when upstream DB request fails, or
            { "error": "Internal server error" } for unexpected errors.

### GET /courses
- Purpose: Retrieve generated courses for a user, or a specific course.
- Authentication: None (userId must be provided in query parameters)
- Query parameters (at least one required):
  - userId (string, optional but required if courseId not provided): Valid UUID of the user
  - courseId (string, optional): Valid UUID of a specific course. If provided, userId is required.
- Behavior:
  - **Case 1**: Only `userId` provided → Returns all courses associated with that user, ordered by creation date (newest first)
  - **Case 2**: Both `userId` and `courseId` provided → Returns the specific course ONLY if it belongs to that user
- Responses:
  - 200 OK (single course):
    - Body:
      {
        "success": true,
        "course": {
          "id": "123e4567-e89b-12d3-a456-426614174000",
          "user_uuid": "550e8400-e29b-41d4-a716-446655440000",
          "course_data": { /* course content */ },
          "created_at": "2025-10-17T12:34:56.789Z"
        }
      }
  - 200 OK (multiple courses):
    - Body:
      {
        "success": true,
        "count": 3,
        "courses": [
          {
            "id": "123e4567-e89b-12d3-a456-426614174000",
            "user_uuid": "550e8400-e29b-41d4-a716-446655440000",
            "course_data": { /* course content */ },
            "created_at": "2025-10-17T12:34:56.789Z"
          },
          ...
        ]
      }
  - 400 Bad Request
    - Missing parameters:
      { "error": "Missing required query parameters. Provide at least userId or both userId and courseId." }
    - courseId without userId:
      { "error": "userId is required when courseId is provided." }
    - Invalid UUID format:
      { "error": "Invalid userId format. Must be a valid UUID." } or
      { "error": "Invalid courseId format. Must be a valid UUID." }
  - 404 Not Found
    - Course not found or doesn't belong to user:
      { "error": "Course not found or does not belong to this user." }
  - 500 Internal Server Error
    - Body: { "error": "Failed to fetch course(s)", "details": "<error message>" } when DB query fails, or
            { "error": "Internal server error", "details": "<error message>" } for unexpected errors.

### POST /courses
- Purpose: Upload a generated course to the database for a specific user.
- Authentication: None (userId must be provided in request body)
- Request:
  - Method: POST
  - Content-Type: application/json
  - Body:
    {
      "userId": "550e8400-e29b-41d4-a716-446655440000"
    }
    - userId (string, required): Must be a valid UUID (RFC 4122 format) representing the user
- Behavior:
  - Reads the ml_course.json file from the resources directory
  - Validates the course JSON structure against the expected schema
  - Inserts the course into the api.courses table with the user's UUID
  - Returns the created course metadata
- Course Schema Validation:
  - Must be an object with topic keys in "Topic/Subtopic" format
  - Each topic must contain an array of content items
  - Each content item must have:
    - Format (string): One of "video", "reading", "mini quiz", "flashcards", "practice exam"
    - content (string): Non-empty description of the content
- Responses:
  - 201 Created
    - Body:
      {
        "success": true,
        "message": "Course created successfully",
        "course": {
          "id": "123e4567-e89b-12d3-a456-426614174000",
          "user_uuid": "550e8400-e29b-41d4-a716-446655440000",
          "created_at": "2025-10-17T12:34:56.789Z"
        }
      }
    - Schema:
      - success: boolean (always true on success)
      - message: string (confirmation message)
      - course: object
        - id: string (UUID of the created course record)
        - user_uuid: string (UUID of the associated user)
        - created_at: string (ISO 8601 timestamp)
  - 400 Bad Request
    - Missing userId:
      { "error": "Missing required field: userId" }
    - Invalid UUID format:
      { "error": "Invalid userId format. Must be a valid UUID." }
    - Invalid course schema:
      { 
        "error": "Invalid course format", 
        "details": "<specific validation error message>" 
      }
  - 500 Internal Server Error
    - Body: { "error": "Failed to insert course", "details": "<error message>" } when DB insert fails, or
            { "error": "Internal server error", "details": "<error message>" } for unexpected errors.

## Errors (generic)
- 404 Not Found (unknown route or unsupported method)
  - Body: { "error": "Not Found" }
- 500 Internal Server Error (unhandled)
  - Body: { "error": "Internal Server Error: <message>" }

## Notes
- Data source: Supabase table selecting only code and title fields.
- Ordering: Not specified by the API (database default).
- Pagination: Not implemented (hard limit 50). Clients should handle fewer results by refining the search term.
- Stability: This is a minimal API; response shapes are stable but may evolve as features are added.

## Examples
- Health check:
  - GET https://edtech-backend-api.onrender.com/health
  - 200 OK → { "ok": true, "ts": "<ISO8601>" }
- College course search:
  - GET https://edtech-backend-api.onrender.com/college-courses?query=cs
  - 200 OK → { "query": "cs", "count": <n>, "items": [ { "code": "CS101", "title": "..." }, ... ] }
- Create a course:
  - POST https://edtech-backend-api.onrender.com/courses
  - Headers: Content-Type: application/json
  - Body: { "userId": "550e8400-e29b-41d4-a716-446655440000" }
  - 201 Created → { "success": true, "message": "Course created successfully", "course": { "id": "...", "user_uuid": "...", "created_at": "..." } }
- Get all user's courses:
  - GET https://edtech-backend-api.onrender.com/courses?userId=550e8400-e29b-41d4-a716-446655440000
  - 200 OK → { "success": true, "count": 3, "courses": [ { "id": "...", "user_uuid": "...", "course_data": {...}, "created_at": "..." }, ... ] }
- Get specific course for user:
  - GET https://edtech-backend-api.onrender.com/courses?userId=550e8400-e29b-41d4-a716-446655440000&courseId=123e4567-e89b-12d3-a456-426614174000
  - 200 OK → { "success": true, "course": { "id": "...", "user_uuid": "...", "course_data": {...}, "created_at": "..." } }