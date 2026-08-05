import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { WebSocket } from 'ws'
import {
  MAX_PAYLOAD_BYTES,
  ValidationError,
  parseDigestConfig,
  parseCommunityDigestConfig,
  validateSubscriptionDeletionEvent,
  validateSubscriptionEvent,
} from '../dist/subscription.js'
import { Connection } from '../dist/relay.js'
import {
  ANCHOR_PUBKEY,
  COMMUNITY_PUBKEY,
  communityConfig,
  config,
  subscriptionEvent,
} from './helpers.js'

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
    () =>
      parseDigestConfig(
        JSON.stringify({ ...config(), manageUrl: 'http://budabit.example/settings' })
      ),
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
    () =>
      parseDigestConfig(JSON.stringify({ ...config(), manageUrl: 'https://budabit.example/#' })),
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
    engagement: { reactions: false, zaps: false },
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

test('repository engagement options are required and strictly shaped', () => {
  const parsed = parseDigestConfig(JSON.stringify(config()))
  assert.deepEqual(parsed.repositories[0].options.engagement, { reactions: true, zaps: true })
  const withoutEngagement = {
    ...config().repositories[0].options,
  }
  delete withoutEngagement.engagement
  assert.throws(
    () =>
      parseDigestConfig(
        JSON.stringify({
          ...config(),
          repositories: [{ ...config().repositories[0], options: withoutEngagement }],
        })
      ),
    /engagement must be an object/
  )
  assert.throws(
    () =>
      parseDigestConfig(
        JSON.stringify({
          ...config(),
          repositories: [
            {
              ...config().repositories[0],
              options: {
                ...config().repositories[0].options,
                engagement: { reactions: true, zaps: true, reviews: true },
              },
            },
          ],
        })
      ),
    /reviews is not supported/
  )
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
    () =>
      validateSubscriptionEvent(
        { ...subscriptionEvent(now), tags: subscriptionEvent(now).tags.toReversed() },
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

test('repository lookup relay limit excludes the handler relay', () => {
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
    /more than 20 unique repository lookup relays/
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

test('community payload is strict v1 and contains no subscriber handler or relay data', () => {
  const parsed = parseCommunityDigestConfig(
    JSON.stringify(communityConfig({ email: ' Member@Example.COM ' })),
    COMMUNITY_PUBKEY
  )
  assert.equal(parsed.email, 'member@example.com')
  assert.equal(parsed.community, COMMUNITY_PUBKEY)
  assert.equal(parsed.preferences.density, 'compact')
  assert.throws(
    () =>
      parseCommunityDigestConfig(
        JSON.stringify({
          ...communityConfig(),
          handler: { address: 'x', relay: 'wss://x.example' },
        }),
        COMMUNITY_PUBKEY
      ),
    /handler is not supported/
  )
  assert.throws(
    () =>
      parseCommunityDigestConfig(
        JSON.stringify({
          ...communityConfig(),
          preferences: {
            ...communityConfig().preferences,
            engagement: { ...communityConfig().preferences.engagement, legacy: false },
          },
        }),
        COMMUNITY_PUBKEY
      ),
    /legacy is not supported/
  )
  assert.throws(
    () =>
      parseCommunityDigestConfig(
        JSON.stringify({ ...communityConfig(), community: 'e'.repeat(64) }),
        COMMUNITY_PUBKEY
      ),
    /must match/
  )
  assert.throws(
    () =>
      parseCommunityDigestConfig(
        JSON.stringify({ ...communityConfig(), manageUrl: 'http://budabit.example/settings' }),
        COMMUNITY_PUBKEY
      ),
    /HTTPS/
  )
})

test('community subscription and deletion envelopes require exact mode-specific tags', () => {
  const now = 2_000_000_000
  const identifier = `budabit/community-alerts/${COMMUNITY_PUBKEY}`
  const event = {
    ...subscriptionEvent(now),
    tags: [
      ['d', identifier],
      ['p', ANCHOR_PUBKEY],
    ],
  }
  assert.doesNotThrow(() => validateSubscriptionEvent(event, ANCHOR_PUBKEY, now, identifier))
  assert.throws(
    () => validateSubscriptionEvent(subscriptionEvent(now), ANCHOR_PUBKEY, now, identifier),
    /exactly/
  )
  const deletion = {
    ...event,
    kind: 5,
    tags: [
      ['a', `32830:${event.pubkey}:${identifier}`],
      ['p', ANCHOR_PUBKEY],
    ],
  }
  assert.doesNotThrow(() => validateSubscriptionDeletionEvent(deletion, ANCHOR_PUBKEY, identifier))
  assert.throws(
    () =>
      validateSubscriptionDeletionEvent(
        { ...deletion, tags: deletion.tags.toReversed() },
        ANCHOR_PUBKEY,
        identifier
      ),
    /exactly/
  )
})

test('relay decrypts subscriptions with NIP-44 only and never falls back to NIP-04', async () => {
  const userSecret = generateSecretKey()
  const serviceSecret = generateSecretKey()
  const userPubkey = getPublicKey(userSecret)
  const servicePubkey = getPublicKey(serviceSecret)
  const messages = []
  const socket = {
    readyState: WebSocket.OPEN,
    send(message) {
      messages.push(JSON.parse(message))
    },
    close() {},
    terminate() {},
  }
  let nip44Calls = 0
  let nip04Calls = 0
  let writes = 0
  const signer = {
    async getPubkey() {
      return servicePubkey
    },
    nip44: {
      async decrypt(_pubkey, content) {
        nip44Calls++
        if (content.includes('?iv=')) throw new Error('not NIP-44')
        return JSON.stringify(config())
      },
    },
    nip04: {
      async decrypt() {
        nip04Calls++
        return JSON.stringify(config())
      },
    },
  }
  const database = {
    async getSubscription() {
      return undefined
    },
  }
  const service = {
    async add(event, parsed) {
      writes++
      return { event, config: parsed, state: 'active', pubkey: event.pubkey }
    },
    async createStatusEvent(subscription) {
      return subscription.event
    },
  }
  const connection = new Connection(socket, database, service, signer, 'wss://anchor.example/')
  const challenge = messages[0][1]
  const now = Math.floor(Date.now() / 1000)
  const auth = finalizeEvent(
    {
      kind: 22242,
      created_at: now,
      content: '',
      tags: [
        ['challenge', challenge],
        ['relay', 'wss://anchor.example/'],
      ],
    },
    userSecret
  )
  await connection.handle(JSON.stringify(['AUTH', auth]))
  const subscription = (created_at, content) =>
    finalizeEvent(
      {
        kind: 32830,
        created_at,
        content,
        tags: [
          ['d', 'budabit/email-digest'],
          ['p', servicePubkey],
        ],
      },
      userSecret
    )
  await connection.handle(JSON.stringify(['EVENT', subscription(now, 'nip44-ciphertext')]))
  await connection.handle(JSON.stringify(['EVENT', subscription(now + 1, 'legacy?iv=value')]))
  assert.equal(userPubkey.length, 64)
  assert.equal(nip44Calls, 2)
  assert.equal(nip04Calls, 0)
  assert.equal(writes, 1)
  assert.match(messages.at(-1)[3], /failed to decrypt/)
})
