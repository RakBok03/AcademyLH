import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Award,
  BarChart3,
  BookOpen,
  Bold,
  Check,
  CheckCircle2,
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

function getUrlParam(name) {
  const hash = window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash;
  const hashParams = new URLSearchParams(hash);
  const searchParams = new URLSearchParams(window.location.search);
  return hashParams.get(name) || searchParams.get(name) || '';
}

function getTelegramStartParam() {
  const tg = window.Telegram?.WebApp;
  return tg?.initDataUnsafe?.start_param
    || new URLSearchParams(tg?.initData || '').get('start_param')
    || getUrlParam('tgWebAppStartParam')
    || getUrlParam('startapp')
    || '';
}

function getInitialRoute() {
  const startParam = getTelegramStartParam();
  const reviewMatch = String(startParam).match(/^review_(\d+)$/);
  if (reviewMatch) return { page: 'admin', submissionId: reviewMatch[1] };

  const requestedPage = getUrlParam('page');
  return {
    page: allowedPages.has(requestedPage) ? requestedPage : 'home',
    submissionId: getUrlParam('submissionId')
  };
}
const puzzleBotMediaBase = 'https://pbt.storage.yandexcloud.net/';
const imageExtensionPattern = /\.(avif|gif|jpe?g|jfif|png|webp)$/i;
const urlPattern = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/gi;

function statusLabel(status) {
  return statusLabels[status] || status;
}

const difficultyLabels = {
  easy: 'легкий',
  middle: 'средний',
  medium: 'средний',
  hard: 'сложный',
  course: 'курс'
};

function formatDifficulty(value) {
  return difficultyLabels[value] || value || 'без уровня';
}

const difficultyOrder = {
  easy: 1,
  middle: 2,
  medium: 2,
  hard: 3
};

function difficultyRank(value) {
  return difficultyOrder[String(value || '').toLowerCase()] || 99;
}

function sortQuizzesByDifficulty(quizzes = []) {
  return [...quizzes].sort((a, b) => (
    difficultyRank(a.difficulty) - difficultyRank(b.difficulty)
    || Number(a.order_index || a.orderIndex || 0) - Number(b.order_index || b.orderIndex || 0)
    || String(a.title || '').localeCompare(String(b.title || ''), 'ru')
  ));
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

function formatTestLabel(value) {
  const number = Math.abs(Number(value) || 0);
  const mod100 = number % 100;
  const mod10 = number % 10;
  if (mod100 >= 11 && mod100 <= 14) return 'тестов';
  if (mod10 === 1) return 'тест';
  if (mod10 >= 2 && mod10 <= 4) return 'теста';
  return 'тестов';
}

function formatTestCount(value) {
  return `${value} ${formatTestLabel(value)}`;
}

function isQuizFullyPassed(quiz) {
  const bestScore = Number(quiz?.best_score || quiz?.bestScore || 0);
  const maxScore = Number(quiz?.max_score || quiz?.maxScore || 0);
  return maxScore > 0 && bestScore >= maxScore;
}

function attemptCategoryLabel(attempt) {
  return attempt.source === 'course' ? 'Стажерская тропа' : attempt.category;
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

const richTextAllowedTags = new Set(['strong', 'b', 'em', 'i', 'u', 'br', 'span']);
const richTextAllowedClasses = new Set(['rt-large', 'rt-small']);

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeRichText(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (typeof window === 'undefined' || !window.DOMParser) return escapeHtml(raw);

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${raw}</div>`, 'text/html');
  const rootNode = doc.body.firstElementChild;
  const output = doc.createElement('div');

  function cleanNode(node) {
    if (node.nodeType === window.Node.TEXT_NODE) return doc.createTextNode(node.textContent || '');
    if (node.nodeType !== window.Node.ELEMENT_NODE) return doc.createTextNode('');

    const tag = node.tagName.toLowerCase();
    if (!richTextAllowedTags.has(tag)) {
      const fragment = doc.createDocumentFragment();
      node.childNodes.forEach((child) => fragment.appendChild(cleanNode(child)));
      return fragment;
    }

    const normalizedTag = tag === 'b' ? 'strong' : tag === 'i' ? 'em' : tag;
    const element = doc.createElement(normalizedTag);
    if (normalizedTag === 'span') {
      const classes = Array.from(node.classList).filter((className) => richTextAllowedClasses.has(className));
      if (classes.length) element.className = classes.join(' ');
    }
    node.childNodes.forEach((child) => element.appendChild(cleanNode(child)));
    return element;
  }

  rootNode.childNodes.forEach((child) => output.appendChild(cleanNode(child)));
  return output.innerHTML;
}

function linkifyRichTextHtml(html) {
  return html.replace(urlPattern, (rawUrl) => {
    const { url, tail } = trimUrlTail(rawUrl);
    const href = escapeHtml(url.startsWith('http') ? url : `https://${url}`);
    return `<a href="${href}" target="_blank" rel="noreferrer">клик</a>${tail}`;
  });
}

function RichText({ text, className, as = 'p' }) {
  if (!text) return null;
  const Tag = as;
  return <Tag className={cx('rich-text', className)} dangerouslySetInnerHTML={{ __html: linkifyRichTextHtml(sanitizeRichText(text)) }} />;
}

function normalizeEditorHtml(html) {
  if (!html) return '';
  if (typeof window === 'undefined' || !window.DOMParser) return sanitizeRichText(html);

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div>${html}</div>`, 'text/html');
  const rootNode = doc.body.firstElementChild;

  rootNode.querySelectorAll('font').forEach((fontNode) => {
    const span = doc.createElement('span');
    const size = Number(fontNode.getAttribute('size') || 3);
    if (size >= 4) span.className = 'rt-large';
    if (size <= 2) span.className = 'rt-small';
    while (fontNode.firstChild) span.appendChild(fontNode.firstChild);
    fontNode.replaceWith(span);
  });

  rootNode.querySelectorAll('[style]').forEach((node) => {
    const fontSize = String(node.style.fontSize || '').toLowerCase();
    if (/large|x-large|larger|1[8-9]px|2[0-9]px/.test(fontSize)) node.classList.add('rt-large');
    if (/small|x-small|smaller|1[0-2]px/.test(fontSize)) node.classList.add('rt-small');
    node.removeAttribute('style');
  });

  rootNode.querySelectorAll('div, p').forEach((node) => {
    if (node === rootNode) return;
    if (node.previousSibling) node.parentNode.insertBefore(doc.createElement('br'), node);
    while (node.firstChild) node.parentNode.insertBefore(node.firstChild, node);
    node.remove();
  });

  const cleaned = sanitizeRichText(rootNode.innerHTML)
    .replace(/^(<br\s*\/?>\s*)+/gi, '')
    .replace(/(\s*<br\s*\/?>)+$/gi, '')
    .trim();
  return cleaned === '<br>' ? '' : cleaned;
}

function RichTextInput({ label, value, onChange, rows = 4, placeholder, required = false }) {
  const editorRef = useRef(null);
  const focusedRef = useRef(false);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || focusedRef.current) return;
    const nextHtml = sanitizeRichText(value);
    if (editor.innerHTML !== nextHtml) editor.innerHTML = nextHtml;
  }, [value]);

  function pushEditorValue() {
    const editor = editorRef.current;
    if (!editor) return;
    onChange(normalizeEditorHtml(editor.innerHTML));
  }

  function applyFormat(command, argument = null) {
    const editor = editorRef.current;
    editor?.focus();
    document.execCommand(command, false, argument);
    pushEditorValue();
  }

  function pastePlainText(event) {
    event.preventDefault();
    const text = event.clipboardData.getData('text/plain');
    document.execCommand('insertText', false, text);
    pushEditorValue();
  }

  return (
    <label>{label}
      <div className="rich-editor">
        <div className="rich-toolbar" aria-label="Форматирование текста">
          <button type="button" className="rich-tool" title="Жирный" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('bold')}>
            <Bold size={16} />
          </button>
          <button type="button" className="rich-tool" title="Крупнее" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('fontSize', '4')}>A+</button>
          <button type="button" className="rich-tool" title="Меньше" onMouseDown={(event) => event.preventDefault()} onClick={() => applyFormat('fontSize', '2')}>A-</button>
        </div>
        <div
          ref={editorRef}
          className="rich-editable rich-text"
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-multiline="true"
          aria-required={required}
          data-placeholder={placeholder || ''}
          style={{ minHeight: `${Math.max(rows, 3) * 24 + 22}px` }}
          onFocus={() => { focusedRef.current = true; }}
          onBlur={() => { focusedRef.current = false; pushEditorValue(); }}
          onInput={pushEditorValue}
          onPaste={pastePlainText}
        />
      </div>
    </label>
  );
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
  const contentBlocks = parseLessonContentBlocks(lesson.body);
  if (contentBlocks) {
    return <LessonBlockContent blocks={contentBlocks} />;
  }

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

function LessonBlockContent({ blocks }) {
  return (
    <div className="lesson-block-flow">
      {blocks.map((block, index) => (
        <div className="lesson-content-block" key={index}>
          <RichText text={block.text} />
          <MediaGrid media={block.media} />
        </div>
      ))}
    </div>
  );
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
  const quizzes = sortQuizzesByDifficulty(section.quizzes || []);
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
  const sortedQuizzes = sortQuizzesByDifficulty(quizzes);
  return (
    <div className={cx('course-actions', inline && 'inline-course-actions')}>
      {sortedQuizzes.map((quiz) => (
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
        <img src={photo} alt="" loading="lazy" decoding="async" onError={() => setImageFailed(true)} />
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

function BackHomeButton({ setPage, className = '' }) {
  return (
    <button type="button" className={cx('ghost compact-button', className)} onClick={() => setPage('home')}>
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

function HomePage({ data, setPage, adminMode, setAdminMode }) {
  return (
    <main className="page">
      <PageHeader eyebrow="LOFT HALL" title="Академия">
        <div className="header-actions">
          {data.user.role === 'admin' && (
            <button type="button" className={cx('mode-toggle', adminMode && 'active')} onClick={() => setAdminMode(!adminMode)}>
              <Settings size={17} />
              {adminMode ? 'Админ' : 'Ученик'}
            </button>
          )}
          <button type="button" className="avatar-button" onClick={() => setPage('profile')} aria-label="Открыть профиль">
            <Avatar user={data.user} />
          </button>
        </div>
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
          <span>{formatPointsLabel(data.user.titleScore)}</span>
        </div>
      </section>
      <section className="quick-grid">
        <button onClick={() => setPage('profile')}><User size={20} />Профиль</button>
        <button onClick={() => setPage('courses')}><BookOpen size={20} />Курсы</button>
        <button onClick={() => setPage('tests')}><ClipboardList size={20} />Тесты</button>
        <button onClick={() => setPage('leaderboard')}><Trophy size={20} />Рейтинг</button>
        <button onClick={() => setPage('tasks')}><Send size={20} />Задания</button>
        {data.user.role === 'admin' && adminMode && <button onClick={() => setPage('admin')}><Settings size={20} />Админка</button>}
      </section>
      <TopList users={data.leaderboard} title="Топ-5" />
    </main>
  );
}

function TopList({ users, title, variant = 'compact', children }) {
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
              isLeaderboard && index >= 5 && index < 10 && 'leaderboard-top10',
              isLeaderboard && index < 10 && 'leaderboard-has-tier'
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
      {children}
    </section>
  );
}

function ProfilePage({ me, setPage, openCourseSection, openAttempt }) {
  const [visibleAttempts, setVisibleAttempts] = useState(5);
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
  const visibleHistory = me.attempts.slice(0, visibleAttempts);

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
        <Stat label="Баллы" value={me.user.titleScore} icon={Sparkles} />
        <Stat label="Прогресс" value={`${completed}/${me.progress.length}`} icon={BarChart3} />
      </section>
      <section className="list-section">
        <h2>Прогресс курса</h2>
        {Object.values(groupedProgress).map((course) => {
          const courseCompleted = course.items.filter((item) => item.status === 'completed').length;
          return (
            <details className="course-progress" key={course.slug}>
              <summary>
                <div>
                  <strong>{course.title}</strong>
                  <span>{course.difficulty}</span>
                </div>
                <b>{courseCompleted}/{course.items.length}</b>
              </summary>
              <div className="progress-lines">
                {course.items.map((item) => (
                  <button
                    type="button"
                    className={cx('progress-line-button', item.status === 'locked' && 'locked')}
                    key={item.slug}
                    onClick={() => openCourseSection(course.slug, item.slug)}
                  >
                    <span>{item.title}</span>
                    <b>{statusLabel(item.status)}</b>
                  </button>
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
          {visibleHistory.map((attempt) => (
            <button className="row row-button" key={attempt.id} onClick={() => openAttempt(attempt.id)}>
              <Check size={18} />
              <div className="row-main">
                <strong>{attempt.title}</strong>
                <span>{attemptCategoryLabel(attempt)} · {formatDifficulty(attempt.difficulty)}</span>
              </div>
              <b>{attempt.score}/{attempt.max_score}</b>
            </button>
          ))}
        </div>
        {visibleAttempts < me.attempts.length && (
          <div className="course-actions">
            <button type="button" className="ghost compact-button" onClick={() => setVisibleAttempts((count) => count + 5)}>
              Показать еще
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function CoursesPage({
  courses,
  selectedCourse,
  activeSectionSlug,
  setActiveSectionSlug,
  openCourse,
  completeSection,
  openQuiz,
  setPage,
  adminMode,
  saveCourse,
  deleteCourse,
  toggleCourseVisibility
}) {
  const activeSection = selectedCourse?.sections.find((section) => section.slug === activeSectionSlug);
  const [courseEditorMode, setCourseEditorMode] = useState(null);

  useEffect(() => {
    if (!adminMode) setCourseEditorMode(null);
  }, [adminMode]);

  if (selectedCourse && activeSection) {
    return (
      <CourseSectionPage
        course={selectedCourse.course}
        sections={selectedCourse.sections}
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
      {adminMode && (
        <section className="course-admin-actions">
          <button type="button" className="primary compact-button" onClick={() => setCourseEditorMode('create')}><Plus size={17} />Создать курс</button>
          {selectedCourse && (
            <button type="button" className="ghost compact-button" onClick={() => setCourseEditorMode('edit')}><Edit3 size={17} />Редактировать выбранный</button>
          )}
        </section>
      )}
      <section className="course-list">
        {courses.map((course) => (
          <div className={cx('course-card', selectedCourse?.course.slug === course.slug && 'selected', course.is_visible === false && 'is-hidden')} key={course.slug}>
            <button type="button" className="course-card-main" onClick={() => openCourse(course.slug)}>
              <div>
                <span>{course.difficulty}</span>
                <h2>{course.title}</h2>
                <p>{course.description}</p>
              </div>
              <BookOpen size={24} />
            </button>
            {adminMode && (
              <div className="course-card-admin-controls">
                <VisibilityToggle
                  enabled={course.is_visible !== false}
                  onChange={(isVisible) => toggleCourseVisibility(course.id, isVisible)}
                />
                <button
                  type="button"
                  className="icon-button course-delete-button"
                  aria-label="Удалить курс"
                  title="Удалить курс"
                  onClick={() => {
                    if (confirm(`Удалить курс «${course.title}» вместе с разделами и курсовыми тестами?`)) {
                      deleteCourse(course.id);
                    }
                  }}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            )}
          </div>
        ))}
      </section>
      {adminMode && courseEditorMode && (
        <CourseAdminTools
          selectedCourse={courseEditorMode === 'edit' ? selectedCourse : null}
          saveCourse={async (id, payload) => {
            await saveCourse(id, payload);
            setCourseEditorMode(null);
          }}
          onClose={() => setCourseEditorMode(null)}
        />
      )}
      {selectedCourse && (
        <>
          <section className="hero-panel compact course-status-panel">
            <Medal size={24} />
            <div>
              <h2>{selectedCourse.completed ? 'Курс пройден' : 'Этапы курса'}</h2>
              <p>{selectedCourse.completed ? 'Разделы остаются доступны для повторения.' : 'Следующие этапы открываются после прохождения предыдущих.'}</p>
            </div>
          </section>
          <section className="section-grid">
            {selectedCourse.sections.map((section) => (
              <button
                key={section.slug}
                className={cx('section-tile', section.user_status === 'locked' && 'locked')}
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

function CourseAdminTools({ selectedCourse, saveCourse, onClose }) {
  const [draft, setDraft] = useState(defaultCourseDraft());
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    if (selectedCourse?.course) {
      setEditingId(selectedCourse.course.id);
      setDraft(courseToDraft(selectedCourse));
      return;
    }
    setEditingId(null);
    setDraft(defaultCourseDraft());
  }, [selectedCourse?.course?.id]);

  function updateSection(sectionIndex, patch) {
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section, index) => index === sectionIndex ? { ...section, ...patch } : section)
    }));
  }

  function updateLesson(sectionIndex, lessonIndex, patch) {
    setDraft((current) => ({
      ...current,
      sections: current.sections.map((section, index) => {
        if (index !== sectionIndex) return section;
        return {
          ...section,
          lessons: section.lessons.map((lesson, currentLessonIndex) => currentLessonIndex === lessonIndex ? { ...lesson, ...patch } : lesson)
        };
      })
    }));
  }

  function updateLessonBlock(sectionIndex, lessonIndex, blockIndex, patch) {
    updateLesson(sectionIndex, lessonIndex, {
      blocks: draft.sections[sectionIndex].lessons[lessonIndex].blocks.map((block, index) => index === blockIndex ? { ...block, ...patch } : block)
    });
  }

  async function submitCourse(event) {
    event.preventDefault();
    await saveCourse(editingId, courseDraftToPayload(draft));
  }

  return (
    <section className="admin-panel course-admin-builder">
      <div className="builder-panel-head">
        <div>
          <span className="eyebrow">{editingId ? 'Редактирование' : 'Новый курс'}</span>
          <h2>{editingId ? draft.title || 'Редактировать курс' : 'Создать курс'}</h2>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Закрыть">×</button>
      </div>
      <form className="editor-form" onSubmit={submitCourse}>
        <div className="field-grid">
          <label>Название курса<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required /></label>
          <label>Уровень сложности<input value={draft.difficulty} onChange={(event) => setDraft({ ...draft, difficulty: event.target.value })} /></label>
        </div>
        <VisibilityToggle enabled={draft.isVisible !== false} onChange={(isVisible) => setDraft({ ...draft, isVisible })} />
        <RichTextInput label="Описание курса" rows={3} value={draft.description} onChange={(description) => setDraft({ ...draft, description })} />
        <div className="builder-stack">
          {draft.sections.map((section, sectionIndex) => (
            <details className="builder-card builder-details" key={sectionIndex} open={sectionIndex === 0}>
              <summary className="builder-summary">
                <span><strong>Раздел {sectionIndex + 1}</strong><small>{section.title || 'Без названия'}</small></span>
                {draft.sections.length > 1 && <button type="button" className="ghost compact-button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setDraft((current) => ({ ...current, sections: current.sections.filter((_, index) => index !== sectionIndex) })); }}><Trash2 size={15} />Удалить</button>}
              </summary>
              <div className="builder-details-body">
                <label>Название раздела<input value={section.title} onChange={(event) => updateSection(sectionIndex, { title: event.target.value })} /></label>
                <RichTextInput label="Вводный текст раздела" rows={3} value={section.description} onChange={(description) => updateSection(sectionIndex, { description })} />
              <div className="builder-stack">
                {section.lessons.map((lesson, lessonIndex) => (
                  <details className="builder-card nested-builder-card builder-details" key={lessonIndex}>
                    <summary className="builder-summary">
                      <span><strong>Подраздел {lessonIndex + 1}</strong><small>{lesson.title || 'Без названия'}</small></span>
                      {section.lessons.length > 1 && <button type="button" className="ghost compact-button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); updateSection(sectionIndex, { lessons: section.lessons.filter((_, index) => index !== lessonIndex) }); }}><Trash2 size={15} />Удалить</button>}
                    </summary>
                    <div className="builder-details-body">
                      <label>Название<input value={lesson.title} onChange={(event) => updateLesson(sectionIndex, lessonIndex, { title: event.target.value })} /></label>
                      <p className="field-note">Медиа появляется ровно в том блоке, где оно загружено: сначала текст блока, затем его фото/файлы, потом следующий блок.</p>
                      <div className="builder-stack">
                        {lesson.blocks.map((block, blockIndex) => (
                          <div className="builder-card content-block-card" key={blockIndex}>
                            <div className="builder-card-head">
                              <strong>Блок материала {blockIndex + 1}</strong>
                              {lesson.blocks.length > 1 && <button type="button" className="ghost compact-button" onClick={() => updateLesson(sectionIndex, lessonIndex, { blocks: lesson.blocks.filter((_, index) => index !== blockIndex) })}><Trash2 size={15} />Удалить</button>}
                            </div>
                            <RichTextInput label="Текст блока" rows={5} value={block.text} onChange={(text) => updateLessonBlock(sectionIndex, lessonIndex, blockIndex, { text })} />
                            <MediaUploadField
                              label="Медиа этого блока"
                              value={block.mediaText}
                              multiple
                              onChange={(mediaText) => updateLessonBlock(sectionIndex, lessonIndex, blockIndex, { mediaText })}
                            />
                          </div>
                        ))}
                        <button type="button" className="ghost compact-button" onClick={() => updateLesson(sectionIndex, lessonIndex, { blocks: [...lesson.blocks, defaultContentBlock()] })}><Plus size={16} />Добавить блок материала</button>
                      </div>
                    </div>
                  </details>
                ))}
                <button type="button" className="ghost compact-button" onClick={() => updateSection(sectionIndex, { lessons: [...section.lessons, defaultCourseLesson()] })}><Plus size={16} />Добавить подраздел</button>
              </div>
              </div>
            </details>
          ))}
          <button type="button" className="ghost compact-button" onClick={() => setDraft((current) => ({ ...current, sections: [...current.sections, defaultCourseSection()] }))}><Plus size={16} />Добавить раздел</button>
        </div>
        <div className="admin-card-actions">
          <button className="primary">{editingId ? 'Сохранить курс' : 'Создать курс'}</button>
          <button type="button" className="ghost" onClick={onClose}>Отмена</button>
        </div>
      </form>
    </section>
  );
}

function CourseSectionPage({ course, sections, section, setActiveSectionSlug, completeSection, openQuiz, setPage }) {
  const { byLessonId, remainingQuizzes } = useMemo(() => splitQuizzesByLesson(section), [section]);
  const isSpacesSection = section.slug === 'spaces';
  const canReadSection = section.isAccessible || section.user_status !== 'locked';
  const nextSection = useMemo(() => {
    if (!sections?.length) return null;
    return sections.find((item) => Number(item.order_index) > Number(section.order_index)) || null;
  }, [sections, section.order_index]);

  return (
    <main className="page">
      <PageHeader eyebrow={course.title} title={section.title}>
        <div className="header-actions course-section-actions">
          <BackHomeButton setPage={setPage} className="sticky-home-button" />
          <button type="button" className="ghost compact-button" onClick={() => setActiveSectionSlug(null)}>
            <BookOpen size={17} />
            К курсу
          </button>
        </div>
      </PageHeader>
      {!canReadSection ? (
        <section className="locked-section-placeholder">
          <Lock size={28} />
          <div>
            <h2>{section.title}</h2>
            <RichText text={section.description || 'Раздел откроется после прохождения предыдущих этапов курса.'} className="muted" />
            <p>Этот материал идет по программе позже. Завершите предыдущие разделы по порядку, чтобы открыть доступ и не пропустить базу, на которой строится тема.</p>
          </div>
        </section>
      ) : (
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
          {section.isCompleted && nextSection && (
            <div className="course-next-actions">
              <button type="button" className="primary compact-button" onClick={() => setActiveSectionSlug(nextSection.slug)}>
                Следующий раздел
                <ArrowRight size={17} />
              </button>
            </div>
          )}
        </section>
      )}
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

function TestsPage({ quizzes, openQuiz, openContentPage, openSeriesDescription, setPage }) {
  const grouped = useMemo(() => {
    const next = quizzes.reduce((acc, quiz) => {
      acc[quiz.category] ||= [];
      acc[quiz.category].push(quiz);
      return acc;
    }, {});
    Object.keys(next).forEach((category) => {
      next[category] = sortQuizzesByDifficulty(next[category]);
    });
    return next;
  }, [quizzes]);

  return (
    <main className="page">
      <PageHeader eyebrow="Проверка знаний" title="Тесты">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      {Object.entries(grouped).map(([category, items]) => {
        const descriptionInfo = getSeriesDescriptionInfo(category, items);
        return (
          <section className="list-section" key={category}>
            <div className="section-title-row">
              <h2>{category}</h2>
              {descriptionInfo && (
                <button className="ghost compact-button" onClick={() => {
                  if (descriptionInfo.type === 'builder') openSeriesDescription(descriptionInfo.title, descriptionInfo.description);
                  else openContentPage(descriptionInfo.slug);
                }}>
                  <BookOpen size={17} />
                  {descriptionInfo.title}
                </button>
              )}
            </div>
            <div className="test-grid">
              {items.map((quiz) => {
                const passed = isQuizFullyPassed(quiz);
                return (
                  <button className={cx('test-card', passed && 'test-card-passed')} key={quiz.slug} onClick={() => openQuiz(quiz.slug)}>
                    {passed && <span className="test-passed-badge"><Check size={14} />Пройден</span>}
                    <span>{formatDifficulty(quiz.difficulty)}</span>
                    <strong>{quiz.title.replace(`${category}: `, '')}</strong>
                    <small>{quiz.max_score} вопросов · вес {quiz.weight}</small>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </main>
  );
}

function QuizPage({ quizState, submitQuiz, close }) {
  const [answers, setAnswers] = useState({});
  const [currentIndex, setCurrentIndex] = useState(0);
  const [result, setResult] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const currentQuestion = quizState.questions[currentIndex];
  const currentAnswer = currentQuestion ? answers[currentQuestion.id] : null;
  const selectedOption = currentQuestion?.options.find((option) => option.id === currentAnswer);
  const isLast = currentIndex === quizState.questions.length - 1;
  const wrongAnswer = feedback?.status === 'wrong';

  useEffect(() => {
    setAnswers({});
    setCurrentIndex(0);
    setResult(null);
    setFeedback(null);
  }, [quizState.quiz.slug]);

  async function finish(nextAnswers = answers) {
    const payload = await submitQuiz(quizState.quiz.slug, nextAnswers);
    setResult(payload.attempt);
  }

  function goNext() {
    setFeedback(null);
    setCurrentIndex((index) => index + 1);
  }

  async function handleAnswer() {
    if (!currentAnswer) return;
    if (wrongAnswer) {
      if (isLast) await finish();
      else goNext();
      return;
    }
    if (selectedOption?.isCorrect) {
      if (isLast) await finish();
      else goNext();
      return;
    }
    const correctAnswer = currentQuestion.options
      .filter((option) => option.isCorrect)
      .map((option) => option.text)
      .join(', ');
    setFeedback({
      status: 'wrong',
      text: currentQuestion.hint || 'Обратите внимание на формулировку вопроса и сравните свой вариант с правильным ответом ниже.',
      correctAnswer
    });
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
            <RichText as="h2" text={currentQuestion.text} />
            <MediaGrid media={[currentQuestion.media_url || currentQuestion.mediaUrl].filter(Boolean)} className="question-media" />
            <div className="options">
              {currentQuestion.options.map((option) => {
                const isSelected = currentAnswer === option.id;
                return (
                  <button
                    key={option.id}
                    className={cx(isSelected && 'selected', feedback && isSelected && (option.isCorrect ? 'correct' : 'wrong'))}
                    onClick={() => !feedback && setAnswers((current) => ({ ...current, [currentQuestion.id]: option.id }))}
                    disabled={Boolean(feedback)}
                  >
                    {option.text}
                  </button>
                );
              })}
            </div>
            {wrongAnswer && (
              <div className="hint-panel">
                <strong>Подсказка к вопросу</strong>
                <RichText text={feedback.text} />
                {feedback.correctAnswer && <p>Правильный ответ: <b>{feedback.correctAnswer}</b></p>}
              </div>
            )}
          </section>
          <div className="sticky-action">
            <button className={cx('primary', wrongAnswer && 'danger')} disabled={!currentAnswer} onClick={handleAnswer}>
              {wrongAnswer ? 'Следующий вопрос' : 'Ответить'}
            </button>
          </div>
        </>
      )}
    </main>
  );
}

function AttemptHistoryPage({ detail, close }) {
  return (
    <main className="page">
      <PageHeader eyebrow={attemptCategoryLabel(detail.attempt)} title={detail.attempt.title}>
        <button className="icon-button" onClick={close}>×</button>
      </PageHeader>
      <section className="result-panel attempt-summary">
        <ClipboardList size={28} />
        <div>
          <h2>{detail.attempt.score}/{detail.attempt.max_score}</h2>
          <p>{attemptCategoryLabel(detail.attempt)} · {formatDifficulty(detail.attempt.difficulty)}</p>
        </div>
      </section>
      <section className="attempt-question-list">
        {detail.questions.map((question, index) => (
          <article className="attempt-question-card" key={question.id}>
            <span>Вопрос {index + 1}</span>
            <RichText as="h2" text={question.text} />
            <div className="attempt-answer-block">
              <p>Ваш ответ: <strong>{question.selectedOptionText || 'не выбран'}</strong></p>
              {question.isCorrect ? (
                <b className="answer-result correct"><CheckCircle2 size={17} /> Правильно</b>
              ) : (
                <b className="answer-result wrong"><X size={17} /> Неправильно</b>
              )}
            </div>
          </article>
        ))}
      </section>
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
  const [topRows, setTopRows] = useState(leaderboard.top || []);
  const [hasMore, setHasMore] = useState(Boolean(leaderboard.hasMore));
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    setTopRows(leaderboard.top || []);
    setHasMore(Boolean(leaderboard.hasMore));
  }, [leaderboard]);

  async function showMore() {
    setLoadingMore(true);
    try {
      const next = await apiFetch(`/leaderboard?limit=10&offset=${topRows.length}`);
      setTopRows((current) => [...current, ...(next.top || [])]);
      setHasMore(Boolean(next.hasMore));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <main className="page">
      <PageHeader eyebrow="Рейтинг" title="Лидеры">
        <BackHomeButton setPage={setPage} />
      </PageHeader>
      <section className="hero-panel compact">
        <Trophy size={30} />
        <div>
          <h2>Твое место: {leaderboard.myRank}</h2>
          <p>{leaderboard.me.titleText} · {formatPoints(leaderboard.me.titleScore)}</p>
        </div>
      </section>
      <TopList users={topRows} title="Топ-25" variant="leaderboard">
        {hasMore && (
          <button className="secondary show-more" type="button" disabled={loadingMore} onClick={showMore}>
            {loadingMore ? 'Загружаем...' : 'Показать еще'}
          </button>
        )}
      </TopList>
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
              <RichText text={task.description} />
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
              <button type="button" className="secondary" disabled={!form.typeEvent || !form.classDish || menuState.loading} onClick={findDishes}>
                {menuState.loading ? 'Ищу...' : 'Показать блюда'}
              </button>
              {menuState.message && <p className="field-note">{menuState.message}</p>}
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

function MediaUploadField({ label, value, onChange, multiple = true }) {
  const [uploading, setUploading] = useState(false);
  const items = mediaTextToArray(value);

  async function uploadFiles(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));
    setUploading(true);
    try {
      const result = await apiFetch('/admin/uploads', {
        method: 'POST',
        body: formData,
        headers: {}
      });
      const uploaded = (result.files || []).map((file) => file.url).filter(Boolean);
      const nextItems = multiple ? [...items, ...uploaded] : uploaded.slice(0, 1);
      onChange(nextItems.join('\n'));
    } catch (error) {
      alert(error.message || 'Не удалось загрузить медиа.');
    } finally {
      setUploading(false);
      event.target.value = '';
    }
  }

  function removeItem(index) {
    onChange(items.filter((_, itemIndex) => itemIndex !== index).join('\n'));
  }

  return (
    <div className="media-upload-field">
      <span>{label}</span>
      <label className="media-picker">
        <input type="file" multiple={multiple} accept="image/*,video/*,application/pdf" onChange={uploadFiles} disabled={uploading} />
        <span>{uploading ? 'Загружаю...' : multiple ? 'Выбрать файлы' : 'Выбрать файл'}</span>
      </label>
      {items.length > 0 && (
        <div className="media-upload-list">
          {items.map((item, index) => (
            <div className="media-upload-item" key={`${item}-${index}`}>
              <a href={mediaUrl(item)} target="_blank" rel="noreferrer">{item.split('/').pop() || `Файл ${index + 1}`}</a>
              <button type="button" className="icon-button small" onClick={() => removeItem(index)}>×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function applySeriesDescription(draft, description) {
  const parsed = parseSeriesDescription(description);
  return {
    ...draft,
    hasDescription: parsed.structured,
    descriptionTitle: parsed.structured ? parsed.title : '',
    descriptionBlocks: parsed.structured ? parsed.blocks : [defaultDescriptionBlock()]
  };
}

function quizToDraft(full) {
  const difficulty = ['easy', 'middle', 'hard'].includes(full.difficulty) ? full.difficulty : 'another';
  const description = parseSeriesDescription(full.description);
  return {
    title: full.title || '',
    seriesMode: 'existing',
    series: full.category,
    newSeries: '',
    difficulty,
    customDifficulty: difficulty === 'another' ? full.difficulty : '',
    weight: full.weight,
    isVisible: full.is_visible !== false,
    hasDescription: description.structured,
    descriptionTitle: description.structured ? description.title : '',
    descriptionBlocks: description.structured ? description.blocks : [defaultDescriptionBlock()],
    questions: (full.questions.length ? full.questions : [defaultQuizQuestion()]).map((question) => ({
      text: question.text,
      hint: question.hint || '',
      mediaUrl: question.media_url || '',
      options: question.options.map((option) => ({ text: option.text, isCorrect: option.isCorrect }))
    }))
  };
}

function buildQuizPayloadFromDraft(draft) {
  const series = (draft.seriesMode === 'new' ? draft.newSeries : draft.series).trim();
  const difficulty = (draft.difficulty === 'another' ? draft.customDifficulty : draft.difficulty).trim();
  const title = draft.title.trim();
  if (!series || !difficulty || !title) {
    throw new Error('Заполните серию, название и сложность теста.');
  }
  const questions = draft.questions
    .map((question) => ({
      text: question.text.trim(),
      hint: question.hint?.trim() || '',
      mediaUrl: question.mediaUrl?.trim() || '',
      options: question.options
        .map((option) => ({ text: option.text.trim(), isCorrect: Boolean(option.isCorrect) }))
        .filter((option) => option.text)
    }))
    .filter((question) => question.text && question.options.length >= 2 && question.options.some((option) => option.isCorrect));
  if (!questions.length || questions.length !== draft.questions.length) {
    throw new Error('В каждом вопросе должен быть текст, минимум два варианта и один правильный ответ.');
  }
  return {
    title,
    category: series,
    difficulty,
    weight: Number(draft.weight || 1),
    isVisible: draft.isVisible !== false,
    description: draft.hasDescription ? serializeSeriesDescription(draft.descriptionTitle, draft.descriptionBlocks) : undefined,
    questions
  };
}

function defaultSeriesDraft() {
  return {
    name: '',
    isVisible: true,
    hasDescription: false,
    descriptionTitle: '',
    descriptionBlocks: [defaultDescriptionBlock()]
  };
}

function seriesDraftFromRow(row) {
  const description = parseSeriesDescription(row.description || '');
  return {
    name: row.name || '',
    isVisible: row.is_visible !== false,
    hasDescription: description.structured,
    descriptionTitle: description.structured ? description.title : '',
    descriptionBlocks: description.structured ? description.blocks : [defaultDescriptionBlock()]
  };
}

function buildSeriesPayload(draft) {
  const name = draft.name.trim();
  if (!name) throw new Error('Введите название серии.');
  return {
    name,
    isVisible: draft.isVisible !== false,
    description: draft.hasDescription ? serializeSeriesDescription(draft.descriptionTitle, draft.descriptionBlocks) : ''
  };
}

function VisibilityToggle({ enabled, onChange, className = '', label = 'Показывается', hiddenLabel = 'Скрыто' }) {
  const currentLabel = enabled ? label : hiddenLabel;
  return (
    <button
      type="button"
      className={cx('visibility-toggle', enabled ? 'is-visible' : 'is-hidden', className)}
      aria-pressed={enabled}
      aria-label={currentLabel}
      title={currentLabel}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onChange(!enabled);
      }}
    >
      {enabled ? <Check size={15} /> : <X size={15} />}
    </button>
  );
}

function SeriesEditorForm({ draft, setDraft, onSubmit, submitLabel, onCancel }) {
  return (
    <form className="editor-form" onSubmit={onSubmit}>
      <label>Название серии<input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} required /></label>
      <VisibilityToggle enabled={draft.isVisible !== false} onChange={(isVisible) => setDraft({ ...draft, isVisible })} />
      <label className="check-line"><input type="checkbox" checked={draft.hasDescription} onChange={(event) => setDraft({ ...draft, hasDescription: event.target.checked })} /> Добавить описание серии</label>
      {draft.hasDescription && (
        <details className="builder-card builder-details description-editor-details" open>
          <summary className="builder-summary"><span><strong>Описание серии</strong><small>Заголовок, текстовые блоки и медиа</small></span><ChevronDown size={18} /></summary>
          <div className="builder-details-body">
          <label>Название описания<input value={draft.descriptionTitle} placeholder="Например, История алкоголя" onChange={(event) => setDraft({ ...draft, descriptionTitle: event.target.value })} /></label>
          {draft.descriptionBlocks.map((block, index) => (
            <div className="builder-card" key={index}>
              <strong>Блок описания {index + 1}</strong>
              <RichTextInput label="Текст" rows={4} value={block.text} onChange={(text) => setDraft((current) => ({ ...current, descriptionBlocks: current.descriptionBlocks.map((item, itemIndex) => itemIndex === index ? { ...item, text } : item) }))} />
              <MediaUploadField
                label="Медиа блока"
                value={block.mediaText}
                multiple
                onChange={(mediaText) => setDraft((current) => ({ ...current, descriptionBlocks: current.descriptionBlocks.map((item, itemIndex) => itemIndex === index ? { ...item, mediaText } : item) }))}
              />
            </div>
          ))}
          <button type="button" className="ghost compact-button" onClick={() => setDraft((current) => ({ ...current, descriptionBlocks: [...current.descriptionBlocks, defaultDescriptionBlock()] }))}><Plus size={16} />Добавить блок описания</button>
          </div>
        </details>
      )}
      <div className="admin-card-actions">
        <button className="primary">{submitLabel}</button>
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>Отмена</button>}
      </div>
    </form>
  );
}

function QuizEditorForm({ draft, setDraft, quizSeries, seriesDescriptionMap, onSubmit, submitLabel, onCancel, formId = 'quiz', hideSeries = false, hideDescription = false }) {
  function updateQuestion(index, patch) {
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((question, questionIndex) => questionIndex === index ? { ...question, ...patch } : question)
    }));
  }

  function updateOption(questionIndex, optionIndex, patch) {
    setDraft((current) => ({
      ...current,
      questions: current.questions.map((question, currentQuestionIndex) => {
        if (currentQuestionIndex !== questionIndex) return question;
        return {
          ...question,
          options: question.options.map((option, currentOptionIndex) => currentOptionIndex === optionIndex ? { ...option, ...patch } : option)
        };
      })
    }));
  }

  function selectSeries(series) {
    setDraft((current) => applySeriesDescription({ ...current, series }, seriesDescriptionMap.get(series) || ''));
  }

  return (
    <form className="editor-form" onSubmit={onSubmit}>
      <label>Название теста<input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} required /></label>
      <VisibilityToggle enabled={draft.isVisible !== false} onChange={(isVisible) => setDraft({ ...draft, isVisible })} />
      <div className="field-grid">
        <label>Сложность
          <select value={draft.difficulty} onChange={(event) => setDraft({ ...draft, difficulty: event.target.value })}>
            <option value="easy">easy</option>
            <option value="middle">middle</option>
            <option value="hard">hard</option>
            <option value="another">другое</option>
          </select>
        </label>
        <label>Вес<input type="number" min="1" value={draft.weight} onChange={(event) => setDraft({ ...draft, weight: event.target.value })} /></label>
      </div>
      {draft.difficulty === 'another' && (
        <label>Своя сложность<input value={draft.customDifficulty} onChange={(event) => setDraft({ ...draft, customDifficulty: event.target.value })} required /></label>
      )}
      {!hideSeries && (
        <div className="field-grid">
          <label>Серия
            <select value={draft.seriesMode} onChange={(event) => setDraft({ ...draft, seriesMode: event.target.value })}>
              <option value="existing">Выбрать серию</option>
              <option value="new">Создать серию</option>
            </select>
          </label>
          {draft.seriesMode === 'existing' ? (
            <label>Название серии
              <select value={draft.series} onChange={(event) => selectSeries(event.target.value)}>
                <option value="">Выберите серию</option>
                {quizSeries.map((series) => <option key={series} value={series}>{series}</option>)}
              </select>
            </label>
          ) : (
            <label>Новая серия<input value={draft.newSeries} onChange={(event) => setDraft({ ...draft, newSeries: event.target.value })} required /></label>
          )}
        </div>
      )}
      {!hideDescription && (
        <>
          <label className="check-line"><input type="checkbox" checked={draft.hasDescription} onChange={(event) => setDraft({ ...draft, hasDescription: event.target.checked })} /> Добавить описание серии</label>
          <p className="field-note">Описание хранится у серии один раз. Изменения применяются ко всем тестам этой серии.</p>
          {draft.hasDescription && (
            <details className="builder-card builder-details description-editor-details" open>
              <summary className="builder-summary"><span><strong>Описание серии</strong><small>Заголовок, текстовые блоки и медиа</small></span><ChevronDown size={18} /></summary>
              <div className="builder-details-body">
              <label>Название описания<input value={draft.descriptionTitle} placeholder="Например, История алкоголя" onChange={(event) => setDraft({ ...draft, descriptionTitle: event.target.value })} /></label>
              {draft.descriptionBlocks.map((block, index) => (
                <div className="builder-card" key={index}>
                  <strong>Блок описания {index + 1}</strong>
                  <RichTextInput label="Текст" rows={4} value={block.text} onChange={(text) => setDraft((current) => ({ ...current, descriptionBlocks: current.descriptionBlocks.map((item, itemIndex) => itemIndex === index ? { ...item, text } : item) }))} />
                  <MediaUploadField
                    label="Медиа блока"
                    value={block.mediaText}
                    multiple
                    onChange={(mediaText) => setDraft((current) => ({ ...current, descriptionBlocks: current.descriptionBlocks.map((item, itemIndex) => itemIndex === index ? { ...item, mediaText } : item) }))}
                  />
                </div>
              ))}
              <button type="button" className="ghost compact-button" onClick={() => setDraft((current) => ({ ...current, descriptionBlocks: [...current.descriptionBlocks, defaultDescriptionBlock()] }))}><Plus size={16} />Добавить блок описания</button>
              </div>
            </details>
          )}
        </>
      )}
      <div className="builder-stack">
        {draft.questions.map((question, questionIndex) => (
          <details className="builder-card builder-details" key={questionIndex} open={questionIndex === 0}>
            <summary className="builder-summary">
              <span><strong>Вопрос {questionIndex + 1}</strong><small>{question.text || 'Без текста'}</small></span>
              {draft.questions.length > 1 && <button type="button" className="ghost compact-button" onClick={(event) => { event.preventDefault(); event.stopPropagation(); setDraft((current) => ({ ...current, questions: current.questions.filter((_, index) => index !== questionIndex) })); }}><Trash2 size={15} />Удалить</button>}
            </summary>
            <div className="builder-details-body">
              <RichTextInput label="Текст вопроса" rows={3} value={question.text} onChange={(text) => updateQuestion(questionIndex, { text })} />
              <RichTextInput label="Подсказка при ошибке" rows={2} value={question.hint || ''} placeholder="Коротко объясните, на что обратить внимание, если выбран неверный вариант." onChange={(hint) => updateQuestion(questionIndex, { hint })} />
              <MediaUploadField
                label="Фото или медиа к вопросу"
                value={question.mediaUrl}
                multiple={false}
                onChange={(mediaUrl) => updateQuestion(questionIndex, { mediaUrl })}
              />
              <div className="option-builder">
                {question.options.map((option, optionIndex) => (
                  <label className="option-line" key={optionIndex}>
                    <input type="radio" name={`${formId}-correct-${questionIndex}`} checked={option.isCorrect} onChange={() => updateQuestion(questionIndex, { options: question.options.map((item, index) => ({ ...item, isCorrect: index === optionIndex })) })} />
                    <input value={option.text} placeholder={`Вариант ${optionIndex + 1}`} onChange={(event) => updateOption(questionIndex, optionIndex, { text: event.target.value })} />
                    {question.options.length > 2 && <button type="button" className="icon-button small" onClick={() => updateQuestion(questionIndex, { options: question.options.filter((_, index) => index !== optionIndex) })}>×</button>}
                  </label>
                ))}
              </div>
              <button type="button" className="ghost compact-button" onClick={() => updateQuestion(questionIndex, { options: [...question.options, { text: '', isCorrect: false }] })}><Plus size={16} />Добавить вариант</button>
            </div>
          </details>
        ))}
        <button type="button" className="ghost compact-button" onClick={() => setDraft((current) => ({ ...current, questions: [...current.questions, defaultQuizQuestion()] }))}><Plus size={16} />Добавить вопрос</button>
      </div>
      <div className="admin-card-actions">
        <button className="primary">{submitLabel}</button>
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>Отмена</button>}
      </div>
    </form>
  );
}

function AdminPage({ admin, reviewSubmission, reload, setPage, selectedSubmissionId, saveTask, deleteTask, saveQuiz, deleteQuiz, loadAdminQuiz, saveQuizSeries, deleteQuizSeries, toggleQuizVisibility, toggleQuizSeriesVisibility }) {
  const [reward, setReward] = useState({});
  const [taskDraft, setTaskDraft] = useState({ title: '', description: '' });
  const [taskEditId, setTaskEditId] = useState(null);
  const [seriesCreateOpen, setSeriesCreateOpen] = useState(false);
  const [seriesCreateDraft, setSeriesCreateDraft] = useState(defaultSeriesDraft());
  const [seriesEditName, setSeriesEditName] = useState(null);
  const [seriesEditDraft, setSeriesEditDraft] = useState(defaultSeriesDraft());
  const [quizCreateSeries, setQuizCreateSeries] = useState(null);
  const [quizCreateDraft, setQuizCreateDraft] = useState(defaultQuizDraft());
  const [quizEditDraft, setQuizEditDraft] = useState(defaultQuizDraft());
  const [quizEditId, setQuizEditId] = useState(null);
  const [openSeries, setOpenSeries] = useState({});
  const selectedId = Number(selectedSubmissionId || 0);
  const quizSeriesRows = useMemo(() => {
    if (admin.series?.length) return admin.series;
    return [...new Set(admin.quizzes.map((quiz) => quiz.category).filter(Boolean))]
      .sort()
      .map((name) => ({ name, description: admin.quizzes.find((quiz) => quiz.category === name)?.description || '' }));
  }, [admin.series, admin.quizzes]);
  const quizSeries = useMemo(() => quizSeriesRows.map((series) => series.name).filter(Boolean), [quizSeriesRows]);
  const seriesDescriptionMap = useMemo(() => new Map(quizSeriesRows.map((series) => [series.name, series.description || ''])), [quizSeriesRows]);
  const quizzesBySeries = useMemo(() => admin.quizzes.reduce((acc, quiz) => {
    acc[quiz.category] ||= [];
    acc[quiz.category].push(quiz);
    return acc;
  }, {}), [admin.quizzes]);

  useEffect(() => {
    if (!selectedId) return;
    requestAnimationFrame(() => {
      document.querySelector(`[data-submission-id="${selectedId}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    });
  }, [selectedId, admin.submissions.length]);

  function editTask(task) {
    setTaskEditId(task.id);
    setTaskDraft({
      title: task.title,
      description: task.description
    });
  }

  function startSeriesEdit(series) {
    setOpenSeries((current) => ({ ...current, [series.name]: true }));
    setSeriesEditName(series.name);
    setSeriesEditDraft(seriesDraftFromRow(series));
    setSeriesCreateOpen(false);
    setQuizCreateSeries(null);
    setQuizEditId(null);
  }

  function startQuizCreate(seriesName) {
    setOpenSeries((current) => ({ ...current, [seriesName]: true }));
    setQuizCreateSeries(seriesName);
    setQuizCreateDraft({ ...defaultQuizDraft(), seriesMode: 'existing', series: seriesName });
    setSeriesCreateOpen(false);
    setSeriesEditName(null);
    setQuizEditId(null);
  }

  async function editQuiz(quiz) {
    const full = await loadAdminQuiz(quiz.id);
    setQuizEditId(full.id);
    setQuizEditDraft(quizToDraft(full));
    setOpenSeries((current) => ({ ...current, [full.category]: true }));
    setQuizCreateSeries(null);
    setSeriesEditName(null);
  }

  async function submitTaskForm(event) {
    event.preventDefault();
    await saveTask(taskEditId, taskDraft);
    setTaskEditId(null);
    setTaskDraft({ title: '', description: '' });
  }

  async function submitSeriesCreateForm(event) {
    event.preventDefault();
    try {
      await saveQuizSeries(null, buildSeriesPayload(seriesCreateDraft));
      setSeriesCreateDraft(defaultSeriesDraft());
      setSeriesCreateOpen(false);
    } catch (error) {
      alert(error.message);
    }
  }

  async function submitSeriesEditForm(event) {
    event.preventDefault();
    try {
      await saveQuizSeries(seriesEditName, buildSeriesPayload(seriesEditDraft));
      setSeriesEditName(null);
      setSeriesEditDraft(defaultSeriesDraft());
    } catch (error) {
      alert(error.message);
    }
  }

  async function submitQuizForm(event) {
    event.preventDefault();
    try {
      await saveQuiz(null, buildQuizPayloadFromDraft(quizCreateDraft));
      setQuizCreateDraft(defaultQuizDraft());
      setQuizCreateSeries(null);
    } catch (error) {
      alert(error.message);
    }
  }

  async function submitQuizEditForm(event) {
    event.preventDefault();
    try {
      await saveQuiz(quizEditId, buildQuizPayloadFromDraft(quizEditDraft));
      setQuizEditId(null);
      setQuizEditDraft(defaultQuizDraft());
    } catch (error) {
      alert(error.message);
    }
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
            <div className={cx('admin-item', selectedId === submission.id && 'selected-admin-item')} key={submission.id} data-submission-id={submission.id}>
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
        <details className="admin-subpanel">
          <summary><span>Добавить задание</span><Plus size={18} /></summary>
          <form className="editor-form" onSubmit={submitTaskForm}>
            <label>Название<input value={taskEditId ? '' : taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} disabled={Boolean(taskEditId)} required /></label>
            <RichTextInput label="Описание" rows={7} value={taskEditId ? '' : taskDraft.description} onChange={(description) => setTaskDraft({ ...taskDraft, description })} />
            <button className="primary" disabled={Boolean(taskEditId)}>Создать задание</button>
          </form>
        </details>
        <div className="list">
          {admin.tasks.map((task) => (
            <div className="admin-manage-card" key={task.id}>
              <div className="admin-card-heading">
                <span>Задание {task.task_num}</span>
                <strong>{task.title}</strong>
              </div>
              {taskEditId === task.id ? (
                <form className="inline-editor-form" onSubmit={submitTaskForm}>
                  <label>Название<input value={taskDraft.title} onChange={(event) => setTaskDraft({ ...taskDraft, title: event.target.value })} required /></label>
                  <RichTextInput label="Описание" rows={6} value={taskDraft.description} onChange={(description) => setTaskDraft({ ...taskDraft, description })} />
                  <div className="admin-card-actions">
                    <button className="primary">Сохранить</button>
                    <button type="button" className="ghost" onClick={() => { setTaskEditId(null); setTaskDraft({ title: '', description: '' }); }}>Отмена</button>
                  </div>
                </form>
              ) : (
                <>
                  <RichText text={task.description} />
                  <small>Поля «комментарий» и «медиа» автоматически появляются у пользователя при выполнении задания.</small>
                  <div className="admin-card-actions">
                    <button className="ghost compact-button" onClick={() => editTask(task)}><Edit3 size={16} />Изменить</button>
                    <button className="secondary compact-button" onClick={() => deleteTask(task.id)}><Trash2 size={16} />Удалить</button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </details>
      <details className="admin-panel">
        <summary><span>Тесты</span><ChevronDown size={18} /></summary>
        <div className="admin-panel-actions">
          <button type="button" className="primary compact-button" onClick={() => { setSeriesCreateOpen(true); setSeriesEditName(null); setQuizCreateSeries(null); }}>
            <Plus size={17} />
            Создать серию
          </button>
        </div>
        {seriesCreateOpen && (
          <section className="admin-inline-note">
            <div className="admin-card-heading">
              <span>Новая серия</span>
              <strong>Создать серию тестов</strong>
            </div>
            <SeriesEditorForm
              draft={seriesCreateDraft}
              setDraft={setSeriesCreateDraft}
              onSubmit={submitSeriesCreateForm}
              submitLabel="Создать серию"
              onCancel={() => { setSeriesCreateOpen(false); setSeriesCreateDraft(defaultSeriesDraft()); }}
            />
          </section>
        )}
        <div className="admin-card-grid quiz-series-grid">
          {quizSeriesRows.map((series) => {
            const seriesQuizzes = quizzesBySeries[series.name] || [];
            const isSeriesOpen = Boolean(openSeries[series.name] || seriesEditName === series.name || quizCreateSeries === series.name || seriesQuizzes.some((quiz) => quiz.id === quizEditId));
            return (
              <div className={cx('admin-manage-card quiz-series-card', isSeriesOpen && 'is-open', series.is_visible === false && 'is-hidden')} key={series.name}>
                <div className="quiz-series-summary-row">
                  <button
                    type="button"
                    className="quiz-series-summary"
                    aria-expanded={isSeriesOpen}
                    onClick={() => setOpenSeries((current) => ({ ...current, [series.name]: !isSeriesOpen }))}
                  >
                    <span className="admin-card-heading">
                      <span>Серия тестов</span>
                      <strong>{series.name}</strong>
                      {series.description && <small>Есть описание серии</small>}
                    </span>
                    <span className="quiz-series-summary-meta"><span>{formatTestCount(seriesQuizzes.length)}</span><ChevronDown size={18} /></span>
                  </button>
                  <VisibilityToggle
                    enabled={series.is_visible !== false}
                    onChange={(isVisible) => toggleQuizSeriesVisibility(series.name, isVisible)}
                    className="summary-visibility-toggle"
                  />
                </div>
                {isSeriesOpen && (
                  <div className="quiz-series-body">
                {seriesEditName === series.name ? (
                  <SeriesEditorForm
                    draft={seriesEditDraft}
                    setDraft={setSeriesEditDraft}
                    onSubmit={submitSeriesEditForm}
                    submitLabel="Сохранить серию"
                    onCancel={() => { setSeriesEditName(null); setSeriesEditDraft(defaultSeriesDraft()); }}
                  />
                ) : (
                  <div className="admin-card-actions">
                    <button type="button" className="ghost compact-button" onClick={() => startSeriesEdit(series)}><Edit3 size={16} />Изменить</button>
                    <button type="button" className="secondary compact-button" onClick={() => {
                      if (confirm(`Удалить серию «${series.name}» вместе с тестами?`)) deleteQuizSeries(series.name);
                    }}><Trash2 size={16} />Удалить</button>
                  </div>
                )}
                <div className="series-test-list">
                  {seriesQuizzes.length === 0 && <p className="muted">В серии пока нет тестов.</p>}
                  {seriesQuizzes.map((quiz) => (
                    <div className={cx('series-test-row', quiz.is_visible === false && 'is-hidden')} key={quiz.id}>
                      <div className="series-test-row-head">
                      <div>
                        <strong>{quiz.title.replace(`${series.name}: `, '')}</strong>
                        <span>{formatDifficulty(quiz.difficulty)} · {quiz.max_score} вопросов · вес {quiz.weight}</span>
                      </div>
                      <VisibilityToggle
                        enabled={quiz.is_visible !== false}
                        onChange={(isVisible) => toggleQuizVisibility(quiz.id, isVisible)}
                        className="row-visibility-toggle"
                      />
                      </div>
                      {quizEditId === quiz.id ? (
                        <QuizEditorForm
                          draft={quizEditDraft}
                          setDraft={setQuizEditDraft}
                          quizSeries={quizSeries}
                          seriesDescriptionMap={seriesDescriptionMap}
                          onSubmit={submitQuizEditForm}
                          submitLabel="Сохранить тест"
                          onCancel={() => { setQuizEditId(null); setQuizEditDraft(defaultQuizDraft()); }}
                          formId={`quiz-edit-${quiz.id}`}
                          hideSeries
                          hideDescription
                        />
                      ) : (
                        <div className="admin-card-actions">
                          <button className="ghost compact-button" onClick={() => editQuiz(quiz)}><Edit3 size={16} />Изменить</button>
                          <button className="secondary compact-button" onClick={() => deleteQuiz(quiz.id)}><Trash2 size={16} />Удалить</button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                {quizCreateSeries === series.name ? (
                  <QuizEditorForm
                    draft={quizCreateDraft}
                    setDraft={setQuizCreateDraft}
                    quizSeries={quizSeries}
                    seriesDescriptionMap={seriesDescriptionMap}
                    onSubmit={submitQuizForm}
                    submitLabel="Создать тест"
                    onCancel={() => { setQuizCreateSeries(null); setQuizCreateDraft(defaultQuizDraft()); }}
                    formId={`quiz-create-${series.name}`}
                    hideSeries
                    hideDescription
                  />
                ) : (
                  <button type="button" className="ghost compact-button" onClick={() => startQuizCreate(series.name)}><Plus size={16} />Добавить тест</button>
                )}
                  </div>
                )}
              </div>
            );
          })}
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
                <span>{user.username ? `@${user.username}` : 'без username'} · {user.title_text}</span>
              </div>
              <b>{user.title_score}</b>
            </div>
          ))}
        </div>
      </details>
    </main>
  );
}

function defaultQuizQuestion() {
  return {
    text: '',
    hint: '',
    mediaUrl: '',
    options: [
      { text: '', isCorrect: true },
      { text: '', isCorrect: false },
      { text: '', isCorrect: false }
    ]
  };
}

function defaultDescriptionBlock() {
  return { text: '', mediaText: '' };
}

function defaultContentBlock() {
  return { text: '', mediaText: '' };
}

function mediaTextToArray(value) {
  return String(value || '')
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseLessonContentBlocks(body) {
  if (!body) return null;
  try {
    const parsed = JSON.parse(body);
    if (!parsed || !Array.isArray(parsed.blocks)) return null;
    const blocks = parsed.blocks
      .map((block) => ({
        text: block.text || '',
        media: Array.isArray(block.media) ? block.media : mediaTextToArray(block.mediaText || '')
      }))
      .filter((block) => block.text.trim() || block.media.length);
    return blocks.length ? blocks : null;
  } catch {
    return null;
  }
}

function parseEditableLessonBlocks(lesson) {
  const parsed = parseLessonContentBlocks(lesson.body);
  if (parsed) {
    return parsed.map((block) => ({
      text: block.text,
      mediaText: block.media.join('\n')
    }));
  }
  return [{
    text: lesson.body || '',
    mediaText: mediaToText(lesson.media)
  }];
}

function serializeLessonBlocks(blocks) {
  return JSON.stringify({
    blocks: (blocks || [])
      .map((block) => ({
        text: block.text || '',
        media: mediaTextToArray(block.mediaText)
      }))
      .filter((block) => block.text.trim() || block.media.length)
  });
}

function contentBlocksMediaText(blocks) {
  return (blocks || [])
    .flatMap((block) => mediaTextToArray(block.mediaText))
    .join('\n');
}

function normalizeDescriptionBlock(block) {
  return {
    text: block?.text || '',
    mediaText: Array.isArray(block?.media)
      ? block.media.join('\n')
      : mediaTextToArray(block?.mediaText || '').join('\n')
  };
}

function parseSeriesDescription(description) {
  if (!description) return { title: '', blocks: [defaultDescriptionBlock()], structured: false };
  try {
    const parsed = JSON.parse(description);
    if (Array.isArray(parsed)) {
      return {
        title: '',
        blocks: parsed.length ? parsed.map(normalizeDescriptionBlock) : [defaultDescriptionBlock()],
        structured: parsed.length > 0
      };
    }
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.blocks)) {
      return {
        title: parsed.title || '',
        blocks: parsed.blocks.length ? parsed.blocks.map(normalizeDescriptionBlock) : [defaultDescriptionBlock()],
        structured: parsed.blocks.length > 0 || Boolean(parsed.title)
      };
    }
  } catch {
    // Older tests store a plain text description.
  }
  return { title: '', blocks: [{ text: description, mediaText: '' }], structured: false };
}

function parseDescriptionBlocks(description) {
  return parseSeriesDescription(description).blocks;
}

function serializeSeriesDescription(title, blocks) {
  const cleanBlocks = blocks
      .map((block) => ({ text: block.text || '', media: mediaTextToArray(block.mediaText) }))
      .filter((block) => block.text.trim() || block.media.length);
  if (!String(title || '').trim() && cleanBlocks.length === 0) return '';
  return JSON.stringify({
    title: String(title || '').trim(),
    blocks: cleanBlocks
  });
}

function getSeriesDescriptionInfo(category, items) {
  const quizWithDescription = items.find((quiz) => parseSeriesDescription(quiz.description).structured);
  if (quizWithDescription) {
    const parsed = parseSeriesDescription(quizWithDescription.description);
    return {
      type: 'builder',
      title: parsed.title || category,
      description: quizWithDescription.description
    };
  }
  return null;
}

function defaultCourseLesson() {
  return { title: '', blocks: [defaultContentBlock()] };
}

function defaultCourseSection() {
  return {
    title: '',
    description: '',
    lessons: [defaultCourseLesson()]
  };
}

function defaultCourseDraft() {
  return {
    title: '',
    difficulty: 'начальный',
    description: '',
    isVisible: true,
    sections: [defaultCourseSection()]
  };
}

function mediaToText(media) {
  return (Array.isArray(media) ? media : [])
    .map((item) => typeof item === 'string' ? item : item.url || item.path || item.media_url || item.mediaUrl || '')
    .filter(Boolean)
    .join('\n');
}

function courseToDraft(selectedCourse) {
  return {
    title: selectedCourse.course.title || '',
    difficulty: selectedCourse.course.difficulty || 'начальный',
    description: selectedCourse.course.description || '',
    isVisible: selectedCourse.course.is_visible !== false,
    sections: (selectedCourse.sections || []).map((section) => ({
      id: section.id,
      title: section.title || '',
      description: section.description || '',
      lessons: (section.lessons?.length ? section.lessons : [defaultCourseLesson()]).map((lesson) => ({
        id: lesson.id,
        title: lesson.title || '',
        blocks: parseEditableLessonBlocks(lesson)
      }))
    }))
  };
}

function courseDraftToPayload(draft) {
  return {
    title: draft.title,
    difficulty: draft.difficulty,
    description: draft.description,
    isVisible: draft.isVisible !== false,
    sections: draft.sections.map((section) => ({
      id: section.id,
      title: section.title,
      description: section.description,
      lessons: section.lessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title,
        body: serializeLessonBlocks(lesson.blocks),
        mediaText: contentBlocksMediaText(lesson.blocks)
      }))
    }))
  };
}

function defaultQuizDraft() {
  return {
    title: '',
    seriesMode: 'existing',
    series: '',
    newSeries: '',
    difficulty: 'easy',
    customDifficulty: '',
    weight: 1,
    isVisible: true,
    hasDescription: false,
    descriptionTitle: '',
    descriptionBlocks: [defaultDescriptionBlock()],
    questions: [defaultQuizQuestion()]
  };
}

export function App() {
  const initialRoute = getInitialRoute();
  const selectedSubmissionId = initialRoute.submissionId;
  const [page, setPage] = useState(initialRoute.page);
  const [boot, setBoot] = useState({ loading: true, error: null });
  const [home, setHome] = useState(null);
  const [me, setMe] = useState(null);
  const [courses, setCourses] = useState([]);
  const [selectedCourse, setSelectedCourse] = useState(null);
  const [activeSectionSlug, setActiveSectionSlug] = useState(null);
  const [quizzes, setQuizzes] = useState([]);
  const [quizState, setQuizState] = useState(null);
  const [contentPage, setContentPage] = useState(null);
  const [attemptDetail, setAttemptDetail] = useState(null);
  const [leaderboard, setLeaderboard] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [admin, setAdmin] = useState(null);
  const [adminMode, setAdminMode] = useState(false);

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
      series: quizRows.series || [],
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

  async function openCourseSection(courseSlug, sectionSlug) {
    await loadCourse(courseSlug, sectionSlug);
    setPage('courses');
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

  async function openAttempt(id) {
    const payload = await apiFetch(`/quiz-attempts/${id}`);
    setAttemptDetail(payload);
  }

  async function openContentPage(slug) {
    const payload = await apiFetch(`/content-pages/${slug}`);
    setContentPage(payload.page);
  }

  function openSeriesDescription(title, description) {
    const parsed = parseSeriesDescription(description);
    const body = parsed.blocks.map((block) => ({
      text: block.text,
      media: mediaTextToArray(block.mediaText)
    }));
    setContentPage({ title: parsed.title || title, body });
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

  async function toggleQuizVisibility(id, isVisible) {
    await apiFetch(`/admin/quizzes/${id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ isVisible })
    });
    await loadAdmin();
    await loadAll();
  }

  async function saveQuizSeries(name, payload) {
    await apiFetch(name ? `/admin/quiz-series/${encodeURIComponent(name)}` : '/admin/quiz-series', {
      method: name ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    await loadAdmin();
    await loadAll();
  }

  async function toggleQuizSeriesVisibility(name, isVisible) {
    await apiFetch(`/admin/quiz-series/${encodeURIComponent(name)}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ isVisible })
    });
    await loadAdmin();
    await loadAll();
  }

  async function deleteQuizSeries(name) {
    await apiFetch(`/admin/quiz-series/${encodeURIComponent(name)}`, { method: 'DELETE' });
    await loadAdmin();
    await loadAll();
  }

  async function saveCourse(id, payload) {
    await apiFetch(id ? `/admin/courses/${id}` : '/admin/courses', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(payload)
    });
    await loadAdmin();
    const coursesData = await apiFetch('/courses');
    setCourses(coursesData.courses);
    if (selectedCourse?.course?.slug) await loadCourse(selectedCourse.course.slug, activeSectionSlug);
  }

  async function toggleCourseVisibility(id, isVisible) {
    await apiFetch(`/admin/courses/${id}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ isVisible })
    });
    await loadAdmin();
    await loadAll();
    if (selectedCourse?.course?.id === id) {
      await loadCourse(selectedCourse.course.slug, activeSectionSlug);
    }
  }

  async function deleteCourse(id) {
    await apiFetch(`/admin/courses/${id}`, { method: 'DELETE' });
    await loadAdmin();
    await loadAll();
    if (selectedCourse?.course?.id === id) {
      setSelectedCourse(null);
      setActiveSectionSlug(null);
    }
  }

  if (boot.loading) return <div className="splash"><LayoutDashboard size={34} /><span>AcademyLH</span></div>;
  if (boot.error) return <div className="splash error"><Lock size={34} /><span>{boot.error}</span></div>;
  if (quizState) return <QuizPage quizState={quizState} submitQuiz={submitQuiz} close={() => setQuizState(null)} />;
  if (attemptDetail) return <AttemptHistoryPage detail={attemptDetail} close={() => setAttemptDetail(null)} />;
  if (contentPage) return <ContentPage contentPage={contentPage} close={() => setContentPage(null)} />;

  return (
    <div className="app-shell">
      {page === 'home' && <HomePage data={home} setPage={setPage} adminMode={adminMode} setAdminMode={setAdminMode} />}
      {page === 'profile' && <ProfilePage me={me} setPage={setPage} openCourseSection={openCourseSection} openAttempt={openAttempt} />}
      {page === 'courses' && <CoursesPage courses={courses} selectedCourse={selectedCourse} activeSectionSlug={activeSectionSlug} setActiveSectionSlug={setActiveSectionSlug} openCourse={openCourse} completeSection={completeSection} openQuiz={openQuiz} setPage={setPage} adminMode={home.user.role === 'admin' && adminMode} saveCourse={saveCourse} deleteCourse={deleteCourse} toggleCourseVisibility={toggleCourseVisibility} />}
      {page === 'tests' && <TestsPage quizzes={quizzes} openQuiz={openQuiz} openContentPage={openContentPage} openSeriesDescription={openSeriesDescription} setPage={setPage} />}
      {page === 'leaderboard' && <LeaderboardPage leaderboard={leaderboard} setPage={setPage} />}
      {page === 'tasks' && <TasksPage tasks={tasks} submitTask={submitTask} loadMenu={loadMenu} loadMenuFilters={() => apiFetch('/tasks/dish-photo/menu-filters')} setPage={setPage} />}
      {page === 'admin' && home.user.role === 'admin' && admin && <AdminPage admin={admin} reviewSubmission={reviewSubmission} reload={loadAdmin} setPage={setPage} selectedSubmissionId={selectedSubmissionId} saveTask={saveTask} deleteTask={deleteTask} saveQuiz={saveQuiz} deleteQuiz={deleteQuiz} loadAdminQuiz={loadAdminQuiz} saveQuizSeries={saveQuizSeries} deleteQuizSeries={deleteQuizSeries} toggleQuizVisibility={toggleQuizVisibility} toggleQuizSeriesVisibility={toggleQuizSeriesVisibility} />}
      {page === 'admin' && home.user.role !== 'admin' && (
        <main className="page">
          <PageHeader eyebrow="Доступ" title="Админка закрыта"><BackHomeButton setPage={setPage} /></PageHeader>
          <section className="list-section"><p className="muted">Этот раздел доступен только администраторам.</p></section>
        </main>
      )}
    </div>
  );
}
