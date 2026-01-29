import { Scalar } from '@scalar/hono-api-reference'
import { OpenAPIHono } from '@hono/zod-openapi'
import { aiRunHandler, aiRunRoute } from './routes/ai'
import { personDetectHandler, personDetectRoute } from './routes/vision'
import type { Bindings } from './types/hono-env'
import { AiRunError, toErrorBody } from './utils/ai-errors'
import { getTraceId } from './utils/trace'
import { apiKeyAuth } from './middleware/api-key'

const app = new OpenAPIHono<{ Bindings: Bindings }>({
  defaultHook: (result, c) => {
    if (result.success) {
      return
    }
    const traceId = getTraceId(c)
    const err = new AiRunError({
      code: 'INVALID_INPUT',
      message: 'Request validation failed',
      status: 400,
      traceId,
      cause: result.error,
    })
    return c.json(toErrorBody(err), err.status)
  },
})

// OpenAPI 配置
const openApiConfig = {
  openapi: '3.0.0',
  info: {
    title: 'Worker API Template',
    version: '0.1.0',
    description: 'Cloudflare Worker API 项目模板'
  },
  components: {
    securitySchemes: {
      ApiKeyAuth: {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
      },
    },
  },
  security: [
    {
      ApiKeyAuth: [],
    },
  ],
}

// 主页
app.get('/', (c) => {
  return c.json({
    success: true,
    message: 'Worker API Template',
    version: '0.1.0',
    description: 'heelo world',
    documentation: '/docs',
    openapi: '/openapi.json'
  })
})

// API 文档路由
app.get('/docs',
  Scalar({
    theme: 'purple',
    url: '/openapi.json',
  })
)

app.use('*', apiKeyAuth)

app.doc('/openapi.json', openApiConfig)

app.openapi(aiRunRoute, aiRunHandler)
app.openapi(personDetectRoute, personDetectHandler)

export default app
