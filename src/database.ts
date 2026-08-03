import crypto from 'node:crypto'
import sqlite3 from 'sqlite3'
import type { SignedEvent } from '@welshman/util'
import type { DigestConfig } from './subscription.js'
import { getSubscriptionAddress } from './subscription.js'

export type SubscriptionState =
  | 'pending'
  | 'active'
  | 'unsubscribed'
  | 'suppressed'
  | 'deleted'
  | 'error'

export type Subscription = {
  pubkey: string
  address: string
  eventId: string
  eventCreatedAt: number
  event: SignedEvent
  config?: DigestConfig
  pendingConfig?: DigestConfig
  state: SubscriptionState
  confirmationTokenHash?: string
  unsubscribeToken: string
  confirmedEmail?: string
  confirmedAt?: number
  unsubscribedAt?: number
  suppressedAt?: number
  suppressedReason?: string
  deletedAt?: number
  periodStart?: number
  lastCompletedAt?: number
  nextRunAt?: number
  lastError?: string
  createdAt: number
  updatedAt: number
}

export type DigestRunStatus =
  | 'queued'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'empty'
  | 'failed'
  | 'canceled'

export type DigestRun = {
  id: number
  runId: string
  subscriptionPubkey: string
  subscriptionEventId: string
  periodStart: number
  periodEnd: number
  status: DigestRunStatus
  attempts: number
  eventCount: number
  messageId?: string
  error?: string
  createdAt: number
  updatedAt: number
  completedAt?: number
}

type SqlValue = string | number | null
type RawRow = Record<string, any>

const token = () => crypto.randomBytes(32).toString('hex')
export const hashToken = (value: string) => crypto.createHash('sha256').update(value).digest('hex')

const optionalNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

const parseSubscription = (row?: RawRow): Subscription | undefined => {
  if (!row) return undefined
  return {
    pubkey: row.pubkey,
    address: row.address,
    eventId: row.event_id,
    eventCreatedAt: row.event_created_at,
    event: JSON.parse(row.event_json),
    config: row.config_json ? JSON.parse(row.config_json) : undefined,
    pendingConfig: row.pending_config_json ? JSON.parse(row.pending_config_json) : undefined,
    state: row.state,
    confirmationTokenHash: row.confirmation_token_hash || undefined,
    unsubscribeToken: row.unsubscribe_token,
    confirmedEmail: row.confirmed_email || undefined,
    confirmedAt: optionalNumber(row.confirmed_at),
    unsubscribedAt: optionalNumber(row.unsubscribed_at),
    suppressedAt: optionalNumber(row.suppressed_at),
    suppressedReason: row.suppressed_reason || undefined,
    deletedAt: optionalNumber(row.deleted_at),
    periodStart: optionalNumber(row.period_start),
    lastCompletedAt: optionalNumber(row.last_completed_at),
    nextRunAt: optionalNumber(row.next_run_at),
    lastError: row.last_error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

const parseRun = (row?: RawRow): DigestRun | undefined => {
  if (!row) return undefined
  return {
    id: row.id,
    runId: row.run_id,
    subscriptionPubkey: row.subscription_pubkey,
    subscriptionEventId: row.subscription_event_id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    status: row.status,
    attempts: row.attempts,
    eventCount: row.event_count,
    messageId: row.message_id || undefined,
    error: row.error || undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: optionalNumber(row.completed_at),
  }
}

export class DigestDatabase {
  private readonly db: sqlite3.Database
  private initialized = false
  private closed = false
  private writeLock = Promise.resolve()

  constructor(path = process.env.ANCHOR_DB_PATH || 'anchor.db') {
    this.db = new sqlite3.Database(path)
    this.db.configure('busyTimeout', 5000)
  }

  private run(sql: string, params: SqlValue[] = []) {
    return new Promise<{ changes: number; lastID: number }>((resolve, reject) => {
      this.db.run(sql, params, function (error) {
        if (error) reject(error)
        else resolve({ changes: this.changes, lastID: this.lastID })
      })
    })
  }

  private exec(sql: string) {
    return new Promise<void>((resolve, reject) => {
      this.db.exec(sql, (error) => (error ? reject(error) : resolve()))
    })
  }

  private get<T = RawRow>(sql: string, params: SqlValue[] = []) {
    return new Promise<T | undefined>((resolve, reject) => {
      this.db.get(sql, params, (error, row) =>
        error ? reject(error) : resolve(row as T | undefined)
      )
    })
  }

  private all<T = RawRow>(sql: string, params: SqlValue[] = []) {
    return new Promise<T[]>((resolve, reject) => {
      this.db.all(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows as T[])
      )
    })
  }

  private async transaction<T>(operation: () => Promise<T>) {
    let unlock = () => {}
    const previous = this.writeLock
    this.writeLock = new Promise<void>((resolve) => {
      unlock = resolve
    })
    await previous
    let began = false
    try {
      await this.exec('BEGIN IMMEDIATE')
      began = true
      const result = await operation()
      await this.exec('COMMIT')
      return result
    } catch (error) {
      if (began) await this.exec('ROLLBACK').catch(() => undefined)
      throw error
    } finally {
      unlock()
    }
  }

  async initialize() {
    if (this.initialized) return
    await this.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    await this.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        pubkey TEXT PRIMARY KEY,
        address TEXT NOT NULL UNIQUE,
        event_id TEXT NOT NULL,
        event_created_at INTEGER NOT NULL,
        event_json TEXT NOT NULL,
        config_json TEXT,
        pending_config_json TEXT,
        state TEXT NOT NULL,
        confirmation_token_hash TEXT UNIQUE,
        unsubscribe_token TEXT NOT NULL UNIQUE,
        confirmed_email TEXT,
        confirmed_at INTEGER,
        unsubscribed_at INTEGER,
        suppressed_at INTEGER,
        suppressed_reason TEXT,
        deleted_at INTEGER,
        period_start INTEGER,
        last_completed_at INTEGER,
        next_run_at INTEGER,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS subscriptions_due
        ON subscriptions (state, next_run_at);

      CREATE TABLE IF NOT EXISTS digest_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL UNIQUE,
        subscription_pubkey TEXT NOT NULL,
        subscription_event_id TEXT NOT NULL,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        event_count INTEGER NOT NULL DEFAULT 0,
        message_id TEXT,
        error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (subscription_pubkey) REFERENCES subscriptions(pubkey)
      );
      CREATE INDEX IF NOT EXISTS digest_runs_pending
        ON digest_runs (subscription_pubkey, status);
      CREATE UNIQUE INDEX IF NOT EXISTS digest_runs_open_period
        ON digest_runs (subscription_pubkey, period_end)
        WHERE status IN ('queued', 'running', 'retrying');
    `)

    const currentTime = Math.floor(Date.now() / 1000)
    await this.transaction(async () => {
      await this.run(
        `UPDATE subscriptions SET state = 'error', last_error = 'Digest failed after 4 attempts',
         next_run_at = NULL, updated_at = ?
         WHERE state = 'active' AND EXISTS (
           SELECT 1 FROM digest_runs
           WHERE digest_runs.subscription_pubkey = subscriptions.pubkey
             AND digest_runs.subscription_event_id = subscriptions.event_id
             AND digest_runs.status = 'running' AND digest_runs.attempts >= 4
         )`,
        [currentTime]
      )
      await this.run(
        `UPDATE subscriptions SET next_run_at = ?, updated_at = ?
         WHERE state = 'active' AND EXISTS (
           SELECT 1 FROM digest_runs
           WHERE digest_runs.subscription_pubkey = subscriptions.pubkey
             AND digest_runs.subscription_event_id = subscriptions.event_id
             AND digest_runs.status = 'running' AND digest_runs.attempts < 4
         )`,
        [currentTime, currentTime]
      )
      await this.run(
        `UPDATE digest_runs SET status = 'failed', error = 'interrupted after 4 attempts',
         completed_at = ?, updated_at = ? WHERE status = 'running' AND attempts >= 4`,
        [currentTime, currentTime]
      )
      await this.run(
        `UPDATE digest_runs SET status = 'retrying', error = 'interrupted', updated_at = ?
         WHERE status = 'running' AND attempts < 4`,
        [currentTime]
      )
    })
    this.initialized = true
  }

  async ping() {
    if (!this.initialized || this.closed) return false
    const row = await this.get<{ ok: number }>('SELECT 1 AS ok')
    return row?.ok === 1
  }

  async close() {
    if (this.closed) return
    await this.writeLock
    await new Promise<void>((resolve, reject) =>
      this.db.close((error) => (error ? reject(error) : resolve()))
    )
    this.closed = true
  }

  async getSubscription(pubkey: string) {
    return parseSubscription(await this.get('SELECT * FROM subscriptions WHERE pubkey = ?', [pubkey]))
  }

  async getSubscriptionsForPubkey(pubkey: string) {
    const subscription = await this.getSubscription(pubkey)
    return subscription ? [subscription] : []
  }

  async upsertSubscription(
    event: SignedEvent,
    config: DigestConfig,
    firstNextRunAt: number,
    currentTime: number
  ): Promise<{
    subscription: Subscription
    applied: boolean
    duplicate: boolean
    confirmationToken?: string
  }> {
    return this.transaction(async () => {
      const existing = parseSubscription(
        await this.get('SELECT * FROM subscriptions WHERE pubkey = ?', [event.pubkey])
      )
      if (
        existing &&
        (event.created_at <= existing.eventCreatedAt ||
          (existing.deletedAt !== undefined && event.created_at <= existing.deletedAt))
      ) {
        return {
          subscription: existing,
          applied: false,
          duplicate: event.id === existing.eventId,
        }
      }

      const confirmationToken = token()
      const sameConfirmedEmail =
        existing?.confirmedAt !== undefined && existing.confirmedEmail === config.email
      const remainsSuppressed = sameConfirmedEmail && existing?.state === 'suppressed'
      const nextState: SubscriptionState = sameConfirmedEmail
        ? remainsSuppressed
          ? 'suppressed'
          : 'active'
        : 'pending'
      const reactivating =
        sameConfirmedEmail && nextState === 'active' && existing?.state !== 'active'
      const unsubscribeToken = existing && !reactivating ? existing.unsubscribeToken : token()
      const activeConfig = sameConfirmedEmail ? config : existing?.config
      const pendingConfig = sameConfirmedEmail ? undefined : config
      const confirmationHash = sameConfirmedEmail ? undefined : hashToken(confirmationToken)
      const cadenceUnchanged =
        sameConfirmedEmail &&
        existing?.config?.cadence.intervalDays === config.cadence.intervalDays &&
        existing.config.cadence.localTime === config.cadence.localTime &&
        existing.config.cadence.timezone === config.cadence.timezone
      const nextRunAt =
        nextState === 'active'
          ? cadenceUnchanged && existing?.nextRunAt
            ? existing.nextRunAt
            : firstNextRunAt
          : undefined
      const periodStart = sameConfirmedEmail
        ? existing?.periodStart || currentTime
        : existing?.periodStart

      await this.run(
        `INSERT INTO subscriptions (
           pubkey, address, event_id, event_created_at, event_json, config_json,
           pending_config_json, state, confirmation_token_hash, unsubscribe_token,
           confirmed_email, confirmed_at, unsubscribed_at, suppressed_at,
           suppressed_reason, deleted_at, period_start, last_completed_at,
           next_run_at, last_error, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(pubkey) DO UPDATE SET
           address = excluded.address,
           event_id = excluded.event_id,
           event_created_at = excluded.event_created_at,
           event_json = excluded.event_json,
           config_json = excluded.config_json,
           pending_config_json = excluded.pending_config_json,
           state = excluded.state,
           confirmation_token_hash = excluded.confirmation_token_hash,
           unsubscribe_token = excluded.unsubscribe_token,
           confirmed_email = excluded.confirmed_email,
           confirmed_at = excluded.confirmed_at,
           unsubscribed_at = NULL,
           suppressed_at = excluded.suppressed_at,
           suppressed_reason = excluded.suppressed_reason,
           deleted_at = NULL,
           period_start = excluded.period_start,
           last_completed_at = excluded.last_completed_at,
           next_run_at = excluded.next_run_at,
           last_error = NULL,
           updated_at = excluded.updated_at
         WHERE excluded.event_created_at > subscriptions.event_created_at`,
        [
          event.pubkey,
          getSubscriptionAddress(event.pubkey),
          event.id,
          event.created_at,
          JSON.stringify(event),
          activeConfig ? JSON.stringify(activeConfig) : null,
          pendingConfig ? JSON.stringify(pendingConfig) : null,
          nextState,
          confirmationHash || null,
          unsubscribeToken,
          sameConfirmedEmail ? existing?.confirmedEmail || config.email : existing?.confirmedEmail || null,
          sameConfirmedEmail ? existing?.confirmedAt || currentTime : existing?.confirmedAt || null,
          remainsSuppressed ? existing?.suppressedAt || currentTime : null,
          remainsSuppressed ? existing?.suppressedReason || 'delivery suppressed' : null,
          periodStart || null,
          existing?.lastCompletedAt || null,
          nextRunAt || null,
          existing?.createdAt || currentTime,
          currentTime,
        ]
      )

      const subscription = parseSubscription(
        await this.get('SELECT * FROM subscriptions WHERE pubkey = ?', [event.pubkey])
      )!
      return {
        subscription,
        applied: subscription.eventId === event.id,
        duplicate: false,
        ...(!sameConfirmedEmail ? { confirmationToken } : {}),
      }
    })
  }

  async getByConfirmationToken(value: string) {
    return parseSubscription(
      await this.get('SELECT * FROM subscriptions WHERE confirmation_token_hash = ?', [hashToken(value)])
    )
  }

  async confirmSubscription(value: string, nextRunAt: number, currentTime: number) {
    const digest = hashToken(value)
    const unsubscribeToken = token()
    return this.transaction(async () => {
      const existing = parseSubscription(
        await this.get('SELECT * FROM subscriptions WHERE confirmation_token_hash = ?', [digest])
      )
      if (!existing?.pendingConfig || existing.state !== 'pending') return undefined
      await this.run(
        `UPDATE subscriptions SET
           config_json = pending_config_json,
           pending_config_json = NULL,
           state = 'active',
           confirmation_token_hash = NULL,
           confirmed_email = ?,
           confirmed_at = ?,
           unsubscribe_token = ?,
           unsubscribed_at = NULL,
           suppressed_at = NULL,
           suppressed_reason = NULL,
           period_start = ?,
           next_run_at = ?,
           last_error = NULL,
           updated_at = ?
         WHERE pubkey = ? AND confirmation_token_hash = ?`,
        [
          existing.pendingConfig.email,
          currentTime,
          unsubscribeToken,
          currentTime,
          nextRunAt,
          currentTime,
          existing.pubkey,
          digest,
        ]
      )
      return this.getSubscription(existing.pubkey)
    })
  }

  async getByUnsubscribeToken(value: string) {
    return parseSubscription(
      await this.get('SELECT * FROM subscriptions WHERE unsubscribe_token = ?', [value])
    )
  }

  async unsubscribe(value: string, currentTime: number) {
    return this.transaction(async () => {
      await this.run(
        `UPDATE subscriptions SET state = 'unsubscribed', unsubscribed_at = ?,
         next_run_at = NULL, updated_at = ? WHERE unsubscribe_token = ?`,
        [currentTime, currentTime, value]
      )
      return parseSubscription(
        await this.get('SELECT * FROM subscriptions WHERE unsubscribe_token = ?', [value])
      )
    })
  }

  async deleteSubscription(pubkey: string, deletedAt: number, currentTime: number) {
    return this.transaction(async () => {
      const result = await this.run(
        `UPDATE subscriptions SET state = 'deleted', deleted_at = ?, next_run_at = NULL,
         updated_at = ? WHERE pubkey = ? AND event_created_at < ?`,
        [deletedAt, currentTime, pubkey, deletedAt]
      )
      return result.changes > 0
    })
  }

  async suppressSubscription(
    pubkey: string,
    confirmedEmail: string | undefined,
    reason: string,
    currentTime: number
  ) {
    const params: SqlValue[] = [currentTime, reason, currentTime, pubkey]
    let emailCondition = ''
    if (confirmedEmail) {
      emailCondition = ' AND confirmed_email = ?'
      params.push(confirmedEmail.trim().toLowerCase())
    }
    return this.transaction(async () => {
      const result = await this.run(
        `UPDATE subscriptions SET state = 'suppressed', suppressed_at = ?,
         suppressed_reason = ?, next_run_at = NULL, updated_at = ?
         WHERE pubkey = ? AND state = 'active'${emailCondition}`,
        params
      )
      return result.changes > 0
    })
  }

  async setSubscriptionError(pubkey: string, error: string | undefined, currentTime: number) {
    await this.transaction(() =>
      this.run('UPDATE subscriptions SET last_error = ?, updated_at = ? WHERE pubkey = ?', [
        error || null,
        currentTime,
        pubkey,
      ])
    )
  }

  async getDueSubscriptions(currentTime: number, limit: number) {
    const rows = await this.all(
      `SELECT * FROM subscriptions WHERE state = 'active' AND confirmed_email IS NOT NULL
       AND config_json IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC LIMIT ?`,
      [currentTime, limit]
    )
    return rows.map(parseSubscription) as Subscription[]
  }

  async getPendingRun(pubkey: string) {
    return parseRun(
      await this.get(
        `SELECT * FROM digest_runs WHERE subscription_pubkey = ?
         AND status IN ('queued', 'running', 'retrying') ORDER BY id DESC LIMIT 1`,
        [pubkey]
      )
    )
  }

  async createDigestRun(
    subscription: Subscription,
    periodStart: number,
    periodEnd: number,
    currentTime: number
  ) {
    const runId = `${subscription.eventId}:${crypto.randomUUID()}`
    return this.transaction(async () => {
      await this.run(
        `INSERT OR IGNORE INTO digest_runs (
           run_id, subscription_pubkey, subscription_event_id, period_start,
           period_end, status, attempts, event_count, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?)`,
        [
          runId,
          subscription.pubkey,
          subscription.eventId,
          periodStart,
          periodEnd,
          currentTime,
          currentTime,
        ]
      )
      return parseRun(
        await this.get(
          `SELECT * FROM digest_runs WHERE subscription_pubkey = ? AND period_end = ?
           AND status IN ('queued', 'running', 'retrying') ORDER BY id DESC LIMIT 1`,
          [subscription.pubkey, periodEnd]
        )
      )!
    })
  }

  async startDigestRun(runId: string, currentTime: number) {
    return this.transaction(async () => {
      return parseRun(
        await this.get(
          `UPDATE digest_runs SET status = 'running', attempts = attempts + 1,
           error = NULL, updated_at = ? WHERE run_id = ? AND status IN ('queued', 'retrying')
           RETURNING *`,
          [currentTime, runId]
        )
      )
    })
  }

  async setRunEventCount(runId: string, eventCount: number, currentTime: number) {
    await this.transaction(() =>
      this.run(
        `UPDATE digest_runs SET event_count = ?, updated_at = ?
         WHERE run_id = ? AND status = 'running'`,
        [eventCount, currentTime, runId]
      )
    )
  }

  async isDeliverable(pubkey: string, eventId: string, email: string) {
    const row = await this.get<{ ok: number }>(
      `SELECT 1 AS ok FROM subscriptions WHERE pubkey = ? AND event_id = ?
       AND state = 'active' AND confirmed_email = ?`,
      [pubkey, eventId, email]
    )
    return row?.ok === 1
  }

  async retryDigestRun(
    runId: string,
    pubkey: string,
    eventId: string,
    nextRetryAt: number,
    error: string,
    currentTime: number
  ) {
    return this.transaction(async () => {
      const retried = parseRun(
        await this.get(
          `UPDATE digest_runs SET status = 'retrying', error = ?, updated_at = ?
           WHERE run_id = ? AND status = 'running' RETURNING *`,
          [error, currentTime, runId]
        )
      )
      if (!retried) return false
      await this.run(
        `UPDATE subscriptions SET next_run_at = ?, last_error = ?, updated_at = ?
         WHERE pubkey = ? AND event_id = ? AND state = 'active'`,
        [nextRetryAt, error, currentTime, pubkey, eventId]
      )
      return true
    })
  }

  async completeDigestRun(
    run: DigestRun,
    status: 'completed' | 'empty',
    eventCount: number,
    messageId: string | undefined,
    nextRunAt: number,
    confirmedEmail: string,
    currentTime: number
  ) {
    return this.transaction(async () => {
      const completed = parseRun(
        await this.get(
        `UPDATE digest_runs SET status = ?, event_count = ?, message_id = ?, error = NULL,
         completed_at = ?, updated_at = ? WHERE run_id = ? AND status = 'running'
         RETURNING *`,
          [status, eventCount, messageId || null, currentTime, currentTime, run.runId]
        )
      )
      if (!completed) return false
      const candidateNextRunAt = Math.max(nextRunAt, run.periodEnd + 1)
      await this.run(
        `UPDATE subscriptions SET period_start = ?, last_completed_at = ?,
         next_run_at = CASE WHEN next_run_at IS NULL OR next_run_at <= ? THEN ? ELSE next_run_at END,
         last_error = NULL, updated_at = ?
         WHERE pubkey = ? AND state = 'active' AND confirmed_email = ?`,
        [
          run.periodEnd,
          currentTime,
          run.periodEnd,
          candidateNextRunAt,
          currentTime,
          run.subscriptionPubkey,
          confirmedEmail,
        ]
      )
      return true
    })
  }

  async failDigestRun(run: DigestRun, error: string, currentTime: number) {
    return this.transaction(async () => {
      const failed = parseRun(
        await this.get(
        `UPDATE digest_runs SET status = 'failed', error = ?, completed_at = ?, updated_at = ?
         WHERE run_id = ? AND status = 'running' RETURNING *`,
          [error, currentTime, currentTime, run.runId]
        )
      )
      if (!failed) return false
      await this.run(
        `UPDATE subscriptions SET state = 'error', last_error = ?, next_run_at = NULL,
         updated_at = ? WHERE pubkey = ? AND event_id = ?`,
        [error, currentTime, run.subscriptionPubkey, run.subscriptionEventId]
      )
      return true
    })
  }

  async cancelDigestRun(runId: string, currentTime: number) {
    return this.transaction(async () => {
      const canceled = parseRun(
        await this.get(
          `UPDATE digest_runs SET status = 'canceled', completed_at = ?, updated_at = ?
           WHERE run_id = ? AND status IN ('queued', 'running', 'retrying') RETURNING *`,
          [currentTime, currentTime, runId]
        )
      )
      return Boolean(canceled)
    })
  }

  async getRuns(pubkey: string) {
    const rows = await this.all(
      'SELECT * FROM digest_runs WHERE subscription_pubkey = ? ORDER BY id',
      [pubkey]
    )
    return rows.map(parseRun) as DigestRun[]
  }
}
