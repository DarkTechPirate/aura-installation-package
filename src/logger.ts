/**
 * Lightweight structured logger.
 *
 * Output format is controlled by the LOG_FORMAT env var:
 *   - LOG_FORMAT=json  → one JSON object per line (machine-parseable, for production)
 *   - (default)        → human-readable  [LEVEL] [module] message  extra=value
 *
 * Log level is controlled by LOG_LEVEL env var:
 *   debug | info | warn | error   (default: info)
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const minLevel: number = LEVELS[(process.env.LOG_LEVEL as Level) ?? 'info'] ?? LEVELS.info;
const jsonMode: boolean = process.env.LOG_FORMAT === 'json';

function emit(level: Level, module: string, message: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < minLevel) return;

  if (jsonMode) {
    const entry: Record<string, unknown> = {
      ts:      new Date().toISOString(),
      level,
      module,
      message,
      ...extra,
    };
    (level === 'error' ? console.error : console.log)(JSON.stringify(entry));
  } else {
    const tag   = `[${level.toUpperCase().padEnd(5)}]`;
    const mod   = `[${module}]`;
    const parts = [tag, mod, message];
    if (extra && Object.keys(extra).length > 0) {
      parts.push(Object.entries(extra).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' '));
    }
    const line = parts.join(' ');
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
  }
}

export function createLogger(module: string) {
  return {
    debug: (message: string, extra?: Record<string, unknown>) => emit('debug', module, message, extra),
    info:  (message: string, extra?: Record<string, unknown>) => emit('info',  module, message, extra),
    warn:  (message: string, extra?: Record<string, unknown>) => emit('warn',  module, message, extra),
    error: (message: string, extra?: Record<string, unknown>) => emit('error', module, message, extra),
  };
}

/** Root logger for use outside a specific module. */
export const log = createLogger('aura');
