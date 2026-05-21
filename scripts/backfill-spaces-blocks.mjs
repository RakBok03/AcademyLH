import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, pool } from '../server/db/pool.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seed = JSON.parse(await fs.readFile(path.join(__dirname, '..', 'server', 'db', 'seed-data.json'), 'utf8'));

function mediaPath(file) {
  if (!file) return '';
  if (typeof file === 'string') return file;
  return file.path || file.url || file.media_url || file.mediaUrl || '';
}

function captionTitle(file) {
  return String(file?.captionTitle || file?.caption || '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function normalizeCaption(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[«»"'’]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isFloorNote(text) {
  return /^-?\d+\s*этаж(?:\s*\([^)]+\))?$/i.test(String(text || '').trim())
    || /^примыкающее здание$/i.test(String(text || '').trim());
}

function normalizeBlocks(blocks) {
  const normalized = [];
  for (const block of blocks || []) {
    const current = {
      text: block.text || '',
      media: Array.isArray(block.media)
        ? block.media.map(mediaPath).filter(Boolean)
        : []
    };
    const previous = normalized[normalized.length - 1];
    if (current.text.trim() && !current.media.length && previous?.media?.length && isFloorNote(current.text)) {
      previous.text = `${previous.text}\n${current.text.trim()}`;
      continue;
    }
    if (current.text.trim() || current.media.length) normalized.push(current);
  }
  return normalized;
}

function existingBlockBody(body) {
  try {
    const parsed = JSON.parse(body);
    if (!parsed || !Array.isArray(parsed.blocks)) return null;
    return JSON.stringify({ blocks: normalizeBlocks(parsed.blocks) });
  } catch {
    return null;
  }
}

function convertSpacesLesson(lesson) {
  const existing = existingBlockBody(lesson.body);
  if (existing) {
    return {
      body: existing,
      media: []
    };
  }

  const media = Array.isArray(lesson.media) ? lesson.media : [];
  const mainMedia = [];
  const groups = new Map();

  for (const file of media) {
    const title = captionTitle(file);
    const url = mediaPath(file);
    if (!url) continue;
    if (!title) {
      mainMedia.push(url);
      continue;
    }
    const key = normalizeCaption(title);
    if (!groups.has(key)) groups.set(key, { title, media: [] });
    groups.get(key).media.push(url);
  }

  if (!groups.size && !mainMedia.length) {
    return {
      body: JSON.stringify({ blocks: [{ text: lesson.body || '', media: [] }] }),
      media: []
    };
  }

  const blocks = [];
  const buffer = [];
  let introMediaAttached = false;

  function flushText(mediaForBlock = []) {
    const text = buffer.join('\n').trim();
    buffer.length = 0;
    if (!text && !mediaForBlock.length) return;
    blocks.push({ text, media: mediaForBlock });
  }

  for (const line of String(lesson.body || '').split('\n')) {
    const group = groups.get(normalizeCaption(line));
    if (group) {
      flushText(introMediaAttached ? [] : mainMedia);
      introMediaAttached = true;
      blocks.push({ text: line.trim() || group.title, media: group.media });
      continue;
    }
    buffer.push(line);
  }

  flushText(introMediaAttached ? [] : mainMedia);

  const usedMedia = new Set(blocks.flatMap((block) => block.media));
  for (const group of groups.values()) {
    const mediaItems = group.media.filter((item) => !usedMedia.has(item));
    if (mediaItems.length) blocks.push({ text: group.title, media: mediaItems });
  }

  return {
    body: JSON.stringify({ blocks: normalizeBlocks(blocks) }),
    media: []
  };
}

const lessons = (seed.lessons || []).filter((lesson) => lesson.sectionSlug === 'spaces');
let updated = 0;

for (const lesson of lessons) {
  const converted = convertSpacesLesson(lesson);
  const result = await query(
    `UPDATE course_lessons
     SET body = $1,
         media = $2::jsonb
     WHERE slug = $3`,
    [converted.body, JSON.stringify(converted.media), lesson.slug]
  );
  updated += result.rowCount;
}

await pool.end();
console.log(`Updated spaces lessons into block format: ${updated}`);
