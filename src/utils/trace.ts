import type { Context } from 'hono'

export function getTraceId(c: Context) {
  return (
    c.req.header('x-request-id') ||
    c.req.header('x-trace-id') ||
    c.req.header('cf-ray') ||
    crypto.randomUUID()
  )
}
