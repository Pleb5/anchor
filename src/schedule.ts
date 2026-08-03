import { DateTime } from 'luxon'
import type { DigestConfig } from './subscription.js'

type Cadence = DigestConfig['cadence']

const localParts = (cadence: Cadence) => {
  const [hour, minute] = cadence.localTime.split(':').map(Number)
  return { hour, minute }
}

const atConfiguredTime = (date: DateTime, cadence: Cadence) => {
  const { hour, minute } = localParts(cadence)
  const local = DateTime.fromObject(
    { year: date.year, month: date.month, day: date.day, hour, minute },
    { zone: cadence.timezone }
  )
  if (!local.isValid) throw new Error(`Unable to schedule in ${cadence.timezone}`)
  return local.startOf('minute')
}

export function firstRunAfter(cadence: Cadence, after: number) {
  const localAfter = DateTime.fromSeconds(after, { zone: cadence.timezone })
  let candidate = atConfiguredTime(localAfter, cadence)
  if (candidate.toSeconds() <= after) {
    candidate = atConfiguredTime(localAfter.plus({ days: cadence.intervalDays }), cadence)
  }
  return Math.floor(candidate.toSeconds())
}

export function nextRunAfter(previousRun: number, cadence: Cadence) {
  const previousLocal = DateTime.fromSeconds(previousRun, { zone: cadence.timezone })
  return Math.floor(
    atConfiguredTime(previousLocal.plus({ days: cadence.intervalDays }), cadence).toSeconds()
  )
}

export function getDuePeriod(nextRun: number, cadence: Cadence, currentTime: number) {
  if (nextRun > currentTime) throw new Error('Subscription is not due')

  let periodEnd = nextRun
  let following = nextRunAfter(periodEnd, cadence)
  let count = 0
  while (following <= currentTime) {
    periodEnd = following
    following = nextRunAfter(periodEnd, cadence)
    if (++count > 100_000) throw new Error('Unable to advance digest schedule')
  }
  return { periodEnd, nextRun: following }
}
