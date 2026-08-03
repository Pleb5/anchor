import test from 'node:test'
import assert from 'node:assert/strict'
import { DateTime } from 'luxon'
import { firstRunAfter, getDuePeriod, nextRunAfter } from '../dist/schedule.js'

test('N-day cadence stays on local calendar time across DST', () => {
  const cadence = { intervalDays: 2, localTime: '09:00', timezone: 'America/New_York' }
  const previous = Math.floor(
    DateTime.fromISO('2026-03-07T09:00:00', { zone: cadence.timezone }).toSeconds()
  )
  const next = nextRunAfter(previous, cadence)
  const local = DateTime.fromSeconds(next, { zone: cadence.timezone })
  assert.equal(local.toISODate(), '2026-03-09')
  assert.equal(local.toFormat('HH:mm'), '09:00')
  assert.equal(next - previous, 47 * 60 * 60)
})

test('nonexistent spring-forward local time advances safely and then returns to configured time', () => {
  const cadence = { intervalDays: 1, localTime: '02:30', timezone: 'America/New_York' }
  const previous = Math.floor(
    DateTime.fromISO('2026-03-07T02:30:00', { zone: cadence.timezone }).toSeconds()
  )
  const shifted = nextRunAfter(previous, cadence)
  assert.equal(DateTime.fromSeconds(shifted, { zone: cadence.timezone }).toFormat('HH:mm'), '03:30')
  const following = nextRunAfter(shifted, cadence)
  assert.equal(DateTime.fromSeconds(following, { zone: cadence.timezone }).toFormat('HH:mm'), '02:30')
})

test('first run and missed periods use one consolidated due boundary', () => {
  const cadence = { intervalDays: 2, localTime: '09:00', timezone: 'UTC' }
  const after = Math.floor(DateTime.fromISO('2026-04-01T10:00:00Z').toSeconds())
  const first = firstRunAfter(cadence, after)
  assert.equal(DateTime.fromSeconds(first, { zone: 'UTC' }).toISO(), '2026-04-03T09:00:00.000Z')
  const current = Math.floor(DateTime.fromISO('2026-04-09T12:00:00Z').toSeconds())
  const due = getDuePeriod(first, cadence, current)
  assert.equal(DateTime.fromSeconds(due.periodEnd, { zone: 'UTC' }).toISODate(), '2026-04-09')
  assert.equal(DateTime.fromSeconds(due.nextRun, { zone: 'UTC' }).toISODate(), '2026-04-11')
})
