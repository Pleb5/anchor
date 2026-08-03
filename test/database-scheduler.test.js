import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DigestDatabase } from '../dist/database.js'
import { DigestScheduler } from '../dist/scheduler.js'
import { config, subscriptionEvent } from './helpers.js'

const withDatabase = async (run) => {
  const directory = await mkdtemp(join(tmpdir(), 'anchor-test-'))
  const database = new DigestDatabase(join(directory, 'anchor.db'))
  try {
    await database.initialize()
    await run(database)
  } finally {
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
}

test('replacement ordering and confirmation transitions are enforced atomically', async () => {
  await withDatabase(async (database) => {
    const initial = await database.upsertSubscription(subscriptionEvent(100), config(), 200, 100)
    assert.equal(initial.subscription.state, 'pending')
    assert.ok(initial.confirmationToken)
    const confirmed = await database.confirmSubscription(initial.confirmationToken, 200, 110)
    assert.equal(confirmed.state, 'active')
    assert.equal(confirmed.confirmedEmail, 'person@example.com')
    assert.notEqual(confirmed.unsubscribeToken, initial.subscription.unsubscribeToken)
    const confirmedUnsubscribeToken = confirmed.unsubscribeToken

    const stale = await database.upsertSubscription(
      subscriptionEvent(99, '2'.repeat(64)),
      config(),
      250,
      120
    )
    assert.equal(stale.applied, false)
    assert.equal(stale.subscription.eventId, initial.subscription.eventId)

    const sameEmail = await database.upsertSubscription(
      subscriptionEvent(101, '3'.repeat(64)),
      config({ repositories: [{ ...config().repositories[0], name: 'Renamed watch' }] }),
      250,
      120
    )
    assert.equal(sameEmail.subscription.state, 'active')
    assert.equal(sameEmail.confirmationToken, undefined)
    assert.equal(sameEmail.subscription.confirmedAt, 110)
    assert.equal(sameEmail.subscription.nextRunAt, 200)
    assert.equal(sameEmail.subscription.periodStart, 110)
    assert.equal(sameEmail.subscription.unsubscribeToken, confirmedUnsubscribeToken)

    const cadenceChanged = await database.upsertSubscription(
      subscriptionEvent(102, '4'.repeat(64)),
      config({ cadence: { intervalDays: 3, localTime: '10:00', timezone: 'UTC' } }),
      300,
      125
    )
    assert.equal(cadenceChanged.subscription.nextRunAt, 300)
    assert.equal(cadenceChanged.subscription.periodStart, 110)
    assert.equal(cadenceChanged.subscription.unsubscribeToken, confirmedUnsubscribeToken)

    const changedEmail = await database.upsertSubscription(
      subscriptionEvent(103, '5'.repeat(64)),
      config({
        email: 'new@example.com',
        cadence: { intervalDays: 3, localTime: '10:00', timezone: 'UTC' },
      }),
      400,
      130
    )
    assert.equal(changedEmail.subscription.state, 'pending')
    assert.equal(changedEmail.subscription.confirmedEmail, 'person@example.com')
    assert.equal(changedEmail.subscription.nextRunAt, undefined)
    assert.equal(changedEmail.subscription.pendingConfig.email, 'new@example.com')
    assert.equal(changedEmail.subscription.unsubscribeToken, confirmedUnsubscribeToken)

    assert.equal(
      await database.suppressSubscription(
        changedEmail.subscription.pubkey,
        'person@example.com',
        'bounce',
        131
      ),
      false
    )
    const changedConfirmed = await database.confirmSubscription(
      changedEmail.confirmationToken,
      400,
      140
    )
    assert.equal(changedConfirmed.confirmedEmail, 'new@example.com')
    assert.notEqual(changedConfirmed.unsubscribeToken, confirmedUnsubscribeToken)
    assert.equal(
      await database.suppressSubscription(
        changedEmail.subscription.pubkey,
        'new@example.com',
        'bounce',
        141
      ),
      true
    )
    assert.equal((await database.getSubscription(changedEmail.subscription.pubkey)).state, 'suppressed')

    await database.deleteSubscription(changedEmail.subscription.pubkey, 200, 200)
    const predatesDelete = await database.upsertSubscription(
      subscriptionEvent(150, '6'.repeat(64)),
      config({ email: 'new@example.com' }),
      500,
      201
    )
    assert.equal(predatesDelete.applied, false)
    assert.equal(predatesDelete.subscription.state, 'deleted')
  })
})

test('run claiming is atomic across competing workers', async () => {
  await withDatabase(async (database) => {
    const pending = await database.upsertSubscription(subscriptionEvent(100), config(), 200, 100)
    const subscription = await database.confirmSubscription(pending.confirmationToken, 200, 100)
    const run = await database.createDigestRun(subscription, 100, 200, 200)
    const claims = await Promise.all([
      database.startDigestRun(run.runId, 200),
      database.startDigestRun(run.runId, 200),
    ])
    assert.equal(claims.filter(Boolean).length, 1)
    assert.equal(claims.find(Boolean).attempts, 1)
  })
})

test('canceled runs remain immutable when a replacement claims the same period', async () => {
  await withDatabase(async (database) => {
    const pending = await database.upsertSubscription(subscriptionEvent(100), config(), 200, 100)
    const subscription = await database.confirmSubscription(pending.confirmationToken, 200, 100)
    let oldRun = await database.createDigestRun(subscription, 100, 200, 200)
    oldRun = await database.startDigestRun(oldRun.runId, 200)
    assert.equal(await database.cancelDigestRun(oldRun.runId, 201), true)

    const replacement = (
      await database.upsertSubscription(
        subscriptionEvent(101, 'b'.repeat(64)),
        config(),
        250,
        202
      )
    ).subscription
    let newRun = await database.createDigestRun(replacement, 100, 200, 202)
    assert.notEqual(newRun.runId, oldRun.runId)
    assert.match(newRun.runId, new RegExp(`^${replacement.eventId}:`))
    newRun = await database.startDigestRun(newRun.runId, 202)

    assert.equal(await database.cancelDigestRun(oldRun.runId, 203), false)
    await database.setRunEventCount(oldRun.runId, 99, 203)
    assert.equal(await database.failDigestRun(oldRun, 'stale failure', 203), false)

    const runs = await database.getRuns(subscription.pubkey)
    assert.equal(runs.length, 2)
    assert.equal(runs.find((run) => run.runId === oldRun.runId).status, 'canceled')
    assert.equal(runs.find((run) => run.runId === oldRun.runId).eventCount, 0)
    assert.equal(runs.find((run) => run.runId === newRun.runId).status, 'running')
    assert.equal((await database.getSubscription(subscription.pubkey)).eventId, replacement.eventId)
  })
})

test('stale failure after replacement does not wedge the same period', async () => {
  await withDatabase(async (database) => {
    const pending = await database.upsertSubscription(subscriptionEvent(100), config(), 200, 100)
    const subscription = await database.confirmSubscription(pending.confirmationToken, 200, 100)
    let oldRun = await database.createDigestRun(subscription, 100, 200, 200)
    oldRun = await database.startDigestRun(oldRun.runId, 200)

    const replacement = (
      await database.upsertSubscription(
        subscriptionEvent(101, 'c'.repeat(64)),
        config(),
        250,
        201
      )
    ).subscription
    assert.equal(await database.failDigestRun(oldRun, 'old worker failed', 202), true)
    const current = await database.getSubscription(subscription.pubkey)
    assert.equal(current.state, 'active')
    assert.equal(current.eventId, replacement.eventId)
    assert.equal(current.nextRunAt, 200)

    const newRun = await database.createDigestRun(current, 100, 200, 203)
    assert.notEqual(newRun.runId, oldRun.runId)
    assert.ok(await database.startDigestRun(newRun.runId, 203))
  })
})

test('startup recovery terminates attempt four and retries lower attempts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'anchor-recovery-test-'))
  const path = join(directory, 'anchor.db')
  const exhaustedEvent = subscriptionEvent(100, 'd'.repeat(64))
  const retryEvent = {
    ...subscriptionEvent(100, 'e'.repeat(64)),
    pubkey: 'f'.repeat(64),
  }
  let database = new DigestDatabase(path)
  try {
    await database.initialize()
    const exhaustedPending = await database.upsertSubscription(exhaustedEvent, config(), 200, 100)
    const exhausted = await database.confirmSubscription(exhaustedPending.confirmationToken, 200, 100)
    let exhaustedRun = await database.createDigestRun(exhausted, 100, 200, 200)
    for (let attempt = 1; attempt <= 4; attempt++) {
      exhaustedRun = await database.startDigestRun(exhaustedRun.runId, 200 + attempt)
      if (attempt < 4) {
        await database.retryDigestRun(
          exhaustedRun.runId,
          exhausted.pubkey,
          exhausted.eventId,
          210 + attempt,
          'retry',
          200 + attempt
        )
      }
    }

    const retryPending = await database.upsertSubscription(retryEvent, config(), 200, 100)
    const retrySubscription = await database.confirmSubscription(retryPending.confirmationToken, 200, 100)
    let retryRun = await database.createDigestRun(retrySubscription, 100, 200, 200)
    retryRun = await database.startDigestRun(retryRun.runId, 201)
    await database.close()

    database = new DigestDatabase(path)
    await database.initialize()
    const exhaustedAfter = await database.getSubscription(exhausted.pubkey)
    const retryAfter = await database.getSubscription(retrySubscription.pubkey)
    const exhaustedRuns = await database.getRuns(exhausted.pubkey)
    const retryRuns = await database.getRuns(retrySubscription.pubkey)
    assert.equal(exhaustedRuns[0].attempts, 4)
    assert.equal(exhaustedRuns[0].status, 'failed')
    assert.equal(exhaustedAfter.state, 'error')
    assert.equal(exhaustedAfter.nextRunAt, undefined)
    assert.equal(retryRuns[0].attempts, 1)
    assert.equal(retryRuns[0].status, 'retrying')
    assert.equal(retryAfter.state, 'active')
    assert.ok(retryAfter.nextRunAt > 200)
  } finally {
    await database.close().catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
})

test('completion advances a same-email replacement without overwriting its later schedule', async () => {
  await withDatabase(async (database) => {
    const pending = await database.upsertSubscription(subscriptionEvent(100), config(), 200, 100)
    const subscription = await database.confirmSubscription(pending.confirmationToken, 200, 100)
    let run = await database.createDigestRun(subscription, 100, 200, 200)
    run = await database.startDigestRun(run.runId, 200)
    assert.equal(await database.isDeliverable(subscription.pubkey, subscription.eventId, subscription.confirmedEmail), true)

    const replacement = await database.upsertSubscription(
      subscriptionEvent(101, '7'.repeat(64)),
      config({ cadence: { intervalDays: 3, localTime: '10:00', timezone: 'UTC' } }),
      400,
      201
    )
    assert.equal(replacement.subscription.nextRunAt, 400)
    await database.completeDigestRun(
      run,
      'completed',
      2,
      'message-id',
      300,
      subscription.confirmedEmail,
      202
    )
    const advanced = await database.getSubscription(subscription.pubkey)
    assert.equal(advanced.eventId, replacement.subscription.eventId)
    assert.equal(advanced.periodStart, 200)
    assert.equal(advanced.nextRunAt, 400)

    let secondRun = await database.createDigestRun(advanced, 200, 400, 400)
    secondRun = await database.startDigestRun(secondRun.runId, 400)
    const pendingEmail = await database.upsertSubscription(
      subscriptionEvent(102, '8'.repeat(64)),
      config({
        email: 'changed@example.com',
        cadence: { intervalDays: 3, localTime: '10:00', timezone: 'UTC' },
      }),
      500,
      401
    )
    await database.completeDigestRun(
      secondRun,
      'empty',
      0,
      undefined,
      500,
      subscription.confirmedEmail,
      402
    )
    const stillPending = await database.getSubscription(subscription.pubkey)
    assert.equal(stillPending.state, 'pending')
    assert.equal(stillPending.periodStart, pendingEmail.subscription.periodStart)
    assert.equal(stillPending.nextRunAt, undefined)
  })
})

test('unsubscribe tokens rotate on unsubscribe and error reactivation', async () => {
  await withDatabase(async (database) => {
    const pending = await database.upsertSubscription(subscriptionEvent(100), config(), 200, 100)
    let subscription = await database.confirmSubscription(pending.confirmationToken, 200, 100)
    const activeToken = subscription.unsubscribeToken
    await database.unsubscribe(activeToken, 110)
    subscription = (
      await database.upsertSubscription(
        subscriptionEvent(101, '9'.repeat(64)),
        config(),
        220,
        120
      )
    ).subscription
    assert.equal(subscription.state, 'active')
    assert.notEqual(subscription.unsubscribeToken, activeToken)

    let run = await database.createDigestRun(subscription, 100, 220, 220)
    run = await database.startDigestRun(run.runId, 220)
    await database.failDigestRun(run, 'failed', 221)
    const errorToken = subscription.unsubscribeToken
    subscription = (
      await database.upsertSubscription(
        subscriptionEvent(102, 'a'.repeat(64)),
        config(),
        300,
        230
      )
    ).subscription
    assert.equal(subscription.state, 'active')
    assert.notEqual(subscription.unsubscribeToken, errorToken)
  })
})

test('an empty due period completes once and advances persisted boundaries without email', async () => {
  await withDatabase(async (database) => {
    const pending = await database.upsertSubscription(subscriptionEvent(100), config(), 200, 100)
    await database.confirmSubscription(pending.confirmationToken, 200, 100)
    let sends = 0
    const collector = {
      async collect(_config, _pubkey, periodStart, periodEnd) {
        return {
          periodStart,
          periodEnd,
          eventCount: 0,
          attentionCount: 0,
          overflow: 0,
          attention: [],
          repositories: [],
        }
      },
      close() {},
    }
    const sender = {
      async sendDigest() {
        sends++
        return 'message-id'
      },
    }
    const scheduler = new DigestScheduler(database, collector, sender, 30_000, 3, () => 200)
    await scheduler.runOnce(200)

    const subscription = await database.getSubscription(subscriptionEvent(100).pubkey)
    const runs = await database.getRuns(subscriptionEvent(100).pubkey)
    assert.equal(sends, 0)
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'empty')
    assert.equal(runs[0].periodStart, 100)
    assert.equal(runs[0].periodEnd, 200)
    assert.equal(subscription.periodStart, 200)
    assert.equal(subscription.lastCompletedAt, 200)
    assert.ok(subscription.nextRunAt > 200)
  })
})

test('scheduler performs three retries after the initial attempt', async () => {
  await withDatabase(async (database) => {
    const pending = await database.upsertSubscription(subscriptionEvent(100), config(), 200, 100)
    await database.confirmSubscription(pending.confirmationToken, 200, 100)
    let collections = 0
    const collector = {
      async collect() {
        collections++
        throw new Error('temporary relay failure')
      },
      close() {},
    }
    const sender = { async sendDigest() { throw new Error('unexpected send') } }
    const scheduler = new DigestScheduler(database, collector, sender)

    await scheduler.runOnce(200)
    assert.equal((await database.getSubscription(subscriptionEvent(100).pubkey)).nextRunAt, 260)
    await scheduler.runOnce(260)
    assert.equal((await database.getSubscription(subscriptionEvent(100).pubkey)).nextRunAt, 560)
    await scheduler.runOnce(560)
    assert.equal((await database.getSubscription(subscriptionEvent(100).pubkey)).nextRunAt, 1460)
    await scheduler.runOnce(1460)

    const runs = await database.getRuns(subscriptionEvent(100).pubkey)
    const subscription = await database.getSubscription(subscriptionEvent(100).pubkey)
    assert.equal(collections, 4)
    assert.equal(runs[0].attempts, 4)
    assert.equal(runs[0].status, 'failed')
    assert.equal(subscription.state, 'error')
  })
})
