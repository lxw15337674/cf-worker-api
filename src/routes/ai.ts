import { Hono } from 'hono'
import type { Bindings } from '../types/hono-env'
import { AiRunError, toErrorBody } from '../utils/ai-errors'
import { runAiModel } from '../services/ai-service'
import { getTraceId } from '../utils/trace'

type AiRunBody = {
  model?: string
  input?: unknown
  options?: Record<string, unknown>
}

const aiRoutes = new Hono<{ Bindings: Bindings }>()

aiRoutes.post('/run', async (c) => {
  const traceId = getTraceId(c)

  let body: AiRunBody
  try {
    body = (await c.req.json()) as AiRunBody
  } catch (error) {
    const err = new AiRunError({
      code: 'INVALID_INPUT',
      message: 'Request body must be valid JSON',
      status: 400,
      traceId,
      cause: error,
    })
    return c.json(toErrorBody(err), err.status)
  }

  if (!body || typeof body !== 'object') {
    const err = new AiRunError({
      code: 'INVALID_INPUT',
      message: 'Request body must be an object',
      status: 400,
      traceId,
    })
    return c.json(toErrorBody(err), err.status)
  }

  const model = typeof body.model === 'string' ? body.model.trim() : ''
  if (!model) {
    const err = new AiRunError({
      code: 'INVALID_INPUT',
      message: 'model is required',
      status: 400,
      traceId,
    })
    return c.json(toErrorBody(err), err.status)
  }

  if (
    body.options !== undefined &&
    (typeof body.options !== 'object' || body.options === null || Array.isArray(body.options))
  ) {
    const err = new AiRunError({
      code: 'INVALID_INPUT',
      message: 'options must be an object when provided',
      status: 400,
      traceId,
    })
    return c.json(toErrorBody(err), err.status)
  }

  const options = body.options ?? {}
  let result: unknown
  try {
    result = await runAiModel({
      ai: c.env.AI,
      model,
      input: body.input,
      options: options as never,
      traceId,
    })
  } catch (error) {
    if (error instanceof AiRunError) {
      return c.json(toErrorBody(error), error.status)
    }
    const fallback = new AiRunError({
      code: 'AI_RUN_EXCEPTION',
      message: 'AI run threw an unexpected error',
      status: 500,
      traceId,
      cause: error,
    })
    return c.json(toErrorBody(fallback), fallback.status)
  }

  if (result instanceof Response) {
    return result
  }

  if (isReadableStream(result) || isBinary(result)) {
    return new Response(result as BodyInit, {
      headers: {
        'content-type': 'application/octet-stream',
      },
    })
  }

  return c.json(result)
})

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'getReader' in (value as Record<string, unknown>)
  )
}

function isBinary(value: unknown) {
  if (value instanceof ArrayBuffer) {
    return true
  }
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(value)) {
    return true
  }
  return false
}

export { aiRoutes }
