import 'dotenv/config';
import app from './app.js';

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Bind to all interfaces for cloud deployment

app.listen(PORT, HOST, () => {
  // Prefer hosted URL if provided by the platform (e.g., Render)
  const externalUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL;
  const base = externalUrl ? externalUrl.replace(/\/$/, '') : `http://localhost:${PORT}`;
  console.log(`API listening on ${HOST}:${PORT}`);
  console.log(`External URL: ${base}`);
});
