import { appendFile } from 'node:fs/promises'

const LOG_FILE = (process.env.ANCHOR_LOG_FILE || 'anchor-alerts.log').trim()

type AlertLogEntry = {
  ts: string
  status: string
  eventId: string
  address: string
  pubkey: string
  detail?: string
}

const formatLine = (entry: AlertLogEntry) => JSON.stringify(entry)

const safeAppend = async (line: string) => {
  try {
    await appendFile(LOG_FILE, `${line}\n`)
  } catch (error) {
    console.warn('Failed to write alert log', error)
  }
}

export const logAlertEvent = (entry: Omit<AlertLogEntry, 'ts'>) => {
  void safeAppend(
    formatLine({
      ...entry,
      ts: new Date().toISOString(),
    })
  )
}
