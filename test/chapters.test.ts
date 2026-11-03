import { describe, expect, it } from 'vitest';
import { CHAPTER_FORMATS, detectChapterFormat, exportChapters, importChapters, type Chapter } from '../src/core/chapters';
import { buildId3Tag, readId3Chapters, parseId3Frames } from '../src/core/id3';
import { formatTimestamp, parseTimestamp } from '../src/shared/time';

const chapters: Chapter[] = [
  { start: 0, title: 'Intro' },
  { start: 65.5, title: 'News & "Updates"', url: 'https://example.com/a?b=1&c=2' },
  { start: 3725.125, title: 'Outro <bye>' },
];

describe('timestamps', () => {
  it('formats and parses', () => {
    expect(formatTimestamp(3725.125)).toBe('01:02:05.125');
    expect(parseTimestamp('01:02:05.125')).toBeCloseTo(3725.125);
    expect(parseTimestamp('2:05')).toBe(125);
    expect(parseTimestamp('abc')).toBeNaN();
  });
});

describe('chapter files', () => {
  for (const fmt of CHAPTER_FORMATS) {
    it(`round-trips ${fmt.id}`, () => {
      const text = exportChapters(chapters, fmt.id, 4000);
      expect(detectChapterFormat(text)).toBe(fmt.id);
      const back = importChapters(text);
      expect(back.map((c) => c.title)).toEqual(chapters.map((c) => c.title));
      back.forEach((c, i) => expect(c.start).toBeCloseTo(chapters[i].start, 3));
      if (fmt.id !== 'audacity') expect(back[1].url).toBe(chapters[1].url);
    });
  }

  it('writes valid Podlove Simple Chapters', () => {
    const xml = exportChapters(chapters, 'psc');
    expect(xml).toContain('xmlns:psc="http://podlove.org/simple-chapters"');
    expect(xml).toContain('start="00:01:05.500"');
    expect(xml).toContain('title="News &amp; &quot;Updates&quot;"');
  });
});

describe('ID3 chapters', () => {
  it('writes CHAP/CTOC frames that read back', () => {
    const tag = buildId3Tag({ title: 'Episode 1', artist: 'Me', chapters, durationSeconds: 4000 });
    expect(tag.toString('latin1', 0, 3)).toBe('ID3');
    const ids = parseId3Frames(tag).map((f) => f.id);
    expect(ids).toContain('TIT2');
    expect(ids).toContain('CTOC');
    expect(ids.filter((i) => i === 'CHAP')).toHaveLength(3);
    const back = readId3Chapters(tag);
    expect(back.map((c) => c.title)).toEqual(chapters.map((c) => c.title));
    expect(back[2].start).toBeCloseTo(3725.125);
    expect(back[1].url).toBe(chapters[1].url);
  });
});
