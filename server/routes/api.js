import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { query, withTransaction } from '../db/pool.js';
import { extractTelegramUser, verifyTelegramInitData } from '../services/telegramAuth.js';
import { recalculateUserScore } from '../services/scoring.js';
import { fetchMissingPhotoDishes } from '../services/nocodb.js';
import { notifyReward, sendReviewMessage } from '../services/puzzlebot.js';

export const api = express.Router();

const uploadDir = path.resolve(process.cwd(), 'uploads');
await fs.mkdir(uploadDir, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, callback) => {
      const ext = path.extname(file.originalname || '');
      callback(null, `${Date.now()}-${Math.random().toString(16).slice(2)}${ext}`);
    }
  }),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 6
  }
});

function signUser(user) {
  return jwt.sign({ userId: user.id, role: user.role }, process.env.SESSION_SECRET || 'dev-secret', { expiresIn: '30d' });
}

async function upsertTelegramUser(telegramUser) {
  const adminIds = new Set(
    String(process.env.ADMIN_TELEGRAM_IDS || '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
  );
  const role = adminIds.has(String(telegramUser.id)) ? 'admin' : 'student';
  const result = await query(
    `INSERT INTO users (telegram_id, username, first_name, last_name, photo_url, role)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (telegram_id) DO UPDATE
     SET username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         photo_url = EXCLUDED.photo_url,
         role = CASE WHEN users.role = 'admin' THEN 'admin' ELSE EXCLUDED.role END,
         updated_at = now()
     RETURNING *`,
    [
      telegramUser.id,
      telegramUser.username || null,
      telegramUser.first_name || null,
      telegramUser.last_name || null,
      telegramUser.photo_url || null,
      role
    ]
  );
  return result.rows[0];
}

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Auth token required' });
    const payload = jwt.verify(token, process.env.SESSION_SECRET || 'dev-secret');
    const result = await query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    if (!result.rows[0]) return res.status(401).json({ error: 'User not found' });
    req.user = result.rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'Invalid auth token' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin role required' });
  next();
}

function publicUser(user) {
  return {
    id: user.id,
    telegramId: user.telegram_id,
    username: user.username,
    firstName: user.first_name,
    lastName: user.last_name,
    photoUrl: user.photo_url,
    role: user.role,
    titleScore: user.title_score,
    titleText: user.title_text,
    academyLevel: user.academy_level
  };
}

api.post('/auth/telegram', async (req, res, next) => {
  try {
    const { initData, unsafeUser } = req.body || {};
    const hasBotToken = Boolean(process.env.TELEGRAM_BOT_TOKEN);
    const allowUnverified = process.env.ALLOW_UNVERIFIED_TELEGRAM === '1' || !hasBotToken;

    if (hasBotToken && !allowUnverified && !verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN)) {
      return res.status(401).json({ error: 'Telegram initData verification failed' });
    }

    const telegramUser = extractTelegramUser(initData, unsafeUser) || (allowUnverified ? {
      id: 100001,
      username: 'demo_user',
      first_name: 'Demo',
      last_name: 'Academy'
    } : null);

    if (!telegramUser?.id) return res.status(401).json({ error: 'Telegram user is missing' });
    const user = await upsertTelegramUser(telegramUser);
    res.json({ token: signUser(user), user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

api.get('/me', requireAuth, async (req, res) => {
  const attempts = await query(
    `SELECT qa.id, qa.score, qa.max_score, qa.weighted_score, qa.passed, qa.created_at,
            q.title, q.category, q.difficulty
     FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id
     WHERE qa.user_id = $1
     ORDER BY qa.created_at DESC
     LIMIT 20`,
    [req.user.id]
  );
  const progress = await query(
    `SELECT cs.slug, cs.title, COALESCE(up.status, 'available') AS status, COALESCE(up.score, 0) AS score
     FROM course_sections cs
     JOIN courses c ON c.id = cs.course_id
     LEFT JOIN user_progress up ON up.section_id = cs.id AND up.user_id = $1
     WHERE c.slug = 'stazher-trail'
     ORDER BY cs.order_index`,
    [req.user.id]
  );
  res.json({ user: publicUser(req.user), attempts: attempts.rows, progress: progress.rows });
});

api.get('/home', requireAuth, async (req, res) => {
  const courses = await query('SELECT * FROM courses ORDER BY order_index, id');
  const tasks = await query('SELECT * FROM tasks WHERE active = true ORDER BY order_index');
  const top = await query(
    `SELECT id, username, first_name, last_name, photo_url, title_score, title_text
     FROM users
     ORDER BY title_score DESC, updated_at ASC
     LIMIT 5`
  );
  const rank = await query(
    `SELECT rank FROM (
       SELECT id, RANK() OVER (ORDER BY title_score DESC, updated_at ASC) AS rank
       FROM users
     ) ranked
     WHERE id = $1`,
    [req.user.id]
  );
  res.json({
    user: publicUser(req.user),
    courses: courses.rows,
    tasks: tasks.rows,
    leaderboard: top.rows,
    rank: rank.rows[0]?.rank || 1
  });
});

api.get('/courses', requireAuth, async (_req, res) => {
  const courses = await query('SELECT * FROM courses ORDER BY order_index, id');
  res.json({ courses: courses.rows });
});

api.get('/courses/:slug', requireAuth, async (req, res) => {
  const course = await query('SELECT * FROM courses WHERE slug = $1', [req.params.slug]);
  if (!course.rows[0]) return res.status(404).json({ error: 'Course not found' });
  const sections = await query(
    `SELECT cs.*, COALESCE(up.status, 'available') AS user_status, COALESCE(up.score, 0) AS user_score
     FROM course_sections cs
     LEFT JOIN user_progress up ON up.section_id = cs.id AND up.user_id = $1
     WHERE cs.course_id = $2
     ORDER BY cs.order_index`,
    [req.user.id, course.rows[0].id]
  );
  res.json({ course: course.rows[0], sections: sections.rows });
});

api.get('/quizzes', requireAuth, async (req, res) => {
  const quizzes = await query(
    `SELECT q.*,
            COALESCE(best.best_score, 0) AS best_score,
            COALESCE(best.best_weighted_score, 0) AS best_weighted_score,
            COALESCE(best.attempts_count, 0) AS attempts_count
     FROM quizzes q
     LEFT JOIN (
       SELECT quiz_id, MAX(score) AS best_score, MAX(weighted_score) AS best_weighted_score, COUNT(*) AS attempts_count
       FROM quiz_attempts
       WHERE user_id = $1
       GROUP BY quiz_id
     ) best ON best.quiz_id = q.id
     ORDER BY q.category, q.order_index`,
    [req.user.id]
  );
  res.json({ quizzes: quizzes.rows });
});

api.get('/quizzes/:slug', requireAuth, async (req, res) => {
  const quiz = await query('SELECT * FROM quizzes WHERE slug = $1', [req.params.slug]);
  if (!quiz.rows[0]) return res.status(404).json({ error: 'Quiz not found' });
  const questions = await query(
    `SELECT qq.id, qq.text, qq.media_url,
            json_agg(json_build_object('id', qo.id, 'text', qo.text) ORDER BY qo.order_index) AS options
     FROM quiz_questions qq
     JOIN quiz_options qo ON qo.question_id = qq.id
     WHERE qq.quiz_id = $1
     GROUP BY qq.id
     ORDER BY qq.order_index`,
    [quiz.rows[0].id]
  );
  res.json({ quiz: quiz.rows[0], questions: questions.rows });
});

api.post('/quizzes/:slug/attempt', requireAuth, async (req, res, next) => {
  try {
    const quizResult = await query('SELECT * FROM quizzes WHERE slug = $1', [req.params.slug]);
    const quiz = quizResult.rows[0];
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });

    const selected = req.body.answers || {};
    const optionIds = Object.values(selected).map(Number).filter(Boolean);
    const correct = optionIds.length
      ? await query('SELECT id FROM quiz_options WHERE id = ANY($1::int[]) AND is_correct = true', [optionIds])
      : { rows: [] };

    const score = correct.rows.length;
    const weightedScore = score * quiz.weight;
    const passed = score >= quiz.pass_score;

    const attempt = await query(
      `INSERT INTO quiz_attempts (user_id, quiz_id, score, max_score, weighted_score, passed, answers)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, quiz.id, score, quiz.max_score, weightedScore, passed, selected]
    );
    const user = await recalculateUserScore(req.user.id);
    res.json({ attempt: attempt.rows[0], user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

api.get('/leaderboard', requireAuth, async (req, res) => {
  const top = await query(
    `SELECT id, username, first_name, last_name, photo_url, title_score, title_text
     FROM users
     ORDER BY title_score DESC, updated_at ASC
     LIMIT 5`
  );
  const rank = await query(
    `SELECT rank FROM (
       SELECT id, RANK() OVER (ORDER BY title_score DESC, updated_at ASC) AS rank
       FROM users
     ) ranked
     WHERE id = $1`,
    [req.user.id]
  );
  res.json({ top: top.rows, myRank: rank.rows[0]?.rank || 1, me: publicUser(req.user) });
});

api.get('/tasks', requireAuth, async (req, res) => {
  const tasks = await query(
    `SELECT t.*,
            ts.status AS last_status,
            ts.reward_points AS last_reward,
            ts.created_at AS last_submitted_at
     FROM tasks t
     LEFT JOIN LATERAL (
       SELECT *
       FROM task_submissions
       WHERE task_id = t.id AND user_id = $1
       ORDER BY created_at DESC
       LIMIT 1
     ) ts ON true
     WHERE t.active = true
     ORDER BY t.order_index`,
    [req.user.id]
  );
  res.json({ tasks: tasks.rows });
});

api.get('/tasks/:slug/menu-options', requireAuth, async (req, res, next) => {
  try {
    const dishes = await fetchMissingPhotoDishes({
      typeEvent: req.query.typeEvent,
      classDish: req.query.classDish
    });
    res.json({ dishes });
  } catch (error) {
    next(error);
  }
});

api.post('/tasks/:slug/submissions', requireAuth, upload.array('files', 6), async (req, res, next) => {
  try {
    const taskResult = await query('SELECT * FROM tasks WHERE slug = $1 AND active = true', [req.params.slug]);
    const task = taskResult.rows[0];
    if (!task) return res.status(404).json({ error: 'Task not found' });
    const payload = {
      typeEvent: req.body.typeEvent || null,
      classDish: req.body.classDish || null,
      dishName: req.body.dishName || null
    };

    const submission = await withTransaction(async (client) => {
      const submissionResult = await client.query(
        `INSERT INTO task_submissions (task_id, user_id, comment, payload)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [task.id, req.user.id, req.body.comment || '', payload]
      );
      const submissionRow = submissionResult.rows[0];
      for (const file of req.files || []) {
        const publicUrl = `/uploads/${file.filename}`;
        await client.query(
          `INSERT INTO uploads (submission_id, original_name, file_name, file_path, mime_type, size_bytes, public_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [submissionRow.id, file.originalname, file.filename, file.path, file.mimetype, file.size, publicUrl]
        );
      }
      return submissionRow;
    });

    const appUrl = process.env.APP_URL || 'https://lofthallacademy.ru';
    const reviewText = [
      '<b>Новое задание на проверку</b>',
      `Задание: ${task.task_num}. ${task.title}`,
      `Пользователь: ${req.user.first_name || ''} ${req.user.last_name || ''} ${req.user.username ? `@${req.user.username}` : ''}`.trim(),
      `Комментарий: ${req.body.comment || '-'}`,
      payload.dishName ? `Блюдо: ${payload.dishName}` : null,
      `Открыть в админке: ${appUrl}/admin`
    ].filter(Boolean).join('\n');
    sendReviewMessage(reviewText).catch((error) => console.error('PuzzleBot review notification failed', error));

    res.status(201).json({ submission });
  } catch (error) {
    next(error);
  }
});

api.get('/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  const users = await query(
    `SELECT id, telegram_id, username, first_name, last_name, photo_url, role, title_score, title_text, academy_level, updated_at
     FROM users
     ORDER BY title_score DESC, updated_at DESC
     LIMIT 200`
  );
  res.json({ users: users.rows });
});

api.get('/admin/submissions', requireAuth, requireAdmin, async (_req, res) => {
  const submissions = await query(
    `SELECT ts.*, t.title AS task_title, t.task_num,
            u.telegram_id, u.username, u.first_name, u.last_name,
            COALESCE(json_agg(json_build_object('id', up.id, 'url', up.public_url, 'name', up.original_name)) FILTER (WHERE up.id IS NOT NULL), '[]') AS uploads
     FROM task_submissions ts
     JOIN tasks t ON t.id = ts.task_id
     JOIN users u ON u.id = ts.user_id
     LEFT JOIN uploads up ON up.submission_id = ts.id
     GROUP BY ts.id, t.title, t.task_num, u.telegram_id, u.username, u.first_name, u.last_name
     ORDER BY ts.created_at DESC
     LIMIT 200`
  );
  res.json({ submissions: submissions.rows });
});

api.post('/admin/submissions/:id/review', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { status = 'approved', rewardPoints = 0, adminComment = '' } = req.body || {};
    const result = await query(
      `UPDATE task_submissions
       SET status = $1, reward_points = $2, admin_comment = $3, reviewed_at = now()
       WHERE id = $4
       RETURNING *`,
      [status, rewardPoints, adminComment, req.params.id]
    );
    const submission = result.rows[0];
    if (!submission) return res.status(404).json({ error: 'Submission not found' });

    if (status === 'approved' && Number(rewardPoints) > 0) {
      await query(
        `INSERT INTO point_events (user_id, source_type, source_id, points, description)
         VALUES ($1, 'task', $2, $3, $4)`,
        [submission.user_id, submission.id, rewardPoints, adminComment || 'Награда за задание']
      );
      const user = await recalculateUserScore(submission.user_id);
      notifyReward(user.telegram_id, rewardPoints).catch((error) => console.error('PuzzleBot reward notification failed', error));
    }
    res.json({ submission });
  } catch (error) {
    next(error);
  }
});
