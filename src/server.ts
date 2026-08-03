import crypto from 'node:crypto'
import express, { type NextFunction, type Request, type Response } from 'express'
import addWebsockets, { type Application } from 'express-ws'
import rateLimit from 'express-rate-limit'
import { WebSocket } from 'ws'
import type { ISigner } from '@welshman/signer'
import type { DigestDatabase } from './database.js'
import type { DigestScheduler } from './scheduler.js'
import { ActionError, SubscriptionService } from './actions.js'
import { Connection, normalizeNip42RelayUrl } from './relay.js'
import { render } from './templates.js'
import { logStructured } from './logger.js'

type ServerDependencies = {
  database: DigestDatabase
  scheduler: DigestScheduler
  service: SubscriptionService
  signer: ISigner
  anchorName: string
  anchorUrl: string
  webhookUsername?: string
  webhookSecret: string
}

type AsyncHandler = (request: Request, response: Response) => Promise<unknown>

export const actionRequestMode = (method: string) =>
  method.toUpperCase() === 'GET' ? 'confirm' : method.toUpperCase() === 'POST' ? 'mutate' : 'reject'

export const acceptsNip11 = (accept: string | undefined) =>
  Boolean(
    accept?.split(',').some((value) => {
      const [mediaType, ...parameters] = value.split(';').map((part) => part.trim().toLowerCase())
      if (mediaType !== 'application/nostr+json') return false
      const quality = parameters.find((parameter) => parameter.startsWith('q='))?.slice(2)
      return quality === undefined || Number.parseFloat(quality) > 0
    })
  )

const secretMatches = (provided: string, expected: string) => {
  const providedBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  return (
    providedBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  )
}

const webhookAuthorized = (
  authorization: string,
  headerSecret: string | undefined,
  username: string,
  secret: string
) => {
  if (headerSecret && secretMatches(headerSecret, secret)) return true
  const bearer = authorization.match(/^Bearer\s+(.+)$/i)?.[1]
  if (bearer && secretMatches(bearer, secret)) return true
  const basic = authorization.match(/^Basic\s+(.+)$/i)?.[1]
  if (!basic) return false
  const decoded = Buffer.from(basic, 'base64').toString('utf8')
  const separator = decoded.indexOf(':')
  if (separator < 0) return false
  return (
    secretMatches(decoded.slice(0, separator), username) &&
    secretMatches(decoded.slice(separator + 1), secret)
  )
}

export function createServer(dependencies: ServerDependencies) {
  const app = express() as unknown as Application
  addWebsockets(app)
  app.set('trust proxy', 1)
  app.disable('x-powered-by')
  app.use(express.json({ limit: '128kb' }))
  app.use(express.urlencoded({ extended: false, limit: '16kb' }))

  const addRoute = (method: 'get' | 'post', path: string, handler: AsyncHandler) => {
    app[method](path, async (request: Request, response: Response, next: NextFunction) => {
      try {
        await handler(request, response)
      } catch (error) {
        next(error)
      }
    })
  }

  addRoute('get', '/health', async (_request, response) => {
    response.json({ status: 'ok' })
  })

  addRoute('get', '/ready', async (_request, response) => {
    const databaseReady = await dependencies.database.ping().catch(() => false)
    const ready = databaseReady && dependencies.scheduler.ready
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      database: databaseReady ? 'ready' : 'not_ready',
      scheduler: dependencies.scheduler.ready ? 'ready' : 'not_ready',
    })
  })

  app.use(
    rateLimit({
      limit: 60,
      windowMs: 5 * 60 * 1000,
      standardHeaders: true,
      legacyHeaders: false,
    })
  )

  addRoute('get', '/', async (request, response) => {
    if (acceptsNip11(request.get('accept'))) {
      response.type('application/nostr+json').json({
        name: dependencies.anchorName,
        description: 'Budabit email digest subscription relay',
        pubkey: await dependencies.signer.getPubkey(),
        supported_nips: [1, 11, 42, 44],
        software: 'https://github.com/coracle-social/anchor',
      })
      return
    }
    response.type('html').send(await render('pages/index.html'))
  })

  addRoute('get', '/confirm', async (request, response) => {
    const token = typeof request.query.token === 'string' ? request.query.token : ''
    try {
      await dependencies.service.inspectConfirmation(token)
      response.send(await render('pages/confirm.html', { token }))
    } catch (error) {
      const message = error instanceof ActionError ? error.message : 'Confirmation is unavailable.'
      response.status(400).send(await render('pages/confirm-error.html', { message }))
    }
  })

  addRoute('post', '/confirm', async (request, response) => {
    const token = typeof request.body?.token === 'string' ? request.body.token : ''
    try {
      await dependencies.service.confirm(token)
      response.send(await render('pages/confirm-success.html'))
    } catch (error) {
      if (!(error instanceof ActionError)) throw error
      response.status(400).send(await render('pages/confirm-error.html', { message: error.message }))
    }
  })

  addRoute('get', '/unsubscribe', async (request, response) => {
    const token = typeof request.query.token === 'string' ? request.query.token : ''
    try {
      await dependencies.service.inspectUnsubscribe(token)
      response.send(await render('pages/unsubscribe.html', { token }))
    } catch (error) {
      const message = error instanceof ActionError ? error.message : 'Unsubscribe is unavailable.'
      response.status(400).send(await render('pages/action-error.html', { message }))
    }
  })

  addRoute('post', '/unsubscribe', async (request, response) => {
    const token =
      typeof request.query.token === 'string'
        ? request.query.token
        : typeof request.body?.token === 'string'
          ? request.body.token
          : ''
    const oneClick = request.body?.['List-Unsubscribe'] === 'One-Click'
    try {
      await dependencies.service.unsubscribe(token)
      if (oneClick) response.status(200).send('Unsubscribed')
      else response.send(await render('pages/unsubscribe-success.html'))
    } catch (error) {
      if (!(error instanceof ActionError)) throw error
      if (oneClick) response.status(400).send('Invalid or expired unsubscribe token')
      else response.status(400).send(await render('pages/action-error.html', { message: error.message }))
    }
  })

  const webhookHandler: AsyncHandler = async (request, response) => {
    const authorization = request.get('authorization') || ''
    if (
      !webhookAuthorized(
        authorization,
        request.get('x-anchor-webhook-secret'),
        dependencies.webhookUsername || 'anchor',
        dependencies.webhookSecret
      )
    ) {
      response.status(401).json({ error: 'Unauthorized' })
      return
    }

    const metadata = request.body?.Metadata
    const pubkey = metadata?.subscription_pubkey
    const recordType = request.body?.RecordType
    if (
      typeof pubkey !== 'string' ||
      !/^[0-9a-f]{64}$/.test(pubkey) ||
      !['Bounce', 'SpamComplaint'].includes(recordType)
    ) {
      response.status(400).json({ error: 'Invalid webhook payload' })
      return
    }
    const email = typeof request.body?.Email === 'string' ? request.body.Email : undefined
    const shouldSuppress = recordType === 'SpamComplaint' || request.body?.Inactive === true
    const reason = recordType === 'SpamComplaint' ? 'spam complaint' : 'permanent bounce'
    const suppressed = shouldSuppress
      ? await dependencies.database.suppressSubscription(
          pubkey,
          email,
          reason,
          Math.floor(Date.now() / 1000)
        )
      : false
    logStructured({
      category: 'webhook',
      status: shouldSuppress ? (suppressed ? 'suppressed' : 'not_matched') : 'soft_bounce',
      subscription: pubkey,
    })
    response.status(200).json({ received: true, suppressed })
  }
  addRoute('post', '/webhooks/postmark', webhookHandler)
  addRoute('post', '/webhooks/postmark/bounce', webhookHandler)
  addRoute('post', '/webhooks/postmark/spam', webhookHandler)

  const connections = new Set<Connection>()
  const messageChains = new Set<Promise<void>>()
  const socketClosePromises = new Map<Connection, Promise<void>>()
  let closingConnections = false
  const relayUrl = normalizeNip42RelayUrl(dependencies.anchorUrl)
  app.ws('/', (socket: WebSocket) => {
    const connection = new Connection(
      socket,
      dependencies.database,
      dependencies.service,
      dependencies.signer,
      relayUrl
    )
    connections.add(connection)
    let resolveSocketClose = () => {}
    const socketClosed = new Promise<void>((resolve) => {
      resolveSocketClose = resolve
    })
    socketClosePromises.set(connection, socketClosed)
    let finalized = false
    let messages = Promise.resolve()
    const finalize = () => {
      if (finalized) return
      finalized = true
      connection.cleanup()
      connections.delete(connection)
      socketClosePromises.delete(connection)
      resolveSocketClose()
    }

    socket.on('message', (message) => {
      if (closingConnections) return
      const next = messages
        .then(() => connection.handle(message))
        .catch((error) => {
          logStructured({
            category: 'server',
            status: 'websocket_handler_error',
            errorType: error instanceof Error ? error.name : 'Error',
          })
          connection.close()
        })
      messages = next
      messageChains.add(next)
      void next.finally(() => messageChains.delete(next))
    })
    socket.once('error', () => {
      connection.close()
    })
    socket.once('close', finalize)
  })

  app.use((error: Error, _request: Request, response: Response, next: NextFunction) => {
    if (!error) return next()
    if (error instanceof ActionError) {
      response.status(400).json({ error: error.message })
      return
    }
    logStructured({
      category: 'server',
      status: 'request_error',
      errorType: error.name,
    })
    response.status(500).json({ error: 'Internal server error' })
  })

  return {
    app,
    closeConnections: async (timeoutMs = 5000) => {
      closingConnections = true
      const closing = [...connections]
      const socketClosures = closing.flatMap((connection) => {
        const closed = socketClosePromises.get(connection)
        return closed ? [closed] : []
      })
      for (const connection of closing) connection.close()
      const pending = [...messageChains, ...socketClosures]
      if (pending.length === 0) return true

      let timeout: NodeJS.Timeout | undefined
      const drained = await Promise.race([
        Promise.allSettled(pending).then(() => true),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), timeoutMs)
        }),
      ])
      if (timeout) clearTimeout(timeout)
      if (!drained) {
        for (const connection of closing) {
          if (connections.has(connection)) connection.terminate()
        }
        await Promise.allSettled(socketClosures)
        logStructured({ category: 'server', status: 'websocket_drain_timeout' })
      }
      return drained
    },
  }
}
