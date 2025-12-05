# EdTech Backend API

Minimal Node.js API that reads courses from a Supabase database.

## Prerequisites
- Node.js 20.x (use `nvm use` to switch to the correct version)
- A Supabase project with a `courses` table containing at least `code` (text) and `title` (text)

## Setup
1. Copy environment file and fill in values:
   - `SUPABASE_URL`: Your Supabase project URL (https://xxxx.supabase.co)
   - `SUPABASE_SERVICE_KEY`: Your Supabase service role key
   - `OPENROUTER_API_KEY`: API key for OpenRouter (Grok 4 Fast Reasoning)
   - `PORT` (optional): Port to run the API (default 3000)

```bash
cp .env.example .env
```

2. Install dependencies:
```bash
npm ci
```

3. Run the server:
```bash
npm run dev
```

Server will start at http://localhost:3000

## Available Scripts

- `npm run dev` - Start development server
- `npm start` - Start production server
- `npm run build` - Run build step (no-op for Express, included for consistency)
- `npm test` - Run automated test suite
- `npm run smoke` - Quick smoke test to verify app loads
- `npm run render-build` - Render.com build command (runs npm ci + build)
- `npm run render-start` - Render.com start command
- `npm run postdeploy` - Post-deployment tasks (Prisma generation, etc.)
- `node scripts/cleanupRagChunks.js` - Prune expired RAG chunks (run via cron)

## API

For a concise, comprehensive spec of the current API, see `docs/api.md`.

### Health Check

- **GET /healthz** - Returns `{ ok: true, ts: <timestamp> }` with 200 status
- **GET /health** - Alias for `/healthz`

## Testing

- Install dependencies: `npm install`
- Run the automated suite: `npm test`

## Notes
- The API only selects `code` and `title` fields to minimize payloads.
- Increase/adjust limits, columns, or sorting in `src/routes/courses.js`.

## Deploying to Render

This repository is configured for seamless deployment to Render using the included `render.yaml` blueprint.

### Prerequisites

1. A GitHub repository with this code
2. A Render account (free tier works fine)
3. Supabase project credentials

### Deployment Steps

#### Option A: Blueprint Deployment (Recommended)

1. **Push to GitHub**
   ```bash
   git push origin main
   ```

2. **Create Blueprint in Render**
   - Go to [Render Dashboard](https://dashboard.render.com/)
   - Click "New" → "Blueprint"
   - Connect your GitHub repository
   - Select the repository containing this backend
   - Render will automatically detect `render.yaml`

3. **Configure Environment Variables**
   
   The following environment variables need to be set in the Render dashboard:
   
   - `SUPABASE_URL` - Your Supabase project URL (e.g., https://xxxxx.supabase.co)
   - `SUPABASE_SERVICE_KEY` - Your Supabase service role key (from Project Settings → API)
   - `OPENROUTER_API_KEY` - Your OpenRouter API key
   
   **Note:** `PORT` is automatically set by Render and doesn't need to be configured.

4. **Deploy**
   - Click "Apply" to create the service
   - Render will:
     - Run `npm run render-build` (which does `npm ci` with optimized flags + `npm run build`)
     - Start the service with `npm run render-start`
     - Health check at `/healthz`
   
5. **Verify Deployment**
   - Once deployed, visit your service URL
   - Check `/healthz` endpoint returns `{ ok: true, ts: "..." }`
   - Test API endpoints like `/courses`

#### Option B: Manual Web Service

1. **Create a Web Service in Render**
   - Go to Render Dashboard
   - Click "New" → "Web Service"
   - Connect your repository

2. **Configure Service Settings**
   - **Name:** edtech-backend-api (or your choice)
   - **Region:** Oregon (or your preferred region)
   - **Branch:** main
   - **Runtime:** Node
   - **Build Command:** `npm run render-build`
   - **Start Command:** `npm run render-start`
   - **Plan:** Free

3. **Set Environment Variables** (same as Option A)

4. **Deploy**

### Build Configuration

The deployment uses hardened npm install settings to ensure:
- ✅ Fast, non-interactive installs (< 2 minutes)
- ✅ No postinstall hangs or prompts
- ✅ Reproducible builds via package-lock.json
- ✅ Node 20.x runtime via `.nvmrc` and `engines` in package.json

**Build command breakdown:**
```bash
npm ci --include=dev --prefer-online --no-audit --no-fund --progress=false --foreground-scripts=false
```

- `npm ci` - Clean install from lockfile (faster, more reliable than `npm install`)
- `--include=dev` - Include devDependencies (needed for build tools)
- `--prefer-online` - Skip stale cache, fetch latest from registry
- `--no-audit` - Skip security audit (speeds up install)
- `--no-fund` - Skip funding messages
- `--progress=false` - Disable progress bars (cleaner logs)
- `--foreground-scripts=false` - Prevent interactive script prompts

### Post-Deployment

The `postdeploy` script runs automatically after deployment to handle:
- Prisma client generation (if Prisma is added and `DATABASE_URL` is set)
- Database migrations
- Cache warming
- Other deployment-specific tasks

Currently, this project doesn't use Prisma, so the script safely no-ops.

If you are provisioning a fresh database, apply the content tables first:

```
-- In your database console
\i docs/migrations/course-content.sql
```

This creates the per-format content tables (`video_items`, `reading_articles`, `flashcard_sets`, `mini_quizzes`) under the `api` schema.

### Monitoring & Debugging

- **Logs:** View real-time logs in Render Dashboard → Your Service → Logs
- **Health Check:** Render automatically pings `/healthz` to verify service health
- **Environment:** All builds run with `NODE_ENV=production` and `CI=true`

### Auto-Deploy

The service is configured with `autoDeploy: true`, meaning:
- Every push to `main` branch triggers automatic deployment
- You can disable this in Render settings if needed

### Troubleshooting

**Build fails with "Cannot find module"**
- Ensure package-lock.json is committed
- Run `npm ci` locally to verify lockfile is valid

**Service won't start**
- Check Render logs for errors
- Verify all required environment variables are set
- Test locally: `npm run render-build && npm run render-start`

**Health check fails**
- Verify app binds to `0.0.0.0` and `process.env.PORT`
- Check `/healthz` returns 200 status locally

**Slow builds (> 2 minutes)**
- Review dependencies for heavy postinstall scripts
- Check if native modules are compiling (should use prebuilts)

### CI/CD

GitHub Actions automatically runs on push/PR:
- Installs dependencies with hardened flags
- Runs build
- Runs test suite
- Runs smoke test

See `.github/workflows/ci.yml` for details.

---

**Quick Local Test (matching Render environment):**
```bash
nvm use
npm ci --prefer-online --no-audit --no-fund --progress=false --foreground-scripts=false
npm run build
npm start
```

Then visit http://localhost:3000/healthz