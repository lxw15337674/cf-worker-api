import { createRoute, extendZodWithOpenApi, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { Bindings } from '../types/hono-env'
import { AiRunError, toErrorBody } from '../utils/ai-errors'
import { runAiModel } from '../services/ai-service'
import { getTraceId } from '../utils/trace'
import { decode as decodeAvif } from '@jsquash/avif'
import { encode as encodePng } from '@jsquash/png'

const DEFAULT_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct'
const PERSON_AREA_RATIO = 0.3
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

extendZodWithOpenApi(z)

const PersonDetectRequestSchema = z.object({
  url: z
    .string()
    .url()
    .openapi({ description: 'Public image URL to fetch and analyze.' }),
})

const PersonDetectUploadSchema = z.object({
  file: z.any().openapi({
    type: 'string',
    format: 'binary',
    description: 'Image file to upload and analyze.',
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
  summary: 'Detect person (Llama 4 Scout)',
  description:
    'Returns isPerson=true only when a person occupies at least 30% of the image area.',
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
              summary: 'Alternate sample image',
              value: {
                url: 'https://gallery233.pages.dev/file/CAACAgUAAyEGAASTYPw6AAEErwppelx1gAZ3GYjD_GgMNvp5dcFoCQACiBcAAivo2FdGPB0AAVbLGgw4BA.webp',
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

      const buffer = await file.arrayBuffer()
      const { bytes, contentType: finalContentType } =
        await normalizeImageBytes(buffer, file.type, traceId)
      const isPerson = await detectPersonWithLlama(
        bytes,
        finalContentType,
        traceId,
        c.env.AI
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
    const { url } = parsed.data
    const { buffer, contentType: fetchedContentType } = await fetchImageBuffer(
      url,
      traceId
    )
    const { bytes, contentType: finalContentType } = await normalizeImageBytes(
      buffer,
      fetchedContentType,
      traceId
    )
    const isPerson = await detectPersonWithLlama(
      bytes,
      finalContentType,
      traceId,
      c.env.AI
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

async function normalizeImageBytes(
  buffer: ArrayBuffer,
  contentType: string | undefined,
  traceId: string
) {
  if (isAvif(buffer, contentType)) {
    try {
      const imageData = await decodeAvif(new Uint8Array(buffer))
      const pngBuffer = await encodePng(imageData)
      return {
        bytes: new Uint8Array(pngBuffer),
        contentType: 'image/png',
      }
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

  const bytes = new Uint8Array(buffer)
  const resolvedType = normalizeMimeType(contentType, bytes)
  return { bytes, contentType: resolvedType }
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

function normalizeMimeType(contentType: string | undefined, bytes: Uint8Array) {
  if (contentType) {
    const normalized = contentType.split(';')[0].trim().toLowerCase()
    if (normalized.startsWith('image/')) {
      return normalized
    }
  }
  return detectMimeType(bytes) ?? 'image/png'
}

function detectMimeType(bytes: Uint8Array) {
  if (bytes.length >= 12) {
    if (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return 'image/png'
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) {
      return 'image/jpeg'
    }
    if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
      return 'image/gif'
    }
    if (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return 'image/webp'
    }
  }
  return undefined
}

async function detectPersonWithLlama(
  bytes: Uint8Array,
  contentType: string,
  traceId: string,
  ai: Bindings['AI']
) {
  const dataUri = buildDataUri(bytes, contentType)
  const minAreaPercent = Math.round(PERSON_AREA_RATIO * 100)
  const result = await runAiModel({
    ai,
    model: DEFAULT_MODEL,
    input: {
      messages: [
        {
          role: 'system',
          content:
            'You are a vision classifier. Respond with JSON only, no extra text.',
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                `Return {"isPerson": true} only if a person occupies at least ${minAreaPercent}% of the image area. ` +
                'If unsure, return {"isPerson": false}.',
            },
            {
              type: 'image_url',
              image_url: {
                url: dataUri,
              },
            },
          ],
        },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          type: 'object',
          properties: {
            isPerson: { type: 'boolean' },
          },
          required: ['isPerson'],
          additionalProperties: false,
        },
      },
      temperature: 0,
      max_tokens: 32,
    },
    traceId,
  })

  const parsed = extractIsPersonResult(result)
  if (!parsed || typeof parsed.isPerson !== 'boolean') {
    throw new AiRunError({
      code: 'AI_RUN_RESPONSE_ERROR',
      message: 'Model returned invalid JSON',
      status: 502,
      traceId,
      raw: result,
    })
  }

  return parsed.isPerson
}

function extractIsPersonResult(result: unknown) {
  if (!result || typeof result !== 'object') {
    return null
  }
  const record = result as Record<string, unknown>
  const direct = normalizeIsPerson(record.response)
  if (direct) {
    return direct
  }
  if (
    record.result &&
    typeof record.result === 'object' &&
    (record.result as Record<string, unknown>).response !== undefined
  ) {
    return normalizeIsPerson((record.result as Record<string, unknown>).response)
  }
  if (typeof record.response === 'string') {
    return parseJsonFromText(record.response)
  }
  return null
}

function parseJsonFromText(text: string) {
  const trimmed = text.trim()
  try {
    return JSON.parse(trimmed) as { isPerson?: unknown }
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1)) as {
          isPerson?: unknown
        }
      } catch {
        return null
      }
    }
    return null
  }
}

function normalizeIsPerson(value: unknown) {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    if (typeof record.isPerson === 'boolean') {
      return { isPerson: record.isPerson }
    }
  }
  if (typeof value === 'string') {
    return parseJsonFromText(value)
  }
  return null
}

function buildDataUri(bytes: Uint8Array, contentType: string) {
  const base64 = toBase64(bytes)
  return `data:${contentType};base64,${base64}`
}

function toBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}
