import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { query, withTransaction } from '../db/pool.js';
import { extractTelegramUser, verifyTelegramInitData } from '../services/telegramAuth.js';
import { fetchTelegramProfilePhoto, getTelegramBotUsername, hasTelegramProfilePhoto, sendTelegramMessage } from '../services/telegramBot.js';
import { recalculateUserScore } from '../services/scoring.js';
import { fetchMenuFilters, fetchMissingPhotoDishes } from '../services/nocodb.js';
import { notifyReward, sendReviewMessage } from '../services/puzzlebot.js';

export const api = express.Router();

const uploadDir = path.resolve(process.cwd(), 'uploads');
await fs.mkdir(uploadDir, { recursive: true });

const nonDemoUserSql = "(telegram_id IS NULL OR telegram_id <> 100001) AND COALESCE(username, '') <> 'demo_user'";
const isProduction = process.env.NODE_ENV === 'production';
const dangerousUploadExtensions = new Set(['.html', '.htm', '.svg', '.js', '.mjs', '.css', '.json']);
const dangerousUploadMimeTypes = new Set(['text/html', 'image/svg+xml', 'application/javascript', 'text/javascript', 'text/css']);
const quizDifficultyOrder = {
  easy: 1,
  middle: 2,
  medium: 2,
  hard: 3
};

function quizDifficultyRank(value) {
  return quizDifficultyOrder[String(value || '').toLowerCase()] || 99;
}

function resolveQuizOrderIndex(body = {}) {
  const explicit = body.orderIndex ?? body.order_index;
  if (explicit !== undefined && explicit !== null && explicit !== '') {
    const parsed = Number(explicit);
    if (Number.isFinite(parsed)) return parsed;
  }
  return quizDifficultyRank(body.difficulty) * 10;
}

function readVisibility(body = {}, fallback = true) {
  const value = body.isVisible ?? body.is_visible;
  if (value === undefined || value === null || value === '') return fallback;
  return !(value === false || value === 'false' || value === 0 || value === '0');
}

function hasVisibility(body = {}) {
  return body.isVisible !== undefined || body.is_visible !== undefined;
}

function formatPointsLabel(value) {
  const number = Math.abs(Number(value) || 0);
  const mod100 = number % 100;
  const mod10 = number % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'баллов';
  if (mod10 === 1) return 'балл';
  if (mod10 >= 2 && mod10 <= 4) return 'балла';
  return 'баллов';
}

function formatPoints(value) {
  return `${value} ${formatPointsLabel(value)}`;
}

function getRequiredConfig(name) {
  const value = String(process.env[name] || '').trim();
  if (!value && isProduction) throw new Error(`${name} is not configured`);
  return value;
}

function getSessionSecret() {
  const secret = String(process.env.SESSION_SECRET || '').trim();
  if (secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return secret;
}

function getAppUrl() {
  const value = getRequiredConfig('APP_URL').replace(/\/+$/, '');
  return value || 'http://localhost:3000';
}

const sessionSecret = getSessionSecret();

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
    files: 12
  },
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    const mimeType = String(file.mimetype || '').toLowerCase();
    if (dangerousUploadExtensions.has(ext) || dangerousUploadMimeTypes.has(mimeType)) {
      return callback(new Error('Недопустимый тип файла'));
    }
    return callback(null, true);
  }
});

function signUser(user) {
  return jwt.sign({ userId: user.id, role: user.role }, sessionSecret, { expiresIn: '30d' });
}

async function upsertTelegramUser(telegramUser) {
  let photoUrl = telegramUser.photo_url || null;
  if (!photoUrl && await hasTelegramProfilePhoto(telegramUser.id)) {
    photoUrl = `/api/telegram/avatar/${telegramUser.id}`;
  }
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
      photoUrl,
      role
    ]
  );
  return result.rows[0];
}

api.get('/telegram/avatar/:telegramId', async (req, res, next) => {
  try {
    const photo = await fetchTelegramProfilePhoto(req.params.telegramId);
    if (!photo) return res.status(404).end();
    res.setHeader('Content-Type', photo.contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    res.send(photo.buffer);
  } catch (error) {
    next(error);
  }
});

async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Auth token required' });
    const payload = jwt.verify(token, sessionSecret);
    const result = await query('SELECT * FROM users WHERE id = $1', [payload.userId]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'User not found' });
    if (process.env.ALLOW_UNVERIFIED_TELEGRAM !== '1' && String(user.telegram_id) === '100001') {
      return res.status(401).json({ error: 'Тестовая demo-сессия больше не действует. Откройте Академию через Telegram.' });
    }
    req.user = user;
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
    academyLevel: user.academy_level,
    courseCompletedAt: user.course_completed_at
  };
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `item-${Date.now()}`;
}

async function createUniqueSlug(client, table, baseValue, excludeId = null) {
  const base = slugify(baseValue);
  let slug = base;
  let index = 2;
  while (true) {
    const params = excludeId ? [slug, excludeId] : [slug];
    const result = await client.query(
      `SELECT id FROM ${table} WHERE slug = $1${excludeId ? ' AND id <> $2' : ''} LIMIT 1`,
      params
    );
    if (!result.rows[0]) return slug;
    slug = `${base}-${index}`;
    index += 1;
  }
}

async function renumberActiveTasks(client) {
  await client.query(
    `WITH ordered AS (
       SELECT id, ROW_NUMBER() OVER (ORDER BY order_index, task_num, id) AS num
       FROM tasks
       WHERE active = true
     )
     UPDATE tasks t
     SET task_num = ordered.num,
         order_index = ordered.num
     FROM ordered
     WHERE t.id = ordered.id`
  );
}

async function isSectionCompleted(userId, sectionId) {
  const stored = await query(
    `SELECT 1 FROM user_progress
     WHERE user_id = $1 AND section_id = $2 AND status = 'completed'
     LIMIT 1`,
    [userId, sectionId]
  );
  if (stored.rows[0]) return true;

  const required = await query(
    `SELECT COUNT(*)::int AS total
     FROM quizzes
     WHERE section_id = $1 AND source = 'course' AND course_required = true`,
    [sectionId]
  );
  const total = Number(required.rows[0]?.total || 0);
  if (!total) return false;

  const passed = await query(
    `SELECT COUNT(DISTINCT q.id)::int AS total
     FROM quizzes q
     JOIN quiz_attempts qa ON qa.quiz_id = q.id AND qa.user_id = $2 AND qa.passed = true
     WHERE q.section_id = $1 AND q.source = 'course' AND q.course_required = true`,
    [sectionId, userId]
  );
  return Number(passed.rows[0]?.total || 0) >= total;
}

async function canAccessSection(user, sectionId) {
  if (user.course_completed_at || Number(user.title_score || 0) > 100) return true;
  const current = await query('SELECT id, course_id, order_index FROM course_sections WHERE id = $1', [sectionId]);
  const section = current.rows[0];
  if (!section) return false;
  if (section.order_index === 1) return true;
  const previous = await query(
    `SELECT id FROM course_sections
     WHERE course_id = $1 AND order_index < $2
     ORDER BY order_index DESC
     LIMIT 1`,
    [section.course_id, section.order_index]
  );
  if (!previous.rows[0]) return true;
  return isSectionCompleted(user.id, previous.rows[0].id);
}

async function refreshCourseSectionCompletion(userId, sectionId) {
  const stats = await query(
    `SELECT cs.order_index, cs.slug,
            COUNT(q.id)::int AS required_count,
            COUNT(DISTINCT passed.quiz_id)::int AS passed_count
     FROM course_sections cs
     LEFT JOIN quizzes q ON q.section_id = cs.id AND q.source = 'course' AND q.course_required = true
     LEFT JOIN quiz_attempts passed ON passed.quiz_id = q.id AND passed.user_id = $2 AND passed.passed = true
     WHERE cs.id = $1
     GROUP BY cs.id`,
    [sectionId, userId]
  );
  const row = stats.rows[0];
  if (!row || Number(row.required_count || 0) === 0 || Number(row.passed_count || 0) < Number(row.required_count || 0)) {
    return false;
  }

  await query(
    `INSERT INTO user_progress (user_id, section_id, status, completed_at)
     VALUES ($1, $2, 'completed', now())
     ON CONFLICT (user_id, section_id) DO UPDATE
     SET status = 'completed',
         completed_at = COALESCE(user_progress.completed_at, now())`,
    [userId, sectionId]
  );
  await query(
    `UPDATE users
     SET academy_level = GREATEST(academy_level, $2),
         course_completed_at = CASE WHEN $3 = 'final' THEN COALESCE(course_completed_at, now()) ELSE course_completed_at END,
         updated_at = now()
     WHERE id = $1`,
    [userId, row.order_index, row.slug]
  );
  return true;
}

async function buildCoursePayload(courseSlug, user) {
  const course = await query('SELECT * FROM courses WHERE slug = $1', [courseSlug]);
  if (!course.rows[0]) return null;
  const rows = await query(
    `SELECT cs.*,
            COALESCE(up.status, 'locked') AS stored_status,
            COALESCE(stats.required_count, 0) AS required_count,
            COALESCE(stats.passed_count, 0) AS passed_count,
            COALESCE(lessons.items, '[]'::json) AS lessons,
            COALESCE(quizzes.items, '[]'::json) AS quizzes
     FROM course_sections cs
     LEFT JOIN user_progress up ON up.section_id = cs.id AND up.user_id = $1
     LEFT JOIN LATERAL (
       SELECT COUNT(q.id)::int AS required_count,
              COUNT(DISTINCT passed.quiz_id)::int AS passed_count
       FROM quizzes q
       LEFT JOIN quiz_attempts passed ON passed.quiz_id = q.id AND passed.user_id = $1 AND passed.passed = true
       WHERE q.section_id = cs.id AND q.source = 'course' AND q.course_required = true
     ) stats ON true
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object(
                'id', cl.id,
                'slug', cl.slug,
                'title', cl.title,
                'body', cl.body,
                'media', cl.media,
                'legacyCommand', cl.legacy_command
              ) ORDER BY cl.order_index, cl.id) AS items
       FROM course_lessons cl
       WHERE cl.section_id = cs.id
     ) lessons ON true
     LEFT JOIN LATERAL (
       SELECT json_agg(json_build_object(
                'id', q.id,
                'slug', q.slug,
                'title', q.title,
                'passScore', q.pass_score,
                'maxScore', q.max_score,
                'rewardPoints', q.reward_points,
                'bestScore', COALESCE(best.best_score, 0),
                'passed', COALESCE(best.passed, false)
              ) ORDER BY q.order_index, q.id) AS items
       FROM quizzes q
       LEFT JOIN LATERAL (
         SELECT MAX(score) AS best_score, BOOL_OR(passed) AS passed
         FROM quiz_attempts qa
         WHERE qa.quiz_id = q.id AND qa.user_id = $1
       ) best ON true
       WHERE q.section_id = cs.id AND q.source = 'course'
     ) quizzes ON true
     WHERE cs.course_id = $2
     ORDER BY cs.order_index`,
    [user.id, course.rows[0].id]
  );

  let previousCompleted = true;
  const courseCompleted = Boolean(user.course_completed_at);
  const bypass = Number(user.title_score || 0) > 100;
  const sections = rows.rows.map((section) => {
    const completedByQuiz = Number(section.required_count || 0) > 0 && Number(section.passed_count || 0) >= Number(section.required_count || 0);
    const completed = courseCompleted || section.stored_status === 'completed' || completedByQuiz;
    const accessible = courseCompleted || bypass || completed || previousCompleted;
    const status = completed ? 'completed' : accessible ? 'available' : 'locked';
    previousCompleted = completed;
    return {
      ...section,
      user_status: status,
      isAccessible: accessible,
      isCompleted: completed,
      required_count: Number(section.required_count || 0),
      passed_count: Number(section.passed_count || 0)
    };
  });
  return { course: course.rows[0], sections, completed: courseCompleted };
}

function normalizeHashtag(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '');
}

function formatReviewMessage({ task, user, comment, payload }) {
  const tags = [`#${task.task_num}задание`];
  if (payload.typeEvent) tags.push(`#${normalizeHashtag(payload.typeEvent)}`);
  if (payload.classDish) tags.push(`#${normalizeHashtag(payload.classDish)}`);

  return [
    '<b>Новый ответ на задание</b>',
    tags.join(' '),
    '',
    `Пользователь: ${[user.first_name, user.last_name].filter(Boolean).join(' ')} ${user.username ? `@${user.username}` : ''}`.trim(),
    `id: ${user.telegram_id || user.id}`,
    payload.typeEvent ? `Тип мероприятия: ${payload.typeEvent}` : null,
    payload.classDish ? `Тип блюда: ${payload.classDish}` : null,
    payload.dishName ? `Блюдо: ${payload.dishName}` : null,
    '',
    '<b>Комментарий:</b>',
    comment || '-'
  ].filter((line) => line !== null).join('\n');
}

async function buildSubmissionRewardUrl(submissionId) {
  const startParam = `review_${submissionId}`;
  const configuredBase = process.env.TELEGRAM_MINI_APP_DEEP_LINK_BASE;
  if (configuredBase) {
    const url = new URL(configuredBase);
    url.searchParams.set('startapp', startParam);
    return url.toString();
  }

  const botUsername = await getTelegramBotUsername();
  if (botUsername) {
    const shortName = String(process.env.TELEGRAM_MINI_APP_SHORT_NAME || '').trim().replace(/^\/+|\/+$/g, '');
    if (shortName) return `https://t.me/${botUsername}/${shortName}?startapp=${startParam}`;
  }

  const appUrl = getAppUrl();
  return `${appUrl}/?page=admin&submissionId=${submissionId}`;
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
      username: 'preview_user',
      first_name: 'Preview',
      last_name: ''
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
            q.title,
            CASE WHEN q.source = 'course' THEN 'Стажерская тропа' ELSE q.category END AS category,
            q.difficulty,
            q.source
     FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id
     WHERE qa.user_id = $1
     ORDER BY qa.created_at DESC
     LIMIT 50`,
    [req.user.id]
  );
  const course = await buildCoursePayload('stazher-trail', req.user);
  const progress = (course?.sections || []).map((section) => ({
    course_slug: course.course.slug,
    course_title: course.course.title,
    course_difficulty: course.course.difficulty,
    slug: section.slug,
    title: section.title,
    status: section.user_status,
    score: section.passed_count
  }));
  res.json({ user: publicUser(req.user), attempts: attempts.rows, progress });
});

api.get('/home', requireAuth, async (req, res) => {
  const courses = await query('SELECT * FROM courses ORDER BY order_index, id');
  const tasks = await query('SELECT * FROM tasks WHERE active = true ORDER BY order_index');
  const top = await query(
    `SELECT id, username, first_name, last_name, photo_url, title_score, title_text
     FROM users
     WHERE ${nonDemoUserSql}
     ORDER BY title_score DESC, updated_at ASC
     LIMIT 5`
  );
  const rank = await query(
    `SELECT rank FROM (
       SELECT id, RANK() OVER (ORDER BY title_score DESC, updated_at ASC) AS rank
       FROM users
       WHERE ${nonDemoUserSql}
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
  const payload = await buildCoursePayload(req.params.slug, req.user);
  if (!payload) return res.status(404).json({ error: 'Course not found' });
  res.json(payload);
});

api.post('/courses/:courseSlug/sections/:sectionSlug/complete', requireAuth, async (req, res, next) => {
  try {
    const section = await query(
      `SELECT cs.*
       FROM course_sections cs
       JOIN courses c ON c.id = cs.course_id
       WHERE c.slug = $1 AND cs.slug = $2`,
      [req.params.courseSlug, req.params.sectionSlug]
    );
    const row = section.rows[0];
    if (!row) return res.status(404).json({ error: 'Section not found' });
    const allowed = await canAccessSection(req.user, row.id);
    if (!allowed) return res.status(403).json({ error: 'Сначала завершите предыдущий этап курса.' });
    const required = await query(
      `SELECT COUNT(*)::int AS total
       FROM quizzes
       WHERE section_id = $1 AND source = 'course' AND course_required = true`,
      [row.id]
    );
    if (Number(required.rows[0]?.total || 0) > 0) {
      return res.status(400).json({ error: 'Этот этап завершается контрольным тестом.' });
    }
    await query(
      `INSERT INTO user_progress (user_id, section_id, status, completed_at)
       VALUES ($1, $2, 'completed', now())
       ON CONFLICT (user_id, section_id) DO UPDATE
       SET status = 'completed',
           completed_at = COALESCE(user_progress.completed_at, now())`,
      [req.user.id, row.id]
    );
    await query(
      `UPDATE users
       SET academy_level = GREATEST(academy_level, $2), updated_at = now()
       WHERE id = $1`,
      [req.user.id, row.order_index]
    );
    const updatedUser = (await query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    const payload = await buildCoursePayload(req.params.courseSlug, updatedUser);
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

api.get('/quizzes', requireAuth, async (req, res) => {
  const quizzes = await query(
    `SELECT q.id, q.slug, q.title, q.category, q.source, q.difficulty, q.weight,
            q.reward_points, q.pass_score, q.max_score, q.section_id, q.course_required, q.order_index,
            COALESCE(NULLIF(qs.description, ''), q.description, '') AS description,
            COALESCE(qs.description, '') AS series_description,
            COALESCE(best.best_score, 0) AS best_score,
            COALESCE(best.best_weighted_score, 0) AS best_weighted_score,
            COALESCE(best.attempts_count, 0) AS attempts_count
     FROM quizzes q
     LEFT JOIN quiz_series qs ON qs.name = q.category
     LEFT JOIN (
       SELECT quiz_id, MAX(score) AS best_score, MAX(weighted_score) AS best_weighted_score, COUNT(*) AS attempts_count
       FROM quiz_attempts
       WHERE user_id = $1
       GROUP BY quiz_id
     ) best ON best.quiz_id = q.id
     WHERE q.source = 'tests'
       AND q.is_visible = true
       AND COALESCE(qs.is_visible, true) = true
     ORDER BY q.category,
              CASE q.difficulty
                WHEN 'easy' THEN 1
                WHEN 'middle' THEN 2
                WHEN 'medium' THEN 2
                WHEN 'hard' THEN 3
                ELSE 99
              END,
              q.order_index,
              q.id`,
    [req.user.id]
  );
  res.json({ quizzes: quizzes.rows });
});

api.get('/quizzes/:slug', requireAuth, async (req, res) => {
  const quiz = await query(
    `SELECT q.*, COALESCE(qs.is_visible, true) AS series_is_visible
     FROM quizzes q
     LEFT JOIN quiz_series qs ON qs.name = q.category
     WHERE q.slug = $1`,
    [req.params.slug]
  );
  if (!quiz.rows[0]) return res.status(404).json({ error: 'Quiz not found' });
  if (
    quiz.rows[0].source === 'tests'
    && req.user.role !== 'admin'
    && (!quiz.rows[0].is_visible || !quiz.rows[0].series_is_visible)
  ) {
    return res.status(404).json({ error: 'Quiz not found' });
  }
  if (quiz.rows[0].source === 'course') {
    const allowed = await canAccessSection(req.user, quiz.rows[0].section_id);
    if (!allowed) return res.status(403).json({ error: 'Сначала завершите предыдущий этап курса.' });
  }
  const questions = await query(
    `SELECT qq.id, qq.text, qq.hint, qq.media_url,
            json_agg(json_build_object('id', qo.id, 'text', qo.text, 'isCorrect', qo.is_correct) ORDER BY qo.order_index) AS options
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
    const quizResult = await query(
      `SELECT q.*, COALESCE(qs.is_visible, true) AS series_is_visible
       FROM quizzes q
       LEFT JOIN quiz_series qs ON qs.name = q.category
       WHERE q.slug = $1`,
      [req.params.slug]
    );
    const quiz = quizResult.rows[0];
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    if (
      quiz.source === 'tests'
      && req.user.role !== 'admin'
      && (!quiz.is_visible || !quiz.series_is_visible)
    ) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    if (quiz.source === 'course') {
      const allowed = await canAccessSection(req.user, quiz.section_id);
      if (!allowed) return res.status(403).json({ error: 'Сначала завершите предыдущий этап курса.' });
    }

    const selected = req.body.answers || {};
    const optionIds = Object.values(selected).map(Number).filter(Boolean);
    const correct = optionIds.length
      ? await query('SELECT id FROM quiz_options WHERE id = ANY($1::int[]) AND is_correct = true', [optionIds])
      : { rows: [] };

    const score = correct.rows.length;
    const passed = score >= quiz.pass_score;
    const weightedScore = quiz.source === 'course'
      ? (passed ? Number(quiz.reward_points || 0) : 0)
      : score * quiz.weight;

    const attempt = await query(
      `INSERT INTO quiz_attempts (user_id, quiz_id, score, max_score, weighted_score, passed, answers)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, quiz.id, score, quiz.max_score, weightedScore, passed, selected]
    );
    if (quiz.source === 'course' && passed) {
      await refreshCourseSectionCompletion(req.user.id, quiz.section_id);
    }
    const user = await recalculateUserScore(req.user.id);
    res.json({ attempt: attempt.rows[0], user: publicUser(user) });
  } catch (error) {
    next(error);
  }
});

api.get('/quiz-attempts/:id', requireAuth, async (req, res) => {
  const attemptResult = await query(
    `SELECT qa.id, qa.score, qa.max_score, qa.weighted_score, qa.passed, qa.created_at, qa.answers,
            q.id AS quiz_id,
            q.title,
            CASE WHEN q.source = 'course' THEN 'Стажерская тропа' ELSE q.category END AS category,
            q.difficulty,
            q.source
     FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id
     WHERE qa.id = $1 AND qa.user_id = $2`,
    [req.params.id, req.user.id]
  );
  const attempt = attemptResult.rows[0];
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  const questions = await query(
    `SELECT qq.id, qq.text,
            selected.text AS "selectedOptionText",
            COALESCE(selected.is_correct, false) AS "isCorrect"
     FROM quiz_questions qq
     CROSS JOIN (SELECT $2::jsonb AS answers) attempt_answers
     LEFT JOIN LATERAL (
       SELECT qo.text, qo.is_correct
       FROM quiz_options qo
       WHERE qo.question_id = qq.id
         AND qo.id::text = attempt_answers.answers ->> qq.id::text
       LIMIT 1
     ) selected ON true
     WHERE qq.quiz_id = $1
     ORDER BY qq.order_index`,
    [attempt.quiz_id, attempt.answers || {}]
  );
  delete attempt.answers;
  res.json({ attempt, questions: questions.rows });
});

api.get('/leaderboard', requireAuth, async (req, res) => {
  const requestedLimit = Number(req.query.limit || 25);
  const requestedOffset = Number(req.query.offset || 0);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 25));
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : 0);
  const top = await query(
    `SELECT id, username, first_name, last_name, photo_url, title_score, title_text
     FROM users
     WHERE ${nonDemoUserSql}
     ORDER BY title_score DESC, updated_at ASC
     LIMIT $1 OFFSET $2`,
    [limit + 1, offset]
  );
  const rows = top.rows.slice(0, limit);
  const rank = await query(
    `SELECT rank FROM (
       SELECT id, RANK() OVER (ORDER BY title_score DESC, updated_at ASC) AS rank
       FROM users
       WHERE ${nonDemoUserSql}
     ) ranked
     WHERE id = $1`,
    [req.user.id]
  );
  res.json({ top: rows, hasMore: top.rows.length > limit, nextOffset: offset + rows.length, myRank: rank.rows[0]?.rank || 1, me: publicUser(req.user) });
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

api.get('/tasks/:slug/menu-filters', requireAuth, async (_req, res, next) => {
  try {
    const filters = await fetchMenuFilters();
    res.json(filters);
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

    const uploadedFiles = [];
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
        uploadedFiles.push({ publicUrl, mimeType: file.mimetype });
      }
      return submissionRow;
    });

    const appUrl = getAppUrl();
    const reviewText = formatReviewMessage({ task, user: req.user, comment: req.body.comment, payload });
    const firstPhoto = uploadedFiles.find((file) => file.mimeType?.startsWith('image/'));
    const rewardUrl = await buildSubmissionRewardUrl(submission.id);
    sendReviewMessage({
      text: reviewText,
      photoUrl: firstPhoto ? `${appUrl}${firstPhoto.publicUrl}` : null,
      rewardUrl
    }).catch((error) => console.error('PuzzleBot review notification failed', error));

    res.status(201).json({ submission });
  } catch (error) {
    next(error);
  }
});

api.get('/content-pages/:slug', requireAuth, async (req, res) => {
  const page = await query('SELECT * FROM content_pages WHERE slug = $1', [req.params.slug]);
  if (!page.rows[0]) return res.status(404).json({ error: 'Content page not found' });
  res.json({ page: page.rows[0] });
});

async function readAdminCourses() {
  const courses = await query('SELECT * FROM courses ORDER BY order_index, id');
  const sections = await query(
    `SELECT cs.*
     FROM course_sections cs
     JOIN courses c ON c.id = cs.course_id
     ORDER BY c.order_index, cs.order_index, cs.id`
  );
  const lessons = await query(
    `SELECT cl.*
     FROM course_lessons cl
     JOIN course_sections cs ON cs.id = cl.section_id
     JOIN courses c ON c.id = cs.course_id
     ORDER BY c.order_index, cs.order_index, cl.order_index, cl.id`
  );
  const lessonsBySection = new Map();
  for (const lesson of lessons.rows) {
    if (!lessonsBySection.has(lesson.section_id)) lessonsBySection.set(lesson.section_id, []);
    lessonsBySection.get(lesson.section_id).push(lesson);
  }
  const sectionsByCourse = new Map();
  for (const section of sections.rows) {
    if (!sectionsByCourse.has(section.course_id)) sectionsByCourse.set(section.course_id, []);
    sectionsByCourse.get(section.course_id).push({ ...section, lessons: lessonsBySection.get(section.id) || [] });
  }
  return courses.rows.map((course) => ({ ...course, sections: sectionsByCourse.get(course.id) || [] }));
}

api.get('/admin/courses', requireAuth, requireAdmin, async (_req, res) => {
  res.json({ courses: await readAdminCourses() });
});

async function saveCourseSections(client, courseId, sections = []) {
  for (const [sectionIndex, section] of sections.entries()) {
    if (!section.title) continue;
    const orderIndex = sectionIndex + 1;
    let sectionId = section.id ? Number(section.id) : null;
    if (sectionId) {
      const updated = await client.query(
        `UPDATE course_sections
         SET title = $1, description = $2, order_index = $3
         WHERE id = $4 AND course_id = $5
         RETURNING id`,
        [section.title, section.description || '', orderIndex, sectionId, courseId]
      );
      sectionId = updated.rows[0]?.id || null;
    }
    if (!sectionId) {
      const slug = await createUniqueSlug(client, 'course_sections', section.title);
      const created = await client.query(
        `INSERT INTO course_sections (course_id, slug, title, description, order_index)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [courseId, slug, section.title, section.description || '', orderIndex]
      );
      sectionId = created.rows[0].id;
    }

    for (const [lessonIndex, lesson] of (section.lessons || []).entries()) {
      if (!lesson.title && !lesson.body) continue;
      const media = Array.isArray(lesson.media)
        ? lesson.media
        : String(lesson.mediaText || '')
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean);
      if (lesson.id) {
        await client.query(
          `UPDATE course_lessons
           SET title = $1, body = $2, media = $3::jsonb, order_index = $4
           WHERE id = $5 AND section_id = $6`,
          [lesson.title || 'Материал', lesson.body || '', JSON.stringify(media), lessonIndex + 1, lesson.id, sectionId]
        );
      } else {
        const slug = await createUniqueSlug(client, 'course_lessons', `${section.title}-${lesson.title || 'material'}`);
        await client.query(
          `INSERT INTO course_lessons (section_id, slug, title, body, media, order_index)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
          [sectionId, slug, lesson.title || 'Материал', lesson.body || '', JSON.stringify(media), lessonIndex + 1]
        );
      }
    }
  }
}

api.post('/admin/courses', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: 'Course title is required' });
    const course = await withTransaction(async (client) => {
      const slug = await createUniqueSlug(client, 'courses', body.title);
      const order = await client.query('SELECT COALESCE(MAX(order_index), 0) + 1 AS next_order FROM courses');
      const created = await client.query(
        `INSERT INTO courses (slug, title, difficulty, description, order_index)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [slug, body.title, body.difficulty || 'начальный', body.description || '', Number(order.rows[0]?.next_order || 1)]
      );
      await saveCourseSections(client, created.rows[0].id, body.sections || []);
      return created.rows[0];
    });
    res.status(201).json({ course });
  } catch (error) {
    next(error);
  }
});

api.put('/admin/courses/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.title) return res.status(400).json({ error: 'Course title is required' });
    const course = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE courses
         SET title = $1, difficulty = $2, description = $3
         WHERE id = $4
         RETURNING *`,
        [body.title, body.difficulty || 'начальный', body.description || '', req.params.id]
      );
      if (!updated.rows[0]) return null;
      await saveCourseSections(client, updated.rows[0].id, body.sections || []);
      return updated.rows[0];
    });
    if (!course) return res.status(404).json({ error: 'Course not found' });
    res.json({ course });
  } catch (error) {
    next(error);
  }
});

api.get('/admin/users', requireAuth, requireAdmin, async (_req, res) => {
  const users = await query(
    `SELECT id, telegram_id, username, first_name, last_name, photo_url, role, title_score, title_text, academy_level, updated_at
     FROM users
     WHERE ${nonDemoUserSql}
     ORDER BY title_score DESC, updated_at DESC
     LIMIT 200`
  );
  res.json({ users: users.rows });
});

api.get('/admin/submissions', requireAuth, requireAdmin, async (req, res) => {
  const status = req.query.status || 'pending';
  const where = status === 'all' ? '' : 'WHERE ts.status = $1';
  const params = status === 'all' ? [] : [status];
  const submissions = await query(
    `SELECT ts.*, t.title AS task_title, t.task_num,
            u.telegram_id, u.username, u.first_name, u.last_name,
            COALESCE(json_agg(json_build_object('id', up.id, 'url', up.public_url, 'name', up.original_name)) FILTER (WHERE up.id IS NOT NULL), '[]') AS uploads
     FROM task_submissions ts
     JOIN tasks t ON t.id = ts.task_id
     JOIN users u ON u.id = ts.user_id
     LEFT JOIN uploads up ON up.submission_id = ts.id
     ${where}
     GROUP BY ts.id, t.title, t.task_num, u.telegram_id, u.username, u.first_name, u.last_name
     ORDER BY ts.created_at DESC
     LIMIT 200`,
    params
  );
  res.json({ submissions: submissions.rows });
});

api.post('/admin/submissions/:id/review', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { status = 'approved', rewardPoints = 0, adminComment = '' } = req.body || {};
    if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid review status' });
    const reward = Math.max(0, Number(rewardPoints || 0));
    const submission = await withTransaction(async (client) => {
      const result = await client.query(
        `UPDATE task_submissions
         SET status = $1, reward_points = $2, admin_comment = $3, reviewed_at = now()
         WHERE id = $4
         RETURNING *`,
        [status, reward, adminComment, req.params.id]
      );
      const row = result.rows[0];
      if (!row) return null;
      await client.query("DELETE FROM point_events WHERE source_type = 'task' AND source_id = $1", [row.id]);
      if (status === 'approved' && reward > 0) {
        await client.query(
          `INSERT INTO point_events (user_id, source_type, source_id, points, description)
           VALUES ($1, 'task', $2, $3, $4)`,
          [row.user_id, row.id, reward, adminComment || 'Награда за задание']
        );
      }
      return row;
    });
    if (!submission) return res.status(404).json({ error: 'Submission not found' });

    const user = await recalculateUserScore(submission.user_id);
    const task = await query(
      `SELECT t.title, t.task_num
       FROM task_submissions ts
       JOIN tasks t ON t.id = ts.task_id
       WHERE ts.id = $1`,
      [submission.id]
    );
    if (status === 'approved') {
      const text = `Ваш ответ на задание «${task.rows[0]?.title || 'Академии'}» засчитан. Добавлено ${formatPoints(reward)}.`;
      sendTelegramMessage(user.telegram_id, text).catch((error) => console.error('Telegram reward message failed', error));
      if (reward > 0) {
        notifyReward(user.telegram_id, reward).catch((error) => console.error('PuzzleBot reward notification failed', error));
      }
    } else {
      const text = `Ваш ответ на задание «${task.rows[0]?.title || 'Академии'}» отклонен.${adminComment ? ` Комментарий: ${adminComment}` : ''}`;
      sendTelegramMessage(user.telegram_id, text).catch((error) => console.error('Telegram rejection message failed', error));
    }
    res.json({ submission });
  } catch (error) {
    next(error);
  }
});

api.get('/admin/tasks', requireAuth, requireAdmin, async (_req, res) => {
  const tasks = await query('SELECT * FROM tasks WHERE active = true ORDER BY task_num, order_index, id');
  res.json({ tasks: tasks.rows });
});

api.post('/admin/uploads', requireAuth, requireAdmin, upload.array('files', 12), async (req, res) => {
  const files = (req.files || []).map((file) => ({
    url: `/uploads/${file.filename}`,
    name: file.originalname,
    mimeType: file.mimetype,
    size: file.size
  }));
  res.status(201).json({ files });
});

api.post('/admin/tasks', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, description = '' } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Task title is required' });
    const result = await withTransaction(async (client) => {
      const number = await client.query('SELECT COALESCE(MAX(task_num), 0) + 1 AS next_num FROM tasks WHERE active = true');
      const taskNum = Number(number.rows[0]?.next_num || 1);
      const slug = req.body.slug || await createUniqueSlug(client, 'tasks', title);
      const inserted = await client.query(
        `INSERT INTO tasks (slug, task_num, title, description, requires_menu, active, order_index)
         VALUES ($1, $2, $3, $4, false, true, $2)
         RETURNING *`,
        [slug, taskNum, title, description]
      );
      await renumberActiveTasks(client);
      return inserted;
    });
    res.status(201).json({ task: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

api.put('/admin/tasks/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { title, description = '' } = req.body || {};
    if (!title) return res.status(400).json({ error: 'Task title is required' });
    const result = await query(
      `UPDATE tasks
       SET title = $1,
           description = $2
       WHERE id = $3 AND active = true
       RETURNING *`,
      [title, description, req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

api.delete('/admin/tasks/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const deleted = await client.query('UPDATE tasks SET active = false WHERE id = $1 RETURNING *', [req.params.id]);
      if (deleted.rows[0]) await renumberActiveTasks(client);
      return deleted;
    });
    if (!result.rows[0]) return res.status(404).json({ error: 'Task not found' });
    res.json({ task: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

async function replaceQuizQuestions(client, quizId, questions) {
  await client.query('DELETE FROM quiz_questions WHERE quiz_id = $1', [quizId]);
  for (const [questionIndex, question] of questions.entries()) {
    const questionRow = await client.query(
      `INSERT INTO quiz_questions (quiz_id, order_index, text, media_url, hint)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [quizId, questionIndex + 1, question.text, question.mediaUrl || null, question.hint || '']
    );
    for (const [optionIndex, option] of (question.options || []).entries()) {
      await client.query(
        `INSERT INTO quiz_options (question_id, order_index, text, is_correct)
         VALUES ($1, $2, $3, $4)`,
        [questionRow.rows[0].id, optionIndex + 1, option.text, Boolean(option.isCorrect)]
      );
    }
  }
}

async function upsertQuizSeries(client, name, description, isVisible) {
  if (!name) return;
  const hasDescription = typeof description === 'string';
  const shouldUpdateVisibility = isVisible !== undefined && isVisible !== null;
  await client.query(
    `INSERT INTO quiz_series (name, description, is_visible, updated_at)
     VALUES ($1, $2, $4, now())
     ON CONFLICT (name) DO UPDATE
     SET description = CASE WHEN $3 THEN EXCLUDED.description ELSE quiz_series.description END,
         is_visible = CASE WHEN $5 THEN EXCLUDED.is_visible ELSE quiz_series.is_visible END,
         updated_at = now()`,
    [name, hasDescription ? description : '', hasDescription, readVisibility({ isVisible }, true), shouldUpdateVisibility]
  );
}

async function readQuizWithQuestions(quizId) {
  const quiz = await query(
    `SELECT q.id, q.slug, q.title, q.category, q.source, q.difficulty, q.weight,
            q.reward_points, q.pass_score, q.max_score, q.section_id, q.course_required, q.is_visible, q.order_index,
            COALESCE(NULLIF(qs.description, ''), q.description, '') AS description,
            COALESCE(qs.description, '') AS series_description,
            COALESCE(qs.is_visible, true) AS series_is_visible,
            cs.slug AS section_slug
     FROM quizzes q
     LEFT JOIN quiz_series qs ON qs.name = q.category
     LEFT JOIN course_sections cs ON cs.id = q.section_id
     WHERE q.id = $1`,
    [quizId]
  );
  if (!quiz.rows[0]) return null;
  const questions = await query(
    `SELECT qq.id, qq.text, qq.hint, qq.media_url,
            COALESCE(json_agg(json_build_object('id', qo.id, 'text', qo.text, 'isCorrect', qo.is_correct) ORDER BY qo.order_index) FILTER (WHERE qo.id IS NOT NULL), '[]') AS options
     FROM quiz_questions qq
     LEFT JOIN quiz_options qo ON qo.question_id = qq.id
     WHERE qq.quiz_id = $1
     GROUP BY qq.id
     ORDER BY qq.order_index`,
    [quizId]
  );
  return { ...quiz.rows[0], questions: questions.rows };
}

api.post('/admin/quiz-series', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Series name is required' });
    const result = await query(
      `INSERT INTO quiz_series (name, description, is_visible, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (name) DO UPDATE
       SET description = EXCLUDED.description,
           is_visible = EXCLUDED.is_visible,
           updated_at = now()
       RETURNING *`,
      [name, req.body?.description || '', readVisibility(req.body, true)]
    );
    res.status(201).json({ series: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

api.put('/admin/quiz-series/:name', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const oldName = req.params.name;
    const nextName = String(req.body?.name || '').trim();
    if (!nextName) return res.status(400).json({ error: 'Series name is required' });
    const result = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE quiz_series
         SET name = $1, description = $2, is_visible = $3, updated_at = now()
         WHERE name = $4
         RETURNING *`,
        [nextName, req.body?.description || '', readVisibility(req.body, true), oldName]
      );
      if (!updated.rows[0]) return null;
      if (nextName !== oldName) {
        await client.query("UPDATE quizzes SET category = $1 WHERE category = $2 AND source = 'tests'", [nextName, oldName]);
      }
      return updated.rows[0];
    });
    if (!result) return res.status(404).json({ error: 'Series not found' });
    res.json({ series: result });
  } catch (error) {
    next(error);
  }
});

api.patch('/admin/quiz-series/:name/visibility', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE quiz_series
       SET is_visible = $1, updated_at = now()
       WHERE name = $2
       RETURNING *`,
      [readVisibility(req.body, true), req.params.name]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Series not found' });
    res.json({ series: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

api.delete('/admin/quiz-series/:name', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const deleted = await withTransaction(async (client) => {
      await client.query("DELETE FROM quizzes WHERE category = $1 AND source = 'tests'", [req.params.name]);
      return client.query('DELETE FROM quiz_series WHERE name = $1 RETURNING id', [req.params.name]);
    });
    if (!deleted.rows[0]) return res.status(404).json({ error: 'Series not found' });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

api.get('/admin/quizzes', requireAuth, requireAdmin, async (_req, res) => {
  const quizzes = await query(
    `SELECT q.id, q.slug, q.title, q.category, q.source, q.difficulty, q.weight,
            q.reward_points, q.pass_score, q.max_score, q.section_id, q.course_required, q.is_visible, q.order_index,
            COALESCE(NULLIF(qs.description, ''), q.description, '') AS description,
            COALESCE(qs.description, '') AS series_description,
            COALESCE(qs.is_visible, true) AS series_is_visible,
            cs.slug AS section_slug
     FROM quizzes q
     LEFT JOIN quiz_series qs ON qs.name = q.category
     LEFT JOIN course_sections cs ON cs.id = q.section_id
     WHERE q.source = 'tests'
     ORDER BY q.category,
              CASE q.difficulty
                WHEN 'easy' THEN 1
                WHEN 'middle' THEN 2
                WHEN 'medium' THEN 2
                WHEN 'hard' THEN 3
                ELSE 99
              END,
              q.order_index,
              q.id`
  );
  const series = await query('SELECT * FROM quiz_series ORDER BY name');
  res.json({ quizzes: quizzes.rows, series: series.rows });
});

api.get('/admin/quizzes/:id', requireAuth, requireAdmin, async (req, res) => {
  const quiz = await readQuizWithQuestions(req.params.id);
  if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
  res.json({ quiz });
});

async function resolveSectionId(sectionSlug) {
  if (!sectionSlug) return null;
  const section = await query('SELECT id FROM course_sections WHERE slug = $1', [sectionSlug]);
  return section.rows[0]?.id || null;
}

api.post('/admin/quizzes', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    if (!body.title || !body.category || !body.questions?.length) {
      return res.status(400).json({ error: 'Quiz series, title and questions are required' });
    }
    const quiz = await withTransaction(async (client) => {
      await upsertQuizSeries(client, body.category, body.description);
      const slug = body.slug || await createUniqueSlug(client, 'quizzes', `${body.category}-${body.difficulty || 'easy'}-${body.title}`);
      const result = await client.query(
        `INSERT INTO quizzes (slug, title, category, source, difficulty, weight, reward_points, pass_score, max_score, description, section_id, course_required, is_visible, order_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          slug,
          body.title,
          body.category,
          'tests',
          body.difficulty || 'easy',
          Number(body.weight || 1),
          0,
          1,
          body.questions.length,
          '',
          null,
          false,
          readVisibility(body, true),
          resolveQuizOrderIndex(body)
        ]
      );
      await replaceQuizQuestions(client, result.rows[0].id, body.questions);
      return result.rows[0];
    });
    res.status(201).json({ quiz: await readQuizWithQuestions(quiz.id) });
  } catch (error) {
    next(error);
  }
});

api.put('/admin/quizzes/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const body = req.body || {};
    const quiz = await withTransaction(async (client) => {
      if (body.category) await upsertQuizSeries(client, body.category, body.description);
      const result = await client.query(
        `UPDATE quizzes
         SET title = $1,
             category = $2,
             source = $3,
             difficulty = $4,
             weight = $5,
             reward_points = $6,
             pass_score = $7,
             max_score = $8,
             description = $9,
             section_id = $10,
             course_required = $11,
             is_visible = CASE WHEN $12 THEN $13 ELSE is_visible END,
             order_index = $14
         WHERE id = $15 AND source = 'tests'
         RETURNING *`,
        [
          body.title,
          body.category,
          'tests',
          body.difficulty || 'easy',
          Number(body.weight || 1),
          0,
          1,
          Number(body.questions?.length || body.maxScore || 0),
          '',
          null,
          false,
          hasVisibility(body),
          readVisibility(body, true),
          resolveQuizOrderIndex(body),
          req.params.id
        ]
      );
      if (!result.rows[0]) return null;
      if (Array.isArray(body.questions)) await replaceQuizQuestions(client, result.rows[0].id, body.questions);
      return result.rows[0];
    });
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    res.json({ quiz: await readQuizWithQuestions(quiz.id) });
  } catch (error) {
    next(error);
  }
});

api.patch('/admin/quizzes/:id/visibility', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await query(
      `UPDATE quizzes
       SET is_visible = $1
       WHERE id = $2 AND source = 'tests'
       RETURNING *`,
      [readVisibility(req.body, true), req.params.id]
    );
    if (!result.rows[0]) return res.status(404).json({ error: 'Quiz not found' });
    res.json({ quiz: result.rows[0] });
  } catch (error) {
    next(error);
  }
});

api.delete('/admin/quizzes/:id', requireAuth, requireAdmin, async (req, res) => {
  const result = await query("DELETE FROM quizzes WHERE id = $1 AND source = 'tests' RETURNING id", [req.params.id]);
  if (!result.rows[0]) return res.status(404).json({ error: 'Quiz not found' });
  res.json({ ok: true });
});
