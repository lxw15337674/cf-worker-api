import { createRoute, extendZodWithOpenApi, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { Bindings } from '../types/hono-env'
import { AiRunError, toErrorBody } from '../utils/ai-errors'
import { runAiModel } from '../services/ai-service'
import { getTraceId } from '../utils/trace'
import { decode as decodeAvif } from '@jsquash/avif'
import { encode as encodePng } from '@jsquash/png'

const DEFAULT_DETR_MODEL = '@cf/facebook/detr-resnet-50'
const DEFAULT_THRESHOLD = 0.7
const DEFAULT_MIN_AREA_RATIO = 0.2
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

extendZodWithOpenApi(z)

const PersonDetectRequestSchema = z.object({
  url: z
    .string()
    .url()
    .openapi({ description: 'Public image URL to fetch and analyze.' }),
  threshold: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .openapi({ description: 'Confidence threshold for person detection.' }),
  minAreaRatio: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .openapi({
      description: 'Minimum person box area ratio (0-1). Default is 0.2.',
    }),
  model: z
    .string()
    .optional()
    .openapi({
      description: 'Optional model override. Default is @cf/facebook/detr-resnet-50.',
    }),
})

const PersonDetectUploadSchema = z.object({
  file: z.any().openapi({
    type: 'string',
    format: 'binary',
    description: 'Image file to upload and analyze.',
  }),
  threshold: z
    .union([z.string(), z.number()])
    .optional()
    .openapi({ description: 'Confidence threshold for person detection.' }),
  minAreaRatio: z
    .union([z.string(), z.number()])
    .optional()
    .openapi({
      description: 'Minimum person box area ratio (0-1). Default is 0.2.',
    }),
  model: z
    .string()
    .optional()
    .openapi({
      description: 'Optional model override. Default is @cf/facebook/detr-resnet-50.',
    }),
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
      'UNAUTHORIZED',
      'FORBIDDEN',
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
                url: 'https://gallery233.pages.dev/file/CAACAgUAAyEGAASTYPw6AAEErwppelx1gAZ3GYjD_GgMNvp5dcFoCQACiBcAAivo2FdGPB0AAVbLGgw4BA.webp',
              },
            },
            custom_threshold: {
              summary: 'Custom threshold',
              value: {
                url: 'https://gallery233.pages.dev/file/CAACAgUAAyEGAASTYPw6AAEErwppelx1gAZ3GYjD_GgMNvp5dcFoCQACiBcAAivo2FdGPB0AAVbLGgw4BA.webp',
                threshold: 0.6,
                minAreaRatio: 0.2,
              },
            },
            area_ratio_only: {
              summary: 'Minimum person box area ratio',
              value: {
                url: 'https://gallery233.pages.dev/file/CAACAgUAAyEGAASTYPw6AAEErwppelx1gAZ3GYjD_GgMNvp5dcFoCQACiBcAAivo2FdGPB0AAVbLGgw4BA.webp',
                minAreaRatio: 0.2,
              },
            },
          },
        },
        'multipart/form-data': {
          schema: PersonDetectUploadSchema,
          examples: {
            upload: {
              summary: 'Upload image file',
              value: {
                file: '<binary>',
                threshold: '0.7',
                minAreaRatio: '0.2',
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
  const contentType = c.req.header('content-type') ?? ''

  try {
    if (contentType.includes('multipart/form-data')) {
      const body = (await c.req.parseBody()) as Record<string, unknown>
      const file = body.file
      if (!(file instanceof File)) {
        throw new AiRunError({
          code: 'INVALID_INPUT',
          message: 'file is required',
          status: 400,
          traceId,
        })
      }
      if (file.size > MAX_IMAGE_BYTES) {
        throw new AiRunError({
          code: 'INVALID_INPUT',
          message: 'Image is too large',
          status: 400,
          traceId,
        })
      }

      const threshold = parseThreshold(body.threshold)
      const minAreaRatio = parseRatio(body.minAreaRatio)
      const model = typeof body.model === 'string' ? body.model : undefined
      const buffer = await file.arrayBuffer()
      const imageBytes = await maybeTranscodeAvif(buffer, file.type, traceId)
      const inputs = { image: [...imageBytes] }
      const result = await runAiModel({
        ai: c.env.AI,
        model: model ?? DEFAULT_DETR_MODEL,
        input: inputs,
        traceId,
      })

      const isPerson = hasPerson(
        result,
        threshold ?? DEFAULT_THRESHOLD,
        minAreaRatio ?? DEFAULT_MIN_AREA_RATIO
      )
      return c.json({ success: true, isPerson })
    }

    if (contentType && !isJsonContentType(contentType)) {
      throw new AiRunError({
        code: 'INVALID_INPUT',
        message: 'Unsupported content-type',
        status: 400,
        traceId,
      })
    }

    let jsonBody: unknown
    try {
      jsonBody = await c.req.json()
    } catch (error) {
      throw new AiRunError({
        code: 'INVALID_INPUT',
        message: 'Request body must be valid JSON',
        status: 400,
        traceId,
        cause: error,
      })
    }

    const parsed = PersonDetectRequestSchema.safeParse(jsonBody)
    if (!parsed.success) {
      throw new AiRunError({
        code: 'INVALID_INPUT',
        message: 'Request body must be valid JSON',
        status: 400,
        traceId,
        cause: parsed.error,
      })
    }
    const { url, threshold, model, minAreaRatio } = parsed.data
    const { buffer, contentType: fetchedContentType } = await fetchImageBuffer(
      url,
      traceId
    )
    const imageBytes = await maybeTranscodeAvif(
      buffer,
      fetchedContentType,
      traceId
    )
    const inputs = { image: [...imageBytes] }
    const result = await runAiModel({
      ai: c.env.AI,
      model: model ?? DEFAULT_DETR_MODEL,
      input: inputs,
      traceId,
    })

    const isPerson = hasPerson(
      result,
      threshold ?? DEFAULT_THRESHOLD,
      minAreaRatio ?? DEFAULT_MIN_AREA_RATIO
    )
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

function isJsonContentType(contentType: string) {
  const value = contentType.toLowerCase()
  return value.includes('application/json') || value.includes('+json')
}

function parseRatio(value: unknown) {
  const parsed = parseThreshold(value)
  if (typeof parsed === 'number' && parsed >= 0 && parsed <= 1) {
    return parsed
  }
  return undefined
}

function parseThreshold(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }
  return undefined
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

function hasPerson(result: unknown, threshold: number, minAreaRatio: number) {
  if (!Array.isArray(result)) {
    return false
  }
  console.log('Detection result:', result)
  debugger
  return result.some((item) => {
    if (!item || typeof item !== 'object') {
      return false
    }
    const record = item as Record<string, unknown>
    if (record.label !== 'person' || typeof record.score !== 'number') {
      return false
    }
    if (record.score < threshold) {
      return false
    }

    const ratio = extractAreaRatio(record)
    if (ratio === null) {
      return true
    }
    return ratio >= minAreaRatio
  })
}

function extractAreaRatio(record: Record<string, unknown>) {
  const box = record.box
  if (!box || typeof box !== 'object') {
    return null
  }

  const asRecord = box as Record<string, unknown>
  const x1 = numberOrUndefined(
    asRecord.xmin ?? asRecord.x1 ?? asRecord.left ?? asRecord.x0
  )
  const y1 = numberOrUndefined(
    asRecord.ymin ?? asRecord.y1 ?? asRecord.top ?? asRecord.y0
  )
  const x2 = numberOrUndefined(
    asRecord.xmax ?? asRecord.x2 ?? asRecord.right ?? asRecord.x1
  )
  const y2 = numberOrUndefined(
    asRecord.ymax ?? asRecord.y2 ?? asRecord.bottom ?? asRecord.y1
  )
  if (x1 !== undefined && y1 !== undefined && x2 !== undefined && y2 !== undefined) {
    const width = x2 - x1
    const height = y2 - y1
    return normalizedArea(width, height)
  }

  const width = numberOrUndefined(asRecord.w ?? asRecord.width)
  const height = numberOrUndefined(asRecord.h ?? asRecord.height)
  if (width !== undefined && height !== undefined) {
    return normalizedArea(width, height)
  }

  if (Array.isArray(box) && box.length >= 4) {
    const bx1 = numberOrUndefined(box[0])
    const by1 = numberOrUndefined(box[1])
    const bx2 = numberOrUndefined(box[2])
    const by2 = numberOrUndefined(box[3])
    if (bx1 !== undefined && by1 !== undefined && bx2 !== undefined && by2 !== undefined) {
      return normalizedArea(bx2 - bx1, by2 - by1)
    }
  }

  return null
}

function normalizedArea(width: number, height: number) {
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    return null
  }
  if (width <= 0 || height <= 0) {
    return null
  }
  if (width > 1 || height > 1) {
    return null
  }
  return width * height
}

function numberOrUndefined(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value
  }
  return undefined
}
