import type { Context, MiddlewareHandler } from 'hono'
import { AiRunError, toErrorBody } from '../utils/ai-errors'
import { getTraceId } from '../utils/trace'

const PUBLIC_PATHS = new Set(['/docs', '/openapi.json'])

export const apiKeyAuth: MiddlewareHandler = async (c: Context, next) => {
  if (PUBLIC_PATHS.has(c.req.path)) {
    return next()
  }

  const traceId = getTraceId(c)
  const configuredKey = c.env?.API_KEY
  const providedKey = c.req.header('x-api-key')

  if (!configuredKey) {
    const err = new AiRunError({
      code: 'UNAUTHORIZED',
      message: 'API key is not configured',
      status: 401,
      traceId,
    })
    return c.json(toErrorBody(err), err.status)
  }

  if (!providedKey) {
    const err = new AiRunError({
      code: 'UNAUTHORIZED',
      message: 'x-api-key header is required',
      status: 401,
      traceId,
    })
    return c.json(toErrorBody(err), err.status)
  }

  if (providedKey !== configuredKey) {
    const err = new AiRunError({
      code: 'FORBIDDEN',
      message: 'Invalid API key',
      status: 403,
      traceId,
    })
    return c.json(toErrorBody(err), err.status)
  }

  return next()
}
