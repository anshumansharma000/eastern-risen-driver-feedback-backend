import { Type } from 'typebox';

export const e164PhoneSchema = Type.String({
  pattern: '^\\+[1-9]\\d{7,14}$',
  maxLength: 16,
});
