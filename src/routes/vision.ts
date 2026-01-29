import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { Bindings } from '../types/hono-env'
import { AiRunError, toErrorBody } from '../utils/ai-errors'
import { runAiModel } from '../services/ai-service'
import { getTraceId } from '../utils/trace'
import { decode as decodeAvif } from '@jsquash/avif'
import { encode as encodePng } from '@jsquash/png'

const DEFAULT_DETR_MODEL = '@cf/facebook/detr-resnet-50'
const DEFAULT_THRESHOLD = 0.7
const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

const PersonDetectRequestSchema = z.object({
  url: z.string().url(),
  threshold: z.number().min(0).max(1).optional(),
  model: z.string().optional(),
})

const PersonDetectResponseSchema = z.object({
  success: z.literal(true),
  isPerson: z.boolean(),
})

const AiErrorResponseSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.enum([
      'INVALID_INPUT',
      'AI_RUN_TIMEOUT',
      'AI_RUN_EXCEPTION',
      'AI_RUN_RESPONSE_ERROR',
    ]),
    message: z.string(),
    traceId: z.string().optional(),
    durationMs: z.number().optional(),
    raw: z.unknown().optional(),
    cause: z.unknown().optional(),
  }),
})

export const personDetectRoute = createRoute({
  method: 'post',
  path: '/ai/vision/person-detect',
  tags: ['AI', 'Vision'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: PersonDetectRequestSchema,
          examples: {
            url_only: {
              summary: 'Default threshold and model',
              value: {
                url: 'https://example.com/photo.jpg',
              },
            },
            custom_threshold: {
              summary: 'Custom threshold',
              value: {
                url: 'https://example.com/photo.jpg',
                threshold: 0.6,
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Person detection result',
      content: {
        'application/json': {
          schema: PersonDetectResponseSchema,
          examples: {
            has_person: {
              summary: 'Person detected',
              value: {
                success: true,
                isPerson: true,
              },
            },
            no_person: {
              summary: 'No person detected',
              value: {
                success: true,
                isPerson: false,
              },
            },
          },
        },
      },
    },
    400: {
      description: 'Invalid request',
      content: {
        'application/json': {
          schema: AiErrorResponseSchema,
        },
      },
    },
    500: {
      description: 'Server error',
      content: {
        'application/json': {
          schema: AiErrorResponseSchema,
        },
      },
    },
    502: {
      description: 'Upstream error',
      content: {
        'application/json': {
          schema: AiErrorResponseSchema,
        },
      },
    },
    504: {
      description: 'Upstream timeout',
      content: {
        'application/json': {
          schema: AiErrorResponseSchema,
        },
      },
    },
  },
})

export const personDetectHandler = async (c: Context<{ Bindings: Bindings }>) => {
  const traceId = getTraceId(c)
  const { url, threshold, model } = c.req.valid('json') as z.infer<
    typeof PersonDetectRequestSchema
  >

  try {
    const { buffer, contentType } = await fetchImageBuffer(url, traceId)
    const imageBytes = await maybeTranscodeAvif(buffer, contentType, traceId)
    const inputs = { image: [...imageBytes] }
    const result = await runAiModel({
      ai: c.env.AI,
      model: model ?? DEFAULT_DETR_MODEL,
      input: inputs,
      traceId,
    })

    const isPerson = hasPerson(result, threshold ?? DEFAULT_THRESHOLD)
    return c.json({ success: true, isPerson })
  } catch (error) {
    if (error instanceof AiRunError) {
      return c.json(toErrorBody(error), error.status)
    }
    const fallback = new AiRunError({
      code: 'AI_RUN_EXCEPTION',
      message: 'Person detection failed',
      status: 500,
      traceId,
      cause: error,
    })
    return c.json(toErrorBody(fallback), fallback.status)
  }
}

async function fetchImageBuffer(url: string, traceId: string) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new AiRunError({
        code: 'INVALID_INPUT',
        message: `Failed to fetch image: ${response.status}`,
        status: 502,
        traceId,
      })
    }
    const contentLength = response.headers.get('content-length')
    if (contentLength && Number(contentLength) > MAX_IMAGE_BYTES) {
      throw new AiRunError({
        code: 'INVALID_INPUT',
        message: 'Image is too large',
        status: 400,
        traceId,
      })
    }
    const buffer = await response.arrayBuffer()
    if (buffer.byteLength > MAX_IMAGE_BYTES) {
      throw new AiRunError({
        code: 'INVALID_INPUT',
        message: 'Image is too large',
        status: 400,
        traceId,
      })
    }
    return {
      buffer,
      contentType: response.headers.get('content-type') ?? undefined,
    }
  } catch (error) {
    if (error instanceof AiRunError) {
      throw error
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new AiRunError({
        code: 'AI_RUN_TIMEOUT',
        message: 'Image fetch timed out',
        status: 504,
        traceId,
        cause: error,
      })
    }
    throw new AiRunError({
      code: 'AI_RUN_EXCEPTION',
      message: 'Failed to fetch image',
      status: 502,
      traceId,
      cause: error,
    })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function maybeTranscodeAvif(
  buffer: ArrayBuffer,
  contentType: string | undefined,
  traceId: string
) {
  if (!isAvif(buffer, contentType)) {
    return new Uint8Array(buffer)
  }

  try {
    const imageData = await decodeAvif(new Uint8Array(buffer))
    const pngBuffer = await encodePng(imageData)
    return new Uint8Array(pngBuffer)
  } catch (error) {
    throw new AiRunError({
      code: 'INVALID_INPUT',
      message: 'Failed to decode AVIF image',
      status: 400,
      traceId,
      cause: error,
    })
  }
}

function isAvif(buffer: ArrayBuffer, contentType?: string) {
  if (contentType?.toLowerCase().includes('image/avif')) {
    return true
  }
  const bytes = new Uint8Array(buffer.slice(0, 32))
  if (bytes.length < 12) {
    return false
  }
  const ftyp =
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  if (!ftyp) {
    return false
  }
  const brands = [8, 12, 16, 20, 24, 28]
  for (const offset of brands) {
    if (offset + 4 > bytes.length) {
      continue
    }
    const brand = String.fromCharCode(
      bytes[offset],
      bytes[offset + 1],
      bytes[offset + 2],
      bytes[offset + 3]
    )
    if (brand === 'avif' || brand === 'avis') {
      return true
    }
  }
  return false
}

function hasPerson(result: unknown, threshold: number) {
  if (!Array.isArray(result)) {
    return false
  }
  return result.some((item) => {
    if (!item || typeof item !== 'object') {
      return false
    }
    const record = item as Record<string, unknown>
    return record.label === 'person' && typeof record.score === 'number'
      ? record.score >= threshold
      : false
  })
}
