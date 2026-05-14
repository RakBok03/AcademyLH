import React, { useEffect, useMemo, useState } from 'react';
import {
  Award,
  BarChart3,
  BookOpen,
  Check,
  ChevronDown,
  ClipboardList,
  Edit3,
  Home,
  LayoutDashboard,
  Lock,
  Maximize2,
  Medal,
  Minus,
  Plus,
  RotateCcw,
  Send,
  Settings,
  Sparkles,
  Trash2,
  Trophy,
  User,
  X
} from 'lucide-react';
import { apiFetch, authenticate } from './lib/api.js';

const statusLabels = {
  available: 'Доступно',
  locked: 'Закрыто',
  pending: 'На проверке',
  approved: 'Принято',
  rejected: 'Отклонено',
  completed: 'Пройдено'
};

const allowedPages = new Set(['home', 'profile', 'courses', 'tests', 'leaderboard', 'tasks', 'admin']);
const puzzleBotMediaBase = 'https://pbt.storage.yandexcloud.net/';
const imageExtensionPattern = /\.(avif|gif|jpe?g|jfif|png|webp)$/i;
const urlPattern = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

function statusLabel(status) {
  return statusLabels[status] || status;
}

function cx(...values) {
  return values.filter(Boolean).join(' ');
}

function trimUrlTail(value) {
  const tail = value.match(/[.,!?;:)\]]+$/)?.[0] || '';
  return {
    url: tail ? value.slice(0, -tail.length) : value,
    tail
  };
}

function RichText({ text, className }) {
  if (!text) return null;
  const value = String(text);
  const nodes = [];
  let lastIndex = 0;

  value.replace(urlPattern, (rawUrl, _match, offset) => {
    if (offset > lastIndex) nodes.push(value.slice(lastIndex, offset));
    const { url, tail } = trimUrlTail(rawUrl);
    const href = url.startsWith('http') ? url : `https://${url}`;
    nodes.push(
      <a key={`${href}-${offset}`} href={href} target="_blank" rel="noreferrer">
        клик
      </a>
    );
    if (tail) nodes.push(tail);
    lastIndex = offset + rawUrl.length;
    return rawUrl;
  });

  if (lastIndex < value.length) nodes.push(value.slice(lastIndex));
  return <p className={cx('rich-text', className)}>{nodes}</p>;
}

function mediaPath(file) {
  if (!file) return '';
  if (typeof file === 'string') return file;
  return file.url || file.path || file.media_url || file.mediaUrl || '';
}

function mediaName(file, index) {
  if (!file || typeof file === 'string') return `Файл ${index + 1}`;
  return file.name || file.title || `Файл ${index + 1}`;
}

function mediaUrl(file) {
  const rawPath = String(mediaPath(file) || '').trim();
  if (!rawPath) return '';
  if (/^(https?:|data:|blob:)/i.test(rawPath)) return rawPath;
  if (rawPath.startsWith('/api/') || rawPath.startsWith('/uploads/')) return rawPath;
  if (rawPath.startsWith('uploads/')) return `/${rawPath}`;
  return `${puzzleBotMediaBase}${rawPath.replace(/^\/+/, '')}`;
}

function isImageMedia(file) {
  const path = mediaPath(file);
  const type = typeof file === 'object' ? file?.type || file?.mime || file?.mimeType || '' : '';
  return String(type).startsWith('image/') || type === 'photo' || imageExtensionPattern.test(String(path).split(/[?#]/)[0]);
}

function MediaGrid({ media, className }) {
  const [openedImage, setOpenedImage] = useState(null);
  const items = (media || []).map((file, index) => ({
    file,
    index,
    url: mediaUrl(file)
  })).filter((item) => item.url);

  if (!items.length) return null;

  return (
    <>
      <div className={cx('media-grid', items.length === 1 && 'single', className)}>
        {items.map(({ file, index, url }) => {
          const label = mediaName(file, index);
          return isImageMedia(file) ? (
            <button
              className="media-image-button"
              type="button"
              onClick={() => setOpenedImage({ url, label })}
              key={`${url}-${index}`}
              aria-label={`Открыть фото: ${label}`}
              style={{ '--media-fill': `url(${encodeURI(url)})` }}
            >
              <img src={encodeURI(url)} alt={label} loading="lazy" />
              <span className="media-zoom-hint"><Maximize2 size={16} /></span>
            </button>
          ) : (
            <a className="media-file-link" href={url} target="_blank" rel="noreferrer" key={`${url}-${index}`}>
              {label}
            </a>
          );
        })}
      </div>
      <ImageLightbox image={openedImage} onClose={() => setOpenedImage(null)} />
    </>
  );
}

function mediaCaptionTitle(file) {
  return String(file?.captionTitle || file?.caption || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function normalizeMediaCaption(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»"'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLessonMedia(media = []) {
  const mainMedia = [];
  const groups = new Map();

  media.forEach((file) => {
    const title = mediaCaptionTitle(file);
    if (!title) {
      mainMedia.push(file);
      return;
    }
    const key = normalizeMediaCaption(title);
    if (!groups.has(key)) groups.set(key, { title, media: [] });
    groups.get(key).media.push(file);
  });

  return { mainMedia, groups };
}

function LessonContent({ lesson, inlineMedia = false }) {
  const media = lesson.media || [];
  if (!inlineMedia) {
    return (
      <>
        <RichText text={lesson.body} />
        <MediaGrid media={media.slice(0, 80)} />
      </>
    );
  }

  return <RichTextWithInlineMedia text={lesson.body} media={media} />;
}

function RichTextWithInlineMedia({ text, media }) {
  const { mainMedia, groups } = splitLessonMedia(media);
  const usedKeys = new Set();
  const blocks = [];
  let buffer = [];

  function flushBuffer(index) {
    const value = buffer.join('\n').trim();
    if (value) blocks.push(<RichText text={value} key={`text-${index}`} />);
    buffer = [];
  }

  String(text || '').split('\n').forEach((line, index) => {
    const key = normalizeMediaCaption(line);
    const group = groups.get(key);
    if (!group) {
      buffer.push(line);
      return;
    }

    flushBuffer(index);
    blocks.push(<RichText text={line} className="hall-title" key={`hall-${key}`} />);
    blocks.push(<MediaGrid media={group.media} className="hall-media-grid" key={`media-${key}`} />);
    usedKeys.add(key);
  });
  flushBuffer('last');

  const remainingGroups = [...groups.entries()].filter(([key]) => !usedKeys.has(key));

  return (
    <div className="lesson-rich-flow">
      <MediaGrid media={mainMedia} className="lesson-overview-media" />
      {blocks}
      {remainingGroups.map(([key, group]) => (
        <div className="hall-media-block" key={key}>
          <h4>{group.title}</h4>
          <MediaGrid media={group.media} className="hall-media-grid" />
        </div>
      ))}
    </div>
  );
}

function normalizeCourseItemTitle(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/:.*$/, '')
    .replace(/[«»"'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitQuizzesByLesson(section) {
  const quizzes = section.quizzes || [];
  const usedQuizSlugs = new Set();
  const byLessonId = new Map();

  (section.lessons || []).forEach((lesson) => {
    const lessonTitle = normalizeCourseItemTitle(lesson.title);
    const matched = quizzes.filter((quiz) => {
      if (usedQuizSlugs.has(quiz.slug)) return false;
      const quizTitle = normalizeCourseItemTitle(quiz.title);
      return lessonTitle && quizTitle && quizTitle === lessonTitle;
    });
    matched.forEach((quiz) => usedQuizSlugs.add(quiz.slug));
    byLessonId.set(lesson.id, matched);
  });

  return {
    byLessonId,
    remainingQuizzes: quizzes.filter((quiz) => !usedQuizSlugs.has(quiz.slug))
  };
}

function CourseQuizActions({ quizzes, openQuiz, inline = false }) {
  if (!quizzes?.length) return null;
  return (
    <div className={cx('course-actions', inline && 'inline-course-actions')}>
      {quizzes.map((quiz) => (
        <button className="secondary" key={quiz.slug} onClick={() => openQuiz(quiz.slug)}>
          {quiz.title} · {quiz.bestScore}/{quiz.maxScore}
        </button>
      ))}
    </div>
  );
}

function QuizStatusBadge({ quiz }) {
  if (!quiz) return null;
  const passed = quiz.passed || Number(quiz.bestScore || 0) >= Number(quiz.passScore || quiz.maxScore || 1);
  const attempted = Number(quiz.bestScore || 0) > 0;
  return (
    <span className={cx('quiz-status-badge', passed ? 'passed' : attempted ? 'attempted' : 'pending')}>
      {passed ? 'Тест пройден' : attempted ? 'Есть попытка' : 'Тест не пройден'}
    </span>
  );
}

function ImageLightbox({ image, onClose }) {
  const [zoom, setZoom] = useState(1);
  const zoomIn = () => setZoom((value) => Math.min(3, Number((value + 0.25).toFixed(2))));
  const zoomOut = () => setZoom((value) => Math.max(1, Number((value - 0.25).toFixed(2))));

  useEffect(() => {
    if (!image) return undefined;
    setZoom(1);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
      if (event.key === '+' || event.key === '=') zoomIn();
      if (event.key === '-') zoomOut();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [image, onClose]);

  if (!image) return null;

  return (
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={image.label}>
      <div className="image-viewer-toolbar">
        <div className="image-viewer-actions">
          <button type="button" onClick={zoomOut} disabled={zoom <= 1} aria-label="Уменьшить"><Minus size={18} /></button>
          <button type="button" onClick={zoomIn} disabled={zoom >= 3} aria-label="Увеличить"><Plus size={18} /></button>
          <button type="button" onClick={() => setZoom(1)} aria-label="Сбросить масштаб"><RotateCcw size={18} /></button>
          <button type="button" onClick={onClose} aria-label="Закрыть"><X size={20} /></button>
        </div>
      </div>
      <div className="image-viewer-stage" style={{ '--media-fill': `url(${encodeURI(image.url)})` }}>
        <img src={encodeURI(image.url)} alt={image.label} style={{ transform: `scale(${zoom})` }} />
      </div>
    </div>
  );
}

function formatName(user) {
  if (!user) return '';
  return [user.firstName || user.first_name, user.lastName || user.last_name].filter(Boolean).join(' ') || user.username || 'Пользователь';
}

function Avatar({ user, size = 'md' }) {
  const photo = user?.photoUrl || user?.photo_url;
  const [imageFailed, setImageFailed] = useState(false);
  const letter = (formatName(user).trim().slice(0, 1) || 'A').toUpperCase();

  useEffect(() => {
    setImageFailed(false);
  }, [photo]);

  return (
    <div className={cx('avatar', size === 'lg' && 'avatar-lg')}>
      {photo && !imageFailed ? (
        <img src={photo} alt="" onError={() => setImageFailed(true)} />
      ) : (
        <span className="avatar-fallback">{letter}</span>
      )}
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
        <div className="surreal-mark" aria-hidden="true"><span /><span /><span /></div>
        <div>
          <p className="eyebrow">Твоя траектория</p>
          <h2>{data.user.titleText}</h2>
          <p>Курс, тесты, задания, рейтинг и профиль собраны в одном mini app.</p>
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
      <TopList users={data.leaderboard} title="Топ-5" />
    </main>
  );
}

function TopList({ users, title, variant = 'compact' }) {
  const isLeaderboard = variant === 'leaderboard';
  return (
    <section className="list-section">
      <h2>{title}</h2>
      <div className={cx('list', isLeaderboard && 'leaderboard-list')}>
        {users.map((user, index) => (
          <div
            className={cx(
              'row',
              isLeaderboard && 'leaderboard-row',
              isLeaderboard && index === 0 && 'leaderboard-top1',
              isLeaderboard && index > 0 && index < 5 && 'leaderboard-top5',
              isLeaderboard && index >= 5 && index < 10 && 'leaderboard-top10'
            )}
            key={user.id}
          >
            <span className={cx('rank', isLeaderboard && 'leaderboard-rank')}>{index + 1}</span>
            <Avatar user={user} />
            <div className="row-main">
              <strong>{formatName(user)}</strong>
              <span>{user.title_text}</span>
            </div>
            <b>{user.title_score}</b>
            {isLeaderboard && index < 10 && (
              <small className="leaderboard-tier">
                {index === 0 ? 'Топ 1' : index < 5 ? 'Топ 5' : 'Топ 10'}
              </small>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ProfilePage({ me, setPage }) {
  const completed = me.progress.filter((item) => item.status === 'completed').length;
  const groupedProgress = useMemo(() => me.progress.reduce((acc, item) => {
    const slug = item.course_slug || 'stazher-trail';
    acc[slug] ||= {
      slug,
      title: item.course_title || 'Стажерская тропа',
      difficulty: item.course_difficulty || 'начальный',
      items: []
    };
    acc[slug].items.push(item);
    return acc;
  }, {}), [me.progress]);

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
                <span>{attempt.source === 'course' ? 'Курс' : attempt.category} · {attempt.difficulty}</span>
              </div>
              <b>{attempt.score}/{attempt.max_score}</b>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

function CoursesPage({ courses, selectedCourse, activeSectionSlug, setActiveSectionSlug, openCourse, completeSection, openQuiz, setPage }) {
  const activeSection = selectedCourse?.sections.find((section) => section.slug === activeSectionSlug);

  if (selectedCourse && activeSection) {
    return (
      <CourseSectionPage
        course={selectedCourse.course}
        section={activeSection}
        setActiveSectionSlug={setActiveSectionSlug}
        completeSection={completeSection}
        openQuiz={openQuiz}
        setPage={setPage}
      />
    );
  }

  return (
    <main className="page">
      <PageHeader eyebrow="Курсы" title="Обучение">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      <section className="course-list">
        {courses.map((course) => (
          <button className={cx('course-card', selectedCourse?.course.slug === course.slug && 'selected')} key={course.slug} onClick={() => openCourse(course.slug)}>
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
        <>
          <section className="hero-panel compact">
            <Medal size={30} />
            <div>
              <h2>{selectedCourse.completed ? 'Курс пройден' : 'Этапы курса'}</h2>
              <p>{selectedCourse.completed ? 'Можно повторять любой раздел и освежать знания без блокировок.' : 'Открывай этапы по порядку: следующий появляется после проверки текущего.'}</p>
            </div>
          </section>
          <section className="section-grid">
            {selectedCourse.sections.map((section) => (
              <button
                key={section.slug}
                className={cx('section-tile', section.user_status === 'locked' && 'locked')}
                disabled={!section.isAccessible}
                onClick={() => setActiveSectionSlug(section.slug)}
              >
                <strong>{section.title}</strong>
                <span>{statusLabel(section.user_status)}</span>
              </button>
            ))}
          </section>
        </>
      )}
    </main>
  );
}

function CourseSectionPage({ course, section, setActiveSectionSlug, completeSection, openQuiz, setPage }) {
  const { byLessonId, remainingQuizzes } = useMemo(() => splitQuizzesByLesson(section), [section]);
  const isSpacesSection = section.slug === 'spaces';

  return (
    <main className="page">
      <PageHeader eyebrow={course.title} title={section.title}>
        <div className="header-actions">
          <button type="button" className="ghost compact-button" onClick={() => setActiveSectionSlug(null)}>
            <BookOpen size={17} />
            К курсу
          </button>
          <BackHomeButton setPage={setPage} />
        </div>
      </PageHeader>
      <section className="list-section">
        <RichText text={section.description} className="muted" />
        <div className="lesson-stack">
          {section.lessons?.map((lesson) => {
            const quizzes = byLessonId.get(lesson.id) || [];
            if (isSpacesSection && quizzes.length) {
              return <SpaceLessonCard key={lesson.id} lesson={lesson} quizzes={quizzes} openQuiz={openQuiz} />;
            }
            return (
              <article className="lesson-card" key={lesson.id}>
                <h3>{lesson.title}</h3>
                <LessonContent lesson={lesson} />
                <CourseQuizActions quizzes={quizzes} openQuiz={openQuiz} inline />
              </article>
            );
          })}
        </div>
        <CourseQuizActions quizzes={remainingQuizzes} openQuiz={openQuiz} />
        {!section.quizzes?.length && section.user_status !== 'completed' && (
          <div className="course-actions">
            <button className="primary" onClick={() => completeSection(section.slug)}>Завершить этап</button>
          </div>
        )}
      </section>
    </main>
  );
}

function SpaceLessonCard({ lesson, quizzes, openQuiz }) {
  const quiz = quizzes[0];
  return (
    <details className="lesson-card lesson-accordion">
      <summary>
        <div>
          <h3>{lesson.title}</h3>
          <span>{quiz?.title?.replace(': контрольный тест', '') || 'Пространство'}</span>
        </div>
        <QuizStatusBadge quiz={quiz} />
      </summary>
      <div className="lesson-accordion-body">
        <LessonContent lesson={lesson} inlineMedia />
        <CourseQuizActions quizzes={quizzes} openQuiz={openQuiz} inline />
      </div>
    </details>
  );
}

function TestsPage({ quizzes, openQuiz, openContentPage, setPage }) {
  const grouped = useMemo(() => quizzes.reduce((acc, quiz) => {
    acc[quiz.category] ||= [];
    acc[quiz.category].push(quiz);
    return acc;
  }, {}), [quizzes]);

  return (
    <main className="page">
      <PageHeader eyebrow="Проверка знаний" title="Тесты">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      {Object.entries(grouped).map(([category, items]) => (
        <section className="list-section" key={category}>
          <div className="section-title-row">
            <h2>{category}</h2>
            {category.toLowerCase().includes('алкоголь') && (
              <button className="ghost compact-button" onClick={() => openContentPage('alcohol-history')}>
                <BookOpen size={17} />
                История
              </button>
            )}
          </div>
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
  const [currentIndex, setCurrentIndex] = useState(0);
  const [result, setResult] = useState(null);
  const currentQuestion = quizState.questions[currentIndex];
  const currentAnswer = currentQuestion ? answers[currentQuestion.id] : null;
  const isLast = currentIndex === quizState.questions.length - 1;

  useEffect(() => {
    setAnswers({});
    setCurrentIndex(0);
    setResult(null);
  }, [quizState.quiz.slug]);

  async function finish() {
    const payload = await submitQuiz(quizState.quiz.slug, answers);
    setResult(payload.attempt);
  }

  return (
    <main className="page">
      <PageHeader eyebrow={quizState.quiz.category} title={quizState.quiz.title}>
        <button className="icon-button" onClick={close}>×</button>
      </PageHeader>
      {result ? (
        <section className="result-panel">
          <Medal size={28} />
          <div>
            <h2>{result.score}/{result.max_score}</h2>
            <p>{result.passed ? 'Тест пройден.' : 'Можно пройти еще раз.'}</p>
            <button className="primary" onClick={close}>Закрыть результат</button>
          </div>
        </section>
      ) : (
        <>
          <section className="question">
            <span>Вопрос {currentIndex + 1}/{quizState.questions.length}</span>
            <h2>{currentQuestion.text}</h2>
            <MediaGrid media={[currentQuestion.media_url || currentQuestion.mediaUrl].filter(Boolean)} className="question-media" />
            <div className="options">
              {currentQuestion.options.map((option) => (
                <button
                  key={option.id}
                  className={currentAnswer === option.id ? 'selected' : ''}
                  onClick={() => setAnswers((current) => ({ ...current, [currentQuestion.id]: option.id }))}
                >
                  {option.text}
                </button>
              ))}
            </div>
          </section>
          <div className="sticky-action">
            {!isLast && <button className="primary" disabled={!currentAnswer} onClick={() => setCurrentIndex((index) => index + 1)}>Следующий вопрос</button>}
            {isLast && <button className="primary" disabled={!currentAnswer} onClick={finish}>Завершить тест</button>}
          </div>
        </>
      )}
    </main>
  );
}

function ContentPage({ contentPage, close }) {
  return (
    <main className="page">
      <PageHeader eyebrow="Материал" title={contentPage.title}>
        <button className="icon-button" onClick={close}>×</button>
      </PageHeader>
      <section className="lesson-stack">
        {contentPage.body.map((block, index) => (
          <article className="lesson-card" key={index}>
            <RichText text={block.text} />
            <MediaGrid media={block.media} />
          </article>
        ))}
      </section>
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
      <TopList users={leaderboard.top} title="Топ-25" variant="leaderboard" />
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
        setFilters(await loadMenuFilters());
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
          <RichText text={activeTask.description} className="task-description" />
          {activeTask.requires_menu && (
            <div className="field-grid">
              <label>Тип мероприятия
                <select name="typeEvent" value={form.typeEvent || ''} required onChange={(event) => {
                  setForm({ ...form, typeEvent: event.target.value, dishName: '' });
                  setMenu([]);
                }}>
                  <option value="">Выбери тип мероприятия</option>
                  {filters.eventTypes.map((type) => <option key={type} value={type}>{type}</option>)}
                </select>
              </label>
              <label>Тип блюда
                <select name="classDish" value={form.classDish || ''} required onChange={(event) => {
                  setForm({ ...form, classDish: event.target.value, dishName: '' });
                  setMenu([]);
                }}>
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
                  <select name="dishName" required value={form.dishName || ''} onChange={(event) => setForm({ ...form, dishName: event.target.value })}>
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

function AdminPage({ admin, reviewSubmission, reload, setPage, selectedSubmissionId, saveTask, deleteTask, saveQuiz, deleteQuiz, loadAdminQuiz }) {
  const [reward, setReward] = useState({});
  const [taskDraft, setTaskDraft] = useState({ title: '', description: '', taskNum: 1, requiresMenu: false, active: true, orderIndex: 100 });
  const [taskEditId, setTaskEditId] = useState(null);
  const [quizDraft, setQuizDraft] = useState(defaultQuizDraft());
  const [quizEditId, setQuizEditId] = useState(null);
  const selectedId = Number(selectedSubmissionId || 0);

  function editTask(task) {
    setTaskEditId(task.id);
    setTaskDraft({
      title: task.title,
      description: task.description,
      taskNum: task.task_num,
      requiresMenu: task.requires_menu,
      active: task.active,
      orderIndex: task.order_index
    });
  }

  async function editQuiz(quiz) {
    const full = await loadAdminQuiz(quiz.id);
    setQuizEditId(full.id);
    setQuizDraft({
      title: full.title,
      category: full.category,
      source: full.source,
      difficulty: full.difficulty,
      weight: full.weight,
      rewardPoints: full.reward_points,
      passScore: full.pass_score,
      description: full.description,
      sectionSlug: admin.sectionSlugs.includes(full.section_slug) ? full.section_slug : '',
      courseRequired: full.course_required,
      orderIndex: full.order_index,
      questionsText: JSON.stringify(full.questions.map((question) => ({
        text: question.text,
        options: question.options.map((option) => ({ text: option.text, isCorrect: option.isCorrect }))
      })), null, 2)
    });
  }

  async function submitTaskForm(event) {
    event.preventDefault();
    await saveTask(taskEditId, taskDraft);
    setTaskEditId(null);
    setTaskDraft({ title: '', description: '', taskNum: 1, requiresMenu: false, active: true, orderIndex: 100 });
  }

  async function submitQuizForm(event) {
    event.preventDefault();
    const questions = JSON.parse(quizDraft.questionsText);
    await saveQuiz(quizEditId, { ...quizDraft, questions });
    setQuizEditId(null);
    setQuizDraft(defaultQuizDraft());
  }

  return (
    <main className="page">
      <PageHeader eyebrow="Админка" title="Управление Академией">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      <details className="admin-panel" open>
        <summary><span>Заявки на проверку</span><ChevronDown size={18} /></summary>
        <div className="list">
          {admin.submissions.length === 0 && <p className="muted">Новых заявок нет.</p>}
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
                    {submission.uploads.map((upload) => <a key={upload.id} href={upload.url} target="_blank" rel="noreferrer">{upload.name}</a>)}
                  </div>
                )}
              </div>
              <input type="number" min="0" placeholder="Баллы" value={reward[submission.id] || ''} onChange={(event) => setReward({ ...reward, [submission.id]: event.target.value })} />
              <button onClick={async () => { await reviewSubmission(submission.id, 'approved', reward[submission.id] || 0); reload(); }}>Засчитать</button>
              <button className="secondary" onClick={async () => { await reviewSubmission(submission.id, 'rejected', 0); reload(); }}>Отклонить</button>
            </div>
          ))}
        </div>
      </details>
      <details className="admin-panel">
        <summary><span>Задания</span><ChevronDown size={18} /></summary>
        <form className="editor-form" onSubmit={submitTaskForm}>
          <div className="field-grid">
            <label>Номер<input type="number" value={taskDraft.taskNum} onChange={(event) => setTaskDraft({ ...taskDraft, taskNum: event.target.value })} /></label>
            <label>Порядок<input type="number" value={taskDraft.orderIndex} onChange={(event) => setTaskDraft({ ...taskDraft, orderIndex: event.target.value })} /></label>
          </div>
          <label>Название<input value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} required /></label>
          <label>Описание<textarea rows="7" value={taskDraft.description} onChange={(event) => setTaskDraft({ ...taskDraft, description: event.target.value })} /></label>
          <label className="check-line"><input type="checkbox" checked={taskDraft.requiresMenu} onChange={(event) => setTaskDraft({ ...taskDraft, requiresMenu: event.target.checked })} /> Использует меню NocoDB</label>
          <label className="check-line"><input type="checkbox" checked={taskDraft.active} onChange={(event) => setTaskDraft({ ...taskDraft, active: event.target.checked })} /> Активно</label>
          <button className="primary">{taskEditId ? 'Сохранить задание' : 'Добавить задание'}</button>
        </form>
        <div className="list">
          {admin.tasks.map((task) => (
            <div className="row" key={task.id}>
              <div className="row-main">
                <strong>{task.task_num}. {task.title}</strong>
                <span>{task.active ? 'активно' : 'скрыто'}</span>
              </div>
              <button className="ghost compact-button" onClick={() => editTask(task)}><Edit3 size={16} />Изменить</button>
              <button className="secondary compact-button" onClick={() => deleteTask(task.id)}><Trash2 size={16} />Удалить</button>
            </div>
          ))}
        </div>
      </details>
      <details className="admin-panel">
        <summary><span>Тесты</span><ChevronDown size={18} /></summary>
        <form className="editor-form" onSubmit={submitQuizForm}>
          <div className="field-grid">
            <label>Тип
              <select value={quizDraft.source} onChange={(event) => setQuizDraft({ ...quizDraft, source: event.target.value })}>
                <option value="tests">Раздел Тесты</option>
                <option value="course">Тест курса</option>
              </select>
            </label>
            <label>Сложность<input value={quizDraft.difficulty} onChange={(event) => setQuizDraft({ ...quizDraft, difficulty: event.target.value })} /></label>
          </div>
          <label>Название<input value={quizDraft.title} onChange={(event) => setQuizDraft({ ...quizDraft, title: event.target.value })} required /></label>
          <label>Категория<input value={quizDraft.category} onChange={(event) => setQuizDraft({ ...quizDraft, category: event.target.value })} required /></label>
          <div className="field-grid">
            <label>Вес<input type="number" value={quizDraft.weight} onChange={(event) => setQuizDraft({ ...quizDraft, weight: event.target.value })} /></label>
            <label>Проходной балл<input type="number" value={quizDraft.passScore} onChange={(event) => setQuizDraft({ ...quizDraft, passScore: event.target.value })} /></label>
            <label>Баллы курса<input type="number" value={quizDraft.rewardPoints} onChange={(event) => setQuizDraft({ ...quizDraft, rewardPoints: event.target.value })} /></label>
            <label>Раздел курса
              <select value={quizDraft.sectionSlug} onChange={(event) => setQuizDraft({ ...quizDraft, sectionSlug: event.target.value })}>
                <option value="">Не привязан</option>
                {admin.sectionSlugs.map((slug) => <option key={slug} value={slug}>{slug}</option>)}
              </select>
            </label>
          </div>
          <label>Описание<textarea rows="3" value={quizDraft.description} onChange={(event) => setQuizDraft({ ...quizDraft, description: event.target.value })} /></label>
          <label>Вопросы JSON<textarea className="textarea-code" rows="12" value={quizDraft.questionsText} onChange={(event) => setQuizDraft({ ...quizDraft, questionsText: event.target.value })} /></label>
          <label className="check-line"><input type="checkbox" checked={quizDraft.courseRequired} onChange={(event) => setQuizDraft({ ...quizDraft, courseRequired: event.target.checked })} /> Обязательный тест курса</label>
          <button className="primary">{quizEditId ? 'Сохранить тест' : 'Добавить тест / уровень'}</button>
        </form>
        <div className="list">
          {admin.quizzes.map((quiz) => (
            <div className="row" key={quiz.id}>
              <div className="row-main">
                <strong>{quiz.title}</strong>
                <span>{quiz.source === 'course' ? 'курс' : 'раздел Тесты'} · {quiz.category} · {quiz.difficulty}</span>
              </div>
              <button className="ghost compact-button" onClick={() => editQuiz(quiz)}><Edit3 size={16} />Изменить</button>
              <button className="secondary compact-button" onClick={() => deleteQuiz(quiz.id)}><Trash2 size={16} />Удалить</button>
            </div>
          ))}
        </div>
      </details>
      <details className="admin-panel">
        <summary><span>Пользователи</span><ChevronDown size={18} /></summary>
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
      </details>
    </main>
  );
}

function defaultQuizDraft() {
  return {
    title: '',
    category: '',
    source: 'tests',
    difficulty: 'easy',
    weight: 1,
    rewardPoints: 0,
    passScore: 1,
    description: '',
    sectionSlug: '',
    courseRequired: false,
    orderIndex: 100,
    questionsText: JSON.stringify([
      {
        text: 'Вопрос',
        options: [
          { text: 'Правильный ответ', isCorrect: true },
          { text: 'Неверный ответ', isCorrect: false },
          { text: 'Неверный ответ', isCorrect: false }
        ]
      }
    ], null, 2)
  };
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
  const [activeSectionSlug, setActiveSectionSlug] = useState(null);
  const [quizzes, setQuizzes] = useState([]);
  const [quizState, setQuizState] = useState(null);
  const [contentPage, setContentPage] = useState(null);
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
    const [users, submissions, taskRows, quizRows] = await Promise.all([
      apiFetch('/admin/users'),
      apiFetch('/admin/submissions'),
      apiFetch('/admin/tasks'),
      apiFetch('/admin/quizzes')
    ]);
    setAdmin({
      users: users.users,
      submissions: submissions.submissions,
      tasks: taskRows.tasks,
      quizzes: quizRows.quizzes,
      sectionSlugs: ['self-employment', 'spaces', 'terms', 'formats', 'serving', 'service', 'final']
    });
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

  async function loadCourse(slug, sectionSlug = null) {
    const payload = await apiFetch(`/courses/${slug}`);
    setSelectedCourse(payload);
    setActiveSectionSlug(sectionSlug);
    return payload;
  }

  async function openCourse(slug) {
    if (selectedCourse?.course.slug === slug) {
      setSelectedCourse(null);
      setActiveSectionSlug(null);
      return;
    }
    await loadCourse(slug);
  }

  async function completeSection(sectionSlug) {
    const payload = await apiFetch(`/courses/${selectedCourse.course.slug}/sections/${sectionSlug}/complete`, { method: 'POST' });
    setSelectedCourse(payload);
    setActiveSectionSlug(null);
    await loadAll();
  }

  async function openQuiz(slug) {
    setQuizState(await apiFetch(`/quizzes/${slug}`));
  }

  async function openContentPage(slug) {
    const payload = await apiFetch(`/content-pages/${slug}`);
    setContentPage(payload.page);
  }

  async function submitQuiz(slug, answers) {
    const result = await apiFetch(`/quizzes/${slug}/attempt`, {
      method: 'POST',
      body: JSON.stringify({ answers })
    });
    await loadAll();
    if (selectedCourse) await loadCourse(selectedCourse.course.slug, activeSectionSlug);
    return result;
  }

  async function loadMenu(typeEvent, classDish) {
    const params = new URLSearchParams({ typeEvent: typeEvent || '', classDish: classDish || '' });
    const result = await apiFetch(`/tasks/dish-photo/menu-options?${params.toString()}`);
    return result.dishes;
  }

  async function submitTask(slug, formData) {
    await apiFetch(`/tasks/${slug}/submissions`, { method: 'POST', body: formData, headers: {} });
    await loadAll();
  }

  async function reviewSubmission(id, status, rewardPoints) {
    await apiFetch(`/admin/submissions/${id}/review`, {
      method: 'POST',
      body: JSON.stringify({ status, rewardPoints: Number(rewardPoints || 0), adminComment: 'Проверено через AcademyLH' })
    });
  }

  async function saveTask(id, payload) {
    await apiFetch(id ? `/admin/tasks/${id}` : '/admin/tasks', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    await loadAdmin();
    await loadAll();
  }

  async function deleteTask(id) {
    await apiFetch(`/admin/tasks/${id}`, { method: 'DELETE' });
    await loadAdmin();
    await loadAll();
  }

  async function loadAdminQuiz(id) {
    const result = await apiFetch(`/admin/quizzes/${id}`);
    return result.quiz;
  }

  async function saveQuiz(id, payload) {
    await apiFetch(id ? `/admin/quizzes/${id}` : '/admin/quizzes', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    await loadAdmin();
    await loadAll();
  }

  async function deleteQuiz(id) {
    await apiFetch(`/admin/quizzes/${id}`, { method: 'DELETE' });
    await loadAdmin();
    await loadAll();
  }

  if (boot.loading) return <div className="splash"><LayoutDashboard size={34} /><span>AcademyLH</span></div>;
  if (boot.error) return <div className="splash error"><Lock size={34} /><span>{boot.error}</span></div>;
  if (quizState) return <QuizPage quizState={quizState} submitQuiz={submitQuiz} close={() => setQuizState(null)} />;
  if (contentPage) return <ContentPage contentPage={contentPage} close={() => setContentPage(null)} />;

  return (
    <div className="app-shell">
      {page === 'home' && <HomePage data={home} setPage={setPage} />}
      {page === 'profile' && <ProfilePage me={me} setPage={setPage} />}
      {page === 'courses' && <CoursesPage courses={courses} selectedCourse={selectedCourse} activeSectionSlug={activeSectionSlug} setActiveSectionSlug={setActiveSectionSlug} openCourse={openCourse} completeSection={completeSection} openQuiz={openQuiz} setPage={setPage} />}
      {page === 'tests' && <TestsPage quizzes={quizzes} openQuiz={openQuiz} openContentPage={openContentPage} setPage={setPage} />}
      {page === 'leaderboard' && <LeaderboardPage leaderboard={leaderboard} setPage={setPage} />}
      {page === 'tasks' && <TasksPage tasks={tasks} submitTask={submitTask} loadMenu={loadMenu} loadMenuFilters={() => apiFetch('/tasks/dish-photo/menu-filters')} setPage={setPage} />}
      {page === 'admin' && home.user.role === 'admin' && admin && <AdminPage admin={admin} reviewSubmission={reviewSubmission} reload={loadAdmin} setPage={setPage} selectedSubmissionId={selectedSubmissionId} saveTask={saveTask} deleteTask={deleteTask} saveQuiz={saveQuiz} deleteQuiz={deleteQuiz} loadAdminQuiz={loadAdminQuiz} />}
      {page === 'admin' && home.user.role !== 'admin' && (
        <main className="page">
          <PageHeader eyebrow="Доступ" title="Админка закрыта"><BackHomeButton setPage={setPage} /></PageHeader>
          <section className="list-section"><p className="muted">Этот раздел доступен только администраторам.</p></section>
        </main>
      )}
    </div>
  );
}
