import { DateTime, IANAZone } from 'luxon'
import { DELETE, type SignedEvent } from '@welshman/util'
import type { AnchorMode } from './mode.js'

export const DIGEST_SUBSCRIPTION_KIND = 32830
export const DIGEST_STATUS_KIND = 32831
export const DIGEST_IDENTIFIER = 'budabit/email-digest'
export const MAX_PAYLOAD_BYTES = 64 * 1024
export const MAX_EVENT_AGE_SECONDS = 24 * 60 * 60
export const MAX_EVENT_FUTURE_SECONDS = 5 * 60

export type DigestOptions = {
  issues: { new: boolean; comments: boolean }
  prs: { new: boolean; comments: boolean; updates: boolean }
  status: { open: boolean; draft: boolean; applied: boolean; closed: boolean }
  engagement: { reactions: boolean; zaps: boolean }
  assignments: boolean
}

export type DigestRepository = {
  address: string
  name: string
  /** WSS lookup hints used only to fetch the exact repository announcement. */
  relays: string[]
  options: DigestOptions
}

export type RepositoryDigestConfig = {
  version: 1
  channel: 'email-digest'
  email: string
  manageUrl: string
  locale?: string
  cadence: {
    intervalDays: number
    localTime: string
    timezone: string
  }
  handler: {
    address: string
    relay: string
  }
  repositories: DigestRepository[]
}

export type CommunityPreferences = {
  density: 'compact' | 'expanded'
  engagement: { replies: boolean; mentions: boolean; reactions: boolean; zaps: boolean }
  access: { membership: boolean; publishing: boolean; moderatorRequests: boolean }
  moderation: { reports: boolean; actions: boolean }
  highlights: { rooms: boolean; threads: boolean; calendar: boolean; goals: boolean }
}

export type CommunityDigestConfig = {
  version: 1
  channel: 'community-alerts'
  community: string
  email: string
  manageUrl: string
  locale?: string
  cadence: RepositoryDigestConfig['cadence']
  preferences: CommunityPreferences
}

export type DigestConfig = RepositoryDigestConfig | CommunityDigestConfig

export class ValidationError extends Error {}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const assertObject = (value: unknown, field: string): Record<string, unknown> => {
  if (!isObject(value)) throw new ValidationError(`${field} must be an object`)
  return value
}

const assertKeys = (value: Record<string, unknown>, allowed: string[], field: string) => {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) throw new ValidationError(`${field}.${unknown} is not supported`)
}

const assertBoolean = (value: unknown, field: string) => {
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be a boolean`)
  return value
}

const normalizeEmail = (value: unknown) => {
  if (typeof value !== 'string') throw new ValidationError('email must be a string')
  const email = value.trim().toLowerCase()
  const [local, domain, extra] = email.split('@')
  const domainLabels = domain?.split('.') || []
  if (
    email.length < 3 ||
    email.length > 254 ||
    extra !== undefined ||
    !local ||
    local.length > 64 ||
    local.startsWith('.') ||
    local.endsWith('.') ||
    local.includes('..') ||
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local) ||
    domainLabels.length < 2 ||
    domainLabels.some(
      (label) =>
        !label ||
        label.length > 63 ||
        !/^[a-z0-9-]+$/i.test(label) ||
        label.startsWith('-') ||
        label.endsWith('-')
    )
  ) {
    throw new ValidationError('email is invalid')
  }
  return email
}

export const normalizeRelayUrl = (value: unknown, field = 'relay') => {
  if (typeof value !== 'string' || value.length > 2048) {
    throw new ValidationError(`${field} must be a valid wss URL`)
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ValidationError(`${field} must be a valid wss URL`)
  }

  if (url.protocol !== 'wss:' || !url.hostname || url.username || url.password || url.hash) {
    throw new ValidationError(`${field} must be a valid wss URL`)
  }

  return url.toString()
}

export const normalizeHttpsUrl = (value: unknown, field = 'URL') => {
  if (typeof value !== 'string' || value.length > 2048 || value.includes('#')) {
    throw new ValidationError(`${field} must be a valid HTTPS URL`)
  }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ValidationError(`${field} must be a valid HTTPS URL`)
  }

  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.hash) {
    throw new ValidationError(`${field} must be a valid HTTPS URL`)
  }
  return url.toString()
}

const normalizeAddress = (value: unknown, kind: number, field: string) => {
  if (typeof value !== 'string' || value.length > 350) {
    throw new ValidationError(`${field} is invalid`)
  }
  const match = value.match(new RegExp(`^${kind}:([0-9a-f]{64}):(.+)$`))
  if (!match || match[2].length > 200 || /[\u0000-\u001f\u007f]/.test(match[2])) {
    throw new ValidationError(`${field} is invalid`)
  }
  return value
}

const parseOptions = (value: unknown, field: string): DigestOptions => {
  const options = assertObject(value, field)
  assertKeys(options, ['issues', 'prs', 'status', 'engagement', 'assignments'], field)

  const issues = assertObject(options.issues, `${field}.issues`)
  assertKeys(issues, ['new', 'comments'], `${field}.issues`)
  const prs = assertObject(options.prs, `${field}.prs`)
  assertKeys(prs, ['new', 'comments', 'updates'], `${field}.prs`)
  const status = assertObject(options.status, `${field}.status`)
  assertKeys(status, ['open', 'draft', 'applied', 'closed'], `${field}.status`)
  const engagement = assertObject(options.engagement, `${field}.engagement`)
  assertKeys(engagement, ['reactions', 'zaps'], `${field}.engagement`)

  return {
    issues: {
      new: assertBoolean(issues.new, `${field}.issues.new`),
      comments: assertBoolean(issues.comments, `${field}.issues.comments`),
    },
    prs: {
      new: assertBoolean(prs.new, `${field}.prs.new`),
      comments: assertBoolean(prs.comments, `${field}.prs.comments`),
      updates: assertBoolean(prs.updates, `${field}.prs.updates`),
    },
    status: {
      open: assertBoolean(status.open, `${field}.status.open`),
      draft: assertBoolean(status.draft, `${field}.status.draft`),
      applied: assertBoolean(status.applied, `${field}.status.applied`),
      closed: assertBoolean(status.closed, `${field}.status.closed`),
    },
    engagement: {
      reactions: assertBoolean(engagement.reactions, `${field}.engagement.reactions`),
      zaps: assertBoolean(engagement.zaps, `${field}.engagement.zaps`),
    },
    assignments: assertBoolean(options.assignments, `${field}.assignments`),
  }
}

const parseLocale = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length > 64) {
    throw new ValidationError('locale is invalid')
  }
  try {
    return new Intl.Locale(value).toString()
  } catch {
    throw new ValidationError('locale is invalid')
  }
}

const parseCadence = (value: unknown) => {
  const cadence = assertObject(value, 'cadence')
  assertKeys(cadence, ['intervalDays', 'localTime', 'timezone'], 'cadence')
  if (
    !Number.isInteger(cadence.intervalDays) ||
    (cadence.intervalDays as number) < 1 ||
    (cadence.intervalDays as number) > 30
  ) {
    throw new ValidationError('cadence.intervalDays must be an integer from 1 to 30')
  }
  if (
    typeof cadence.localTime !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(cadence.localTime)
  ) {
    throw new ValidationError('cadence.localTime must use HH:MM')
  }
  if (
    typeof cadence.timezone !== 'string' ||
    !IANAZone.isValidZone(cadence.timezone) ||
    !DateTime.local().setZone(cadence.timezone).isValid
  ) {
    throw new ValidationError('cadence.timezone must be a valid IANA timezone')
  }
  return {
    intervalDays: cadence.intervalDays as number,
    localTime: cadence.localTime,
    timezone: cadence.timezone,
  }
}

export const hasSelectedActivity = (options: DigestOptions) =>
  options.issues.new ||
  options.issues.comments ||
  options.prs.new ||
  options.prs.comments ||
  options.prs.updates ||
  options.status.open ||
  options.status.draft ||
  options.status.applied ||
  options.status.closed ||
  options.engagement.reactions ||
  options.engagement.zaps ||
  options.assignments

export function parseDigestConfig(plaintext: string): RepositoryDigestConfig {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new ValidationError('encrypted payload exceeds 64 KiB')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new ValidationError('encrypted payload is not valid JSON')
  }

  const value = assertObject(parsed, 'payload')
  assertKeys(
    value,
    ['version', 'channel', 'email', 'manageUrl', 'locale', 'cadence', 'handler', 'repositories'],
    'payload'
  )
  if (value.version !== 1) throw new ValidationError('version must be 1')
  if (value.channel !== 'email-digest') {
    throw new ValidationError('channel must be email-digest')
  }

  const locale = parseLocale(value.locale)
  const cadence = parseCadence(value.cadence)

  const handler = assertObject(value.handler, 'handler')
  assertKeys(handler, ['address', 'relay'], 'handler')

  if (
    !Array.isArray(value.repositories) ||
    value.repositories.length < 1 ||
    value.repositories.length > 50
  ) {
    throw new ValidationError('repositories must contain between 1 and 50 entries')
  }

  const addresses = new Set<string>()
  const uniqueRelays = new Set<string>()
  const repositories = value.repositories.map((item, index): DigestRepository => {
    const field = `repositories[${index}]`
    const repository = assertObject(item, field)
    assertKeys(repository, ['address', 'name', 'relays', 'options'], field)
    const address = normalizeAddress(repository.address, 30617, `${field}.address`)
    if (addresses.has(address))
      throw new ValidationError('repositories contain a duplicate address')
    addresses.add(address)

    if (
      typeof repository.name !== 'string' ||
      !repository.name.trim() ||
      repository.name.trim().length > 200 ||
      /[\u0000-\u001f\u007f]/.test(repository.name)
    ) {
      throw new ValidationError(`${field}.name is invalid`)
    }
    if (
      !Array.isArray(repository.relays) ||
      repository.relays.length < 1 ||
      repository.relays.length > 3
    ) {
      throw new ValidationError(`${field}.relays must contain between 1 and 3 lookup URLs`)
    }
    const relays = repository.relays.map((relay, relayIndex) =>
      normalizeRelayUrl(relay, `${field}.relays[${relayIndex}]`)
    )
    if (new Set(relays).size !== relays.length) {
      throw new ValidationError(`${field}.relays contains a duplicate lookup URL`)
    }
    relays.forEach((relay) => uniqueRelays.add(relay))

    return {
      address,
      name: repository.name.trim(),
      relays,
      options: parseOptions(repository.options, `${field}.options`),
    }
  })

  const handlerRelay = normalizeRelayUrl(handler.relay, 'handler.relay')
  if (uniqueRelays.size > 20) {
    throw new ValidationError('configuration uses more than 20 unique repository lookup relays')
  }
  if (!repositories.some((repository) => hasSelectedActivity(repository.options))) {
    throw new ValidationError('configuration selects no activity')
  }

  return {
    version: 1,
    channel: 'email-digest',
    email: normalizeEmail(value.email),
    manageUrl: normalizeHttpsUrl(value.manageUrl, 'manageUrl'),
    ...(locale ? { locale } : {}),
    cadence: {
      intervalDays: cadence.intervalDays,
      localTime: cadence.localTime,
      timezone: cadence.timezone,
    },
    handler: {
      address: normalizeAddress(handler.address, 31990, 'handler.address'),
      relay: handlerRelay,
    },
    repositories,
  }
}

const parseBooleanGroup = <T extends string>(
  value: unknown,
  field: string,
  keys: readonly T[]
): Record<T, boolean> => {
  const group = assertObject(value, field)
  assertKeys(group, [...keys], field)
  if (Object.keys(group).length !== keys.length) {
    throw new ValidationError(`${field} must contain exactly ${keys.join(', ')}`)
  }
  return Object.fromEntries(
    keys.map((key) => [key, assertBoolean(group[key], `${field}.${key}`)])
  ) as Record<T, boolean>
}

export function parseCommunityDigestConfig(
  plaintext: string,
  expectedCommunityPubkey: string
): CommunityDigestConfig {
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new ValidationError('encrypted payload exceeds 64 KiB')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new ValidationError('encrypted payload is not valid JSON')
  }
  const value = assertObject(parsed, 'payload')
  assertKeys(
    value,
    ['version', 'channel', 'community', 'email', 'manageUrl', 'locale', 'cadence', 'preferences'],
    'payload'
  )
  if (value.version !== 1) throw new ValidationError('version must be 1')
  if (value.channel !== 'community-alerts') {
    throw new ValidationError('channel must be community-alerts')
  }
  if (value.community !== expectedCommunityPubkey) {
    throw new ValidationError('community must match the configured community pubkey')
  }
  const preferences = assertObject(value.preferences, 'preferences')
  assertKeys(
    preferences,
    ['density', 'engagement', 'access', 'moderation', 'highlights'],
    'preferences'
  )
  if (Object.keys(preferences).length !== 5) {
    throw new ValidationError('preferences must contain every preference group')
  }
  if (!['compact', 'expanded'].includes(preferences.density as string)) {
    throw new ValidationError('preferences.density must be compact or expanded')
  }
  const locale = parseLocale(value.locale)

  return {
    version: 1,
    channel: 'community-alerts',
    community: expectedCommunityPubkey,
    email: normalizeEmail(value.email),
    manageUrl: normalizeHttpsUrl(value.manageUrl, 'manageUrl'),
    ...(locale ? { locale } : {}),
    cadence: parseCadence(value.cadence),
    preferences: {
      density: preferences.density as 'compact' | 'expanded',
      engagement: parseBooleanGroup(preferences.engagement, 'preferences.engagement', [
        'replies',
        'mentions',
        'reactions',
        'zaps',
      ]),
      access: parseBooleanGroup(preferences.access, 'preferences.access', [
        'membership',
        'publishing',
        'moderatorRequests',
      ]),
      moderation: parseBooleanGroup(preferences.moderation, 'preferences.moderation', [
        'reports',
        'actions',
      ]),
      highlights: parseBooleanGroup(preferences.highlights, 'preferences.highlights', [
        'rooms',
        'threads',
        'calendar',
        'goals',
      ]),
    },
  }
}

export function validateSubscriptionEvent(
  event: SignedEvent,
  anchorPubkey: string,
  currentTime = Math.floor(Date.now() / 1000),
  identifier = DIGEST_IDENTIFIER
) {
  if (event.kind !== DIGEST_SUBSCRIPTION_KIND) {
    throw new ValidationError(`event kind must be ${DIGEST_SUBSCRIPTION_KIND}`)
  }
  if (!Number.isInteger(event.created_at)) throw new ValidationError('event created_at is invalid')
  if (event.created_at < currentTime - MAX_EVENT_AGE_SECONDS) {
    throw new ValidationError('event is stale')
  }
  if (event.created_at > currentTime + MAX_EVENT_FUTURE_SECONDS) {
    throw new ValidationError('event is too far in the future')
  }
  const expected = [
    ['d', identifier],
    ['p', anchorPubkey],
  ]
  if (JSON.stringify(event.tags) !== JSON.stringify(expected)) {
    throw new ValidationError(`event tags must be exactly d=${identifier} and p=<Anchor pubkey>`)
  }
}

export const getSubscriptionAddress = (pubkey: string, identifier = DIGEST_IDENTIFIER) =>
  `${DIGEST_SUBSCRIPTION_KIND}:${pubkey}:${identifier}`

export function validateSubscriptionDeletionEvent(
  event: SignedEvent,
  anchorPubkey: string,
  identifier = DIGEST_IDENTIFIER
) {
  if (event.kind !== DELETE) throw new ValidationError(`event kind must be ${DELETE}`)

  const expected = [
    ['a', getSubscriptionAddress(event.pubkey, identifier)],
    ['p', anchorPubkey],
  ]
  if (JSON.stringify(event.tags) !== JSON.stringify(expected)) {
    throw new ValidationError(
      'deletion tags must exactly reference the email digest subscription and Anchor pubkey'
    )
  }
}

export const parseConfigForMode = (plaintext: string, mode: AnchorMode) =>
  mode.mode === 'community'
    ? parseCommunityDigestConfig(plaintext, mode.communityPubkey)
    : parseDigestConfig(plaintext)
