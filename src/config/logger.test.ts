import { describe, expect, it } from 'vitest';
import { loggerRedaction } from './logger.js';

describe('logger redaction', () => {
  it('covers credentials and passenger payload fields', () => {
    expect(loggerRedaction.paths).toEqual(
      expect.arrayContaining([
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers.set-cookie',
        'req.body.password',
        'req.body.respondent',
        'req.body.questionnaireSnapshot',
        'req.body.answers',
      ]),
    );
  });
});
