import test from 'node:test'
import assert from 'node:assert/strict'
import {
  MAX_PAYLOAD_BYTES,
  ValidationError,
  parseDigestConfig,
  validateSubscriptionDeletionEvent,
  validateSubscriptionEvent,
} from '../dist/subscription.js'
import { ANCHOR_PUBKEY, config, subscriptionEvent } from './helpers.js'

test('strict digest payload validation accepts and normalizes the protocol object', () => {
  const parsed = parseDigestConfig(JSON.stringify(config({ email: ' Person@Example.COM ' })))
  assert.equal(parsed.email, 'person@example.com')
  assert.equal(parsed.manageUrl, 'https://budabit.example/settings/notifications')
  assert.equal(parsed.repositories[0].relays[0], 'wss://relay.example/')
  assert.equal(parsed.handler.relay, 'wss://handler.example/')
})

test('payload validation rejects unknown fields, duplicate repositories, no activity, and oversized data', () => {
  assert.throws(
    () => parseDigestConfig(JSON.stringify({ ...config(), legacy: true })),
    ValidationError
  )
  assert.throws(
    () => parseDigestConfig(JSON.stringify({ ...config(), manageUrl: 'http://budabit.example/settings' })),
    /HTTPS URL/
  )
  assert.throws(
    () =>
      parseDigestConfig(
        JSON.stringify({ ...config(), manageUrl: 'https://user:secret@budabit.example/settings' })
      ),
    /HTTPS URL/
  )
  assert.throws(
    () => parseDigestConfig(JSON.stringify({ ...config(), manageUrl: 'https://budabit.example/#' })),
    /HTTPS URL/
  )
  assert.throws(
    () =>
      parseDigestConfig(
        JSON.stringify({
          ...config(),
          repositories: [config().repositories[0], config().repositories[0]],
        })
      ),
    /duplicate address/
  )
  const disabled = {
    issues: { new: false, comments: false },
    prs: { new: false, comments: false, updates: false },
    status: { open: false, draft: false, applied: false, closed: false },
    assignments: false,
  }
  assert.throws(
    () =>
      parseDigestConfig(
        JSON.stringify({
          ...config(),
          repositories: [{ ...config().repositories[0], options: disabled }],
        })
      ),
    /selects no activity/
  )
  assert.throws(() => parseDigestConfig(`{"padding":"${'x'.repeat(MAX_PAYLOAD_BYTES)}"}`), /64 KiB/)
})

test('subscription envelope requires exact stable tags and rejects stale or future events', () => {
  const now = 2_000_000_000
  assert.doesNotThrow(() => validateSubscriptionEvent(subscriptionEvent(now), ANCHOR_PUBKEY, now))
  assert.throws(
    () =>
      validateSubscriptionEvent(
        { ...subscriptionEvent(now), tags: [...subscriptionEvent(now).tags, ['client', 'x']] },
        ANCHOR_PUBKEY,
        now
      ),
    /exactly/
  )
  assert.throws(
    () => validateSubscriptionEvent(subscriptionEvent(now - 86_401), ANCHOR_PUBKEY, now),
    /stale/
  )
  assert.throws(
    () => validateSubscriptionEvent(subscriptionEvent(now + 301), ANCHOR_PUBKEY, now),
    /future/
  )
})

test('repository relay limit excludes the handler relay', () => {
  const repositories = Array.from({ length: 7 }, (_, repositoryIndex) => ({
    ...config().repositories[0],
    address: `30617:${repositoryIndex.toString(16).padStart(64, '0')}:repo-${repositoryIndex}`,
    name: `Repository ${repositoryIndex}`,
    relays: Array.from(
      { length: repositoryIndex === 6 ? 2 : 3 },
      (_, relayIndex) => `wss://relay-${repositoryIndex}-${relayIndex}.example`
    ),
  }))
  assert.equal(new Set(repositories.flatMap((repository) => repository.relays)).size, 20)
  assert.doesNotThrow(() =>
    parseDigestConfig(
      JSON.stringify({
        ...config(),
        handler: { ...config().handler, relay: 'wss://handler-not-counted.example' },
        repositories,
      })
    )
  )
  repositories[6].relays.push('wss://relay-6-2.example')
  assert.throws(
    () => parseDigestConfig(JSON.stringify({ ...config(), repositories })),
    /more than 20 unique repository relays/
  )
})

test('subscription deletion requires exact address and Anchor tags', () => {
  const event = subscriptionEvent(2_000_000_000)
  const deletion = {
    ...event,
    kind: 5,
    tags: [
      ['a', `32830:${event.pubkey}:budabit/email-digest`],
      ['p', ANCHOR_PUBKEY],
    ],
  }

  assert.doesNotThrow(() => validateSubscriptionDeletionEvent(deletion, ANCHOR_PUBKEY))
  assert.throws(
    () =>
      validateSubscriptionDeletionEvent(
        { ...deletion, tags: [...deletion.tags, ['k', '32830']] },
        ANCHOR_PUBKEY
      ),
    /exactly/
  )
})
