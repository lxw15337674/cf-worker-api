import type { Ai } from '@cloudflare/workers-types'

export type Bindings = {
  AI: Ai
  API_KEY: string
}
