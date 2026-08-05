import test from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import { createServer, actionRequestMode, acceptsNip11 } from '../dist/server.js'
import {
  EmailService,
  buildPostmarkDigestMessage,
  buildDigestSubject,
  buildCommunityDigestSubject,
} from '../dist/mailer.js'
import { COMMUNITY_PUBKEY, communityConfig, config } from './helpers.js'

test('GET action links are confirmation-only while POST is mutating', () => {
  assert.equal(actionRequestMode('GET'), 'confirm')
  assert.equal(actionRequestMode('POST'), 'mutate')
  assert.equal(actionRequestMode('DELETE'), 'reject')
})

test('NIP-11 requires an explicit application/nostr+json Accept value', () => {
  assert.equal(acceptsNip11('application/nostr+json'), true)
  assert.equal(acceptsNip11('text/html, application/nostr+json; q=0.9'), true)
  assert.equal(acceptsNip11('application/nostr+json; q=0'), false)
  assert.equal(acceptsNip11('*/*'), false)
  assert.equal(acceptsNip11('text/html,application/xhtml+xml'), false)
})

test('community NIP-11 and readiness expose the pinned verified mode', async () => {
  const mode = {
    mode: 'community',
    communityPubkey: COMMUNITY_PUBKEY,
    bootstrapRelays: ['wss://relay.example/'],
    handlerAddress: `31990:${'d'.repeat(64)}:budabit`,
    handlerRelay: 'wss://handler.example/',
  }
  const { app, closeConnections } = createServer({
    database: { async ping() { return true } },
    scheduler: { ready: true },
    service: {},
    signer: { async getPubkey() { return 'a'.repeat(64) } },
    anchorName: 'Community Anchor',
    anchorUrl: 'http://127.0.0.1:4739',
    webhookSecret: 'secret',
    mode,
    advertisement: { ready: false },
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  try {
    const ready = await fetch(`${base}/ready`)
    assert.equal(ready.status, 503)
    assert.equal((await ready.json()).advertisement, 'not_ready')
    const response = await fetch(`${base}/`, {
      headers: { accept: 'application/nostr+json' },
    })
    const nip11 = await response.json()
    assert.equal(nip11.mode, 'community')
    assert.equal(nip11.community, COMMUNITY_PUBKEY)
    assert.match(nip11.description, new RegExp(COMMUNITY_PUBKEY))
  } finally {
    await closeConnections()
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('unsubscribe GET is scanner-safe and RFC8058 POST mutates', async () => {
  let mutations = 0
  const service = {
    async inspectUnsubscribe(token) {
      assert.equal(token, 'safe-token')
      return {}
    },
    async unsubscribe(token) {
      assert.equal(token, 'safe-token')
      mutations++
      return {}
    },
  }
  const { app, closeConnections } = createServer({
    database: { async ping() { return true } },
    scheduler: { ready: true },
    service,
    signer: { async getPubkey() { return 'a'.repeat(64) } },
    anchorName: 'Anchor',
    anchorUrl: 'http://127.0.0.1:4738',
    webhookUsername: 'anchor',
    webhookSecret: 'webhook-secret',
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`
  try {
    const htmlResponse = await fetch(`${base}/`, { headers: { accept: '*/*' } })
    assert.equal(htmlResponse.status, 200)
    assert.match(htmlResponse.headers.get('content-type'), /^text\/html/)
    assert.match(await htmlResponse.text(), /Anchor Email Digest/)

    const nip11Response = await fetch(`${base}/`, {
      headers: { accept: 'application/nostr+json' },
    })
    assert.equal(nip11Response.status, 200)
    assert.equal(nip11Response.headers.get('content-type'), 'application/nostr+json; charset=utf-8')
    const nip11 = await nip11Response.json()
    assert.equal(nip11.description, 'Budabit email digest subscription relay')
    assert.equal(nip11.software, 'https://github.com/Pleb5/anchor')

    const getResponse = await fetch(`${base}/unsubscribe?token=safe-token`)
    assert.equal(getResponse.status, 200)
    assert.match(await getResponse.text(), /has not changed your subscription/)
    assert.equal(mutations, 0)

    const postResponse = await fetch(`${base}/unsubscribe?token=safe-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'List-Unsubscribe=One-Click',
    })
    assert.equal(postResponse.status, 200)
    assert.equal(await postResponse.text(), 'Unsubscribed')
    assert.equal(mutations, 1)

    const websocket = new WebSocket(base.replace('http:', 'ws:'))
    await new Promise((resolve, reject) => {
      websocket.once('open', resolve)
      websocket.once('error', reject)
    })
    const closed = new Promise((resolve) => websocket.once('close', resolve))
    assert.equal(await closeConnections(1000), true)
    await closed
    assert.equal(websocket.readyState, WebSocket.CLOSED)
  } finally {
    await closeConnections()
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('Postmark webhooks support Basic auth and ignore soft bounces', async () => {
  const suppressions = []
  const { app, closeConnections } = createServer({
    database: {
      async ping() { return true },
      async suppressSubscription(...args) {
        suppressions.push(args)
        return true
      },
    },
    scheduler: { ready: true },
    service: {},
    signer: { async getPubkey() { return 'a'.repeat(64) } },
    anchorName: 'Anchor',
    anchorUrl: 'http://127.0.0.1:4738',
    webhookUsername: 'postmark',
    webhookSecret: 'webhook-secret',
  })
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const address = server.address()
  const endpoint = `http://127.0.0.1:${address.port}/webhooks/postmark`
  const authorization = `Basic ${Buffer.from('postmark:webhook-secret').toString('base64')}`
  const payload = {
    Metadata: { subscription_pubkey: 'a'.repeat(64) },
    Email: 'person@example.com',
  }
  const post = (body) =>
    fetch(endpoint, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  try {
    let response = await post({ ...payload, RecordType: 'Bounce', Inactive: false })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { received: true, suppressed: false })
    assert.equal(suppressions.length, 0)

    response = await post({ ...payload, RecordType: 'Bounce', Inactive: true })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { received: true, suppressed: true })
    assert.equal(suppressions.length, 1)
    assert.equal(suppressions[0][2], 'permanent bounce')

    response = await post({ ...payload, RecordType: 'SpamComplaint', Inactive: false })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { received: true, suppressed: true })
    assert.equal(suppressions.length, 2)
    assert.equal(suppressions[1][2], 'spam complaint')
  } finally {
    await closeConnections()
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('Postmark digest payload includes stream, run metadata, text, and unsubscribe headers', () => {
  const message = buildPostmarkDigestMessage({
    to: 'person@example.com',
    sender: 'Budabit <digest@example.com>',
    stream: 'digests',
    subscriptionPubkey: 'a'.repeat(64),
    runId: 'run-123',
    periodEnd: 1234,
    subject: '[Budabit] 3 updates in 1 repository',
    html: '<p>Digest</p>',
    text: 'Digest',
    unsubscribeUrl: 'https://anchor.example/unsubscribe?token=secret',
  })
  assert.equal(message.MessageStream, 'digests')
  assert.equal(message.Tag, 'email-digest')
  assert.equal(message.Metadata.run_id, 'run-123')
  assert.equal(message.TextBody, 'Digest')
  assert.deepEqual(message.Headers, [
    {
      Name: 'List-Unsubscribe',
      Value: '<https://anchor.example/unsubscribe?token=secret>',
    },
    { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
  ])
  assert.equal(
    buildDigestSubject({ eventCount: 4, attentionCount: 1, repositories: [{}] }),
    '[Budabit] 1 item needs you, 4 updates in 1 repository'
  )
})

test('Postmark digest metadata keeps durable run identifiers within provider limits', () => {
  const uuid = '11111111-2222-4333-8444-555555555555'
  const message = buildPostmarkDigestMessage({
    to: 'person@example.com',
    sender: 'Budabit <digest@example.com>',
    stream: 'outbound',
    subscriptionPubkey: 'a'.repeat(64),
    runId: `${'b'.repeat(64)}:${uuid}`,
    periodEnd: 1234,
    subject: '[Budabit] Digest',
    html: '<p>Digest</p>',
    text: 'Digest',
    unsubscribeUrl: 'https://anchor.example/unsubscribe?token=secret',
  })

  assert.equal(message.Metadata.run_id, uuid)
  assert.ok(message.Metadata.run_id.length <= 80)
})

test('EmailService compiles responsive MJML and sends matching HTML and text bodies', async () => {
  let sent
  const client = {
    async sendEmail(message) {
      sent = message
      return { MessageID: 'postmark-id' }
    },
  }
  const mailer = new EmailService(
    {
      apiKey: 'unused',
      sender: 'digest@example.com',
      anchorName: 'Anchor',
      anchorUrl: 'https://anchor.example',
      messageStream: 'digests',
    },
    client
  )
  const row = {
    key: 'row',
    repositoryAddress: config().repositories[0].address,
    repositoryName: 'Anchor',
    title: 'Issue title',
    summary: 'Assigned to you',
    author: 'Contributor',
    createdAt: 150,
    link: 'https://budabit.example/item',
    attention: true,
    eventCount: 1,
  }
  const data = {
    periodStart: 100,
    periodEnd: 200,
    eventCount: 1,
    attentionCount: 1,
    overflow: 0,
    attention: [row],
    repositories: [
      {
        address: config().repositories[0].address,
        name: 'Anchor',
        counts: {
          newItems: 0,
          comments: 0,
          updates: 0,
          statuses: 0,
          assignments: 1,
          reactions: 1,
          zaps: 1,
          zapSats: 0,
          zapsWithAmount: 0,
          total: 1,
        },
        attentionCount: 1,
        recentAt: 150,
        rows: [],
      },
    ],
  }
  const messageId = await mailer.sendDigest(
    {
      pubkey: 'a'.repeat(64),
      eventId: 'event-id',
      config: config(),
      confirmedEmail: 'person@example.com',
      unsubscribeToken: 'unsubscribe-token',
    },
    { runId: 'run-id', periodEnd: 200 },
    data
  )
  assert.equal(messageId, 'postmark-id')
  assert.match(sent.HtmlBody, /Needs attention/)
  assert.match(sent.HtmlBody, /Open in Budabit/)
  assert.match(sent.HtmlBody, /budabit\.example&#x2F;settings&#x2F;notifications/)
  assert.match(sent.HtmlBody, /<div[^>]*color:#ffffff[^>]*>1<\/div>/)
  assert.match(sent.HtmlBody, /<div[^>]*color:#b7c0d2[^>]*>Updates<\/div>/)
  assert.match(sent.TextBody, /NEEDS ATTENTION/)
  assert.match(sent.TextBody, /1 reaction \/ 1 zap/)
  assert.match(sent.TextBody, /Manage settings: https:\/\/budabit\.example\/settings\/notifications/)
  assert.equal(sent.MessageStream, 'digests')
})

test('community email uses separate sections, subject, text, and Postmark metadata', async () => {
  let sent
  const mailer = new EmailService(
    {
      apiKey: 'unused',
      sender: 'community@example.com',
      anchorName: 'Community Anchor',
      anchorUrl: 'https://alerts.example',
      messageStream: 'community-digests',
      mode: 'community',
      communityPubkey: COMMUNITY_PUBKEY,
    },
    { async sendEmail(message) { sent = message; return { MessageID: 'community-message' } } }
  )
  const row = {
    key: 'needs:one',
    section: 'needsAttention',
    title: 'Publishing request',
    summary: '1 request',
    author: 'Member',
    createdAt: 150,
    link: 'https://budabit.example/nevent',
    eventCount: 1,
  }
  const data = {
    periodStart: 100,
    periodEnd: 200,
    eventCount: 2,
    overflow: 1,
    sourceTruncated: true,
    needsAttention: [row],
    forYou: [],
    appreciation: [{ ...row, key: 'thanks:one', section: 'appreciation', title: 'Your post' }],
    highlights: [],
  }
  const messageId = await mailer.sendDigest(
    {
      pubkey: 'a'.repeat(64),
      eventId: 'event-id',
      config: communityConfig(),
      confirmedEmail: 'member@example.com',
      unsubscribeToken: 'unsubscribe-token',
    },
    { runId: 'community-run', periodEnd: 200 },
    data
  )
  assert.equal(messageId, 'community-message')
  assert.equal(buildCommunityDigestSubject(data), '[Budabit] 1 community item for you')
  assert.match(sent.HtmlBody, /Needs attention/)
  assert.match(sent.HtmlBody, /Appreciation/)
  assert.match(sent.HtmlBody, /High-volume relay results/)
  assert.match(sent.TextBody, /NEEDS ATTENTION/)
  assert.doesNotMatch(sent.HtmlBody, /Repositories/)
  assert.equal(sent.Tag, 'community-alerts')
  assert.equal(sent.MessageStream, 'community-digests')
  assert.equal(sent.Metadata.mode, 'community')
  assert.equal(sent.Metadata.community, COMMUNITY_PUBKEY)
})
