import type { RunStatus } from '@upgradelab/contracts';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
} as const;

export interface UiOptions {
  readonly json: boolean;
  readonly color?: boolean;
  readonly stdout?: NodeJS.WritableStream;
  readonly stderr?: NodeJS.WritableStream;
}

/** Minimal terminal UI; all structured output goes to stdout, logs to stderr. */
export class Ui {
  readonly json: boolean;
  readonly color: boolean;
  private readonly stdout: NodeJS.WritableStream;
  private readonly stderr: NodeJS.WritableStream;

  constructor(options: UiOptions) {
    this.json = options.json;
    this.color = options.color ?? false;
    this.stdout = options.stdout ?? process.stdout;
    this.stderr = options.stderr ?? process.stderr;
  }

  private paint(code: keyof typeof ANSI, text: string): string {
    return this.color ? `${ANSI[code]}${text}${ANSI.reset}` : text;
  }

  line(text = ''): void {
    this.stdout.write(`${text}\n`);
  }

  error(text: string): void {
    this.stderr.write(`${this.paint('red', text)}\n`);
  }

  warning(text: string): void {
    this.stderr.write(`${this.paint('yellow', text)}\n`);
  }

  progress(text: string): void {
    if (this.json) {
      return;
    }
    this.stderr.write(`${this.paint('dim', text)}\n`);
  }

  heading(text: string): void {
    this.line(this.paint('bold', text));
  }

  status(status: RunStatus | string): string {
    switch (status) {
      case 'PASSED':
        return this.paint('green', 'PASSED');
      case 'FAILED':
        return this.paint('red', 'FAILED');
      case 'INCONCLUSIVE':
        return this.paint('yellow', 'INCONCLUSIVE');
      case 'CANCELLED':
        return this.paint('magenta', 'CANCELLED');
      default:
        return String(status);
    }
  }

  ok(value: boolean): string {
    return value ? this.paint('green', 'ok') : this.paint('red', 'FAILED');
  }

  dim(text: string): string {
    return this.paint('dim', text);
  }

  bold(text: string): string {
    return this.paint('bold', text);
  }
}

export function shouldUseColor(
  noColor: boolean,
  stream: NodeJS.WriteStream = process.stdout,
): boolean {
  if (noColor || process.env['NO_COLOR'] !== undefined || process.env['TERM'] === 'dumb') {
    return false;
  }
  return Boolean(stream.isTTY);
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) {
    return `${ms}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

export interface DoctorLine {
  readonly id: string;
  readonly status: 'PASSED' | 'FAILED' | 'WARNING';
  readonly message: string;
}

/** Renders a simple aligned table without extra dependencies. */
export function renderTable(
  rows: readonly (readonly string[])[],
  headers: readonly string[],
): string {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => (row[index] ?? '').length)),
  );
  const renderRow = (row: readonly string[]): string =>
    row
      .map((cell, index) => (cell ?? '').padEnd(widths[index] ?? 0))
      .join('  ')
      .trimEnd();
  return [
    renderRow(headers),
    renderRow(widths.map((width) => '-'.repeat(width))),
    ...rows.map(renderRow),
  ].join('\n');
}
