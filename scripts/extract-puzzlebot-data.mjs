import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const testsFile = path.resolve(root, '..', 'puzzlebot-tests-initConstructor.json');
const academyFile = path.resolve(root, '..', 'puzzlebot-initConstructor.json');
const testsData = JSON.parse(fs.readFileSync(testsFile, 'utf8'));
const academyData = JSON.parse(fs.readFileSync(academyFile, 'utf8'));

const stripHtml = (text = '') =>
  String(text)
    .replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, '$2: $1')
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
        text: stripHtml(button.text),
        target: button.callback_data || button.command_name || button.goto_condition || button.goto_web_page_name || button.url || null,
        url: button.url || null
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

function extractQuiz(sourceData, commandName, meta) {
  const command = sourceData.G_commands[commandName];
  if (!command) return null;
  const difficulty = typeof meta.difficulty === 'string'
    ? { key: meta.difficulty, title: meta.difficulty, weight: meta.weight || 1 }
    : meta.difficulty;
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
      mediaUrl: q.file_path || null,
      options
    });
  }

  if (!questions.length) return null;
  return {
    slug: meta.slug || `${meta.categorySlug}-${difficulty.key}`,
    title: meta.title || `${meta.categoryTitle}: ${difficulty.title}`,
    category: meta.categoryTitle,
    source: meta.source || 'tests',
    difficulty: difficulty.key,
    weight: difficulty.weight,
    rewardPoints: meta.rewardPoints || 0,
    passScore: meta.passScore || questions.length,
    maxScore: questions.length,
    description: meta.description || '',
    sectionSlug: meta.sectionSlug || null,
    courseRequired: Boolean(meta.courseRequired),
    questions
  };
}

const testRoots = [
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
for (const rootDef of testRoots) {
  const rootCommand = testsData.G_commands[rootDef.command];
  for (const button of getButtons(rootCommand)) {
    if (!button.target || button.target.startsWith('/') || button.target.startsWith('http')) continue;
    const difficulty = detectDifficulty(button.text, button.target);
    const quiz = extractQuiz(testsData, button.target, {
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

function collectActionMedia(action) {
  const media = [];
  for (const item of action.media || action.mediaGroupPhoto || action.files || []) {
    if (item?.path) media.push({ type: 'image', path: item.path, name: item.name || '' });
  }
  if (action.file_path) media.push({ type: 'file', path: action.file_path, name: action.file_name || '' });
  return media;
}

function extractLesson(commandName, sectionSlug, title, orderIndex) {
  const command = academyData.G_commands[commandName];
  if (!command) throw new Error(`Missing academy command: ${commandName}`);
  const parts = [];
  const media = [];
  for (const action of command.actions || []) {
    if (action.actionName === 'sendForm') continue;
    const text = stripHtml(action.text || action.caption || '');
    if (text) parts.push(text);
    media.push(...collectActionMedia(action));
  }

  const links = getButtons(command)
    .filter((button) => button.url)
    .map((button) => `${button.text}: ${button.url}`);
  if (links.length) parts.push(`Полезные ссылки:\n${links.join('\n')}`);

  return {
    sectionSlug,
    slug: `${sectionSlug}-${slugify(commandName)}`,
    title,
    body: parts.join('\n\n'),
    media,
    legacyCommand: commandName,
    orderIndex
  };
}

const lessonPlan = [
  ['self-employment', [
    ['Введение', 'Введение'],
    ['СЗ', 'Самозанятость'],
    ['Покупка униформы', 'Покупка униформы'],
    ['LOFT MEN — купить форму', 'LOFT MEN'],
    ['LOFT WOMEN — купить форму', 'LOFT WOMEN']
  ]],
  ['spaces', [
    ['Форма готова — двигаемся дальше', 'Как устроен раздел'],
    ['LOFT #1', 'LOFT #1'],
    ['LOFT #2', 'LOFT #2'],
    ['LOFT #3', 'LOFT #3'],
    ['LOFT 4', 'LOFT #4'],
    ['LOFT #5', 'LOFT #5'],
    ['LOFT #8', 'LOFT #8'],
    ['LOFT #10', 'LOFT #10'],
    ['The Birch', 'The Birch']
  ]],
  ['terms', [
    ['/ter', 'Как работать с терминами'],
    ['Термины_бар', 'Бар'],
    ['Термины_Кухня', 'Кухня'],
    ['Термины_Общие', 'Общие термины']
  ]],
  ['formats', [
    ['Форматы мероприятий', 'Как устроены форматы'],
    ['Академия_банкет', 'Банкет'],
    ['Акаедмия_фурик', 'Фуршет'],
    ['Академия_другие форматы', 'Другие форматы']
  ]],
  ['serving', [
    ['Сервировка стажер', 'Как устроен раздел'],
    ['Натирка посуды', 'Натирка посуды'],
    ['Подготовка стейшена', 'Подготовка стейшена'],
    ['Тестильная  салфетка', 'Текстильная салфетка'],
    ['Сервировка', 'Сервировка стола']
  ]],
  ['service', [
    ['Обслуживание стажер', 'Как устроен раздел'],
    ['Встреча', 'Встреча гостей'],
    ['Презентация напитков', 'Презентация напитков'],
    ['Обнос холодных закусок', 'Обнос холодных закусок'],
    ['Подача горячих закусокк', 'Подача горячих закусок'],
    ['Подача горячих блюд', 'Подача горячих блюд'],
    ['Подача горячих десертов', 'Подача горячих десертов'],
    ['Группа выносаа', 'Группа выноса']
  ]],
  ['final', [
    ['Финальный тест академия стажер', 'Финальная проверка']
  ]]
];

const lessons = lessonPlan.flatMap(([sectionSlug, items]) =>
  items.map(([commandName, title], index) => extractLesson(commandName, sectionSlug, title, index + 1))
);

const courseQuizDefs = [
  ['Академия стажер 1 лофт', 'course-loft-1', 'LOFT #1', 'spaces', 5, 1],
  ['Академия стажер 2 лофт', 'course-loft-2', 'LOFT #2', 'spaces', 5, 1],
  ['Академия стажер 3 лофт', 'course-loft-3', 'LOFT #3', 'spaces', 6, 1],
  ['Академия стажер 4 лофт', 'course-loft-4', 'LOFT #4', 'spaces', 5, 1],
  ['Академия стажер 5 лофт', 'course-loft-5', 'LOFT #5', 'spaces', 5, 1],
  ['Академия стажер 8 лофт', 'course-loft-8', 'LOFT #8', 'spaces', 5, 1],
  ['Академия стажер 10 лофт', 'course-loft-10', 'LOFT #10', 'spaces', 5, 1],
  ['Академия стажер the birch', 'course-the-birch', 'The Birch', 'spaces', 5, 1],
  ['Академия стажер термины', 'course-terms', 'Термины', 'terms', 10, 10],
  ['Академия стажер форматы', 'course-formats', 'Форматы мероприятий', 'formats', 7, 10],
  ['Академия стажер сервировка', 'course-serving', 'Сервировка', 'serving', 8, 10],
  ['Академия стажер обслуживание', 'course-service', 'Обслуживание', 'service', 10, 10],
  ['Академия стажер финал', 'course-final', 'Финальный тест', 'final', 21, 100]
];

const sectionTitles = Object.fromEntries(academyCourse().sections.map((section) => [section.slug, section.title]));
const courseQuizzes = courseQuizDefs
  .map(([command, slug, title, sectionSlug, passScore, rewardPoints]) => extractQuiz(academyData, command, {
    slug,
    title: `${title}: контрольный тест`,
    categoryTitle: sectionTitles[sectionSlug],
    description: `Контрольный тест раздела «${sectionTitles[sectionSlug]}».`,
    source: 'course',
    difficulty: 'course',
    weight: 1,
    rewardPoints,
    passScore,
    sectionSlug,
    courseRequired: true
  }))
  .filter(Boolean);

function extractWebPage(slug, sourceData, pageName, title) {
  const page = sourceData.G_web_pages?.[pageName];
  if (!page) return null;
  return {
    slug,
    title,
    body: page.blocks.map((block) => ({
      type: block.type,
      style: block.style || '',
      text: stripHtml(block.text || block.caption || ''),
      media: [
        ...(block.files || []).map((file) => ({ path: file.path, name: file.name || '' })),
        ...(block.file?.path ? [{ path: block.file.path, name: block.file.name || '' }] : [])
      ]
    })).filter((block) => block.text || block.media.length)
  };
}

const contentPages = [
  extractWebPage('alcohol-history', testsData, 'История алкоголя', 'История алкоголя')
].filter(Boolean);

const tasks = [
  {
    slug: 'photo-line',
    taskNum: 1,
    title: 'Фото линии',
    description: 'Что можно отправлять:\nБар\nФуршетная линия\nСервировки\nКофе-поинты\nАнимационные станции\n\nТребования:\nФото должны соответствовать стандартам компании.\n→ Примеры смотрите во вкладке «Схемы рабочих зон».\n\nАнимационные станции:\nлибо отсутствующие в боте,\nлибо фото лучшего качества и с большей детализацией.\n\nКачество фото:\nхорошее освещение,\nчеткий фокус,\nбез мусора, дефектов, грязной посуды,\nблюда без повреждений.',
    requiresMenu: false
  },
  {
    slug: 'dish-photo',
    taskNum: 2,
    title: 'Фото блюда из меню',
    description: 'Выбери тип мероприятия и тип блюда. Система покажет позиции из NocoDB, у которых нет фото.\n\nТребования:\nФото в хорошем качестве (свет, резкость).\n\nФото должно соответствовать реальной подаче.',
    requiresMenu: true
  },
  {
    slug: 'create-test',
    taskNum: 3,
    title: 'Создать тест',
    description: 'Формат:\n1 вопрос\n3-4 варианта ответа\n\nТема теста (одна на тест):\nменю\nистория\nсервис\nалкоголь\n\nПравила:\nОдин тест = одна тема.\nВсе тесты должны быть в одном формате.\nМожно делать серию тестов по одной теме:\nлегкий\nсредний\nсложный уровень.',
    requiresMenu: false
  },
  {
    slug: 'fact-of-day',
    taskNum: 4,
    title: 'Факт дня',
    description: 'Требования:\nТема (одна на факт):\nменю\nистория\nсервис\nалкоголь\n\nСодержание:\nФакт дня должен раскрывать конкретную тему и давать практическую пользу.\nЭто не абстрактные рассуждения и не общие фразы.\nВ тексте должен быть:\nодин четкий тезис,\nконкретный прием, правило или знание, которое можно применить в работе.\n\nФормат текста:\nкороткий,\nчитается за 10-15 секунд,\nбез воды и философии.\n\nФото:\nобязательно прикрепить изображение,\nжелательно с площадки LOFT HALL,\nдопускается фото из интернета, если нет своего.',
    requiresMenu: false
  },
  {
    slug: 'bot-bug',
    taskNum: 5,
    title: 'Ошибка в боте',
    description: 'Сообщить об ошибке\n\nЧтобы мы быстро ее исправили, укажите:\n- раздел (где произошла ошибка)\n- шаг (что делали перед этим)\n- описание (что именно не работает или отображается неверно)\n\nПрикрепите скриншот.\nБез этой информации ошибка не принимается.',
    requiresMenu: false
  }
];

const seed = {
  generatedAt: new Date().toISOString(),
  courses: [academyCourse()],
  lessons,
  quizzes,
  courseQuizzes,
  contentPages,
  tasks,
  stats: {
    quizzes: quizzes.length,
    courseQuizzes: courseQuizzes.length,
    lessons: lessons.length,
    questions: [...quizzes, ...courseQuizzes].reduce((sum, quiz) => sum + quiz.questions.length, 0)
  }
};

fs.mkdirSync(path.resolve(root, 'server', 'db'), { recursive: true });
fs.writeFileSync(path.resolve(root, 'server', 'db', 'seed-data.json'), JSON.stringify(seed, null, 2), 'utf8');
console.log(JSON.stringify(seed.stats, null, 2));
