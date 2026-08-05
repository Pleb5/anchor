import 'localstorage-polyfill'
import { DigestDatabase } from './database.js'
import { DigestCollector } from './digest.js'
import { CommunityDigestCollector } from './community-digest.js'
import { CommunityContext } from './community.js'
import { EmailService } from './mailer.js'
import { DigestScheduler } from './scheduler.js'
import { SubscriptionService } from './actions.js'
import { createServer } from './server.js'
import {
  ANCHOR_DB_PATH,
  ANCHOR_NAME,
  ANCHOR_MODE,
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
import { communityDescriptor } from './mode.js'
import type { DigestConfig } from './subscription.js'

const servicePubkey = await appSigner.getPubkey()
const community =
  ANCHOR_MODE.mode === 'community'
    ? new CommunityContext(
        ANCHOR_MODE,
        communityDescriptor(ANCHOR_MODE, servicePubkey, ANCHOR_URL)
      )
    : undefined
if (community) {
  await community.refresh().catch((error) => {
    logStructured({
      category: 'server',
      status: 'community_definition_unavailable',
      errorType: error instanceof Error ? error.name : 'Error',
    })
  })
  community.start()
}
const database = new DigestDatabase(ANCHOR_DB_PATH, ANCHOR_MODE)
const repositoryCollector = ANCHOR_MODE.mode === 'repository' ? new DigestCollector() : undefined
const communityCollector =
  ANCHOR_MODE.mode === 'community' && community
    ? new CommunityDigestCollector(community, ANCHOR_MODE)
    : undefined
const collector = {
  async collect(config: DigestConfig, pubkey: string, periodStart: number, periodEnd: number) {
    if (config.channel === 'community-alerts') {
      if (!communityCollector) throw new Error('Community collector is not configured')
      return communityCollector.collect(config, pubkey, periodStart, periodEnd)
    }
    if (!repositoryCollector) throw new Error('Repository collector is not configured')
    return repositoryCollector.collect(config, pubkey, periodStart, periodEnd)
  },
  async close() {
    await repositoryCollector?.close()
    await communityCollector?.close()
  },
}
const mailer = new EmailService({
  apiKey: POSTMARK_API_KEY,
  sender: POSTMARK_SENDER_ADDRESS,
  anchorName: ANCHOR_NAME,
  anchorUrl: ANCHOR_URL,
  messageStream: POSTMARK_MESSAGE_STREAM,
  mode: ANCHOR_MODE.mode,
  communityPubkey:
    ANCHOR_MODE.mode === 'community' ? ANCHOR_MODE.communityPubkey : undefined,
})
const service = new SubscriptionService(
  database,
  mailer,
  appSigner,
  undefined,
  ANCHOR_MODE,
  community
)
const scheduler = new DigestScheduler(
  database,
  collector,
  mailer,
  SCHEDULER_POLL_MS,
  3,
  undefined,
  community
)
const { app, closeConnections } = createServer({
  database,
  scheduler,
  service,
  signer: appSigner,
  anchorName: ANCHOR_NAME,
  anchorUrl: ANCHOR_URL,
  webhookUsername: POSTMARK_WEBHOOK_USERNAME,
  webhookSecret: POSTMARK_WEBHOOK_SECRET,
  mode: ANCHOR_MODE,
  advertisement: community,
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
  console.log(`Anchor ${ANCHOR_MODE.mode} email service listening on ${HOST}:${PORT} as ${servicePubkey}`)
})
