import { invalid } from './errors.js';
export function validateDate(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value
  )
    throw invalid('A valid calendar date is required');
}
export function validatePeriod(from: string, to?: string | null): void {
  validateDate(from);
  if (to) {
    validateDate(to);
    if (to < from) throw invalid('End date must not precede start date');
  }
}
export function financialYear(date: string): string {
  validateDate(date);
  const year = Number(date.slice(0, 4)) - (Number(date.slice(5, 7)) < 4 ? 1 : 0);
  return `${year.toString().slice(-2)}${(year + 1).toString().slice(-2)}`;
}
