import { query } from '../db/pool.js';

export function resolveTitle(score) {
  if (score > 450) return 'Легенда LOFT HALL';
  if (score > 349) return 'Наставник';
  if (score > 199) return 'Профессионал';
  if (score > 99) return 'Ученик';
  if (score > 49) return 'Новичок';
  return 'Стажер';
}

export async function recalculateUserScore(userId) {
  const bestAttempts = await query(
    `SELECT COALESCE(SUM(best_score), 0)::int AS total
     FROM (
       SELECT quiz_id, MAX(weighted_score) AS best_score
       FROM quiz_attempts
       WHERE user_id = $1
       GROUP BY quiz_id
     ) best`,
    [userId]
  );
  const rewardRows = await query(
    `SELECT COALESCE(SUM(points), 0)::int AS total
     FROM point_events
     WHERE user_id = $1`,
    [userId]
  );
  const total = Number(bestAttempts.rows[0].total || 0) + Number(rewardRows.rows[0].total || 0);
  const title = resolveTitle(total);
  const updated = await query(
    `UPDATE users
     SET title_score = $1, title_text = $2, updated_at = now()
     WHERE id = $3
     RETURNING *`,
    [total, title, userId]
  );
  return updated.rows[0];
}
