import { createRoute, z } from '@hono/zod-openapi'
import type { Context } from 'hono'
import type { Bindings } from '../types/hono-env'
import { AiRunError, toErrorBody } from '../utils/ai-errors'
import { runAiModel } from '../services/ai-service'
import { getTraceId } from '../utils/trace'

const AiRunRequestSchema = z.object({
  model: z.string().min(1),
  input: z.unknown().optional(),
  options: z.record(z.unknown()).optional(),
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

export const aiRunRoute = createRoute({
  method: 'post',
  path: '/ai/run',
  tags: ['AI'],
  request: {
    body: {
      required: true,
      content: {
        'application/json': {
          schema: AiRunRequestSchema,
          examples: {
            text_generation_prompt: {
              summary: 'Text generation with prompt',
              value: {
                model: '@cf/meta/llama-3.1-8b-instruct',
                input: {
                  prompt: 'Where did the phrase Hello World come from',
                },
              },
            },
            chat_messages: {
              summary: 'Chat-style messages',
              value: {
                model: '@cf/meta/llama-3.1-8b-instruct',
                input: {
                  messages: [
                    {
                      role: 'system',
                      content: 'You are a friendly assistant.',
                    },
                    {
                      role: 'user',
                      content: 'What is the origin of the phrase Hello, World?',
                    },
                  ],
                },
              },
            },
            embeddings: {
              summary: 'Text embeddings',
              value: {
                model: '@cf/baai/bge-base-en-v1.5',
                input: {
                  text: [
                    'This is a story about an orange cloud',
                    'This is a story about a llama',
                  ],
                },
              },
            },
            text_to_image: {
              summary: 'Text to image',
              value: {
                model: '@cf/black-forest-labs/flux-1-schnell',
                input: {
                  prompt: 'a cyberpunk lizard',
                  seed: 12345,
                },
              },
            },
          },
        },
      },
    },
  },
  responses: {
    200: {
      description: 'AI run result',
      content: {
        'application/json': {
          schema: z.unknown(),
          examples: {
            text_generation_prompt: {
              summary: 'Text generation result',
              value: {
                result: {
                  response: 'The phrase Hello World originated in early programming examples.',
                },
                success: true,
                errors: [],
                messages: [],
              },
            },
            chat_messages: {
              summary: 'Chat completion result',
              value: {
                result: {
                  response: 'It became popular through early programming tutorials.',
                },
                success: true,
                errors: [],
                messages: [],
              },
            },
            embeddings: {
              summary: 'Embeddings result',
              value: {
                result: {
                  shape: [2, 768],
                  data: [
                    [0.01, -0.02, 0.03],
                    [0.02, -0.01, 0.04],
                  ],
                  pooling: 'mean',
                },
                success: true,
                errors: [],
                messages: [],
              },
            },
            text_to_image: {
              summary: 'Text-to-image result',
              value: {
                result: {
                  image: '<base64>',
                },
                success: true,
                errors: [],
                messages: [],
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
          examples: {
            missing_model: {
              summary: 'Missing model',
              value: {
                success: false,
                error: {
                  code: 'INVALID_INPUT',
                  message: 'model is required',
                },
              },
            },
          },
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

export const aiRunHandler = async (c: Context<{ Bindings: Bindings }>) => {
  const traceId = getTraceId(c)
  const { model, input, options } = c.req.valid('json') as z.infer<
    typeof AiRunRequestSchema
  >

  try {
    const result = await runAiModel({
      ai: c.env.AI,
      model,
      input,
      options: options as never,
      traceId,
    })

    if (isReadableStream(result) || isBinary(result)) {
      return new Response(result as BodyInit, {
        headers: {
          'content-type': 'application/octet-stream',
        },
      })
    }

    return c.json(result)
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
}

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
