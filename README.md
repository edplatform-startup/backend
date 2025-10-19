# EdTech Backend API

Minimal Node.js API that reads courses from a Supabase database.

## Prerequisites
- Node.js 18 or newer
- A Supabase project with a `courses` table containing at least `code` (text) and `title` (text)

## Setup
1. Copy environment file and fill in values:
   - `SUPABASE_URL`: Your Supabase project URL (https://xxxx.supabase.co)
   - `SUPABASE_SERVICE_KEY`: Your Supabase anon public key
   - `PORT` (optional): Port to run the API (default 3000)
    - `OPENROUTER_GROK_4_FAST_KEY`: API key for OpenRouter (Grok 4 Fast Reasoning with web search)

```
cp .env.example .env
```

2. Install dependencies:
```
npm install
```

3. Run the server:
```
npm run dev
```

Server will start at http://localhost:3000

## API

For a concise, comprehensive spec of the current API, see `docs/api.md`.

## Testing

- Install dependencies: `npm install`
- Run the automated suite: `npm test`

## Notes
- The API only selects `code` and `title` fields to minimize payloads.
- Increase/adjust limits, columns, or sorting in `src/routes/courses.js`.

## Deploying to Render

Option A: One-click Blueprint (render.yaml)

1. Push this repo (or just the `backend` directory) to GitHub.
2. In Render, create a new Blueprint from your repo.
3. Render will detect `render.yaml` and create a Web Service:
  - Build Command: `npm install`
  - Start Command: `npm start`
  - Node version: 20
4. Add environment variables on the service:
  - `SUPABASE_URL`: https://<project>.supabase.co
  - `SUPABASE_SERVICE_KEY`: your anon key
  - `PORT` is provided in the blueprint (3000). Render sets PORT automatically; this app respects it.
5. Deploy. Your service will be available at the provided Render URL.

Option B: Manual Web Service

1. Create a Web Service in Render pointing to this directory.
2. Set:
  - Runtime: Node
  - Build Command: `npm install`
  - Start Command: `npm start`
  - Add env vars: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
3. Deploy.