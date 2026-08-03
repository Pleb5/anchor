import 'localstorage-polyfill'
import { DigestDatabase } from './database.js'
import { DigestCollector } from './digest.js'
import { EmailService } from './mailer.js'
import { DigestScheduler } from './scheduler.js'
import { SubscriptionService } from './actions.js'
import { createServer } from './server.js'
import {
  ANCHOR_DB_PATH,
  ANCHOR_NAME,
  ANCHOR_URL,
  HOST,
  PORT,
  POSTMARK_API_KEY,
  POSTMARK_MESSAGE_STREAM,
  POSTMARK_SENDER_ADDRESS,
  POSTMARK_WEBHOOK_SECRET,
  POSTMARK_WEBHOOK_USERNAME,
  SCHEDULER_POLL_MS,
  appSigner,
} from './env.js'
import { logStructured } from './logger.js'

const database = new DigestDatabase(ANCHOR_DB_PATH)
const collector = new DigestCollector()
const mailer = new EmailService({
  apiKey: POSTMARK_API_KEY,
  sender: POSTMARK_SENDER_ADDRESS,
  anchorName: ANCHOR_NAME,
  anchorUrl: ANCHOR_URL,
  messageStream: POSTMARK_MESSAGE_STREAM,
})
const service = new SubscriptionService(database, mailer, appSigner)
const scheduler = new DigestScheduler(database, collector, mailer, SCHEDULER_POLL_MS, 3)
const { app, closeConnections } = createServer({
  database,
  scheduler,
  service,
  signer: appSigner,
  anchorName: ANCHOR_NAME,
  anchorUrl: ANCHOR_URL,
  webhookUsername: POSTMARK_WEBHOOK_USERNAME,
  webhookSecret: POSTMARK_WEBHOOK_SECRET,
})

let shuttingDown = false
let httpServer: ReturnType<typeof app.listen> | undefined

const shutdown = async (signal: string) => {
  if (shuttingDown) return
  shuttingDown = true
  logStructured({ category: 'server', status: `shutdown_${signal.toLowerCase()}` })
  const forcedExit = setTimeout(() => {
    logStructured({ category: 'server', status: 'shutdown_timeout' })
    process.exit(process.exitCode || 0)
  }, 35_000)

  const boundedServerClose = new Promise<boolean>((resolve) => {
    if (!httpServer) {
      resolve(true)
      return
    }
    const timeout = setTimeout(() => {
      httpServer?.closeAllConnections()
      resolve(false)
    }, 5000)
    httpServer.close(() => {
      clearTimeout(timeout)
      resolve(true)
    })
  })
  await Promise.all([closeConnections(5000), scheduler.stop(), boundedServerClose])
  await database.close()
  clearTimeout(forcedExit)
}

process.once('SIGTERM', () => void shutdown('SIGTERM'))
process.once('SIGINT', () => void shutdown('SIGINT'))
process.on('unhandledRejection', (error) => {
  logStructured({
    category: 'server',
    status: 'unhandled_rejection',
    errorType: error instanceof Error ? error.name : 'Error',
  })
  process.exitCode = 1
  void shutdown('UNHANDLED_REJECTION')
})
process.on('uncaughtException', (error) => {
  logStructured({
    category: 'server',
    status: 'uncaught_exception',
    errorType: error.name,
  })
  process.exitCode = 1
  void shutdown('UNCAUGHT_EXCEPTION')
})

await database.initialize()
scheduler.start()
httpServer = app.listen(PORT, HOST, async () => {
  const pubkey = await appSigner.getPubkey()
  console.log(`Anchor email digest listening on ${HOST}:${PORT} as ${pubkey}`)
})
