import { AppError } from '../../shared/errors/app-error.js';

// Require an international prefix; never guess a traveller's country from the booking.
export function normalizeRespondentPhone(value: string): string {
  const phone = value
    .trim()
    .replace(/[\s().-]/g, '')
    .replace(/^00/, '+');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new AppError({
      code: 'RESPONDENT_PHONE_INVALID',
      message: 'Enter a valid phone number including its country code',
      statusCode: 400,
    });
  }
  return phone;
}
