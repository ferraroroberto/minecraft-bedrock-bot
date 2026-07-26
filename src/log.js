// Timestamped, single-line logging.
//
// Every state transition gets a line so the next incident is diagnosable from
// the log alone, without attaching a debugger to a bot that ran overnight on a
// headless Mac Mini. ISO-8601 UTC because two hosts in one timezone still beats
// guessing which local clock a line came from.

/** @param {(line: string) => void} [sink] injectable so tests can assert on output */
export function createLogger(sink = console.log, now = () => new Date()) {
  const emit = (level, event, detail) => {
    const parts = [now().toISOString(), level.padEnd(5), event]
    if (detail) parts.push(`— ${detail}`)
    sink(parts.join(' '))
  }
  return {
    info: (event, detail) => emit('INFO', event, detail),
    warn: (event, detail) => emit('WARN', event, detail),
    error: (event, detail) => emit('ERROR', event, detail),
  }
}

/** Human-readable duration for log lines: 800ms, 4.5s, 2m30s. */
export function formatDuration(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes}m${String(seconds).padStart(2, '0')}s`
}
