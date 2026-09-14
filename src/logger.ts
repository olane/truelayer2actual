function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular references, BigInt, etc. Never let logging itself throw.
    return '[unserialisable]';
  }
}

function formatMessage(level: string, args: unknown[]): string {
  const timestamp = new Date().toISOString();
  const message = args
    .map((arg) =>
      typeof arg === 'object' && arg !== null ? stringify(arg) : String(arg)
    )
    .join(' ');
  return `${timestamp} [${level}] ${message}`;
}

export const logger = {
  info(...args: unknown[]): void {
    process.stdout.write(formatMessage('INFO', args) + '\n');
  },

  debug(...args: unknown[]): void {
    process.stdout.write(formatMessage('DEBUG', args) + '\n');
  },

  warn(...args: unknown[]): void {
    process.stderr.write(formatMessage('WARN', args) + '\n');
  },

  error(...args: unknown[]): void {
    process.stderr.write(formatMessage('ERROR', args) + '\n');
  },
};
