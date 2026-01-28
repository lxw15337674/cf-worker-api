# Media Download API 测试用例清单

本文档列出了用于测试 `/api/parse` 接口的各类 URL 场景。这些链接将用于验证解析器的鲁棒性。

## 1. Bilibili (B站)

| 场景 | 示例 URL | 预期解析内容 |
| :--- | :--- | :--- |
| **标准视频 (BV)** | `https://www.bilibili.com/video/BV1GJ411x7h7/` | 标题、封面、视频/音频流地址 |
| **带参数链接** | `https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.1007` | 应能自动过滤参数并解析 |
| **多 P 视频 (P1)** | `https://www.bilibili.com/video/BV1V7411h7cX/?p=1` | 解析第一集 |
| **多 P 视频 (P2)** | `https://www.bilibili.com/video/BV1V7411h7cX/?p=2` | 解析第二集 |
| **短链接** | `https://b23.tv/BV1xx411c7mD` (示例) | 展开后解析 |

## 2. 抖音 (Douyin)

| 场景 | 示例 URL | 预期解析内容 |
| :--- | :--- | :--- |
| **网页版视频** | `https://www.douyin.com/video/7491698414288260387` | 无水印视频链接、作者信息 |
| **网页版旧链接** | `https://www.douyin.com/video/7584822468569812233` | 旧版链接兼容性 |
| **分享短链接** | `https://v.douyin.com/fiU6t9rA3QU` (示例) | 展开并获取无水印视频 |

<!-- ## 3. 小红书 (Xiaohongshu)

| 场景 | 示例 URL | 预期解析内容 |
| :--- | :--- | :--- |
| **视频笔记** | `https://www.xiaohongshu.com/explore/693eaa64000000001e002822` | 视频直链、封面 |
| **图文笔记** | `https://www.xiaohongshu.com/explore/69475603000000001e0153e2` | 高清图片列表 |
| **分享短链接** | `http://xhslink.com/a/b/c` (需替换为真实链接) | 展开并解析成功 | -->

## 4. 异常边界测试 (Exception/Boundary)

| 场景 | URL | 预期结果 |
| :--- | :--- | :--- |
| **非法域名** | `https://www.google.com` | `success: false` 或 `platform: unknown` |
| **纯文本** | `just_a_string` | `success: false`, HTTP 400 |
| **空参数** | `/api/parse?url=` | HTTP 400 |
| **已删除内容** | (需找一个失效链接) | 优雅报错，不崩溃 |

---