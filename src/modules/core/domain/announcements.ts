import { invalid } from './errors.js';

export const announcementCategories = [
  'GENERAL',
  'NEW_JOURNEY',
  'SEASONAL',
  'TRAVEL_ADVISORY',
  'SERVICE_UPDATE',
] as const;
export type AnnouncementInput = {
  name: string;
  category: (typeof announcementCategories)[number];
  message: string;
  linkText: string | null;
  linkUrl: string | null;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  startsAt: string;
  endsAt: string | null;
  placement: 'HOME' | 'PUBLIC' | 'SELECTED';
  paths: string[];
  priority: 'NORMAL' | 'IMPORTANT';
  dismissible: boolean;
};

const hasControlCharacters = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32);

export function publicPath(value: string): string {
  if (hasControlCharacters(value) || !/^\/(?!\/)[^?#\\\s]*$/.test(value) || /%/.test(value))
    throw invalid('Choose a public website path without a query or fragment');
  const path = value.replace(/\/+$/, '') || '/';
  if (path.split('/').some((part) => part === '.' || part === '..'))
    throw invalid('Relative path segments are not allowed');
  if (/^\/(account|quote|api)(\/|$)/i.test(path))
    throw invalid('Announcements cannot target private account, quote or API pages');
  return path;
}

export function announcementLink(value: string): string {
  if (hasControlCharacters(value) || /[\\\s]/.test(value))
    throw invalid('Enter a valid website link');
  if (value.startsWith('/')) {
    if (value.startsWith('//')) throw invalid('Use a website path or a full HTTPS link');
    const parsed = new URL(value, 'https://website.invalid');
    publicPath(parsed.pathname);
    return value;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid('Enter a valid HTTPS link');
  }
  if (url.protocol !== 'https:' || url.username || url.password)
    throw invalid('External links must use HTTPS without embedded credentials');
  return url.href;
}

export function normalizeAnnouncement(input: AnnouncementInput): AnnouncementInput {
  const name = input.name.trim(),
    message = input.message.trim();
  if (!name || !message || hasControlCharacters(message))
    throw invalid('Enter an internal name and a single-line announcement message');
  const linkText = input.linkText?.trim() || null;
  const linkUrl = input.linkUrl?.trim() || null;
  if (Boolean(linkText) !== Boolean(linkUrl))
    throw invalid('Provide both link text and destination, or neither');
  const start = Date.parse(input.startsAt),
    end = input.endsAt === null ? null : Date.parse(input.endsAt);
  if (!Number.isFinite(start) || (end !== null && (!Number.isFinite(end) || end <= start)))
    throw invalid('The end must be later than the start');
  const paths = input.placement === 'SELECTED' ? [...new Set(input.paths.map(publicPath))] : [];
  if (input.placement === 'SELECTED' && !paths.length)
    throw invalid('Select at least one public page');
  return {
    ...input,
    name,
    message,
    linkText,
    linkUrl: linkUrl ? announcementLink(linkUrl) : null,
    paths,
  };
}
