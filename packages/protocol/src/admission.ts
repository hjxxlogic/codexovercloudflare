import { z } from 'zod';

export const MAX_FRAME = 256 * 1024;
export const MAX_QUEUE = 8 * 1024 * 1024;
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const accessEmailSchema = z
  .string()
  .max(254)
  .regex(
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}(?![\s\S])/,
  )
  .transform((email) => {
    const at = email.lastIndexOf('@');
    return email.slice(0, at) + email.slice(at).toLowerCase();
  });
export const accessEmailsSchema = z
  .array(accessEmailSchema)
  .transform((emails) => [...new Set(emails)].sort());
export const wakeUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    if (value === '') return true;
    if (
      !/^https?:\/\/(\[[0-9a-fA-F:]+\]|[a-zA-Z0-9.-]+)(:[0-9]{1,5})?([/?][^\s\\#]*)?$/.test(
        value,
      )
    )
      return false;
    try {
      const url = new URL(value);
      return (
        url.port !== '0' &&
        (url.protocol === 'https:' ||
          ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      );
    } catch {
      return false;
    }
  }, 'Use an HTTPS wake URL without credentials or fragment (HTTP only on loopback)');
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export function errorData(e: unknown) {
  return e instanceof AppError
    ? { code: e.code, message: e.message }
    : e instanceof z.ZodError || e instanceof SyntaxError
      ? { code: 'INVALID_REQUEST', message: 'Invalid request fields' }
      : { code: 'INTERNAL_ERROR', message: 'Service temporarily unavailable' };
}
