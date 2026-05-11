import React, { useEffect, useMemo, useState } from 'react';
import {
  Award,
  BarChart3,
  BookOpen,
  Check,
  ClipboardList,
  Home,
  LayoutDashboard,
  Lock,
  Medal,
  Send,
  Settings,
  Sparkles,
  Trophy,
  User
} from 'lucide-react';
import { apiFetch, authenticate } from './lib/api.js';

const statusLabels = {
  available: 'Доступно',
  locked: 'Закрыто',
  pending: 'На проверке',
  approved: 'Принято',
  rejected: 'Нужно доработать'
};

const allowedPages = new Set(['home', 'profile', 'courses', 'tests', 'leaderboard', 'tasks', 'admin']);

function statusLabel(status) {
  return statusLabels[status] || status;
}

function cx(...values) {
  return values.filter(Boolean).join(' ');
}

function formatName(user) {
  if (!user) return '';
  return [user.firstName || user.first_name, user.lastName || user.last_name].filter(Boolean).join(' ') || user.username || 'Пользователь';
}

function Avatar({ user, size = 'md' }) {
  const photo = user?.photoUrl || user?.photo_url;
  return (
    <div className={cx('avatar', size === 'lg' && 'avatar-lg')}>
      {photo ? <img src={photo} alt="" /> : <span>{formatName(user).slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}

function PageHeader({ eyebrow, title, children }) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {children}
    </header>
  );
}

function BackHomeButton({ setPage }) {
  return (
    <button type="button" className="ghost compact-button" onClick={() => setPage('home')}>
      <Home size={17} />
      Главная
    </button>
  );
}

function Stat({ label, value, icon: Icon }) {
  return (
    <div className="stat">
      <Icon size={18} />
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function HomePage({ data, setPage }) {
  return (
    <main className="page">
      <PageHeader eyebrow="LOFT HALL" title="Академия">
        <button type="button" className="avatar-button" onClick={() => setPage('profile')} aria-label="Открыть профиль">
          <Avatar user={data.user} />
        </button>
      </PageHeader>
      <section className="hero-panel">
        <div className="surreal-mark" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div>
          <p className="eyebrow">Твоя траектория</p>
          <h2>{data.user.titleText}</h2>
          <p>Очки, тесты, задания и прогресс теперь собраны в одном mini app.</p>
        </div>
        <div className="hero-score">
          <strong>{data.user.titleScore}</strong>
          <span>очков</span>
        </div>
      </section>
      <section className="quick-grid">
        <button onClick={() => setPage('profile')}><User size={20} />Профиль</button>
        <button onClick={() => setPage('courses')}><BookOpen size={20} />Курсы</button>
        <button onClick={() => setPage('tests')}><ClipboardList size={20} />Тесты</button>
        <button onClick={() => setPage('leaderboard')}><Trophy size={20} />Рейтинг</button>
        <button onClick={() => setPage('tasks')}><Send size={20} />Задания</button>
        {data.user.role === 'admin' && <button onClick={() => setPage('admin')}><Settings size={20} />Админка</button>}
      </section>
      <section className="list-section">
        <h2>Топ-5</h2>
        <div className="list">
          {data.leaderboard.map((user, index) => (
            <div className="row" key={user.id}>
              <span className="rank">{index + 1}</span>
              <Avatar user={user} />
              <div className="row-main">
                <strong>{formatName(user)}</strong>
                <span>{user.title_text}</span>
              </div>
              <b>{user.title_score}</b>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function ProfilePage({ me, setPage }) {
  const completed = me.progress.filter((item) => item.status === 'completed').length;
  const groupedProgress = useMemo(() => {
    return me.progress.reduce((acc, item) => {
      const slug = item.course_slug || 'stazher-trail';
      acc[slug] ||= {
        slug,
        title: item.course_title || 'Стажерская тропа',
        difficulty: item.course_difficulty || 'начальный',
        items: []
      };
      acc[slug].items.push(item);
      return acc;
    }, {});
  }, [me.progress]);

  return (
    <main className="page">
      <PageHeader eyebrow="Профиль" title={formatName(me.user)}>
        <div className="header-actions">
          <BackHomeButton setPage={setPage} />
          <Avatar user={me.user} size="lg" />
        </div>
      </PageHeader>
      <section className="stats-grid">
        <Stat label="Титул" value={me.user.titleText} icon={Award} />
        <Stat label="Очки" value={me.user.titleScore} icon={Sparkles} />
        <Stat label="Прогресс" value={`${completed}/${me.progress.length}`} icon={BarChart3} />
      </section>
      <section className="list-section">
        <h2>Прогресс курса</h2>
        {Object.values(groupedProgress).map((course) => {
          const courseCompleted = course.items.filter((item) => item.status === 'completed').length;
          return (
            <details className="course-progress" key={course.slug} open>
              <summary>
                <div>
                  <strong>{course.title}</strong>
                  <span>{course.difficulty}</span>
                </div>
                <b>{courseCompleted}/{course.items.length}</b>
              </summary>
              <div className="progress-lines">
                {course.items.map((item) => (
                  <div key={item.slug}>
                    <span>{item.title}</span>
                    <b>{statusLabel(item.status)}</b>
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </section>
      <section className="list-section">
        <h2>История тестов</h2>
        <div className="list">
          {me.attempts.length === 0 && <p className="muted">Попыток пока нет.</p>}
          {me.attempts.map((attempt) => (
            <div className="row" key={attempt.id}>
              <Check size={18} />
              <div className="row-main">
                <strong>{attempt.title}</strong>
                <span>{attempt.category} · {attempt.difficulty}</span>
              </div>
              <b>{attempt.score}/{attempt.max_score}</b>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function CoursesPage({ courses, selectedCourse, openCourse, setPage }) {
  return (
    <main className="page">
      <PageHeader eyebrow="Курсы" title="Обучение">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      <section className="course-list">
        {courses.map((course) => (
          <button className="course-card" key={course.slug} onClick={() => openCourse(course.slug)}>
            <div>
              <span>{course.difficulty}</span>
              <h2>{course.title}</h2>
              <p>{course.description}</p>
            </div>
            <BookOpen size={24} />
          </button>
        ))}
      </section>
      {selectedCourse && (
        <section className="list-section">
          <h2>{selectedCourse.course.title}</h2>
          <div className="timeline">
            {selectedCourse.sections.map((section) => (
              <div key={section.slug}>
                <span />
                <div>
                  <strong>{section.title}</strong>
                  <p>{section.description}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

function TestsPage({ quizzes, openQuiz, setPage }) {
  const grouped = useMemo(() => {
    return quizzes.reduce((acc, quiz) => {
      acc[quiz.category] ||= [];
      acc[quiz.category].push(quiz);
      return acc;
    }, {});
  }, [quizzes]);

  return (
    <main className="page">
      <PageHeader eyebrow="Проверка знаний" title="Тесты">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      {Object.entries(grouped).map(([category, items]) => (
        <section className="list-section" key={category}>
          <h2>{category}</h2>
          <div className="test-grid">
            {items.map((quiz) => (
              <button className="test-card" key={quiz.slug} onClick={() => openQuiz(quiz.slug)}>
                <span>{quiz.difficulty}</span>
                <strong>{quiz.title.replace(`${category}: `, '')}</strong>
                <small>{quiz.max_score} вопросов · вес {quiz.weight}</small>
              </button>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}

function QuizPage({ quizState, submitQuiz, close }) {
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const done = Object.keys(answers).length === quizState.questions.length;

  async function onSubmit() {
    const payload = await submitQuiz(quizState.quiz.slug, answers);
    setResult(payload.attempt);
  }

  return (
    <main className="page">
      <PageHeader eyebrow={quizState.quiz.category} title={quizState.quiz.title}>
        <button className="icon-button" onClick={close}>×</button>
      </PageHeader>
      {result && (
        <section className="result-panel">
          <Medal size={28} />
          <div>
            <h2>{result.score}/{result.max_score}</h2>
            <p>{result.passed ? 'Тест пройден.' : 'Можно пройти еще раз.'}</p>
          </div>
        </section>
      )}
      <section className="quiz-stack">
        {quizState.questions.map((question, index) => (
          <div className="question" key={question.id}>
            <span>Вопрос {index + 1}</span>
            <h2>{question.text}</h2>
            <div className="options">
              {question.options.map((option) => (
                <button
                  key={option.id}
                  className={answers[question.id] === option.id ? 'selected' : ''}
                  onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.id }))}
                >
                  {option.text}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>
      <div className="sticky-action">
        <button className="primary" disabled={!done || result} onClick={onSubmit}>Завершить тест</button>
      </div>
    </main>
  );
}

function LeaderboardPage({ leaderboard, setPage }) {
  return (
    <main className="page">
      <PageHeader eyebrow="Рейтинг" title="Лидеры">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      <section className="hero-panel compact">
        <Trophy size={30} />
        <div>
          <h2>Твое место: {leaderboard.myRank}</h2>
          <p>{leaderboard.me.titleText} · {leaderboard.me.titleScore} очков</p>
        </div>
      </section>
      <section className="list-section">
        <h2>Топ-5</h2>
        <div className="list">
          {leaderboard.top.map((user, index) => (
            <div className="row" key={user.id}>
              <span className="rank">{index + 1}</span>
              <Avatar user={user} />
              <div className="row-main">
                <strong>{formatName(user)}</strong>
                <span>{user.title_text}</span>
              </div>
              <b>{user.title_score}</b>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function TasksPage({ tasks, submitTask, loadMenu, loadMenuFilters, setPage }) {
  const [active, setActive] = useState(null);
  const [form, setForm] = useState({});
  const [menu, setMenu] = useState([]);
  const [filters, setFilters] = useState({ eventTypes: [], dishClasses: [] });
  const [menuState, setMenuState] = useState({ loading: false, message: '' });
  const activeTask = tasks.find((task) => task.slug === active);

  useEffect(() => {
    if (!activeTask?.requires_menu) return;
    (async () => {
      try {
        const payload = await loadMenuFilters();
        setFilters(payload);
      } catch {
        setMenuState({ loading: false, message: 'Не удалось загрузить справочник меню.' });
      }
    })();
  }, [activeTask?.slug]);

  async function findDishes() {
    setMenuState({ loading: true, message: '' });
    try {
      const dishes = await loadMenu(form.typeEvent, form.classDish);
      setMenu(dishes);
      setMenuState({ loading: false, message: dishes.length ? '' : 'Подходящих блюд не найдено.' });
    } catch {
      setMenu([]);
      setMenuState({ loading: false, message: 'Не удалось получить блюда из меню.' });
    }
  }

  async function onSubmit(event) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    await submitTask(activeTask.slug, data);
    setActive(null);
    setForm({});
    setMenu([]);
  }

  return (
    <main className="page">
      <PageHeader eyebrow="Практика" title="Доска заданий">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      {!activeTask && (
        <section className="task-grid">
          {tasks.map((task) => (
            <button className="task-card" key={task.slug} onClick={() => setActive(task.slug)}>
              <span>Задание {task.task_num}</span>
              <h2>{task.title}</h2>
              <p>{task.description}</p>
              {task.last_status && <b>{statusLabel(task.last_status)}</b>}
            </button>
          ))}
        </section>
      )}
      {activeTask && (
        <form className="submission-form" onSubmit={onSubmit}>
          <button type="button" className="ghost" onClick={() => setActive(null)}>Назад</button>
          <h2>{activeTask.title}</h2>
          <p className="task-description">{activeTask.description}</p>
          {activeTask.requires_menu && (
            <div className="field-grid">
              <label>Тип мероприятия
                <select
                  name="typeEvent"
                  value={form.typeEvent || ''}
                  required
                  onChange={(e) => {
                    setForm({ ...form, typeEvent: e.target.value, dishName: '' });
                    setMenu([]);
                  }}
                >
                  <option value="">Выбери тип мероприятия</option>
                  {filters.eventTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label>Тип блюда
                <select
                  name="classDish"
                  value={form.classDish || ''}
                  required
                  onChange={(e) => {
                    setForm({ ...form, classDish: e.target.value, dishName: '' });
                    setMenu([]);
                  }}
                >
                  <option value="">Выбери тип блюда</option>
                  {filters.dishClasses.map((dishClass) => <option key={dishClass} value={dishClass}>{dishClass}</option>)}
                </select>
              </label>
              <button type="button" className="secondary" disabled={!form.typeEvent || !form.classDish || menuState.loading} onClick={findDishes}>
                {menuState.loading ? 'Ищу...' : 'Показать блюда'}
              </button>
              {menuState.message && <p className="field-note">{menuState.message}</p>}
              {menu.length > 0 && (
                <label className="full">Блюдо
                  <select name="dishName" required value={form.dishName || ''} onChange={(e) => setForm({ ...form, dishName: e.target.value })}>
                    <option value="">Выбери позицию</option>
                    {menu.map((dish) => (
                      <option key={dish.id || dish.Id || dish.name} value={dish.name || dish.Name || dish.title}>{dish.name || dish.Name || dish.title || `Позиция ${dish.id}`}</option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
          <label>Комментарий<textarea name="comment" rows="4" placeholder="Опиши выполнение задания" /></label>
          <label>Файлы<input name="files" type="file" multiple /></label>
          <button className="primary" type="submit">Отправить на проверку</button>
        </form>
      )}
    </main>
  );
}

function AdminPage({ admin, reviewSubmission, reload, setPage, selectedSubmissionId }) {
  const [reward, setReward] = useState({});
  const selectedId = Number(selectedSubmissionId || 0);
  return (
    <main className="page">
      <PageHeader eyebrow="Админка" title="Проверка и пользователи">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      <section className="list-section">
        <h2>Заявки</h2>
        <div className="list">
          {admin.submissions.map((submission) => (
            <div className={cx('admin-item', selectedId === submission.id && 'selected-admin-item')} key={submission.id}>
              <div>
                <strong>{submission.task_num}. {submission.task_title}</strong>
                <span>{submission.first_name} {submission.last_name} {submission.username ? `@${submission.username}` : ''}</span>
                {submission.payload?.typeEvent && <small>Тип мероприятия: {submission.payload.typeEvent}</small>}
                {submission.payload?.classDish && <small>Тип блюда: {submission.payload.classDish}</small>}
                {submission.payload?.dishName && <small>Блюдо: {submission.payload.dishName}</small>}
                <p>{submission.comment || 'Без комментария'}</p>
                <small>{statusLabel(submission.status)}</small>
                {submission.uploads?.length > 0 && (
                  <div className="upload-links">
                    {submission.uploads.map((upload) => (
                      <a key={upload.id} href={upload.url} target="_blank" rel="noreferrer">{upload.name}</a>
                    ))}
                  </div>
                )}
              </div>
              <input type="number" min="0" placeholder="Баллы" value={reward[submission.id] || ''} onChange={(e) => setReward({ ...reward, [submission.id]: e.target.value })} />
              <button onClick={async () => { await reviewSubmission(submission.id, 'approved', reward[submission.id] || 0); reload(); }}>Вознаградить</button>
              <button className="secondary" onClick={async () => { await reviewSubmission(submission.id, 'rejected', 0); reload(); }}>Отклонить</button>
            </div>
          ))}
        </div>
      </section>
      <section className="list-section">
        <h2>Пользователи</h2>
        <div className="list">
          {admin.users.map((user) => (
            <div className="row" key={user.id}>
              <Avatar user={user} />
              <div className="row-main">
                <strong>{formatName(user)}</strong>
                <span>{user.title_text} · {user.role}</span>
              </div>
              <b>{user.title_score}</b>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

export function App() {
  const query = new URLSearchParams(window.location.search);
  const requestedPage = query.get('page');
  const selectedSubmissionId = query.get('submissionId');
  const [page, setPage] = useState(allowedPages.has(requestedPage) ? requestedPage : 'home');
  const [boot, setBoot] = useState({ loading: true, error: null });
  const [home, setHome] = useState(null);
  const [me, setMe] = useState(null);
  const [courses, setCourses] = useState([]);
  const [selectedCourse, setSelectedCourse] = useState(null);
  const [quizzes, setQuizzes] = useState([]);
  const [quizState, setQuizState] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [admin, setAdmin] = useState(null);

  async function loadAll() {
    const [homeData, meData, coursesData, quizzesData, leaderboardData, tasksData] = await Promise.all([
      apiFetch('/home'),
      apiFetch('/me'),
      apiFetch('/courses'),
      apiFetch('/quizzes'),
      apiFetch('/leaderboard'),
      apiFetch('/tasks')
    ]);
    setHome(homeData);
    setMe(meData);
    setCourses(coursesData.courses);
    setQuizzes(quizzesData.quizzes);
    setLeaderboard(leaderboardData);
    setTasks(tasksData.tasks);
    if (homeData.user.role === 'admin') await loadAdmin();
  }

  async function loadAdmin() {
    const [users, submissions] = await Promise.all([
      apiFetch('/admin/users'),
      apiFetch('/admin/submissions')
    ]);
    setAdmin({ users: users.users, submissions: submissions.submissions });
  }

  useEffect(() => {
    (async () => {
      try {
        await authenticate();
        await loadAll();
        setBoot({ loading: false, error: null });
      } catch (error) {
        setBoot({ loading: false, error: error.message });
      }
    })();
  }, []);

  async function openCourse(slug) {
    setSelectedCourse(await apiFetch(`/courses/${slug}`));
  }

  async function openQuiz(slug) {
    setQuizState(await apiFetch(`/quizzes/${slug}`));
  }

  async function submitQuiz(slug, answers) {
    const result = await apiFetch(`/quizzes/${slug}/attempt`, {
      method: 'POST',
      body: JSON.stringify({ answers })
    });
    await loadAll();
    return result;
  }

  async function loadMenu(typeEvent, classDish) {
    const params = new URLSearchParams({ typeEvent: typeEvent || '', classDish: classDish || '' });
    const result = await apiFetch(`/tasks/dish-photo/menu-options?${params.toString()}`);
    return result.dishes;
  }

  async function loadMenuFilters() {
    return apiFetch('/tasks/dish-photo/menu-filters');
  }

  async function submitTask(slug, formData) {
    await apiFetch(`/tasks/${slug}/submissions`, {
      method: 'POST',
      body: formData,
      headers: {}
    });
    await loadAll();
  }

  async function reviewSubmission(id, status, rewardPoints) {
    await apiFetch(`/admin/submissions/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ status, rewardPoints: Number(rewardPoints || 0), adminComment: 'Проверено через AcademyLH' })
    });
  }

  if (boot.loading) return <div className="splash"><LayoutDashboard size={34} /><span>AcademyLH</span></div>;
  if (boot.error) return <div className="splash error"><Lock size={34} /><span>{boot.error}</span></div>;
  if (quizState) return <QuizPage quizState={quizState} submitQuiz={submitQuiz} close={() => setQuizState(null)} />;

  return (
    <div className="app-shell">
      {page === 'home' && <HomePage data={home} setPage={setPage} />}
      {page === 'profile' && <ProfilePage me={me} setPage={setPage} />}
      {page === 'courses' && <CoursesPage courses={courses} selectedCourse={selectedCourse} openCourse={openCourse} setPage={setPage} />}
      {page === 'tests' && <TestsPage quizzes={quizzes} openQuiz={openQuiz} setPage={setPage} />}
      {page === 'leaderboard' && <LeaderboardPage leaderboard={leaderboard} setPage={setPage} />}
      {page === 'tasks' && <TasksPage tasks={tasks} submitTask={submitTask} loadMenu={loadMenu} loadMenuFilters={loadMenuFilters} setPage={setPage} />}
      {page === 'admin' && home.user.role === 'admin' && admin && <AdminPage admin={admin} reviewSubmission={reviewSubmission} reload={loadAdmin} setPage={setPage} selectedSubmissionId={selectedSubmissionId} />}
      {page === 'admin' && home.user.role !== 'admin' && (
        <main className="page">
          <PageHeader eyebrow="Доступ" title="Админка закрыта">
            <BackHomeButton setPage={setPage} />
          </PageHeader>
          <section className="list-section">
            <p className="muted">Этот раздел доступен только администраторам.</p>
          </section>
        </main>
      )}
    </div>
  );
}
