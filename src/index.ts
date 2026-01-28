import { Hono } from 'hono'
import { Scalar } from '@scalar/hono-api-reference'
import { aiRoutes } from './routes/ai'
import type { Bindings } from './types/hono-env'

const app = new Hono<{ Bindings: Bindings }>()

// OpenAPI 配置
const openApiConfig = {
  openapi: '3.0.0',
  info: {
    title: 'Worker API Template',
    version: '0.1.0',
    description: 'Cloudflare Worker API 项目模板'
  },
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
  })
)

// OpenAPI JSON 端点 - 模板规范（空路径）
app.get('/openapi.json', (c) => {
  const fullSpec = {
    ...openApiConfig,
    paths: {}
  }
  return c.json(fullSpec)
})

app.route('/ai', aiRoutes)

export default app
