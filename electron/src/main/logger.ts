import log from 'electron-log';
import { app } from 'electron';

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

log.transports.console.level = isDev ? 'debug' : 'info';
log.transports.file.level = isDev ? 'debug' : 'info';

/** Patterns that may indicate sensitive data — redacted from log output. */
const SENSITIVE_PATTERNS = [
  /password[=:\s][^\s&]+/gi,
  /token[=:\s][^\s&]+/gi,
  /bearer\s+[^\s]+/gi,
  /cookie[=:\s][^\s]+/gi,
  /jwt[=:\s][^\s]+/gi,
  /authorization[=:\s][^\s]+/gi,
];

function sanitize(message: string): string {
  let result = message;
  for (const pattern of SENSITIVE_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function formatArgs(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === 'string') return sanitize(arg);
    if (arg instanceof Error) return sanitize(arg.message);
    try {
      return sanitize(JSON.stringify(arg));
    } catch {
      return arg;
    }
  });
}

export const logger = {
  debug: (...args: unknown[]) => log.debug(...formatArgs(args)),
  info: (...args: unknown[]) => log.info(...formatArgs(args)),
  warn: (...args: unknown[]) => log.warn(...formatArgs(args)),
  error: (...args: unknown[]) => log.error(...formatArgs(args)),
};

export function isDevelopment(): boolean {
  return isDev;
}
