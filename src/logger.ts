import 'dotenv/config'
import { appendFile } from 'node:fs/promises'

const LOG_FILE = (process.env.ANCHOR_LOG_FILE || 'anchor-digest.log').trim()

type StructuredLog = {
  category: 'subscription' | 'delivery' | 'webhook' | 'server'
  status: string
  subscription?: string
  eventId?: string
  runId?: string
  eventCount?: number
  messageId?: string
  errorType?: string
}

const safeAppend = async (entry: StructuredLog) => {
  const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry })
  try {
    await appendFile(LOG_FILE, `${line}\n`)
  } catch (error) {
    console.warn('Unable to write structured service log', error instanceof Error ? error.name : 'Error')
  }
}

export const logStructured = (entry: StructuredLog) => {
  void safeAppend(entry)
}
