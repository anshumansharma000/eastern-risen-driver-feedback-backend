import { describe, expect, it } from 'vitest';
import {
  announcementLink,
  normalizeAnnouncement,
  publicPath,
  type AnnouncementInput,
} from './announcements.js';
const input: AnnouncementInput = {
  name: ' Winter ',
  category: 'SEASONAL',
  message: ' Travel slowly. ',
  linkText: null,
  linkUrl: null,
  status: 'PUBLISHED',
  startsAt: '2026-10-27T00:00:00Z',
  endsAt: null,
  placement: 'HOME',
  paths: [],
  priority: 'NORMAL',
  dismissible: true,
};
describe('website announcement validation', () => {
  it('normalizes content and selected paths', () => {
    expect(
      normalizeAnnouncement({ ...input, placement: 'SELECTED', paths: ['/tours/', '/tours', '/'] }),
    ).toMatchObject({ name: 'Winter', message: 'Travel slowly.', paths: ['/tours', '/'] });
    expect(normalizeAnnouncement({ ...input, paths: ['/tours'] }).paths).toEqual([]);
  });
  it.each([
    '/account',
    '/account/login/',
    '/quote/abc',
    '/api/v1/core',
    '//evil.test',
    '/tours?x=1',
    '/tours#x',
    '/a/../account',
    '/%61ccount',
    '/a\\b',
  ])('rejects private or ambiguous paths %s', (path) => expect(() => publicPath(path)).toThrow());
  it.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    '//evil.test',
    'http://evil.test',
    'https://user:pass@example.com',
    '/\\evil.test',
    '/account/login',
    '/a/../quote/secret',
  ])('rejects unsafe destinations %s', (url) => expect(() => announcementLink(url)).toThrow());
  it('accepts public relative links and external HTTPS', () => {
    expect(announcementLink('/tours?region=odisha#journeys')).toBe('/tours?region=odisha#journeys');
    expect(announcementLink('https://example.com/news')).toBe('https://example.com/news');
  });
  it.each([
    { message: ' ' },
    { message: 'Two\nlines' },
    { endsAt: '2026-10-26T00:00:00Z' },
    { endsAt: input.startsAt },
    { placement: 'SELECTED', paths: [] },
    { linkText: 'Read more' },
    { linkUrl: '/tours' },
  ])('rejects inconsistent content and schedules', (patch) =>
    expect(() => normalizeAnnouncement({ ...input, ...patch } as AnnouncementInput)).toThrow(),
  );
});
