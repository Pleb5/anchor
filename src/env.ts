import 'dotenv/config'
import { Nip01Signer } from '@welshman/signer'
import { parseAnchorMode } from './mode.js'

const required = (name: string) => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is not defined.`)
  return value
}

const integer = (name: string, fallback: number) => {
  const value = process.env[name]
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`)
  return parsed
}

export const ANCHOR_NAME = required('ANCHOR_NAME')
export const ANCHOR_URL = required('ANCHOR_URL').replace(/\/$/, '')
export const appSigner = Nip01Signer.fromSecret(required('ANCHOR_SECRET'))
export const POSTMARK_API_KEY = required('POSTMARK_API_KEY')
export const POSTMARK_SENDER_ADDRESS = required('POSTMARK_SENDER_ADDRESS')
export const POSTMARK_MESSAGE_STREAM = process.env.POSTMARK_MESSAGE_STREAM?.trim() || 'outbound'
export const POSTMARK_WEBHOOK_USERNAME = process.env.POSTMARK_WEBHOOK_USERNAME?.trim() || 'anchor'
export const POSTMARK_WEBHOOK_SECRET = required('POSTMARK_WEBHOOK_SECRET')
export const HOST = process.env.HOST?.trim() || '127.0.0.1'
export const PORT = integer('PORT', 4738)
export const SCHEDULER_POLL_MS = integer('SCHEDULER_POLL_MS', 30_000)
export const ANCHOR_DB_PATH = process.env.ANCHOR_DB_PATH?.trim() || 'anchor.db'
export const ANCHOR_MODE = parseAnchorMode(process.env)
