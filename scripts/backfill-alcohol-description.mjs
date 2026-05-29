import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, pool } from '../server/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'server', 'db', 'seed-data.json'), 'utf8'));
const page = (seed.contentPages || []).find((item) => item.slug === 'alcohol-history');

if (!page) {
  throw new Error('alcohol-history content page was not found in seed-data.json');
}

const description = JSON.stringify({
  title: page.title,
  blocks: (page.body || []).map((block) => ({
    text: block.text || '',
    media: Array.isArray(block.media)
      ? block.media.map((file) => file.path || file.url || file.media_url || file.mediaUrl || '').filter(Boolean)
      : []
  })).filter((block) => block.text.trim() || block.media.length)
});

await query(
  `INSERT INTO quiz_series (name, description, updated_at)
   VALUES ($1, $2, now())
   ON CONFLICT (name) DO UPDATE
   SET description = EXCLUDED.description,
       updated_at = now()`,
  ['Алкоголь и его история', description]
);

const result = await query(
  `UPDATE quizzes
   SET description = ''
   WHERE source = 'tests'
     AND category = 'Алкоголь и его история'`,
);

await pool.end();
console.log(`Updated alcohol description for ${result.rowCount} quizzes`);
