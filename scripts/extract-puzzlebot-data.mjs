import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const testsFile = path.resolve(root, '..', 'puzzlebot-tests-initConstructor.json');
const academyFile = path.resolve(root, '..', 'puzzlebot-initConstructor.json');
const testsData = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
const academyData = JSON.parse(fs.readFileSync(academyFile, 'utf8'));

const stripHtml = (text = '') =>
  String(text)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

const slugify = (value) =>
  String(value)
    .toLowerCase()
    .replace(/[ё]/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90);

function walkButtons(markup, callback) {
  for (const row of markup || []) {
    for (const button of row || []) callback(button);
  }
}

function getButtons(command) {
  const buttons = [];
  for (const action of command?.actions || []) {
    walkButtons(action.reply_markup, (button) => {
      buttons.push({
        text: button.text,
        target: button.callback_data || button.command_name || button.goto_condition || button.goto_web_page_name || button.url || null
      });
    });
  }
  return buttons;
}

function detectDifficulty(label, target) {
  const text = `${label} ${target}`.toLowerCase();
  if (text.includes('мега')) return { key: 'veryhard', title: 'мега-сложный', weight: 3 };
  if (text.includes('слож')) return { key: 'hard', title: 'сложный', weight: 3 };
  if (text.includes('сред')) return { key: 'middle', title: 'средний', weight: 2 };
  return { key: 'easy', title: 'легкий', weight: 1 };
}

function extractQuiz(commandName, meta) {
  const command = testsData.G_commands[commandName];
  if (!command) return null;
  const questions = [];
  for (const action of command.actions || []) {
    if (action.actionName !== 'sendForm') continue;
    const q = action.question_action || {};
    const options = [];
    walkButtons(q.reply_markup, (button) => {
      options.push({
        text: stripHtml(button.text),
        isCorrect: Boolean(button.true_answer)
      });
    });
    if (!options.length) continue;
    questions.push({
      text: stripHtml(q.text).replace(/^ВОПРОС №\d+\s*/i, '').trim(),
      options
    });
  }

  if (!questions.length) return null;
  return {
    slug: `${meta.categorySlug}-${meta.difficulty.key}`,
    title: `${meta.categoryTitle}: ${meta.difficulty.title}`,
    category: meta.categoryTitle,
    source: 'tests',
    difficulty: meta.difficulty.key,
    weight: meta.difficulty.weight,
    passScore: questions.length,
    maxScore: questions.length,
    description: meta.description || '',
    questions
  };
}

const roots = [
  {
    command: '/test_loft_hall',
    slug: 'lofthall-history',
    title: 'Пространства и история LOFT HALL',
    description: 'Проверка знаний по пространствам и истории LOFT HALL.'
  },
  {
    command: '/test_menu',
    slug: 'menu',
    title: 'Оценка знаний по меню',
    description: 'Меню еды, состав блюд и подача.'
  },
  {
    command: '/test_alcohol',
    slug: 'alcohol',
    title: 'Алкоголь и его история',
    description: 'История алкоголя и базовая теория напитков.'
  },
  {
    command: '/test_loft_4',
    slug: 'loft-4',
    title: 'Пространства LOFT #4',
    description: 'Проверка знаний по площадке LOFT #4.'
  },
  {
    command: '/test_cheese',
    slug: 'cheese',
    title: 'Сырный эксперт',
    description: 'Базовая проверка знаний по сырам.'
  },
  {
    command: '/test_servise',
    slug: 'service',
    title: 'Банкетное обслуживание',
    description: 'Дополнительный раздел по обслуживанию.'
  }
];

const quizzes = [];
for (const rootDef of roots) {
  const rootCommand = testsData.G_commands[rootDef.command];
  for (const button of getButtons(rootCommand)) {
    if (!button.target || button.target.startsWith('/') || button.target.startsWith('http')) continue;
    const difficulty = detectDifficulty(button.text, button.target);
    const quiz = extractQuiz(button.target, {
      categorySlug: rootDef.slug,
      categoryTitle: rootDef.title,
      description: rootDef.description,
      difficulty
    });
    if (quiz) quizzes.push(quiz);
  }
}

function academyCourse() {
  return {
    slug: 'stazher-trail',
    title: 'Стажерская тропа',
    difficulty: 'начальный',
    description: 'Первый курс Академии LOFT HALL: самозанятость, форма, пространства, термины, форматы, сервировка, обслуживание и финальный тест.',
    sections: [
      ['self-employment', 'Самозанятость и форма', 'Входной блок о подготовке к работе и форме официанта.'],
      ['spaces', 'Пространства LOFT HALL', 'Залы, площадки и особенности пространств.'],
      ['terms', 'Термины', 'Барные, кухонные и общие рабочие термины.'],
      ['formats', 'Форматы мероприятий', 'Банкет, фуршет, кофе-брейк и другие форматы.'],
      ['serving', 'Сервировка', 'Посуда, стейшен, текстиль и сервировка стола.'],
      ['service', 'Обслуживание', 'Встреча гостей, подача блюд и напитков, группа выноса.'],
      ['final', 'Финал', 'Финальная проверка знаний стажера.']
    ].map(([slug, title, description], index) => ({ slug, title, description, orderIndex: index + 1 }))
  };
}

const tasks = [
  {
    slug: 'photo-line',
    taskNum: 1,
    title: 'Фото линии',
    description: 'Загрузи фото линии или рабочей зоны и добавь короткий комментарий.',
    requiresMenu: false
  },
  {
    slug: 'dish-photo',
    taskNum: 2,
    title: 'Фото блюда из меню',
    description: 'Выбери тип мероприятия и класс блюда. Система покажет позиции из NocoDB, у которых нет фото. Загрузи фото выбранного блюда.',
    requiresMenu: true
  },
  {
    slug: 'create-test',
    taskNum: 3,
    title: 'Создать тест',
    description: 'Предложи вопрос для Академии, варианты ответов и отметь правильный.',
    requiresMenu: false
  },
  {
    slug: 'fact-of-day',
    taskNum: 4,
    title: 'Факт дня',
    description: 'Поделись полезным фактом для команды LOFT HALL.',
    requiresMenu: false
  },
  {
    slug: 'bot-bug',
    taskNum: 5,
    title: 'Ошибка в боте',
    description: 'Опиши ошибку в Академии или боте. Можно приложить скриншот.',
    requiresMenu: false
  }
];

const seed = {
  generatedAt: new Date().toISOString(),
  courses: [academyCourse()],
  quizzes,
  tasks,
  stats: {
    quizzes: quizzes.length,
    questions: quizzes.reduce((sum, quiz) => sum + quiz.questions.length, 0)
  }
};

fs.mkdirSync(path.resolve(root, 'server', 'db'), { recursive: true });
fs.writeFileSync(path.resolve(root, 'server', 'db', 'seed-data.json'), JSON.stringify(seed, null, 2), 'utf8');
console.log(JSON.stringify(seed.stats, null, 2));
