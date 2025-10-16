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

### GET /courses
- Purpose: Search for courses by code or title (case-insensitive, partial match).
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
- Course search:
  - GET https://edtech-backend-api.onrender.com/courses?query=cs
  - 200 OK → { "query": "cs", "count": <n>, "items": [ { "code": "CS101", "title": "..." }, ... ] }