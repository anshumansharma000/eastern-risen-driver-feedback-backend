import { AppError } from '../../../shared/errors/app-error.js';
export const invalid = (message: string) =>
  new AppError({ code: 'CORE_VALIDATION_FAILED', message, statusCode: 422 });
export const missing = (resource: string) =>
  new AppError({ code: 'CORE_NOT_FOUND', message: `${resource} was not found`, statusCode: 404 });
export const conflict = (code: string, message: string) =>
  new AppError({ code, message, statusCode: 409 });
