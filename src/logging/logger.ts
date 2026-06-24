/**
 * Structured logger with colored terminal output for protocol traces.
 */

// ANSI color codes
const Colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',

  // Foreground
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Background
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
} as const;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

export class Logger {
  private minLevel: LogLevel;

  constructor(
    private readonly prefix: string,
    minLevel: LogLevel = 'info'
  ) {
    this.minLevel = minLevel;
  }

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /**
   * Log a protocol message exchange with direction arrows.
   */
  protocol(
    direction: 'send' | 'receive',
    command: string,
    summary: string,
    rawData?: string
  ): void {
    if (LOG_LEVEL_PRIORITY[this.minLevel] > LOG_LEVEL_PRIORITY.info) return;

    const timestamp = this.formatTime();
    const arrow =
      direction === 'send'
        ? `${Colors.cyan}──▶${Colors.reset}`
        : `${Colors.green}◀──${Colors.reset}`;
    const cmdColor =
      direction === 'send' ? Colors.cyan : Colors.green;

    let line = `${Colors.gray}${timestamp}${Colors.reset} ${arrow} `;
    line += `${Colors.bold}${cmdColor}${command}${Colors.reset} `;
    line += summary;

    console.log(line);

    if (rawData) {
      console.log(
        `${Colors.gray}         │ ${Colors.dim}${this.truncate(rawData, 120)}${Colors.reset}`
      );
    }
  }

  /**
   * Log a state transition.
   */
  stateChange(from: string, to: string, trigger: string): void {
    if (LOG_LEVEL_PRIORITY[this.minLevel] > LOG_LEVEL_PRIORITY.info) return;

    const timestamp = this.formatTime();
    console.log(
      `${Colors.gray}${timestamp}${Colors.reset} ` +
        `${Colors.magenta}◆${Colors.reset} ` +
        `${Colors.dim}${from}${Colors.reset} → ` +
        `${Colors.bold}${Colors.magenta}${to}${Colors.reset} ` +
        `${Colors.gray}(${trigger})${Colors.reset}`
    );
  }

  /**
   * Log a section separator.
   */
  section(title: string): void {
    console.log(
      `\n${Colors.bold}${Colors.yellow}═══ ${title} ${'═'.repeat(Math.max(0, 60 - title.length))}${Colors.reset}\n`
    );
  }

  private log(
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>
  ): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.minLevel]) return;

    const timestamp = this.formatTime();
    const levelStr = this.formatLevel(level);
    const prefixStr = `${Colors.dim}[${this.prefix}]${Colors.reset}`;

    let line = `${Colors.gray}${timestamp}${Colors.reset} ${levelStr} ${prefixStr} ${message}`;

    if (data) {
      const dataStr = Object.entries(data)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ');
      line += ` ${Colors.gray}${dataStr}${Colors.reset}`;
    }

    console.log(line);
  }

  private formatTime(): string {
    const now = new Date();
    return `${now.toTimeString().slice(0, 8)}.${String(now.getMilliseconds()).padStart(3, '0')}`;
  }

  private formatLevel(level: LogLevel): string {
    switch (level) {
      case 'debug':
        return `${Colors.gray}DBG${Colors.reset}`;
      case 'info':
        return `${Colors.blue}INF${Colors.reset}`;
      case 'warn':
        return `${Colors.yellow}WRN${Colors.reset}`;
      case 'error':
        return `${Colors.red}ERR${Colors.reset}`;
    }
  }

  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) return str;
    return str.slice(0, maxLength - 3) + '...';
  }
}
