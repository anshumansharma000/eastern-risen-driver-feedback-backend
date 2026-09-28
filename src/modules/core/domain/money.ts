import { invalid } from './errors.js';
const MONEY = /^(0|[1-9][0-9]{0,11})\.[0-9]{2}$/;
const RATE = /^(100(\.0{1,4})?|[0-9]{1,2}(\.[0-9]{1,4})?)$/;
const MAX_MINOR = 99_999_999_999_999n;
/** Monetary input/output is decimal text. Arithmetic uses integer paise, never floats. */
export function minor(value: string): bigint {
  if (!MONEY.test(value))
    throw invalid('Amounts must be nonnegative decimal strings with exactly two fractional digits');
  return BigInt(value.replace('.', ''));
}
export function decimal(value: bigint): string {
  if (value < 0n || value > MAX_MINOR) throw invalid('Amount exceeds the supported range');
  return `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
}
/** Half-up rounding once per line/component, to the nearest paise. */
export function taxAmount(amount: string, rate: string): string {
  if (!RATE.test(rate))
    throw invalid('Tax rates must be between 0 and 100 with up to four fractional digits');
  const [whole, fraction = ''] = rate.split('.');
  const units = BigInt(whole!) * 10000n + BigInt(fraction.padEnd(4, '0'));
  return decimal((minor(amount) * units + 500000n) / 1000000n);
}
export function sum(amounts: readonly string[]): string {
  return decimal(amounts.reduce((total, amount) => total + minor(amount), 0n));
}
