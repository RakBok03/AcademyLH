import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(await fs.readFile(path.join(__dirname, 'seed-data.json'), 'utf8'));
const allQuizzes = [...(seed.quizzes || []), ...(seed.courseQuizzes || [])];

await withTransaction(async (client) => {
  const sectionIds = new Map();

  for (const course of seed.courses) {
    const courseRow = await client.query(
      `INSERT INTO courses (slug, title, difficulty, description, order_index)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (slug) DO UPDATE
       SET title = EXCLUDED.title,
           difficulty = EXCLUDED.difficulty,
           description = EXCLUDED.description,
           order_index = EXCLUDED.order_index
       RETURNING id`,
      [course.slug, course.title, course.difficulty, course.description, 1]
    );
    const courseId = courseRow.rows[0].id;
    for (const section of course.sections) {
      await client.query(
        `INSERT INTO course_sections (course_id, slug, title, description, order_index)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (slug) DO UPDATE
         SET course_id = EXCLUDED.course_id,
             title = EXCLUDED.title,
             description = EXCLUDED.description,
             order_index = EXCLUDED.order_index`,
        [courseId, section.slug, section.title, section.description, section.orderIndex]
      );
      const sectionRow = await client.query('SELECT id FROM course_sections WHERE slug = $1', [section.slug]);
      sectionIds.set(section.slug, sectionRow.rows[0].id);
    }
  }

  for (const lesson of seed.lessons || []) {
    const sectionId = sectionIds.get(lesson.sectionSlug);
    if (!sectionId) continue;
    await client.query(
      `INSERT INTO course_lessons (section_id, slug, title, body, media, legacy_command, order_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (slug) DO UPDATE
       SET section_id = EXCLUDED.section_id,
           title = EXCLUDED.title,
           body = EXCLUDED.body,
           media = EXCLUDED.media,
           legacy_command = EXCLUDED.legacy_command,
           order_index = EXCLUDED.order_index`,
      [
        sectionId,
        lesson.slug,
        lesson.title,
        lesson.body || '',
        JSON.stringify(lesson.media || []),
        lesson.legacyCommand || null,
        lesson.orderIndex
      ]
    );
  }

  for (const page of seed.contentPages || []) {
    await client.query(
      `INSERT INTO content_pages (slug, title, body, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (slug) DO UPDATE
       SET title = EXCLUDED.title,
           body = EXCLUDED.body,
           updated_at = now()`,
      [page.slug, page.title, JSON.stringify(page.body || [])]
    );
  }

  for (const stale of seed.deactivateQuizSlugs || []) {
    await client.query('DELETE FROM quizzes WHERE slug = $1', [stale]);
  }

  for (const [quizIndex, quiz] of allQuizzes.entries()) {
    let sectionId = null;
    if (quiz.sectionSlug) {
      sectionId = sectionIds.get(quiz.sectionSlug) || null;
    }
    const quizRow = await client.query(
      `INSERT INTO quizzes (slug, title, category, source, difficulty, weight, reward_points, pass_score, max_score, description, section_id, course_required, order_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       ON CONFLICT (slug) DO UPDATE
       SET title = EXCLUDED.title,
           category = EXCLUDED.category,
           source = EXCLUDED.source,
           difficulty = EXCLUDED.difficulty,
           weight = EXCLUDED.weight,
           reward_points = EXCLUDED.reward_points,
           pass_score = EXCLUDED.pass_score,
           max_score = EXCLUDED.max_score,
           description = EXCLUDED.description,
           section_id = EXCLUDED.section_id,
           course_required = EXCLUDED.course_required,
           order_index = EXCLUDED.order_index
       RETURNING id`,
      [
        quiz.slug,
        quiz.title,
        quiz.category,
        quiz.source,
        quiz.difficulty,
        quiz.weight,
        quiz.rewardPoints || 0,
        quiz.passScore,
        quiz.maxScore,
        quiz.description,
        sectionId,
        Boolean(quiz.courseRequired),
        quizIndex + 1
      ]
    );
    const quizId = quizRow.rows[0].id;
    await client.query('DELETE FROM quiz_questions WHERE quiz_id = $1', [quizId]);
    for (const [questionIndex, question] of quiz.questions.entries()) {
      const questionRow = await client.query(
        `INSERT INTO quiz_questions (quiz_id, order_index, text, media_url)
         VALUES ($1, $2, $3, $4)
         RETURNING id`,
        [quizId, questionIndex + 1, question.text, question.mediaUrl || null]
      );
      const questionId = questionRow.rows[0].id;
      for (const [optionIndex, option] of question.options.entries()) {
        await client.query(
          `INSERT INTO quiz_options (question_id, order_index, text, is_correct)
           VALUES ($1, $2, $3, $4)`,
          [questionId, optionIndex + 1, option.text, option.isCorrect]
        );
      }
    }
  }

  for (const [index, task] of seed.tasks.entries()) {
    await client.query(
      `INSERT INTO tasks (slug, task_num, title, description, requires_menu, active, order_index)
       VALUES ($1, $2, $3, $4, $5, true, $6)
       ON CONFLICT (slug) DO UPDATE
       SET task_num = EXCLUDED.task_num,
           title = EXCLUDED.title,
           description = EXCLUDED.description,
           requires_menu = EXCLUDED.requires_menu,
           order_index = EXCLUDED.order_index`,
      [task.slug, task.taskNum, task.title, task.description, task.requiresMenu, index + 1]
    );
  }
});

console.log(`Seed completed: ${allQuizzes.length} quizzes, ${seed.tasks.length} tasks`);
