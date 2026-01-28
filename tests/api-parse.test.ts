import { expect, test, describe } from 'vitest'
import app from '../src/index'

describe('Media Download API - /api/parse', () => {
  
  // Bilibili 测试
  describe('Bilibili', () => {
    test('解析标准视频链接', async () => {
      const res = await app.request('/api/parse?url=https://www.bilibili.com/video/BV1GJ411x7h7/')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.data.platform).toBe('bili')
      expect(data.data.title).toBeDefined()
    })

    test('解析短链接', async () => {
      const res = await app.request('/api/parse?url=https://b23.tv/BV1xx411c7mD')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.data.platform).toBe('bili')
    })
  })

  // 抖音测试
  describe('Douyin', () => {
    test('解析视频链接', async () => {
      const res = await app.request('/api/parse?url=https://www.douyin.com/video/7491698414288260387')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.data.platform).toBe('douyin')
      expect(data.data.title).toContain('济公')
    })

    test('解析精选页modal_id格式链接', async () => {
      const res = await app.request('/api/parse?url=https://www.douyin.com/jingxuan?modal_id=7573004270581140751')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.data.platform).toBe('douyin')
      expect(data.data.title).toBeDefined()
    })

    test('解析抖音口令（从文本中提取URL）', async () => {
      const shareText = '7.17 复制打开抖音，看看【开心的小丁ya的作品】郑州跨年三大避雷景点  https://v.douyin.com/A0DM9yrpyko/ V@Y.ZZ XMJ:/ 08/10'
      const res = await app.request(`/api/parse?url=${encodeURIComponent(shareText)}`)
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.data.platform).toBe('douyin')
      expect(data.data.title).toBeDefined()
    })

    test('解析抖音短链接 (示例1)', async () => {
      const res = await app.request('/api/parse?url=https://v.douyin.com/fiU6t9rA3QU/')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.data.platform).toBe('douyin')
    })

    test('解析抖音短链接 (示例2 - 曾因误判图文失败)', async () => {
      const res = await app.request('/api/parse?url=https://v.douyin.com/uJzqMYeqOe8/')
      expect(res.status).toBe(200)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.data.platform).toBe('douyin')
      expect(data.data.title).toBeDefined()
    })
  })

  // // 小红书测试
  // describe('Xiaohongshu', () => {
  //   test.skip('解析视频笔记', async () => {
  //     const res = await app.request('/api/parse?url=https://www.xiaohongshu.com/explore/656598c1000000000102d53c')
  //     expect(res.status).toBe(200)
  //     const data = await res.json()
  //     expect(data.success).toBe(true)
  //     expect(data.data.platform).toBe('xiaohongshu')
  //   })
  // })

  // 异常处理测试
  describe('Error Handling', () => {
    test('处理不支持的域名', async () => {
      const res = await app.request('/api/parse?url=https://www.google.com')
      const data = await res.json()
      expect(data.success).toBe(false)
      expect(data.error).toContain('不支持')
    })

    test('处理非法格式', async () => {
      const res = await app.request('/api/parse?url=not-a-url')
      const data = await res.json()
      expect(data.success).toBe(false)
    })
  })
})
