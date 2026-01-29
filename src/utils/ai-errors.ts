export type AiErrorCode =
  | 'INVALID_INPUT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'AI_RUN_TIMEOUT'
  | 'AI_RUN_EXCEPTION'
  | 'AI_RUN_RESPONSE_ERROR'

export class AiRunError extends Error {
  code: AiErrorCode
  status: number
  traceId?: string
  durationMs?: number
  raw?: unknown
  cause?: unknown

  constructor(params: {
    code: AiErrorCode
    message: string
    status: number
    traceId?: string
    durationMs?: number
    raw?: unknown
    cause?: unknown
  }) {
    super(params.message)
    this.name = 'AiRunError'
    this.code = params.code
    this.status = params.status
    this.traceId = params.traceId
    this.durationMs = params.durationMs
    this.raw = params.raw
    this.cause = params.cause
  }
}

export function toErrorBody(error: AiRunError) {
  const body: {
    success: false
    error: {
      code: AiErrorCode
      message: string
      traceId?: string
      durationMs?: number
      raw?: unknown
      cause?: unknown
    }
  } = {
    success: false,
    error: {
      code: error.code,
      message: error.message,
    },
  }

  if (error.traceId) {
    body.error.traceId = error.traceId
  }
  if (typeof error.durationMs === 'number') {
    body.error.durationMs = error.durationMs
  }
  if (error.raw !== undefined) {
    body.error.raw = error.raw
  }
  if (error.cause !== undefined) {
    body.error.cause = serializeCause(error.cause)
  }

  return body
}

function serializeCause(cause: unknown) {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message }
  }
  return String(cause)
}
