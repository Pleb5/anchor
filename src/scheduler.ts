import type { DigestDatabase, DigestRun, Subscription } from './database.js'
import type { DigestData } from './digest.js'
import { getDuePeriod } from './schedule.js'
import { logStructured } from './logger.js'

type Collector = {
  collect(
    config: NonNullable<Subscription['config']>,
    pubkey: string,
    periodStart: number,
    periodEnd: number
  ): Promise<DigestData>
  close(): void | Promise<void>
}

type Sender = {
  sendDigest(subscription: Subscription, run: DigestRun, data: DigestData): Promise<string>
}

const retryDelay = (attempts: number) => {
  if (attempts <= 1) return 60
  if (attempts === 2) return 5 * 60
  return 15 * 60
}

const failureMessage = () => 'Digest collection or delivery failed'

export class DigestScheduler {
  private readonly active = new Map<string, Promise<void>>()
  private timer?: NodeJS.Timeout
  private polling = false
  private started = false
  private stopping = false
  private healthy = false

  constructor(
    private readonly database: DigestDatabase,
    private readonly collector: Collector,
    private readonly sender: Sender,
    private readonly pollIntervalMs = 30_000,
    private readonly concurrency = 3,
    private readonly clock = () => Math.floor(Date.now() / 1000)
  ) {}

  get ready() {
    return this.started && !this.stopping && this.healthy
  }

  start() {
    if (this.started) return
    this.started = true
    this.timer = setInterval(() => void this.poll(), this.pollIntervalMs)
    this.timer.unref()
    void this.poll()
  }

  private launch(subscription: Subscription, currentTime: number) {
    if (this.stopping || this.active.has(subscription.pubkey)) return
    const task = this.process(subscription, currentTime)
      .catch((error) => {
        logStructured({
          category: 'delivery',
          status: 'worker_error',
          subscription: subscription.pubkey,
          errorType: error instanceof Error ? error.name : 'Error',
        })
      })
      .finally(() => {
        this.active.delete(subscription.pubkey)
        if (!this.stopping) void this.poll()
      })
    this.active.set(subscription.pubkey, task)
  }

  private async poll() {
    if (!this.started || this.stopping || this.polling) return
    const available = this.concurrency - this.active.size
    if (available <= 0) return
    this.polling = true
    try {
      const currentTime = this.clock()
      const due = await this.database.getDueSubscriptions(currentTime, available)
      if (!this.stopping) {
        for (const subscription of due) this.launch(subscription, currentTime)
      }
      this.healthy = true
    } catch (error) {
      this.healthy = false
      logStructured({
        category: 'delivery',
        status: 'poll_failed',
        errorType: error instanceof Error ? error.name : 'Error',
      })
    } finally {
      this.polling = false
    }
  }

  async runOnce(currentTime = this.clock()) {
    const due = await this.database.getDueSubscriptions(currentTime, this.concurrency)
    const tasks = due
      .filter((subscription) => !this.active.has(subscription.pubkey))
      .map(async (subscription) => {
        const task = this.process(subscription, currentTime)
        this.active.set(subscription.pubkey, task)
        try {
          await task
        } finally {
          this.active.delete(subscription.pubkey)
        }
      })
    await Promise.all(tasks)
  }

  private async process(subscription: Subscription, currentTime: number) {
    if (!subscription.config || !subscription.confirmedEmail || !subscription.nextRunAt) return

    let run = await this.database.getPendingRun(subscription.pubkey)
    if (run && run.subscriptionEventId !== subscription.eventId) {
      await this.database.cancelDigestRun(run.runId, currentTime)
      run = undefined
    }
    let nextRunAt: number
    if (!run) {
      const period = getDuePeriod(
        subscription.nextRunAt,
        subscription.config.cadence,
        currentTime
      )
      nextRunAt = period.nextRun
      run = await this.database.createDigestRun(
        subscription,
        subscription.periodStart || subscription.confirmedAt || currentTime,
        period.periodEnd,
        currentTime
      )
    } else {
      nextRunAt = getDuePeriod(run.periodEnd, subscription.config.cadence, run.periodEnd).nextRun
    }

    const claimedRun = await this.database.startDigestRun(run.runId, currentTime)
    if (!claimedRun) return
    run = claimedRun
    logStructured({
      category: 'delivery',
      status: 'started',
      subscription: subscription.pubkey,
      runId: run.runId,
    })

    try {
      const data = await this.collector.collect(
        subscription.config,
        subscription.pubkey,
        run.periodStart,
        run.periodEnd
      )
      await this.database.setRunEventCount(run.runId, data.eventCount, currentTime)
      const deliverable = await this.database.isDeliverable(
        subscription.pubkey,
        run.subscriptionEventId,
        subscription.confirmedEmail
      )
      if (!deliverable) {
        await this.database.cancelDigestRun(run.runId, currentTime)
        logStructured({
          category: 'delivery',
          status: 'canceled',
          subscription: subscription.pubkey,
          runId: run.runId,
        })
        return
      }

      if (data.eventCount === 0) {
        await this.database.completeDigestRun(
          run,
          'empty',
          0,
          undefined,
          nextRunAt,
          subscription.confirmedEmail,
          currentTime
        )
        logStructured({
          category: 'delivery',
          status: 'empty',
          subscription: subscription.pubkey,
          runId: run.runId,
          eventCount: 0,
        })
        return
      }

      const messageId = await this.sender.sendDigest(subscription, run, data)
      await this.database.completeDigestRun(
        run,
        'completed',
        data.eventCount,
        messageId,
        nextRunAt,
        subscription.confirmedEmail,
        currentTime
      )
      logStructured({
        category: 'delivery',
        status: 'sent',
        subscription: subscription.pubkey,
        runId: run.runId,
        eventCount: data.eventCount,
        messageId,
      })
    } catch (error) {
      const message = failureMessage()
      const deliverable = await this.database.isDeliverable(
        subscription.pubkey,
        run.subscriptionEventId,
        subscription.confirmedEmail
      )
      if (!deliverable) {
        await this.database.cancelDigestRun(run.runId, currentTime)
        logStructured({
          category: 'delivery',
          status: 'canceled',
          subscription: subscription.pubkey,
          runId: run.runId,
        })
        return
      }
      if (run.attempts < 4) {
        const nextRetry = currentTime + retryDelay(run.attempts)
        await this.database.retryDigestRun(
          run.runId,
          subscription.pubkey,
          run.subscriptionEventId,
          nextRetry,
          `${message}; retry ${run.attempts} of 3 scheduled`,
          currentTime
        )
        logStructured({
          category: 'delivery',
          status: 'retrying',
          subscription: subscription.pubkey,
          runId: run.runId,
          errorType: error instanceof Error ? error.name : 'Error',
        })
      } else {
        await this.database.failDigestRun(run, `${message} after 4 attempts`, currentTime)
        logStructured({
          category: 'delivery',
          status: 'failed',
          subscription: subscription.pubkey,
          runId: run.runId,
          errorType: error instanceof Error ? error.name : 'Error',
        })
      }
    }
  }

  async stop() {
    if (this.stopping) return
    this.stopping = true
    this.started = false
    if (this.timer) clearInterval(this.timer)
    while (this.polling) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await Promise.allSettled(this.active.values())
    await this.collector.close()
  }
}
