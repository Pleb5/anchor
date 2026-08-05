import { makeEvent, type SignedEvent } from '@welshman/util'
import type { ISigner } from '@welshman/signer'
import type { DigestDatabase, Subscription } from './database.js'
import type { DigestConfig } from './subscription.js'
import {
  DIGEST_STATUS_KIND,
  validateSubscriptionDeletionEvent,
} from './subscription.js'
import {
  statusIdentifier,
  subscriptionIdentifier,
  type AnchorMode,
} from './mode.js'
import { firstRunAfter } from './schedule.js'
import type { EmailService } from './mailer.js'
import { logStructured } from './logger.js'

export class ActionError extends Error {}

export type EligibilityResult = {
  eligible: boolean
  role?: 'admin' | 'moderator' | 'member'
  reason?: string
}

export type EligibilityGate = {
  check(pubkey: string): Promise<EligibilityResult>
  readonly ready: boolean
}

export class SubscriptionService {
  constructor(
    private readonly database: DigestDatabase,
    private readonly mailer: EmailService,
    private readonly signer: ISigner,
    private readonly clock = () => Math.floor(Date.now() / 1000),
    private readonly mode: AnchorMode = { mode: 'repository' },
    private readonly eligibility?: EligibilityGate
  ) {}

  async add(event: SignedEvent, config: DigestConfig) {
    const currentTime = this.clock()
    if (this.mode.mode === 'community') {
      let eligibility: EligibilityResult
      try {
        eligibility = await this.eligibility!.check(event.pubkey)
      } catch {
        throw new ActionError('Community membership could not be verified')
      }
      if (!eligibility.eligible) {
        throw new ActionError(eligibility.reason || 'Current community membership is required')
      }
    }
    const result = await this.database.upsertSubscription(
      event,
      config,
      firstRunAfter(config.cadence, currentTime),
      currentTime
    )
    if (!result.applied) {
      if (result.duplicate) return result.subscription
      throw new ActionError('A newer subscription event already exists')
    }

    logStructured({
      category: 'subscription',
      status: result.confirmationToken ? 'pending_confirmation' : 'active',
      subscription: event.pubkey,
      eventId: event.id,
    })
    if (result.confirmationToken) {
      try {
        await this.mailer.sendConfirmation(result.subscription, config.email, result.confirmationToken)
      } catch (error) {
        await this.database.setSubscriptionError(
          event.pubkey,
          'Confirmation email could not be delivered; replace the subscription to retry',
          currentTime
        )
        logStructured({
          category: 'delivery',
          status: 'confirmation_failed',
          subscription: event.pubkey,
          errorType: error instanceof Error ? error.name : 'Error',
        })
      }
    }
    return (await this.database.getSubscription(event.pubkey))!
  }

  async inspectConfirmation(token: string) {
    if (!token) throw new ActionError('No confirmation token was provided.')
    const subscription = await this.database.getByConfirmationToken(token)
    if (!subscription?.pendingConfig || subscription.state !== 'pending') {
      throw new ActionError('This confirmation link is invalid or has expired.')
    }
    return subscription
  }

  async confirm(token: string) {
    const subscription = await this.inspectConfirmation(token)
    const currentTime = this.clock()
    const nextRunAt = firstRunAfter(subscription.pendingConfig!.cadence, currentTime)
    const confirmed = await this.database.confirmSubscription(token, nextRunAt, currentTime)
    if (!confirmed) throw new ActionError('This confirmation link is invalid or has expired.')
    logStructured({
      category: 'subscription',
      status: 'confirmed',
      subscription: confirmed.pubkey,
      eventId: confirmed.eventId,
    })
    return confirmed
  }

  async inspectUnsubscribe(token: string) {
    if (!token) throw new ActionError('No unsubscribe token was provided.')
    const subscription = await this.database.getByUnsubscribeToken(token)
    if (!subscription) throw new ActionError('This unsubscribe link is invalid or has expired.')
    return subscription
  }

  async unsubscribe(token: string) {
    await this.inspectUnsubscribe(token)
    const subscription = await this.database.unsubscribe(token, this.clock())
    if (!subscription) throw new ActionError('This unsubscribe link is invalid or has expired.')
    logStructured({
      category: 'subscription',
      status: 'unsubscribed',
      subscription: subscription.pubkey,
      eventId: subscription.eventId,
    })
    return subscription
  }

  async delete(event: SignedEvent) {
    validateSubscriptionDeletionEvent(
      event,
      await this.signer.getPubkey(),
      subscriptionIdentifier(this.mode)
    )
    const deleted = await this.database.deleteSubscription(event.pubkey, event.created_at, this.clock())
    if (!deleted) throw new ActionError('Deletion is stale or the subscription does not exist')
    return true
  }

  async createStatusEvent(subscription: Subscription) {
    const status = getSubscriptionStatus(subscription)
    return this.signer.sign(
      makeEvent(DIGEST_STATUS_KIND, {
        content: await this.signer.nip44.encrypt(subscription.pubkey, JSON.stringify(status)),
        tags: [
          ['d', statusIdentifier(this.mode, subscription.pubkey)],
          ['p', subscription.pubkey],
        ],
      })
    )
  }
}

export function getSubscriptionStatus(subscription: Subscription) {
  let status = 'inactive'
  let message = 'This email digest is inactive.'
  if (subscription.state === 'pending') {
    status = 'pending'
    message = subscription.lastError || 'Confirm the email address before digest delivery starts.'
  } else if (subscription.state === 'active') {
    status = 'ok'
    message = subscription.lastError || 'This email digest is active.'
  } else if (subscription.state === 'suppressed') {
    status = 'error'
    message = 'Delivery was suppressed after a bounce or spam complaint.'
  } else if (subscription.state === 'error') {
    status = 'error'
    message = subscription.lastError || 'Delivery stopped after repeated failures.'
  } else if (subscription.state === 'unsubscribed') {
    message = 'This email digest has been unsubscribed.'
  } else if (subscription.state === 'deleted') {
    message = 'This email digest has been deleted.'
  } else if (subscription.state === 'ineligible') {
    status = 'inactive'
    message = subscription.lastError || 'Current community membership is required.'
  }

  return {
    version: 1,
    channel: subscription.config?.channel || subscription.pendingConfig?.channel || 'email-digest',
    status,
    state: subscription.state,
    message,
    emailConfirmed: subscription.state !== 'pending' && Boolean(subscription.confirmedAt),
    nextRunAt: subscription.nextRunAt || null,
    lastCompletedAt: subscription.lastCompletedAt || null,
  }
}
