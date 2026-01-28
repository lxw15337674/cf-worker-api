export class TimeoutError extends Error {
  timeoutMs: number

  constructor(timeoutMs: number) {
    super(`AI run timed out after ${timeoutMs}ms`)
    this.name = 'TimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export const DEFAULT_AI_TIMEOUT_MS = 60_000

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new TimeoutError(timeoutMs)), timeoutMs)
  })

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }
  })
}
