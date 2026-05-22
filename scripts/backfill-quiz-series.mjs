import 'dotenv/config';
import { query, pool } from '../server/db/pool.js';

function isStructuredDescription(description) {
  if (!description) return false;
  try {
    const parsed = JSON.parse(description);
    if (Array.isArray(parsed)) return parsed.length > 0;
    return Boolean(parsed && typeof parsed === 'object' && Array.isArray(parsed.blocks) && (parsed.blocks.length || parsed.title));
  } catch {
    return false;
  }
}

const quizzes = await query(
  `SELECT category, description
   FROM quizzes
   WHERE source = 'tests'
   ORDER BY category, id`
);

const series = new Map();
for (const quiz of quizzes.rows) {
  if (!quiz.category) continue;
  const current = series.get(quiz.category) || '';
  if (!current && isStructuredDescription(quiz.description)) {
    series.set(quiz.category, quiz.description);
  } else if (!series.has(quiz.category)) {
    series.set(quiz.category, '');
  }
}

for (const [name, description] of series.entries()) {
  await query(
    `INSERT INTO quiz_series (name, description, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (name) DO UPDATE
     SET description = CASE
           WHEN EXCLUDED.description <> '' THEN EXCLUDED.description
           ELSE quiz_series.description
         END,
         updated_at = now()`,
    [name, description]
  );
}

const cleared = await query("UPDATE quizzes SET description = '' WHERE source = 'tests'");

await pool.end();
console.log(`Backfilled ${series.size} quiz series and cleared ${cleared.rowCount} test quiz descriptions`);
