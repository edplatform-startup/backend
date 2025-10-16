import 'dotenv/config';
import app from './app.js';

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  // Prefer hosted URL if provided by the platform (e.g., Render)
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL;
  const base = externalUrl ? externalUrl.replace(/\/$/, '') : `http://localhost:${PORT}`;
  console.log(`API listening on ${base}`);
});
