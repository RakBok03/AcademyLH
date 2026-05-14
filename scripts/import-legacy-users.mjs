import 'dotenv/config';
import { query, withTransaction, pool } from '../server/db/pool.js';

const args = new Set(process.argv.slice(2));
const resetUsers = args.has('--reset');
const dryRun = args.has('--dry-run');
const includeZeroFull = args.has('--full-zero');
const limitArg = process.argv.find((arg) => arg.startsWith('--limit='));
const limit = limitArg ? Number(limitArg.split('=')[1]) : null;

const nocoBaseUrl = process.env.NOCODB_IMPORT_BASE_URL || process.env.NOCODB_BASE_URL || 'https://nocodb.puzzlebot.top';
const nocoToken = process.env.NOCODB_IMPORT_TOKEN || process.env.NOCODB_TOKEN;
const nocoUsersTableId = process.env.NOCODB_USERS_TABLE_ID || 'm3ptjdlul8p3yx7';
const puzzleToken = process.env.PUZZLEBOT_IMPORT_API_TOKEN || process.env.PUZZLEBOT_API_TOKEN;
const puzzleDelayMs = Number(process.env.PUZZLEBOT_IMPORT_DELAY_MS || 550);
const adminIds = new Set(
  String(process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

const courseVariableMap = [
  { variable: 'loft1_good', quizSlug: 'course-loft-1', reward: 1 },
  { variable: 'loft2_good', quizSlug: 'course-loft-2', reward: 1 },
  { variable: 'loft3_good', quizSlug: 'course-loft-3', reward: 1 },
  { variable: 'loft4_good', quizSlug: 'course-loft-4', reward: 1 },
  { variable: 'loft5_good', quizSlug: 'course-loft-5', reward: 1 },
  { variable: 'loft8_good', quizSlug: 'course-loft-8', reward: 1 },
  { variable: 'loft10_good', quizSlug: 'course-loft-10', reward: 1 },
  { variable: 'thebirch_good', quizSlug: 'course-the-birch', reward: 1 },
  { variable: 'termin_good', quizSlug: 'course-terms', reward: 10 },
  { variable: 'format_good', quizSlug: 'course-formats', reward: 10 },
  { variable: 'servirovka_good', quizSlug: 'course-serving', reward: 10 },
  { variable: 'obsluga_good', quizSlug: 'course-service', reward: 10 },
  { variable: 'final_good', quizSlug: 'course-final', reward: 100 }
];

const externalQuizVariableMap = [
  { variable: 'point_test_LoftHall_easy', quizSlug: 'lofthall-history-easy', weight: 1 },
  { variable: 'point_test_LoftHall_middle', quizSlug: 'lofthall-history-middle', weight: 2 },
  { variable: 'point_test_LoftHall_hard', quizSlug: 'lofthall-history-hard', weight: 3 },
  { variable: 'point_test_menu_easy', quizSlug: 'menu-easy', weight: 1 },
  { variable: 'point_test_menu_middle', quizSlug: 'menu-middle', weight: 2 },
  { variable: 'point_test_menu_hard', quizSlug: 'menu-hard', weight: 3 },
  { variable: 'point_test_menu_Veryhard', quizSlug: 'menu-veryhard', weight: 3 },
  { variable: 'point_test_alcohol_easy', quizSlug: 'alcohol-easy', weight: 1 },
  { variable: 'point_test_alcohol_middle', quizSlug: 'alcohol-middle', weight: 2 },
  { variable: 'point_test_alcohol_hard', quizSlug: 'alcohol-hard', weight: 3 },
  { variable: 'point_test_Loft4_easy', quizSlug: 'loft-4-easy', weight: 1 },
  { variable: 'point_test_Loft4_middle', quizSlug: 'loft-4-middle', weight: 2 },
  { variable: 'point_test_Loft4_hard', quizSlug: 'loft-4-hard', weight: 3 },
  { variable: 'point_test_cheese', quizSlug: 'cheese-easy', weight: 1 },
  { variable: 'point_test_service_easy', quizSlug: 'service-easy', weight: 1 },
  { variable: 'point_test_service_middle', quizSlug: 'service-middle', weight: 2 },
  { variable: 'point_test_service_hard', quizSlug: 'service-hard', weight: 3 }
];

const fullVariables = [
  'academy_user_lvl',
  'Boss_academy',
  'title_lvl',
  'points_from_help_in_tasks',
  ...courseVariableMap.map((item) => item.variable),
  ...externalQuizVariableMap.map((item) => item.variable)
];

const zeroScoreVariables = ['academy_user_lvl', 'Boss_academy'];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberValue(value) {
  if (Array.isArray(value) || value === null || value === undefined || value === '') return 0;
  const normalized = String(value).replace(',', '.').replace(/[^\d.-]/g, '');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textValue(value) {
  if (Array.isArray(value) || value === null || value === undefined) return '';
  return String(value).trim();
}

function stripHtml(value) {
  return textValue(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .trim();
}

function extractDomain(value) {
  const match = textValue(value).match(/tg:\/\/resolve\?domain=([^"'>\s]+)/i);
  return match?.[1] || '';
}

function resolveTitle(score) {
  if (score > 450) return 'Легенда LOFT HALL';
  if (score > 349) return 'Наставник';
  if (score > 199) return 'Профессионал';
  if (score > 99) return 'Ученик';
  if (score > 49) return 'Новичок';
  return 'Стажер';
}

async function fetchNocoRecords() {
  if (!nocoToken) throw new Error('NOCODB_IMPORT_TOKEN or NOCODB_TOKEN is required');
  const rows = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const url = new URL(`/api/v2/tables/${nocoUsersTableId}/records`, nocoBaseUrl);
    url.searchParams.set('limit', String(pageSize));
    url.searchParams.set('offset', String(offset));
    const response = await fetch(url, { headers: { 'xc-token': nocoToken } });
    if (!response.ok) throw new Error(`NocoDB users request failed: ${response.status}`);
    const data = await response.json();
    const list = data.list || data.records || [];
    rows.push(...list);
    if (data.pageInfo?.isLastPage || list.length === 0 || list.length < pageSize) break;
    offset += pageSize;
  }
  return rows;
}

let lastPuzzleCallAt = 0;

async function callPuzzleBot(method, params = {}) {
  if (!puzzleToken) throw new Error('PUZZLEBOT_IMPORT_API_TOKEN or PUZZLEBOT_API_TOKEN is required');
  const now = Date.now();
  const wait = Math.max(0, lastPuzzleCallAt + puzzleDelayMs - now);
  if (wait) await sleep(wait);
  lastPuzzleCallAt = Date.now();

  const url = new URL('https://api.puzzlebot.top/');
  url.searchParams.set('token', puzzleToken);
  url.searchParams.set('method', method);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const response = await fetch(url);
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { code: response.ok ? 0 : response.status, data: text };
  }
}

async function getPuzzleVariable(userId, variable) {
  const result = await callPuzzleBot('getVariableValue', { user_id: userId, variable });
  if (result.code && result.code !== 0) return '';
  return result.value ?? result.data ?? result.result ?? '';
}

async function getPuzzleVariables(userId, variables) {
  const out = {};
  for (const variable of variables) {
    out[variable] = await getPuzzleVariable(userId, variable);
  }
  return out;
}

function normalizeUsers(rows) {
  const byTelegramId = new Map();
  for (const row of rows) {
    const telegramId = Number(textValue(row.User_id));
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0 || telegramId === 100001) continue;
    const username = textValue(row.Username || extractDomain(row.First_name)).replace(/^@/, '');
    const firstName = stripHtml(row.First_name) || username || null;
    const score = numberValue(row.total_score);
    const title = stripHtml(row['Титул']) || resolveTitle(score);
    const normalized = { telegramId, username, firstName, score, title };
    const existing = byTelegramId.get(telegramId);
    if (!existing || normalized.score >= existing.score) byTelegramId.set(telegramId, normalized);
  }
  return [...byTelegramId.values()]
    .sort((a, b) => b.score - a.score || a.telegramId - b.telegramId)
    .slice(0, limit || undefined);
}

async function loadQuizMap(client) {
  const quizzes = await client.query('SELECT * FROM quizzes');
  return new Map(quizzes.rows.map((row) => [row.slug, row]));
}

async function loadSectionMap(client) {
  const sections = await client.query('SELECT * FROM course_sections');
  return new Map(sections.rows.map((row) => [row.slug, row]));
}

async function insertQuizAttempt(client, userId, quiz, score, weightedScore, variable) {
  await client.query(
    `INSERT INTO quiz_attempts (user_id, quiz_id, score, max_score, weighted_score, passed, answers)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      userId,
      quiz.id,
      Math.max(0, Math.min(Number(score || 0), Number(quiz.max_score || score || 0))),
      Number(quiz.max_score || score || 0),
      Number(weightedScore || 0),
      Number(score || 0) >= Number(quiz.pass_score || 0),
      JSON.stringify({ legacyImport: true, variable })
    ]
  );
}

async function completeSection(client, userId, section) {
  if (!section) return;
  await client.query(
    `INSERT INTO user_progress (user_id, section_id, status, score, completed_at)
     VALUES ($1, $2, 'completed', 1, now())
     ON CONFLICT (user_id, section_id) DO UPDATE
     SET status = 'completed',
         score = GREATEST(user_progress.score, EXCLUDED.score),
         completed_at = COALESCE(user_progress.completed_at, now())`,
    [userId, section.id]
  );
}

function estimateAcademyLevel(vars, importedCourseSlugs) {
  const oldLevel = numberValue(vars.academy_user_lvl);
  let level = Math.max(0, Math.min(oldLevel, 7));
  if (importedCourseSlugs.size > 0) level = Math.max(level, 1);
  const allSpaces = [
    'course-loft-1',
    'course-loft-2',
    'course-loft-3',
    'course-loft-4',
    'course-loft-5',
    'course-loft-8',
    'course-loft-10',
    'course-the-birch'
  ].every((slug) => importedCourseSlugs.has(slug));
  if (allSpaces) level = Math.max(level, 2);
  if (importedCourseSlugs.has('course-terms')) level = Math.max(level, 3);
  if (importedCourseSlugs.has('course-formats')) level = Math.max(level, 4);
  if (importedCourseSlugs.has('course-serving')) level = Math.max(level, 5);
  if (importedCourseSlugs.has('course-service')) level = Math.max(level, 6);
  if (importedCourseSlugs.has('course-final')) level = Math.max(level, 7);
  return level;
}

async function importUser(client, user, vars, quizMap, sectionMap) {
  const role = adminIds.has(String(user.telegramId)) ? 'admin' : 'student';
  const importedCourseSlugs = new Set();
  const userResult = await client.query(
    `INSERT INTO users (telegram_id, username, first_name, photo_url, role, title_score, title_text, academy_level)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 0)
     ON CONFLICT (telegram_id) DO UPDATE
     SET username = EXCLUDED.username,
         first_name = EXCLUDED.first_name,
         photo_url = EXCLUDED.photo_url,
         role = EXCLUDED.role,
         title_score = EXCLUDED.title_score,
         title_text = EXCLUDED.title_text,
         updated_at = now()
     RETURNING *`,
    [
      user.telegramId,
      user.username || null,
      user.firstName || null,
      `/api/telegram/avatar/${user.telegramId}`,
      role,
      user.score,
      user.title || resolveTitle(user.score)
    ]
  );
  const dbUser = userResult.rows[0];

  let importedScore = 0;

  for (const item of courseVariableMap) {
    const value = numberValue(vars[item.variable]);
    if (value <= 0) continue;
    const quiz = quizMap.get(item.quizSlug);
    if (!quiz) continue;
    importedCourseSlugs.add(item.quizSlug);
    await insertQuizAttempt(client, dbUser.id, quiz, quiz.max_score, item.reward, item.variable);
    importedScore += item.reward;
  }

  for (const item of externalQuizVariableMap) {
    const weighted = numberValue(vars[item.variable]);
    if (weighted <= 0) continue;
    const quiz = quizMap.get(item.quizSlug);
    if (!quiz) continue;
    const rawScore = Math.max(0, Math.min(Math.round(weighted / item.weight), Number(quiz.max_score || 0)));
    await insertQuizAttempt(client, dbUser.id, quiz, rawScore, weighted, item.variable);
    importedScore += weighted;
  }

  const taskPoints = numberValue(vars.points_from_help_in_tasks);
  if (taskPoints !== 0) {
    await client.query(
      `INSERT INTO point_events (user_id, source_type, source_id, points, description)
       VALUES ($1, 'legacy_task', NULL, $2, $3)`,
      [dbUser.id, taskPoints, 'Imported from PuzzleBot points_from_help_in_tasks']
    );
    importedScore += taskPoints;
  }

  const targetScore = user.score;
  const adjustment = targetScore - importedScore;
  if (adjustment !== 0) {
    await client.query(
      `INSERT INTO point_events (user_id, source_type, source_id, points, description)
       VALUES ($1, 'legacy_adjustment', NULL, $2, $3)`,
      [dbUser.id, adjustment, 'Imported correction to match legacy NocoDB total_score']
    );
  }

  const academyLevel = estimateAcademyLevel(vars, importedCourseSlugs);
  const boss = textValue(vars.Boss_academy).toLowerCase() === 'boss';
  const courseCompleted = boss || importedCourseSlugs.has('course-final');

  if (academyLevel >= 1) await completeSection(client, dbUser.id, sectionMap.get('self-employment'));
  if (academyLevel >= 2) await completeSection(client, dbUser.id, sectionMap.get('spaces'));
  if (academyLevel >= 3) await completeSection(client, dbUser.id, sectionMap.get('terms'));
  if (academyLevel >= 4) await completeSection(client, dbUser.id, sectionMap.get('formats'));
  if (academyLevel >= 5) await completeSection(client, dbUser.id, sectionMap.get('serving'));
  if (academyLevel >= 6) await completeSection(client, dbUser.id, sectionMap.get('service'));
  if (courseCompleted) await completeSection(client, dbUser.id, sectionMap.get('final'));

  await client.query(
    `UPDATE users
     SET academy_level = $2,
         course_completed_at = CASE WHEN $3 THEN COALESCE(course_completed_at, now()) ELSE course_completed_at END,
         title_score = $4,
         title_text = $5,
         updated_at = now()
     WHERE id = $1`,
    [dbUser.id, academyLevel, courseCompleted, targetScore, user.title || resolveTitle(targetScore)]
  );

  return {
    userId: dbUser.id,
    telegramId: user.telegramId,
    importedScore,
    targetScore,
    adjustment,
    academyLevel,
    courseCompleted
  };
}

async function main() {
  const nocoRows = await fetchNocoRecords();
  const users = normalizeUsers(nocoRows);
  console.log(`NocoDB rows: ${nocoRows.length}; users to import: ${users.length}`);

  if (dryRun) {
    console.log(JSON.stringify(users.slice(0, 10), null, 2));
    return;
  }

  if (resetUsers) {
    await query('TRUNCATE users RESTART IDENTITY CASCADE');
    console.log('User data reset completed');
  }

  const stats = {
    imported: 0,
    positiveScore: 0,
    fullSynced: 0,
    zeroBasicSynced: 0,
    courseCompleted: 0,
    errors: 0
  };

  const quizMap = await loadQuizMap({ query });
  const sectionMap = await loadSectionMap({ query });

  for (const [index, user] of users.entries()) {
    const shouldFullSync = includeZeroFull || user.score > 0;
    const variables = shouldFullSync ? fullVariables : zeroScoreVariables;
    try {
      await withTransaction(async (client) => {
        const vars = await getPuzzleVariables(user.telegramId, variables);
        const result = await importUser(client, user, vars, quizMap, sectionMap);
        stats.imported += 1;
        if (user.score > 0) stats.positiveScore += 1;
        if (shouldFullSync) stats.fullSynced += 1;
        else stats.zeroBasicSynced += 1;
        if (result.courseCompleted) stats.courseCompleted += 1;
      });
      if ((index + 1) % 25 === 0 || index === users.length - 1) {
        console.log(`Imported ${index + 1}/${users.length}`);
      }
    } catch (error) {
      stats.errors += 1;
      console.error(`Failed to import ${user.telegramId}: ${error.message}`);
    }
  }

  console.log(JSON.stringify(stats, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
