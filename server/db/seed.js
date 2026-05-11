import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTransaction } from './pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(await fs.readFile(path.join(__dirname, 'seed-data.json'), 'utf8'));

await withTransaction(async (client) => {
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
    }
  }

  for (const [quizIndex, quiz] of seed.quizzes.entries()) {
    const quizRow = await client.query(
      `INSERT INTO quizzes (slug, title, category, source, difficulty, weight, pass_score, max_score, description, order_index)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (slug) DO UPDATE
       SET title = EXCLUDED.title,
           category = EXCLUDED.category,
           source = EXCLUDED.source,
           difficulty = EXCLUDED.difficulty,
           weight = EXCLUDED.weight,
           pass_score = EXCLUDED.pass_score,
           max_score = EXCLUDED.max_score,
           description = EXCLUDED.description,
           order_index = EXCLUDED.order_index
       RETURNING id`,
      [quiz.slug, quiz.title, quiz.category, quiz.source, quiz.difficulty, quiz.weight, quiz.passScore, quiz.maxScore, quiz.description, quizIndex + 1]
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

console.log(`Seed completed: ${seed.quizzes.length} quizzes, ${seed.tasks.length} tasks`);
