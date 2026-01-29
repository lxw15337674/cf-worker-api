import type { Ai, AiOptions } from '@cloudflare/workers-types'
import { AiRunError } from '../utils/ai-errors'
import { DEFAULT_AI_TIMEOUT_MS, TimeoutError, withTimeout } from '../utils/timeout'

export type AiRunWrapperOptions = AiOptions & {
  timeoutMs?: number
  traceId?: string
}

export type AiRunParams = {
  ai: Ai
  model: string
  input: unknown
  options?: AiRunWrapperOptions
  traceId: string
}

export async function runAiModel({
  ai,
  model,
  input,
  options,
  traceId,
}: AiRunParams) {
  const startedAt = Date.now()
  const { timeoutMs, traceId: overrideTraceId, ...aiOptions } = options ?? {}
  const effectiveTraceId = overrideTraceId || traceId
  const effectiveTimeoutMs =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_AI_TIMEOUT_MS

  try {
    const result = await withTimeout(
      ai.run(model as never, input as never, aiOptions as AiOptions),
      effectiveTimeoutMs
    )

    
    const durationMs = Date.now() - startedAt
    logAiSuccess({
      model,
      durationMs,
      traceId: effectiveTraceId,
      gatewayLogId: ai.aiGatewayLogId ?? undefined,
    })

    if (isErrorResponse(result)) {
      throw new AiRunError({
        code: 'AI_RUN_RESPONSE_ERROR',
        message: 'AI run returned an error response',
        status: 502,
        traceId: effectiveTraceId,
        durationMs,
        raw: result,
      })
    }

    return result
  } catch (error) {
    const durationMs = Date.now() - startedAt

    if (error instanceof AiRunError) {
      logAiFailure(error, model, ai.aiGatewayLogId ?? undefined)
      throw error
    }

    if (error instanceof TimeoutError) {
      const wrapped = new AiRunError({
        code: 'AI_RUN_TIMEOUT',
        message: error.message,
        status: 504,
        traceId: effectiveTraceId,
        durationMs,
        cause: error,
      })
      logAiFailure(wrapped, model, ai.aiGatewayLogId ?? undefined)
      throw wrapped
    }

    const wrapped = new AiRunError({
      code: 'AI_RUN_EXCEPTION',
      message: 'AI run threw an exception',
      status: 500,
      traceId: effectiveTraceId,
      durationMs,
      cause: error,
    })
    logAiFailure(wrapped, model, ai.aiGatewayLogId ?? undefined)
    throw wrapped
  }
}

function isErrorResponse(value: unknown) {
  if (!value || typeof value !== 'object') {
    return false
  }
  const record = value as Record<string, unknown>
  if (record.success === false) {
    return true
  }
  if (Array.isArray(record.errors) && record.errors.length > 0) {
    return true
  }
  return false
}

function logAiSuccess(params: {
  model: string
  durationMs: number
  traceId: string
  gatewayLogId?: string
}) {
  console.log({
    event: 'ai_run_success',
    model: params.model,
    durationMs: params.durationMs,
    traceId: params.traceId,
    gatewayLogId: params.gatewayLogId,
  })
}

function logAiFailure(error: AiRunError, model: string, gatewayLogId?: string) {
  console.error({
    event: 'ai_run_error',
    model,
    errorCode: error.code,
    message: error.message,
    durationMs: error.durationMs,
    traceId: error.traceId,
    gatewayLogId,
  })
}
