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

function normalizeQuizType(value) {
  return value === 'survey' || value === 'poll' ? 'survey' : 'testing';
}

function normalizeAnswerType(value, quizType = 'testing') {
  const type = String(value || '').toLowerCase();
  if (quizType === 'survey' && type === 'text') return 'text';
  if (type === 'multiple') return 'multiple';
  return 'single';
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

  const stats = await getSectionRequirementStats(userId, sectionId);
  return stats.requiredCount > 0 && stats.passedCount >= stats.requiredCount;
}

async function canAccessSection(user, sectionId) {
  const current = await query('SELECT id, course_id, order_index FROM course_sections WHERE id = $1', [sectionId]);
  const section = current.rows[0];
  if (!section) return false;
  const completedCourse = await query(
    'SELECT 1 FROM user_course_progress WHERE user_id = $1 AND course_id = $2 LIMIT 1',
    [user.id, section.course_id]
  );
  if (completedCourse.rows[0]) return true;
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

async function getSectionRequirementStats(userId, sectionId, includeDetails = false) {
  const requirements = [];
  const courseQuizzes = await query(
    `SELECT q.id, q.slug, q.title, q.pass_score, q.max_score, q.quiz_type,
            COALESCE(best.best_score, 0) AS best_score,
            COALESCE(best.passed, false) AS passed
     FROM quizzes q
     LEFT JOIN LATERAL (
       SELECT MAX(score) AS best_score, BOOL_OR(passed) AS passed
       FROM quiz_attempts qa
       WHERE qa.quiz_id = q.id AND qa.user_id = $2
     ) best ON true
     WHERE q.section_id = $1 AND q.source = 'course' AND q.course_required = true
     ORDER BY q.order_index, q.id`,
    [sectionId, userId]
  );
  for (const quiz of courseQuizzes.rows) {
    requirements.push({
      type: 'course_quiz',
      id: quiz.id,
      slug: quiz.slug,
      title: quiz.title,
      quizType: quiz.quiz_type,
      passScore: Number(quiz.pass_score || 0),
      maxScore: Number(quiz.max_score || 0),
      bestScore: Number(quiz.best_score || 0),
      passed: Boolean(quiz.passed)
    });
  }

  const external = await query(
    `SELECT csr.requirement_type, csr.quiz_id, csr.series_id,
            q.slug AS quiz_slug, q.title AS quiz_title, q.pass_score AS quiz_pass_score,
            q.max_score AS quiz_max_score, q.quiz_type AS quiz_type,
            COALESCE(qbest.best_score, 0) AS quiz_best_score,
            COALESCE(qbest.passed, false) AS quiz_passed,
            qs.name AS series_name
     FROM course_section_requirements csr
     LEFT JOIN quizzes q ON q.id = csr.quiz_id
     LEFT JOIN LATERAL (
       SELECT MAX(score) AS best_score, BOOL_OR(passed) AS passed
       FROM quiz_attempts qa
       WHERE qa.quiz_id = q.id AND qa.user_id = $2
     ) qbest ON true
     LEFT JOIN quiz_series qs ON qs.id = csr.series_id
     WHERE csr.section_id = $1
     ORDER BY csr.order_index, csr.id`,
    [sectionId, userId]
  );

  for (const req of external.rows) {
    if (req.requirement_type === 'series') {
      const seriesQuizzes = await query(
        `SELECT q.id, q.slug, q.title, q.pass_score, q.max_score, q.quiz_type,
                COALESCE(best.best_score, 0) AS best_score,
                COALESCE(best.passed, false) AS passed
         FROM quizzes q
         LEFT JOIN LATERAL (
           SELECT MAX(score) AS best_score, BOOL_OR(passed) AS passed
           FROM quiz_attempts qa
           WHERE qa.quiz_id = q.id AND qa.user_id = $2
         ) best ON true
         WHERE q.source = 'tests'
           AND q.category = $1
           AND q.is_visible = true
         ORDER BY q.order_index, q.id`,
        [req.series_name, userId]
      );
      const items = seriesQuizzes.rows.map((quiz) => ({
        type: 'quiz',
        id: quiz.id,
        slug: quiz.slug,
        title: quiz.title,
        quizType: quiz.quiz_type,
        passScore: Number(quiz.pass_score || 0),
        maxScore: Number(quiz.max_score || 0),
        bestScore: Number(quiz.best_score || 0),
        passed: Boolean(quiz.passed)
      }));
      requirements.push({
        type: 'series',
        id: req.series_id,
        title: req.series_name,
        passed: items.length > 0 && items.every((item) => item.passed),
        passedCount: items.filter((item) => item.passed).length,
        totalCount: items.length,
        quizzes: includeDetails ? items : []
      });
    } else if (req.quiz_id) {
      requirements.push({
        type: 'quiz',
        id: req.quiz_id,
        slug: req.quiz_slug,
        title: req.quiz_title,
        quizType: req.quiz_type,
        passScore: Number(req.quiz_pass_score || 0),
        maxScore: Number(req.quiz_max_score || 0),
        bestScore: Number(req.quiz_best_score || 0),
        passed: Boolean(req.quiz_passed)
      });
    }
  }

  return {
    requiredCount: requirements.length,
    passedCount: requirements.filter((item) => item.passed).length,
    requirements: includeDetails ? requirements : []
  };
}

async function markCourseCompleteIfReady(userId, courseId) {
  const course = await query('SELECT * FROM courses WHERE id = $1', [courseId]);
  if (!course.rows[0]) return null;
  const sections = await query(
    'SELECT id FROM course_sections WHERE course_id = $1 ORDER BY order_index, id',
    [courseId]
  );
  if (!sections.rows.length) return null;
  for (const section of sections.rows) {
    if (!await isSectionCompleted(userId, section.id)) return null;
  }
  const completed = await query(
    `INSERT INTO user_course_progress (user_id, course_id, completed_at)
     VALUES ($1, $2, now())
     ON CONFLICT (user_id, course_id) DO NOTHING
     RETURNING completed_at`,
    [userId, courseId]
  );
  return completed.rows[0] ? course.rows[0] : null;
}

async function refreshCourseSectionCompletion(userId, sectionId) {
  const section = await query(
    'SELECT id, course_id, order_index FROM course_sections WHERE id = $1',
    [sectionId]
  );
  const row = section.rows[0];
  const stats = row ? await getSectionRequirementStats(userId, sectionId) : { requiredCount: 0, passedCount: 0 };
  if (!row || stats.requiredCount === 0 || stats.passedCount < stats.requiredCount) {
    return { sectionCompleted: false, courseCompleted: null };
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
         updated_at = now()
     WHERE id = $1`,
    [userId, row.order_index]
  );
  return {
    sectionCompleted: true,
    courseCompleted: await markCourseCompleteIfReady(userId, row.course_id)
  };
}

async function refreshSectionsForPassedQuiz(userId, quiz) {
  const sectionIds = new Set();
  if (quiz.source === 'course' && quiz.section_id) sectionIds.add(Number(quiz.section_id));
  const direct = await query(
    'SELECT section_id FROM course_section_requirements WHERE quiz_id = $1',
    [quiz.id]
  );
  direct.rows.forEach((row) => sectionIds.add(Number(row.section_id)));
  const series = await query('SELECT id FROM quiz_series WHERE name = $1', [quiz.category]);
  if (series.rows[0]) {
    const rows = await query(
      'SELECT section_id FROM course_section_requirements WHERE series_id = $1',
      [series.rows[0].id]
    );
    rows.rows.forEach((row) => sectionIds.add(Number(row.section_id)));
  }

  const completedCourses = [];
  for (const sectionId of sectionIds) {
    const result = await refreshCourseSectionCompletion(userId, sectionId);
    if (result.courseCompleted) completedCourses.push(result.courseCompleted);
  }
  return completedCourses;
}

function answerIdList(value) {
  const raw = Array.isArray(value) ? value : [value];
  return raw.map(Number).filter((item) => Number.isFinite(item) && item > 0);
}

function isExactAnswer(selectedIds, correctIds) {
  if (selectedIds.length !== correctIds.length) return false;
  const selected = new Set(selectedIds);
  return correctIds.every((id) => selected.has(id));
}

function gradeQuizAttempt(quiz, questions, selectedAnswers) {
  if (quiz.quiz_type === 'survey') {
    return { score: 0, maxScore: 0, passed: true, weightedScore: 0 };
  }
  let score = 0;
  for (const question of questions) {
    const answerType = normalizeAnswerType(question.answer_type, quiz.quiz_type);
    const selectedIds = answerIdList(selectedAnswers?.[question.id]);
    const correctIds = (question.options || [])
      .filter((option) => option.isCorrect)
      .map((option) => Number(option.id));
    const correct = answerType === 'multiple'
      ? isExactAnswer(selectedIds, correctIds)
      : selectedIds.length === 1 && correctIds.includes(selectedIds[0]);
    if (correct) score += 1;
  }
  const maxScore = questions.length;
  const passed = score >= Number(quiz.pass_score || 0);
  const weightedScore = quiz.source === 'course'
    ? (passed ? Number(quiz.reward_points || 0) : 0)
    : score * Number(quiz.weight || 1);
  return { score, maxScore, passed, weightedScore };
}

async function buildCoursePayload(courseSlug, user, options = {}) {
  const course = await query(
    `SELECT c.*, ucp.completed_at AS user_completed_at
     FROM courses c
     LEFT JOIN user_course_progress ucp ON ucp.course_id = c.id AND ucp.user_id = $2
     WHERE c.slug = $1`,
    [courseSlug, user.id]
  );
  if (!course.rows[0]) return null;
  if (!options.includeHidden && user.role !== 'admin' && course.rows[0].is_visible === false) return null;
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
                'quizType', q.quiz_type,
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
  const courseCompleted = Boolean(course.rows[0].user_completed_at);
  const sections = [];
  for (const section of rows.rows) {
    const stats = await getSectionRequirementStats(user.id, section.id, true);
    const completedByRequirements = stats.requiredCount > 0 && stats.passedCount >= stats.requiredCount;
    const ownCompleted = courseCompleted || section.stored_status === 'completed' || completedByRequirements;
    const accessible = courseCompleted || previousCompleted;
    const status = accessible ? (ownCompleted ? 'completed' : 'available') : 'locked';
    previousCompleted = previousCompleted && ownCompleted;
    sections.push({
      ...section,
      user_status: status,
      isAccessible: accessible,
      isCompleted: ownCompleted,
      required_count: stats.requiredCount,
      passed_count: stats.passedCount,
      requirements: stats.requirements
    });
  }
  const computedCourseCompleted = courseCompleted || (sections.length > 0 && sections.every((section) => section.isCompleted));
  return {
    course: course.rows[0],
    sections: sections.map((section) => ({
      ...section,
      user_status: computedCourseCompleted ? 'completed' : section.user_status,
      isAccessible: computedCourseCompleted || section.isAccessible,
      isCompleted: computedCourseCompleted || section.isCompleted
    })),
    completed: computedCourseCompleted
  };
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

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function reportTag(value) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^@/, '')
    .replace(/\s+/g, '_')
    .replace(/[^\p{L}\p{N}_]/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned ? `#${cleaned}` : null;
}

function userReportTags(user) {
  return [
    user.telegram_id ? `#idusertg_${user.telegram_id}` : `#idlocal_${user.id}`,
    user.username ? reportTag(`username_${user.username}`) : null
  ].filter(Boolean);
}

function userReportName(user) {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `ID ${user.telegram_id || user.id}`;
  return `${escapeHtml(name)}${user.username ? ` (@${escapeHtml(user.username)})` : ''}`;
}

async function sendAcademyReport(text) {
  const chatId = process.env.ACADEMY_REPORT_CHAT_ID;
  if (!chatId) return;
  const result = await sendTelegramMessage(chatId, text);
  if (result?.ok === false) console.error('Academy report failed', result);
}

function answerTextForReport(question, answers) {
  const value = answers?.[question.id];
  if (question.answer_type === 'text') return String(value || '').trim() || 'нет ответа';
  const selectedIds = answerIdList(value);
  return (question.options || [])
    .filter((option) => selectedIds.includes(Number(option.id)))
    .map((option) => option.text)
    .join(', ') || 'не выбран';
}

async function sendQuizAttemptReport(user, quiz, questions, attempt) {
  if (quiz.quiz_type !== 'survey' && !attempt.passed) return;
  const isSurvey = quiz.quiz_type === 'survey';
  const tags = [
    ...userReportTags(user),
    isSurvey ? '#survey' : '#test',
    reportTag(`quiz_${quiz.slug}`),
    reportTag(`series_${quiz.category}`),
    quiz.source === 'course' ? '#course_test' : '#tests_section'
  ].filter(Boolean).join(' ');
  const lines = [
    `<b>${isSurvey ? 'Опрос пройден' : 'Тест пройден'}</b>`,
    tags,
    '',
    `Пользователь: ${userReportName(user)}`,
    `Материал: ${escapeHtml(quiz.title)}`,
    `Серия: ${escapeHtml(quiz.category || '-')}`,
    isSurvey ? null : `Результат: ${attempt.score}/${attempt.max_score}`,
    ''
  ].filter((line) => line !== null);
  if (isSurvey) {
    lines.push('<b>Ответы:</b>');
    questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${escapeHtml(question.text)}`);
      lines.push(`Ответ: ${escapeHtml(answerTextForReport(question, attempt.answers || {}))}`);
    });
  }
  await sendAcademyReport(lines.join('\n'));
}

async function sendCourseCompletionReport(user, course) {
  const tags = [
    ...userReportTags(user),
    '#course',
    '#course_completed',
    reportTag(`course_${course.slug}`)
  ].filter(Boolean).join(' ');
  await sendAcademyReport([
    '<b>Курс завершен</b>',
    tags,
    '',
    `Пользователь: ${userReportName(user)}`,
    `Курс: ${escapeHtml(course.title)}`,
    'Статус: все обязательные этапы курса успешно закрыты.'
  ].join('\n'));
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
            CASE WHEN q.source = 'course' THEN COALESCE(c.title, q.category) ELSE q.category END AS category,
            q.difficulty,
            q.source
     FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id
     LEFT JOIN course_sections cs ON cs.id = q.section_id
     LEFT JOIN courses c ON c.id = cs.course_id
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
  const courses = await query(
    `SELECT * FROM courses
     WHERE $1::boolean = true OR is_visible = true
     ORDER BY order_index, id`,
    [req.user.role === 'admin']
  );
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

api.get('/courses', requireAuth, async (req, res) => {
  const courses = await query(
    `SELECT * FROM courses
     WHERE $1::boolean = true OR is_visible = true
     ORDER BY order_index, id`,
    [req.user.role === 'admin']
  );
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
      `SELECT cs.*, c.is_visible AS course_is_visible
       FROM course_sections cs
       JOIN courses c ON c.id = cs.course_id
       WHERE c.slug = $1 AND cs.slug = $2`,
      [req.params.courseSlug, req.params.sectionSlug]
    );
    const row = section.rows[0];
    if (!row) return res.status(404).json({ error: 'Section not found' });
    if (req.user.role !== 'admin' && row.course_is_visible === false) return res.status(404).json({ error: 'Course not found' });
    const allowed = await canAccessSection(req.user, row.id);
    if (!allowed) return res.status(403).json({ error: 'Сначала завершите предыдущий этап курса.' });
    const stats = await getSectionRequirementStats(req.user.id, row.id);
    if (stats.requiredCount > 0) {
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
    const completedCourse = await markCourseCompleteIfReady(req.user.id, row.course_id);
    const updatedUser = (await query('SELECT * FROM users WHERE id = $1', [req.user.id])).rows[0];
    const payload = await buildCoursePayload(req.params.courseSlug, updatedUser);
    if (completedCourse) {
      sendCourseCompletionReport(updatedUser, completedCourse).catch((error) => console.error('Academy course report failed', error));
    }
    res.json(payload);
  } catch (error) {
    next(error);
  }
});

api.get('/quizzes', requireAuth, async (req, res) => {
  const quizzes = await query(
    `SELECT q.id, q.slug, q.title, q.category, q.source, q.quiz_type, q.difficulty, q.weight,
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
    `SELECT q.*, COALESCE(qs.is_visible, true) AS series_is_visible,
            COALESCE(c.is_visible, true) AS course_is_visible
     FROM quizzes q
     LEFT JOIN quiz_series qs ON qs.name = q.category
     LEFT JOIN course_sections cs ON cs.id = q.section_id
     LEFT JOIN courses c ON c.id = cs.course_id
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
    if (req.user.role !== 'admin' && quiz.rows[0].course_is_visible === false) {
      return res.status(404).json({ error: 'Quiz not found' });
    }
    const allowed = await canAccessSection(req.user, quiz.rows[0].section_id);
    if (!allowed) return res.status(403).json({ error: 'Сначала завершите предыдущий этап курса.' });
  }
  const questions = await query(
    `SELECT qq.id, qq.text, qq.hint, qq.media_url, qq.answer_type, qq.show_hint,
            COALESCE(json_agg(json_build_object('id', qo.id, 'text', qo.text, 'isCorrect', qo.is_correct) ORDER BY qo.order_index) FILTER (WHERE qo.id IS NOT NULL), '[]') AS options
     FROM quiz_questions qq
     LEFT JOIN quiz_options qo ON qo.question_id = qq.id
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
      `SELECT q.*, COALESCE(qs.is_visible, true) AS series_is_visible,
              COALESCE(c.is_visible, true) AS course_is_visible
       FROM quizzes q
       LEFT JOIN quiz_series qs ON qs.name = q.category
       LEFT JOIN course_sections cs ON cs.id = q.section_id
       LEFT JOIN courses c ON c.id = cs.course_id
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
      if (req.user.role !== 'admin' && quiz.course_is_visible === false) {
        return res.status(404).json({ error: 'Quiz not found' });
      }
      const allowed = await canAccessSection(req.user, quiz.section_id);
      if (!allowed) return res.status(403).json({ error: 'Сначала завершите предыдущий этап курса.' });
    }

    const selected = req.body.answers || {};
    const fullQuiz = await readQuizWithQuestions(quiz.id);
    const { score, maxScore, passed, weightedScore } = gradeQuizAttempt(quiz, fullQuiz.questions, selected);

    const attempt = await query(
      `INSERT INTO quiz_attempts (user_id, quiz_id, score, max_score, weighted_score, passed, answers)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.id, quiz.id, score, maxScore, weightedScore, passed, selected]
    );
    let completedCourses = [];
    if (passed) {
      completedCourses = await refreshSectionsForPassedQuiz(req.user.id, quiz);
    }
    const user = await recalculateUserScore(req.user.id);
    sendQuizAttemptReport(user, fullQuiz, fullQuiz.questions, attempt.rows[0]).catch((error) => console.error('Academy quiz report failed', error));
    for (const completedCourse of completedCourses) {
      sendCourseCompletionReport(user, completedCourse).catch((error) => console.error('Academy course report failed', error));
    }
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
            CASE WHEN q.source = 'course' THEN COALESCE(c.title, q.category) ELSE q.category END AS category,
            q.difficulty,
            q.source,
            q.quiz_type
     FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id
     LEFT JOIN course_sections cs ON cs.id = q.section_id
     LEFT JOIN courses c ON c.id = cs.course_id
     WHERE qa.id = $1 AND ($3::boolean = true OR qa.user_id = $2)`,
    [req.params.id, req.user.id, req.user.role === 'admin']
  );
  const attempt = attemptResult.rows[0];
  if (!attempt) return res.status(404).json({ error: 'Attempt not found' });
  const fullQuiz = await readQuizWithQuestions(attempt.quiz_id);
  const questions = fullQuiz.questions.map((question) => {
    const value = attempt.answers?.[question.id];
    if (question.answer_type === 'text') {
      return {
        id: question.id,
        text: question.text,
        selectedOptionText: String(value || '').trim() || 'нет ответа',
        isCorrect: true
      };
    }
    const selectedIds = answerIdList(value);
    const selectedOptions = (question.options || []).filter((option) => selectedIds.includes(Number(option.id)));
    const correctIds = (question.options || []).filter((option) => option.isCorrect).map((option) => Number(option.id));
    return {
      id: question.id,
      text: question.text,
      selectedOptionText: selectedOptions.map((option) => option.text).join(', ') || 'не выбран',
      isCorrect: attempt.quiz_type === 'survey' || (question.answer_type === 'multiple'
        ? isExactAnswer(selectedIds, correctIds)
        : selectedIds.length === 1 && correctIds.includes(selectedIds[0]))
    };
  });
  delete attempt.answers;
  res.json({ attempt, questions });
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
  const requirements = await query(
    `SELECT csr.*, q.title AS quiz_title, q.slug AS quiz_slug, qs.name AS series_name
     FROM course_section_requirements csr
     LEFT JOIN quizzes q ON q.id = csr.quiz_id
     LEFT JOIN quiz_series qs ON qs.id = csr.series_id
     ORDER BY csr.order_index, csr.id`
  );
  const requirementsBySection = new Map();
  for (const requirement of requirements.rows) {
    if (!requirementsBySection.has(requirement.section_id)) requirementsBySection.set(requirement.section_id, []);
    requirementsBySection.get(requirement.section_id).push(requirement);
  }
  const courseQuizzes = await query(
    `SELECT q.*
     FROM quizzes q
     JOIN course_sections cs ON cs.id = q.section_id
     JOIN courses c ON c.id = cs.course_id
     WHERE q.source = 'course'
     ORDER BY c.order_index, cs.order_index, q.order_index, q.id`
  );
  const courseQuizIds = courseQuizzes.rows.map((quiz) => quiz.id);
  const courseQuestions = courseQuizIds.length ? await query(
    `SELECT qq.id, qq.quiz_id, qq.text, qq.hint, qq.media_url, qq.answer_type, qq.show_hint,
            COALESCE(json_agg(json_build_object('id', qo.id, 'text', qo.text, 'isCorrect', qo.is_correct) ORDER BY qo.order_index) FILTER (WHERE qo.id IS NOT NULL), '[]') AS options
     FROM quiz_questions qq
     LEFT JOIN quiz_options qo ON qo.question_id = qq.id
     WHERE qq.quiz_id = ANY($1::int[])
     GROUP BY qq.id
     ORDER BY qq.order_index`,
    [courseQuizIds]
  ) : { rows: [] };
  const questionsByQuiz = new Map();
  for (const question of courseQuestions.rows) {
    if (!questionsByQuiz.has(question.quiz_id)) questionsByQuiz.set(question.quiz_id, []);
    questionsByQuiz.get(question.quiz_id).push(question);
  }
  const quizzesBySection = new Map();
  for (const quiz of courseQuizzes.rows) {
    if (!quizzesBySection.has(quiz.section_id)) quizzesBySection.set(quiz.section_id, []);
    quizzesBySection.get(quiz.section_id).push({ ...quiz, questions: questionsByQuiz.get(quiz.id) || [] });
  }
  const sectionsByCourse = new Map();
  for (const section of sections.rows) {
    if (!sectionsByCourse.has(section.course_id)) sectionsByCourse.set(section.course_id, []);
    sectionsByCourse.get(section.course_id).push({
      ...section,
      lessons: lessonsBySection.get(section.id) || [],
      requirements: requirementsBySection.get(section.id) || [],
      courseQuizzes: quizzesBySection.get(section.id) || []
    });
  }
  return courses.rows.map((course) => ({ ...course, sections: sectionsByCourse.get(course.id) || [] }));
}

api.get('/admin/courses', requireAuth, requireAdmin, async (_req, res) => {
  res.json({ courses: await readAdminCourses() });
});

async function saveCourseSections(client, courseId, courseTitle, sections = []) {
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

    if (Array.isArray(section.requirements)) {
      await client.query('DELETE FROM course_section_requirements WHERE section_id = $1', [sectionId]);
      for (const [requirementIndex, requirement] of section.requirements.entries()) {
        const requirementType = requirement.type === 'series' || requirement.requirement_type === 'series' ? 'series' : 'quiz';
        const quizId = Number(requirement.quizId || requirement.quiz_id || 0) || null;
        const seriesId = Number(requirement.seriesId || requirement.series_id || 0) || null;
        if (requirementType === 'quiz' && !quizId) continue;
        if (requirementType === 'series' && !seriesId) continue;
        await client.query(
          `INSERT INTO course_section_requirements (section_id, requirement_type, quiz_id, series_id, order_index)
           VALUES ($1, $2, $3, $4, $5)`,
          [sectionId, requirementType, requirementType === 'quiz' ? quizId : null, requirementType === 'series' ? seriesId : null, requirementIndex + 1]
        );
      }
    }

    if (Array.isArray(section.courseQuizzes)) {
      const keepQuizIds = [];
      for (const [quizIndex, quiz] of section.courseQuizzes.entries()) {
        if (!quiz.title || !Array.isArray(quiz.questions) || !quiz.questions.length) continue;
        const quizType = normalizeQuizType(quiz.quizType || quiz.quiz_type);
        const passScore = quizType === 'survey' ? 0 : Number(quiz.passScore || quiz.pass_score || 1);
        const maxScore = quizType === 'survey' ? 0 : quiz.questions.length;
        let quizId = quiz.id ? Number(quiz.id) : null;
        if (quizId) {
          const updated = await client.query(
            `UPDATE quizzes
             SET title = $1,
                 category = $2,
                 quiz_type = $3,
                 difficulty = $4,
                 weight = $5,
                 reward_points = $6,
                 pass_score = $7,
                 max_score = $8,
                 section_id = $9,
                 course_required = true,
                 order_index = $10
             WHERE id = $11 AND source = 'course'
             RETURNING id`,
            [
              quiz.title,
              courseTitle,
              quizType,
              quiz.difficulty || 'course',
              Number(quiz.weight || 1),
              Number(quiz.rewardPoints || quiz.reward_points || 0),
              passScore,
              maxScore,
              sectionId,
              quizIndex + 1,
              quizId
            ]
          );
          quizId = updated.rows[0]?.id || null;
        }
        if (!quizId) {
          const slug = await createUniqueSlug(client, 'quizzes', `${section.title}-${quiz.title}`);
          const created = await client.query(
            `INSERT INTO quizzes (slug, title, category, source, quiz_type, difficulty, weight, reward_points, pass_score, max_score, description, section_id, course_required, is_visible, order_index)
             VALUES ($1, $2, $3, 'course', $4, $5, $6, $7, $8, $9, '', $10, true, true, $11)
             RETURNING id`,
            [
              slug,
              quiz.title,
              courseTitle,
              quizType,
              quiz.difficulty || 'course',
              Number(quiz.weight || 1),
              Number(quiz.rewardPoints || quiz.reward_points || 0),
              passScore,
              maxScore,
              sectionId,
              quizIndex + 1
            ]
          );
          quizId = created.rows[0].id;
        }
        keepQuizIds.push(quizId);
        await replaceQuizQuestions(client, quizId, quiz.questions, quizType);
      }
      if (keepQuizIds.length) {
        await client.query(
          "DELETE FROM quizzes WHERE source = 'course' AND section_id = $1 AND id <> ALL($2::int[])",
          [sectionId, keepQuizIds]
        );
      } else {
        await client.query("DELETE FROM quizzes WHERE source = 'course' AND section_id = $1", [sectionId]);
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
        `INSERT INTO courses (slug, title, difficulty, description, is_visible, order_index)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [
          slug,
          body.title,
          body.difficulty || 'начальный',
          body.description || '',
          readVisibility(body, true),
          Number(order.rows[0]?.next_order || 1)
        ]
      );
      await saveCourseSections(client, created.rows[0].id, body.title, body.sections || []);
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
         SET title = $1,
             difficulty = $2,
             description = $3,
             is_visible = CASE WHEN $4::boolean THEN $5::boolean ELSE is_visible END
         WHERE id = $6
         RETURNING *`,
        [
          body.title,
          body.difficulty || 'начальный',
          body.description || '',
          hasVisibility(body),
          readVisibility(body, true),
          req.params.id
        ]
      );
      if (!updated.rows[0]) return null;
      await saveCourseSections(client, updated.rows[0].id, body.title, body.sections || []);
      return updated.rows[0];
    });
    if (!course) return res.status(404).json({ error: 'Course not found' });
    res.json({ course });
  } catch (error) {
    next(error);
  }
});

api.patch('/admin/courses/:id/visibility', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const isVisible = readVisibility(req.body, true);
    const updated = await query(
      `UPDATE courses
       SET is_visible = $1
       WHERE id = $2
       RETURNING *`,
      [isVisible, req.params.id]
    );
    if (!updated.rows[0]) return res.status(404).json({ error: 'Course not found' });
    res.json({ course: updated.rows[0] });
  } catch (error) {
    next(error);
  }
});

api.delete('/admin/courses/:id', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const deleted = await withTransaction(async (client) => {
      const sections = await client.query('SELECT id FROM course_sections WHERE course_id = $1', [req.params.id]);
      const sectionIds = sections.rows.map((row) => row.id);
      let affectedUserIds = [];
      if (sectionIds.length) {
        const quizzes = await client.query(
          "SELECT id FROM quizzes WHERE source = 'course' AND section_id = ANY($1::int[])",
          [sectionIds]
        );
        const quizIds = quizzes.rows.map((row) => row.id);
        if (quizIds.length) {
          const affected = await client.query(
            'SELECT DISTINCT user_id FROM quiz_attempts WHERE quiz_id = ANY($1::int[])',
            [quizIds]
          );
          affectedUserIds = affected.rows.map((row) => row.user_id);
          await client.query('DELETE FROM quizzes WHERE id = ANY($1::int[])', [quizIds]);
        }
      }
      const result = await client.query('DELETE FROM courses WHERE id = $1 RETURNING id', [req.params.id]);
      return result.rows[0] ? { course: result.rows[0], affectedUserIds } : null;
    });
    if (!deleted) return res.status(404).json({ error: 'Course not found' });
    for (const userId of deleted.affectedUserIds) {
      await recalculateUserScore(userId);
    }
    res.json({ ok: true });
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

api.get('/admin/users/:id', requireAuth, requireAdmin, async (req, res) => {
  const userResult = await query(
    `SELECT *
     FROM users
     WHERE id = $1 AND ${nonDemoUserSql}`,
    [req.params.id]
  );
  const user = userResult.rows[0];
  if (!user) return res.status(404).json({ error: 'User not found' });

  const attempts = await query(
    `SELECT qa.id, qa.score, qa.max_score, qa.weighted_score, qa.passed, qa.created_at,
            q.title,
            CASE WHEN q.source = 'course' THEN COALESCE(c.title, q.category) ELSE q.category END AS category,
            q.difficulty,
            q.source,
            q.quiz_type,
            q.slug
     FROM quiz_attempts qa
     JOIN quizzes q ON q.id = qa.quiz_id
     LEFT JOIN course_sections cs ON cs.id = q.section_id
     LEFT JOIN courses c ON c.id = cs.course_id
     WHERE qa.user_id = $1
     ORDER BY qa.created_at DESC
     LIMIT 200`,
    [user.id]
  );

  const submissions = await query(
    `SELECT ts.id, ts.status, ts.comment, ts.payload, ts.reward_points, ts.admin_comment, ts.created_at, ts.reviewed_at,
            t.title AS task_title, t.task_num
     FROM task_submissions ts
     JOIN tasks t ON t.id = ts.task_id
     WHERE ts.user_id = $1
     ORDER BY ts.created_at DESC
     LIMIT 100`,
    [user.id]
  );

  const courseRows = await query('SELECT slug FROM courses ORDER BY order_index, id');
  const courses = [];
  for (const course of courseRows.rows) {
    const payload = await buildCoursePayload(course.slug, user, { includeHidden: true });
    if (payload) {
      courses.push({
        course: payload.course,
        completed: payload.completed,
        sections: payload.sections.map((section) => ({
          id: section.id,
          slug: section.slug,
          title: section.title,
          order_index: section.order_index,
          user_status: section.user_status,
          isCompleted: section.isCompleted,
          required_count: section.required_count,
          passed_count: section.passed_count
        }))
      });
    }
  }

  const totalSections = courses.reduce((sum, course) => sum + course.sections.length, 0);
  const completedSections = courses.reduce(
    (sum, course) => sum + course.sections.filter((section) => section.user_status === 'completed').length,
    0
  );
  const passedAttempts = attempts.rows.filter((attempt) => attempt.passed).length;

  res.json({
    user: publicUser(user),
    attempts: attempts.rows,
    submissions: submissions.rows,
    courses,
    stats: {
      coursesCompleted: courses.filter((course) => course.completed).length,
      coursesTotal: courses.length,
      sectionsCompleted: completedSections,
      sectionsTotal: totalSections,
      attemptsCount: attempts.rows.length,
      passedAttemptsCount: passedAttempts,
      submissionsCount: submissions.rows.length
    }
  });
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

async function replaceQuizQuestions(client, quizId, questions, quizType = 'testing') {
  await client.query('DELETE FROM quiz_questions WHERE quiz_id = $1', [quizId]);
  for (const [questionIndex, question] of questions.entries()) {
    const answerType = normalizeAnswerType(question.answerType || question.answer_type, quizType);
    const questionRow = await client.query(
      `INSERT INTO quiz_questions (quiz_id, order_index, text, media_url, hint, answer_type, show_hint)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [quizId, questionIndex + 1, question.text, question.mediaUrl || null, question.hint || '', answerType, question.showHint !== false]
    );
    if (answerType === 'text') continue;
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
    `SELECT q.id, q.slug, q.title, q.category, q.source, q.quiz_type, q.difficulty, q.weight,
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
    `SELECT qq.id, qq.text, qq.hint, qq.media_url, qq.answer_type, qq.show_hint,
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
    `SELECT q.id, q.slug, q.title, q.category, q.source, q.quiz_type, q.difficulty, q.weight,
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
    const quizType = normalizeQuizType(body.quizType || body.quiz_type);
    const quiz = await withTransaction(async (client) => {
      await upsertQuizSeries(client, body.category, body.description);
      const slug = body.slug || await createUniqueSlug(client, 'quizzes', `${body.category}-${body.difficulty || 'easy'}-${body.title}`);
      const result = await client.query(
        `INSERT INTO quizzes (slug, title, category, source, quiz_type, difficulty, weight, reward_points, pass_score, max_score, description, section_id, course_required, is_visible, order_index)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING *`,
        [
          slug,
          body.title,
          body.category,
          'tests',
          quizType,
          body.difficulty || 'easy',
          Number(body.weight || 1),
          0,
          quizType === 'survey' ? 0 : 1,
          quizType === 'survey' ? 0 : body.questions.length,
          '',
          null,
          false,
          readVisibility(body, true),
          resolveQuizOrderIndex(body)
        ]
      );
      await replaceQuizQuestions(client, result.rows[0].id, body.questions, quizType);
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
    const quizType = normalizeQuizType(body.quizType || body.quiz_type);
    const quiz = await withTransaction(async (client) => {
      if (body.category) await upsertQuizSeries(client, body.category, body.description);
      const result = await client.query(
        `UPDATE quizzes
         SET title = $1,
             category = $2,
             source = $3,
             quiz_type = $4,
             difficulty = $5,
             weight = $6,
             reward_points = $7,
             pass_score = $8,
             max_score = $9,
             description = $10,
             section_id = $11,
             course_required = $12,
             is_visible = CASE WHEN $13 THEN $14 ELSE is_visible END,
             order_index = $15
         WHERE id = $16 AND source = 'tests'
         RETURNING *`,
        [
          body.title,
          body.category,
          'tests',
          quizType,
          body.difficulty || 'easy',
          Number(body.weight || 1),
          0,
          quizType === 'survey' ? 0 : 1,
          quizType === 'survey' ? 0 : Number(body.questions?.length || body.maxScore || 0),
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
      if (Array.isArray(body.questions)) await replaceQuizQuestions(client, result.rows[0].id, body.questions, quizType);
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
