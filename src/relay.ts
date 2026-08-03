import { WebSocket } from 'ws'
import { decrypt, type ISigner } from '@welshman/signer'
import { randomId } from '@welshman/lib'
import {
  CLIENT_AUTH,
  DELETE,
  matchFilters,
  getTagValue,
  verifyEvent,
  type Filter,
  type SignedEvent,
} from '@welshman/util'
import type { DigestDatabase } from './database.js'
import { ActionError, SubscriptionService } from './actions.js'
import {
  DIGEST_SUBSCRIPTION_KIND,
  MAX_EVENT_AGE_SECONDS,
  MAX_EVENT_FUTURE_SECONDS,
  parseDigestConfig,
  validateSubscriptionEvent,
  ValidationError,
} from './subscription.js'
import { logStructured } from './logger.js'

type RelayMessage = [string, ...any[]]

const currentSeconds = () => Math.floor(Date.now() / 1000)

export const normalizeNip42RelayUrl = (value: string) => {
  const url = new URL(value)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Invalid relay URL')
  }
  return url.toString()
}

export class Connection {
  private readonly subscriptions = new Map<string, Filter[]>()
  private cleaned = false
  private auth: { challenge: string; event?: SignedEvent } = { challenge: randomId() }

  constructor(
    private readonly socket: WebSocket,
    private readonly database: DigestDatabase,
    private readonly service: SubscriptionService,
    private readonly signer: ISigner,
    private readonly expectedRelayUrl: string
  ) {
    this.send(['AUTH', this.auth.challenge])
  }

  cleanup() {
    if (this.cleaned) return
    this.cleaned = true
    this.subscriptions.clear()
  }

  close() {
    this.cleanup()
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close(1001, 'server shutdown')
    }
  }

  terminate() {
    this.cleanup()
    this.socket.terminate()
  }

  private send(message: RelayMessage) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message))
    }
  }

  async handle(message: WebSocket.Data) {
    let parsed: unknown
    try {
      parsed = JSON.parse(message.toString())
    } catch {
      this.send(['NOTICE', 'Unable to parse message'])
      return
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') {
      this.send(['NOTICE', 'Unable to read message'])
      return
    }

    const [verb, ...payload] = parsed as RelayMessage
    const handler = this[`on${verb}` as keyof Connection]
    if (typeof handler !== 'function' || !['onAUTH', 'onREQ', 'onCLOSE', 'onEVENT'].includes(`on${verb}`)) {
      this.send(['NOTICE', `Unable to handle ${verb} message`])
      return
    }
    await (handler as (...args: any[]) => Promise<void>).call(this, ...payload)
  }

  private async onAUTH(event: SignedEvent) {
    if (!event || !verifyEvent(event)) {
      this.send(['OK', event?.id || '', false, 'invalid signature'])
      return
    }
    if (event.kind !== CLIENT_AUTH) {
      this.send(['OK', event.id, false, 'invalid kind'])
      return
    }
    const now = currentSeconds()
    if (event.created_at < now - 5 * 60 || event.created_at > now + 5 * 60) {
      this.send(['OK', event.id, false, 'created_at is too far from current time'])
      return
    }
    if (getTagValue('challenge', event.tags) !== this.auth.challenge) {
      this.send(['OK', event.id, false, 'invalid challenge'])
      return
    }

    let relay: string
    try {
      relay = normalizeNip42RelayUrl(getTagValue('relay', event.tags) || '')
    } catch {
      this.send(['OK', event.id, false, 'invalid relay'])
      return
    }
    if (relay !== this.expectedRelayUrl) {
      this.send(['OK', event.id, false, 'invalid relay'])
      return
    }
    this.auth.event = event
    this.send(['OK', event.id, true, ''])
  }

  private async onREQ(id: string, ...filters: Filter[]) {
    if (!this.auth.event) {
      this.send(['CLOSED', id, 'auth-required: subscriptions are protected'])
      return
    }
    if (typeof id !== 'string' || !filters.length || filters.some((filter) => !filter || typeof filter !== 'object')) {
      this.send(['CLOSED', typeof id === 'string' ? id : '', 'invalid: malformed request'])
      return
    }
    this.subscriptions.set(id, filters)
    const subscriptions = await this.database.getSubscriptionsForPubkey(this.auth.event.pubkey)
    for (const subscription of subscriptions) {
      const events = [
        ...(subscription.state === 'deleted' ? [] : [subscription.event]),
        await this.service.createStatusEvent(subscription),
      ]
      for (const event of events) {
        if (matchFilters(filters, event)) this.send(['EVENT', id, event])
      }
    }
    this.send(['EOSE', id])
  }

  private async onCLOSE(id: string) {
    if (typeof id === 'string') this.subscriptions.delete(id)
  }

  private async onEVENT(event: SignedEvent) {
    if (!event || !verifyEvent(event)) {
      this.send(['OK', event?.id || '', false, 'invalid signature'])
      return
    }
    if (!this.auth.event || event.pubkey !== this.auth.event.pubkey) {
      this.send(['OK', event.id, false, 'event not authorized'])
      return
    }

    try {
      if (event.kind === DIGEST_SUBSCRIPTION_KIND) {
        await this.handleSubscription(event)
      } else if (event.kind === DELETE) {
        const now = currentSeconds()
        if (
          event.created_at < now - MAX_EVENT_AGE_SECONDS ||
          event.created_at > now + MAX_EVENT_FUTURE_SECONDS
        ) {
          throw new ValidationError('event created_at is too far from current time')
        }
        await this.service.delete(event)
        this.send(['OK', event.id, true, ''])
      } else {
        this.send(['OK', event.id, false, 'event kind not accepted'])
      }
    } catch (error) {
      const known = error instanceof ValidationError || error instanceof ActionError
      this.send(['OK', event.id, false, known ? error.message : 'internal error'])
      logStructured({
        category: 'subscription',
        status: 'rejected',
        subscription: event.pubkey,
        eventId: event.id,
        errorType: error instanceof Error ? error.name : 'Error',
      })
    }
  }

  private async handleSubscription(event: SignedEvent) {
    const anchorPubkey = await this.signer.getPubkey()
    validateSubscriptionEvent(event, anchorPubkey)
    const existing = await this.database.getSubscription(event.pubkey)
    if (existing?.eventId === event.id) {
      this.send(['OK', event.id, true, 'duplicate: already accepted'])
      return
    }
    if (existing && event.created_at <= existing.eventCreatedAt) {
      throw new ActionError('A newer subscription event already exists')
    }

    let plaintext: string
    try {
      plaintext = await decrypt(this.signer, event.pubkey, event.content)
    } catch {
      throw new ValidationError('failed to decrypt event content')
    }
    const config = parseDigestConfig(plaintext)
    const subscription = await this.service.add(event, config)
    this.send(['OK', event.id, true, ''])

    const events = [subscription.event, await this.service.createStatusEvent(subscription)]
    for (const [id, filters] of this.subscriptions) {
      for (const accepted of events) {
        if (matchFilters(filters, accepted)) this.send(['EVENT', id, accepted])
      }
    }
  }
}
