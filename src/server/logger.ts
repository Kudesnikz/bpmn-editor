export function logEvent(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'info',
    event,
    ...fields
  })}\n`);
}

export function logError(event: string, error: unknown, fields: Record<string, unknown> = {}): void {
  process.stderr.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    level: 'error',
    event,
    error: error instanceof Error ? error.message : String(error),
    ...fields
  })}\n`);
}
