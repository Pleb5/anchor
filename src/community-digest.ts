import { SimplePool, verifyEvent, type Event as NostrEvent, type Filter } from 'nostr-tools'
import { validateZapRequest } from 'nostr-tools/nip57'
import { naddrEncode, neventEncode } from 'nostr-tools/nip19'
import type {
  CommunityContext,
  CommunityQuery,
  CommunityRelayResult,
  CommunitySnapshot,
} from './community.js'
import {
  COMMUNITY_DEFINITION_KIND,
  canManageSection,
  canModerateKind,
  isAuthorizedForKind,
  membershipFor,
  requireCommunityEose,
} from './community.js'
import type { CommunityMode } from './mode.js'
import { normalizeRelayUrl } from './subscription.js'
import type { CommunityDigestConfig } from './subscription.js'

export const COMMUNITY_EXCLUSIVE_KINDS = [11, 9, 1111, 7, 1984, 1985, 5]
export const COMMUNITY_WRAPPER_KIND = 30222
export const COMMUNITY_TARGET_KINDS = [31922, 31923, 9041]
export const ADMISSION_FORM_KIND = 30168
export const ADMISSION_RESPONSE_KIND = 1069
export const PROFILE_LIST_KIND = 30000
export const ZAP_RECEIPT_KIND = 9735
export const MAX_COMMUNITY_EVENTS = 1000
export const COMMUNITY_QUERY_LIMIT = 500

export type CommunitySection = 'needsAttention' | 'forYou' | 'appreciation' | 'highlights'

export type CommunityDigestRow = {
  key: string
  section: CommunitySection
  title: string
  summary: string
  author: string
  createdAt: number
  link: string
  eventCount: number
}

export type CommunityDigestData = {
  periodStart: number
  periodEnd: number
  eventCount: number
  overflow: number
  sourceTruncated: boolean
  needsAttention: CommunityDigestRow[]
  forYou: CommunityDigestRow[]
  appreciation: CommunityDigestRow[]
  highlights: CommunityDigestRow[]
}

export type CommunityReference = {
  ids: Set<string>
  addresses: Set<string>
  relays: Set<string>
}

type MutableRow = {
  key: string
  section: CommunitySection
  target: NostrEvent
  events: NostrEvent[]
  labels: Map<string, number>
  title: string
}

const ADDRESS = /^(\d+):([0-9a-f]{64}):([^\u0000-\u001f\u007f]{1,200})$/

const tagValues = (event: NostrEvent, name: string) =>
  event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1])

export const communityAddress = (communityPubkey: string) =>
  `${COMMUNITY_DEFINITION_KIND}:${communityPubkey}:`

export const isRoomEvent = (event: NostrEvent) =>
  event.kind === 11 && event.tags.some((tag) => tag.length === 1 && tag[0] === 'room')

export const communityKindSubtype = (event: NostrEvent, kind = event.kind) => {
  if (kind === 9) return 'room-message'
  if (kind === 11) return isRoomEvent(event) ? 'room' : 'threads'
  return undefined
}

export function getCommunityReferences(event: NostrEvent) {
  const rootId = tagValues(event, 'E')[0]
  const rootAddress = tagValues(event, 'A')[0]
  const parentId = event.kind === 9 ? tagValues(event, 'q')[0] : tagValues(event, 'e')[0]
  const parentAddress = tagValues(event, 'a')[0]
  return { rootId, rootAddress, parentId, parentAddress }
}

const replaceableAddress = (event: NostrEvent) => {
  if (event.kind < 30000 || event.kind >= 40000) return undefined
  const dTags = event.tags.filter((tag) => tag[0] === 'd')
  if (dTags.length !== 1 || dTags[0][1] === undefined) return undefined
  return `${event.kind}:${event.pubkey}:${dTags[0][1]}`
}

const newestEvents = (events: NostrEvent[]) => {
  const byKey = new Map<string, NostrEvent>()
  for (const event of events) {
    const key = replaceableAddress(event) || event.id
    const current = byKey.get(key)
    if (
      !current ||
      event.created_at > current.created_at ||
      (event.created_at === current.created_at && event.id < current.id)
    ) {
      byKey.set(key, event)
    }
  }
  return [...byKey.values()]
}

const firstLine = (event: NostrEvent, fallback: string) => {
  const value = event.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
  if (!value) return fallback
  return value.length > 140 ? `${value.slice(0, 137)}...` : value
}

const shortPubkey = (pubkey: string) => `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`

export const getCommunityFallbackHandlerTemplate = (manageUrl: string) =>
  `${new URL(manageUrl).origin}/<bech32>`

const validCommunityHandlerTemplate = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048 || !value.includes('<bech32>')) return false
  try {
    const url = new URL(value.replaceAll('<bech32>', 'note1example'))
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    )
  } catch {
    return false
  }
}

const exactAddressEvent = (event: NostrEvent, address: string) => {
  const match = address.match(ADDRESS)
  const candidate = {
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  }
  if (!match || !verifyEvent(candidate)) return false
  const dTags = event.tags.filter((tag) => tag[0] === 'd')
  return (
    event.kind === Number(match[1]) &&
    event.pubkey === match[2] &&
    dTags.length === 1 &&
    dTags[0][1] === match[3]
  )
}

export const selectCommunityHandlerTemplate = (
  events: NostrEvent[],
  handlerAddress: string,
  manageUrl: string
) =>
  newestEvents(events.filter((event) => exactAddressEvent(event, handlerAddress)))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .flatMap((event) => event.tags)
    .find((tag) => tag[0] === 'web' && validCommunityHandlerTemplate(tag[1]))?.[1] ||
  getCommunityFallbackHandlerTemplate(manageUrl)

const eventBech32 = (event: NostrEvent, relays: string[]) => {
  const address = replaceableAddress(event)
  if (address) {
    const [kind, pubkey, ...identifier] = address.split(':')
    return naddrEncode({ kind: Number(kind), pubkey, identifier: identifier.join(':'), relays })
  }
  return neventEncode({ id: event.id, author: event.pubkey, relays })
}

export const buildCommunityLink = (template: string, event: NostrEvent, relays: string[]) => {
  const link = template.replaceAll('<bech32>', eventBech32(event, relays))
  try {
    const url = new URL(link)
    return url.protocol === 'https:' ? url.toString() : '#'
  } catch {
    return '#'
  }
}

export const isValidZapReceipt = (event: NostrEvent, expectedRecipient?: string) => {
  if (event.kind !== ZAP_RECEIPT_KIND || !verifyEvent(event)) return false
  const description = event.tags.find((tag) => tag[0] === 'description')?.[1]
  if (!description || validateZapRequest(description) !== null) return false
  try {
    const request = JSON.parse(description) as NostrEvent
    if (expectedRecipient && !tagValues(request, 'p').includes(expectedRecipient)) return false
    const receiptTargets = new Set([...tagValues(event, 'e'), ...tagValues(event, 'a')])
    const requestTargets = [...tagValues(request, 'e'), ...tagValues(request, 'a')]
    return requestTargets.length === 0 || requestTargets.some((target) => receiptTargets.has(target))
  } catch {
    return false
  }
}

const wrapperKind = (event: NostrEvent) => {
  const values = tagValues(event, 'k')
  if (values.length !== 1 || !/^\d+$/.test(values[0])) return undefined
  const kind = Number(values[0])
  return COMMUNITY_TARGET_KINDS.includes(kind) ? kind : undefined
}

export function wrapperReference(event: NostrEvent, communityPubkey: string) {
  if (
    event.kind !== COMMUNITY_WRAPPER_KIND ||
    !verifyEvent(event) ||
    !tagValues(event, 'p').includes(communityPubkey)
  ) {
    return undefined
  }
  const kind = wrapperKind(event)
  if (kind === undefined) return undefined
  const ids = new Set(tagValues(event, 'e').filter((id) => /^[0-9a-f]{64}$/.test(id)))
  const addresses = new Set(
    tagValues(event, 'a').filter(
      (address) => address.match(ADDRESS) && Number(address.split(':')[0]) === kind
    )
  )
  if (ids.size + addresses.size !== 1) return undefined
  const relays = new Set<string>()
  for (const value of tagValues(event, 'r').slice(0, 3)) {
    try {
      relays.add(normalizeRelayUrl(value, 'wrapper relay hint'))
    } catch {
      // Invalid relay hints do not invalidate an otherwise attributable wrapper.
    }
  }
  return { kind, ids, addresses, relays }
}

const formSectionName = (event: NostrEvent) => {
  const tags = event.tags.filter((tag) => tag[0] === 'content')
  return tags.length === 1 && tags[0].length === 2 && tags[0][1]
    ? tags[0][1]
    : undefined
}

const formForResponse = (
  event: NostrEvent,
  byAddress: Map<string, NostrEvent>,
  snapshot: CommunitySnapshot
) => {
  if (event.kind !== ADMISSION_RESPONSE_KIND) return undefined
  const addresses = tagValues(event, 'a')
  if (addresses.length !== 1) return undefined
  const form = byAddress.get(addresses[0])
  return form && isAdmissionForm(form, snapshot) ? form : undefined
}

const followupTarget = (event: NostrEvent, byId: Map<string, NostrEvent>) => {
  if (![7, 5].includes(event.kind)) return undefined
  const targets = tagValues(event, 'e').map((id) => byId.get(id)).filter(Boolean)
  return targets.length === 1 ? targets[0] : undefined
}

const isAdmissionForm = (event: NostrEvent, snapshot: CommunitySnapshot) => {
  const sectionName = formSectionName(event)
  return Boolean(
    event.kind === ADMISSION_FORM_KIND &&
    verifyEvent(event) &&
    tagValues(event, 'a').includes(communityAddress(snapshot.event.pubkey)) &&
    Boolean(replaceableAddress(event)) &&
    sectionName &&
    canManageSection(snapshot, event.pubkey, sectionName)
  )
}

const isModeratorRequest = (event: NostrEvent, snapshot: CommunitySnapshot) =>
  event.kind === PROFILE_LIST_KIND &&
  verifyEvent(event) &&
  tagValues(event, 'a').includes(communityAddress(snapshot.event.pubkey)) &&
  Boolean(replaceableAddress(event)) &&
  membershipFor(snapshot, event.pubkey).eligible

const authorizedCandidates = (
  events: NostrEvent[],
  snapshot: CommunitySnapshot,
  contextEvents: NostrEvent[]
) => {
  const verifiedContext = newestEvents(
    [...events, ...contextEvents].filter((event) => verifyEvent(event))
  )
  const byId = new Map(verifiedContext.map((event) => [event.id, event]))
  const byAddress = new Map<string, NostrEvent>()
  verifiedContext.forEach((event) => {
    const address = replaceableAddress(event)
    if (address) byAddress.set(address, event)
  })
  const currentLists = new Set(snapshot.profileListEvents.map((event) => event.id))

  return newestEvents(events.filter((event) => verifyEvent(event))).filter((event) => {
    if (snapshot.banned.has(event.pubkey)) return false
    if (event.kind === ZAP_RECEIPT_KIND) return true
    if (currentLists.has(event.id)) return true
    if ([7, 5].includes(event.kind)) {
      const target = followupTarget(event, byId)
      if (target && isModeratorRequest(target, snapshot)) {
        return snapshot.admins.has(event.pubkey)
      }
      if (target?.kind === ADMISSION_RESPONSE_KIND) {
        const form = formForResponse(target, byAddress, snapshot)
        if (!form) return false
        const sectionName = formSectionName(form)
        if (event.kind === 5 && event.pubkey === target.pubkey) return true
        return (
          snapshot.admins.has(event.pubkey) ||
          event.pubkey === form.pubkey ||
          Boolean(sectionName && canManageSection(snapshot, event.pubkey, sectionName))
        )
      }
    }
    if (COMMUNITY_EXCLUSIVE_KINDS.includes(event.kind)) {
      if (!tagValues(event, 'h').includes(snapshot.event.pubkey)) return false
      return isAuthorizedForKind(
        snapshot,
        event.pubkey,
        event.kind,
        communityKindSubtype(event)
      )
    }
    if (event.kind === COMMUNITY_WRAPPER_KIND) {
      const reference = wrapperReference(event, snapshot.event.pubkey)
      return Boolean(
        reference &&
        isAuthorizedForKind(
          snapshot,
          event.pubkey,
          reference.kind,
          communityKindSubtype(event, reference.kind)
        )
      )
    }
    if (isAdmissionForm(event, snapshot) || isModeratorRequest(event, snapshot)) return true
    if (event.kind === ADMISSION_RESPONSE_KIND) {
      return Boolean(formForResponse(event, byAddress, snapshot))
    }
    return false
  })
}

export function authorizeCommunityEvents(
  events: NostrEvent[],
  snapshot: CommunitySnapshot,
  contextEvents: NostrEvent[] = []
) {
  return authorizedCandidates(events, snapshot, contextEvents).filter((event) => event.kind !== 5)
}

const rowSummary = (row: MutableRow, expanded: boolean) => {
  const labels = [...row.labels]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, count]) => `${count} ${label}${count === 1 ? '' : 's'}`)
  if (expanded && row.events.length) {
    const recent = [...row.events].sort((a, b) => b.created_at - a.created_at)[0]
    const detail = firstLine(recent, '')
    if (
      detail &&
      ![1984, PROFILE_LIST_KIND, ADMISSION_FORM_KIND, ADMISSION_RESPONSE_KIND].includes(recent.kind)
    ) {
      labels.push(detail)
    }
  }
  return labels.join(' | ')
}

export function normalizeCommunityDigest(
  config: CommunityDigestConfig,
  userPubkey: string,
  rawEvents: NostrEvent[],
  contextEvents: NostrEvent[],
  snapshot: CommunitySnapshot,
  profiles: Map<string, string>,
  handlerTemplate: string,
  periodStart: number,
  periodEnd: number,
  sourceTruncated = false
): CommunityDigestData {
  const verifiedContext = newestEvents(
    [...contextEvents, ...rawEvents].filter((event) => verifyEvent(event))
  )
  const byId = new Map(verifiedContext.map((event) => [event.id, event]))
  const byAddress = new Map<string, NostrEvent>()
  verifiedContext.forEach((event) => {
    const address = replaceableAddress(event)
    if (address) byAddress.set(address, event)
  })

  const candidates = authorizedCandidates(rawEvents, snapshot, contextEvents)
  const censoredIds = new Set<string>()
  for (const deletion of candidates.filter((event) => event.kind === 5)) {
    const target = followupTarget(deletion, byId)
    if (target && [ADMISSION_RESPONSE_KIND, PROFILE_LIST_KIND].includes(target.kind)) {
      censoredIds.add(target.id)
    }
    for (const id of tagValues(deletion, 'e')) {
      const directTarget = byId.get(id)
      if (
        directTarget &&
        (directTarget.pubkey === deletion.pubkey ||
          snapshot.admins.has(deletion.pubkey) ||
          canModerateKind(
            snapshot,
            deletion.pubkey,
            directTarget.kind,
            communityKindSubtype(directTarget)
          ))
      ) {
        censoredIds.add(id)
      }
    }
  }

  const events = candidates.filter((event) => {
    if (
      event.kind === 5 ||
      event.pubkey === userPubkey ||
      event.created_at < periodStart ||
      event.created_at >= periodEnd ||
      censoredIds.has(event.id)
    ) {
      return false
    }
    const references = getCommunityReferences(event)
    return ![references.rootId, references.parentId].some(
      (reference) => reference && censoredIds.has(reference)
    )
  })
  const grouped = new Map<string, MutableRow>()

  const add = (
    event: NostrEvent,
    section: CommunitySection,
    key: string,
    title: string,
    label: string,
    target: NostrEvent
  ) => {
    const mapKey = `${section}:${key}`
    const existing = grouped.get(mapKey) || {
      key: mapKey,
      section,
      target,
      events: [],
      labels: new Map<string, number>(),
      title,
    }
    existing.events.push(event)
    existing.labels.set(label, (existing.labels.get(label) || 0) + 1)
    grouped.set(mapKey, existing)
  }

  for (const event of events) {
    const references = getCommunityReferences(event)
    const target =
      (references.rootId && byId.get(references.rootId)) ||
      (references.rootAddress && byAddress.get(references.rootAddress)) ||
      (references.parentId && byId.get(references.parentId)) ||
      (references.parentAddress && byAddress.get(references.parentAddress)) ||
      event
    const userTargeted = tagValues(event, 'p').includes(userPubkey) || target.pubkey === userPubkey

    if (event.kind === 1984 && canModerateKind(snapshot, userPubkey, 1984)) {
      if (config.preferences.moderation.reports) {
        add(event, 'needsAttention', target.id, 'Community report', 'new report', target)
      }
      continue
    }
    if (event.kind === 1985 && canModerateKind(snapshot, userPubkey, 1985)) {
      if (config.preferences.moderation.actions) {
        add(event, 'needsAttention', target.id, 'Moderation activity', 'action', target)
      }
      continue
    }
    if (isModeratorRequest(event, snapshot)) {
      if (snapshot.admins.has(userPubkey) && config.preferences.access.moderatorRequests) {
        add(event, 'needsAttention', event.id, 'Moderator request', 'request', event)
      }
      continue
    }
    const stagedTarget = followupTarget(event, byId)
    if (stagedTarget && isModeratorRequest(stagedTarget, snapshot)) {
      if (
        stagedTarget.pubkey === userPubkey &&
        config.preferences.access.moderatorRequests
      ) {
        add(event, 'needsAttention', stagedTarget.id, 'Moderator request updated', 'review', stagedTarget)
      }
      continue
    }
    if (event.kind === ADMISSION_RESPONSE_KIND) {
      const form = formForResponse(event, byAddress, snapshot)
      const sectionName = form && formSectionName(form)
      if (
        form &&
        sectionName &&
        config.preferences.access.publishing &&
        (snapshot.admins.has(userPubkey) ||
          userPubkey === form.pubkey ||
          canManageSection(snapshot, userPubkey, sectionName))
      ) {
        add(event, 'needsAttention', event.id, 'Publishing request', 'request', event)
      }
      continue
    }
    if (stagedTarget?.kind === ADMISSION_RESPONSE_KIND) {
      if (stagedTarget.pubkey === userPubkey && config.preferences.access.publishing) {
        add(event, 'needsAttention', stagedTarget.id, 'Publishing review updated', 'review', stagedTarget)
      }
      continue
    }
    if (snapshot.profileListEvents.some((list) => list.id === event.id)) {
      if (tagValues(event, 'p').includes(userPubkey) && config.preferences.access.membership) {
        add(event, 'needsAttention', event.id, 'Membership updated', 'change', event)
      }
      continue
    }
    if (event.kind === 1111) {
      if (target.pubkey === userPubkey && config.preferences.engagement.replies) {
        add(event, 'forYou', target.id, firstLine(target, 'Your conversation'), 'reply', target)
      } else if (tagValues(event, 'p').includes(userPubkey) && config.preferences.engagement.mentions) {
        add(event, 'forYou', target.id, firstLine(target, 'Community conversation'), 'mention', target)
      }
      continue
    }
    if (event.kind === 7 && userTargeted && config.preferences.engagement.reactions) {
      add(event, 'appreciation', target.id, firstLine(target, 'Your community post'), 'reaction', target)
      continue
    }
    if (
      event.kind === ZAP_RECEIPT_KIND &&
      config.preferences.engagement.zaps &&
      isValidZapReceipt(event, userPubkey)
    ) {
      add(event, 'appreciation', target.id, firstLine(target, 'Your community post'), 'zap', target)
      continue
    }
    if (
      tagValues(event, 'p').includes(userPubkey) &&
      config.preferences.engagement.mentions &&
      [9, 11].includes(event.kind)
    ) {
      add(event, 'forYou', target.id, firstLine(target, 'Community mention'), 'mention', target)
      continue
    }
    if (event.kind === 9 && isRoomEvent(target) && config.preferences.highlights.rooms) {
      add(event, 'highlights', target.id, firstLine(target, 'Room activity'), 'message', target)
      continue
    }
    if (event.kind === 11) {
      if (isRoomEvent(event) && config.preferences.highlights.rooms) {
        add(event, 'highlights', event.id, firstLine(event, 'New room'), 'new room', event)
      } else if (config.preferences.highlights.threads) {
        add(event, 'highlights', event.id, firstLine(event, 'New thread'), 'new thread', event)
      }
      continue
    }
    if (event.kind === COMMUNITY_WRAPPER_KIND) {
      const reference = wrapperReference(event, snapshot.event.pubkey)
      if (!reference) continue
      const original =
        [...reference.ids].map((id) => byId.get(id)).find(Boolean) ||
        [...reference.addresses].map((address) => byAddress.get(address)).find(Boolean)
      if (
        !original ||
        original.kind !== reference.kind ||
        !isAuthorizedForKind(
          snapshot,
          original.pubkey,
          original.kind,
          communityKindSubtype(original)
        )
      ) {
        continue
      }
      const enabled =
        ([31922, 31923].includes(original.kind) && config.preferences.highlights.calendar) ||
        (original.kind === 9041 && config.preferences.highlights.goals)
      if (enabled) {
        const label = [31922, 31923].includes(original.kind) ? 'calendar update' : 'goal update'
        add(event, 'highlights', original.id, firstLine(original, label), label, original)
      }
    }
  }

  const rows = [...grouped.values()].map((row): CommunityDigestRow => {
    const recent = [...row.events].sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
    )[0]
    return {
      key: row.key,
      section: row.section,
      title: row.title,
      summary: rowSummary(row, config.preferences.density === 'expanded'),
      author: profiles.get(recent.pubkey) || shortPubkey(recent.pubkey),
      createdAt: recent.created_at,
      link: buildCommunityLink(handlerTemplate, row.target, snapshot.relays),
      eventCount: row.events.length,
    }
  })
  const ordered = (section: CommunitySection) =>
    rows
      .filter((row) => row.section === section)
      .sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))
  let remaining = 40
  const take = (section: CommunitySection) => {
    const selected = ordered(section).slice(0, remaining)
    remaining -= selected.length
    return selected
  }
  const needsAttention = take('needsAttention')
  const forYou = take('forYou')
  const appreciation = take('appreciation')
  const highlights = take('highlights')
  const rendered = needsAttention.length + forYou.length + appreciation.length + highlights.length

  return {
    periodStart,
    periodEnd,
    eventCount: rows.reduce((sum, row) => sum + row.eventCount, 0),
    overflow: Math.max(0, rows.length - rendered),
    sourceTruncated,
    needsAttention,
    forYou,
    appreciation,
    highlights,
  }
}

export function buildCommunityDiscoveryFilters(
  communityPubkey: string,
  userPubkey: string,
  periodStart: number,
  periodEnd: number
): Filter[] {
  const period = { since: periodStart, until: periodEnd - 1, limit: COMMUNITY_QUERY_LIMIT }
  return [
    { kinds: COMMUNITY_EXCLUSIVE_KINDS, '#h': [communityPubkey], ...period },
    { kinds: [ZAP_RECEIPT_KIND], '#p': [userPubkey], ...period },
    {
      kinds: [COMMUNITY_WRAPPER_KIND],
      '#p': [communityPubkey],
      '#k': COMMUNITY_TARGET_KINDS.map(String),
      ...period,
    },
    {
      kinds: [ADMISSION_FORM_KIND],
      '#a': [communityAddress(communityPubkey)],
      until: periodEnd - 1,
      limit: COMMUNITY_QUERY_LIMIT,
    },
    {
      kinds: [PROFILE_LIST_KIND],
      '#a': [communityAddress(communityPubkey)],
      until: periodEnd - 1,
      limit: COMMUNITY_QUERY_LIMIT,
    },
  ]
}

const queryRelay = (
  pool: SimplePool,
  relayUrl: string,
  filters: Filter[],
  maxWait = 6000
) =>
  new Promise<CommunityRelayResult>((resolve) => {
    const events = new Map<string, NostrEvent>()
    let finished = false
    let subscription: { close(reason?: string): void } | undefined
    const finish = (eose: boolean, reason?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (!eose) subscription?.close('anchor community digest query timeout')
      resolve({ relay: relayUrl, events: [...events.values()], eose, reason })
    }
    const timeout = setTimeout(() => finish(false, 'timeout'), maxWait)
    void pool
      .ensureRelay(relayUrl, { connectionTimeout: Math.max(1000, maxWait - 1000) })
      .then((relay) => {
        if (finished) return
        subscription = relay.subscribe(filters, {
          onevent: (event) => events.set(event.id, event),
          oneose: () => {
            finish(true)
            subscription?.close('anchor community digest query completed')
          },
          onclose: (reason) => finish(false, reason),
          eoseTimeout: maxWait * 2,
        })
      })
      .catch((error) => finish(false, error instanceof Error ? error.message : 'connection failed'))
  })

const addressFilters = (addresses: Set<string>): Filter[] => {
  const groups = new Map<string, Set<string>>()
  for (const address of addresses) {
    const match = address.match(ADDRESS)
    if (!match) continue
    const key = `${match[1]}:${match[2]}`
    const identifiers = groups.get(key) || new Set<string>()
    identifiers.add(match[3])
    groups.set(key, identifiers)
  }
  return [...groups].map(([key, identifiers]) => {
    const [kind, author] = key.split(':')
    return {
      kinds: [Number(kind)],
      authors: [author],
      '#d': [...identifiers],
      limit: Math.min(COMMUNITY_QUERY_LIMIT, identifiers.size * 2),
    }
  })
}

const exactReferencedEvents = (
  events: NostrEvent[],
  ids: Set<string>,
  addresses: Set<string>
) => events.filter(
  (event) =>
    verifyEvent(event) &&
    (ids.has(event.id) || (replaceableAddress(event) && addresses.has(replaceableAddress(event)!)))
)

const referenceFilters = (references: CommunityReference): Filter[] => [
  ...(references.ids.size
    ? [{ ids: [...references.ids], limit: Math.min(COMMUNITY_QUERY_LIMIT, references.ids.size) }]
    : []),
  ...addressFilters(references.addresses),
]

const collectReferences = (events: NostrEvent[]) => {
  const references: CommunityReference = {
    ids: new Set<string>(),
    addresses: new Set<string>(),
    relays: new Set<string>(),
  }
  for (const event of events) {
    const tags = getCommunityReferences(event)
    if (tags.rootId) references.ids.add(tags.rootId)
    if (tags.parentId) references.ids.add(tags.parentId)
    if (tags.rootAddress?.match(ADDRESS)) references.addresses.add(tags.rootAddress)
    if (tags.parentAddress?.match(ADDRESS)) references.addresses.add(tags.parentAddress)
  }
  return references
}

export class CommunityDigestCollector {
  private readonly pool = new SimplePool({ enablePing: true })
  private readonly query: CommunityQuery

  constructor(
    private readonly context: CommunityContext,
    private readonly mode: CommunityMode,
    query?: CommunityQuery
  ) {
    this.query = query || ((relay, filters, maxWait) => queryRelay(this.pool, relay, filters, maxWait))
  }

  private async queryAuthoritative(
    relays: string[],
    filters: Filter[],
    phase: string
  ) {
    const results = await Promise.all(relays.map((relay) => this.query(relay, filters)))
    requireCommunityEose(results, phase)
    return results
  }

  async collect(
    config: CommunityDigestConfig,
    userPubkey: string,
    periodStart: number,
    periodEnd: number
  ) {
    const snapshot = await this.context.refresh()
    const discovery = await this.queryAuthoritative(
      snapshot.relays,
      buildCommunityDiscoveryFilters(config.community, userPubkey, periodStart, periodEnd),
      'core discovery'
    )
    let sourceTruncated = discovery.some((result) => result.events.length >= COMMUNITY_QUERY_LIMIT)
    const discovered = newestEvents(
      discovery.flatMap((result) => result.events).filter((event) => verifyEvent(event))
    )
    const forms = discovered.filter((event) => isAdmissionForm(event, snapshot))
    const requests = discovered.filter((event) => isModeratorRequest(event, snapshot))
    const wrappers = discovered.filter((event) => wrapperReference(event, config.community))

    const wrapperReferences: CommunityReference = {
      ids: new Set<string>(),
      addresses: new Set<string>(),
      relays: new Set<string>(),
    }
    wrappers.forEach((wrapper) => {
      const reference = wrapperReference(wrapper, config.community)!
      reference.ids.forEach((id) => wrapperReferences.ids.add(id))
      reference.addresses.forEach((address) => wrapperReferences.addresses.add(address))
      reference.relays.forEach((relay) => wrapperReferences.relays.add(relay))
    })
    let originals: NostrEvent[] = []
    const wrapperFilters = referenceFilters(wrapperReferences)
    if (wrapperFilters.length) {
      const authoritative = await this.queryAuthoritative(
        snapshot.relays,
        wrapperFilters,
        'wrapper target resolution'
      )
      const hintedRelays = [...wrapperReferences.relays].filter(
        (relay) => !snapshot.relays.includes(relay)
      )
      const hinted = await Promise.all(
        hintedRelays.map((relay) => this.query(relay, wrapperFilters))
      )
      originals = exactReferencedEvents(
        [...authoritative, ...hinted].flatMap((result) => result.events),
        wrapperReferences.ids,
        wrapperReferences.addresses
      )
    }

    const formAddresses = new Set(forms.flatMap((event) => replaceableAddress(event) || []))
    let responses: NostrEvent[] = []
    if (formAddresses.size) {
      const responseResults = await this.queryAuthoritative(
        snapshot.relays,
        [{
          kinds: [ADMISSION_RESPONSE_KIND],
          '#a': [...formAddresses],
          until: periodEnd - 1,
          limit: COMMUNITY_QUERY_LIMIT,
        }],
        'admission responses'
      )
      if (responseResults.some((result) => result.events.length >= COMMUNITY_QUERY_LIMIT)) {
        sourceTruncated = true
      }
      responses = responseResults.flatMap((result) => result.events)
    }

    const followupIds = new Set([...responses, ...requests].map((event) => event.id))
    let followups: NostrEvent[] = []
    if (followupIds.size) {
      if (followupIds.size > COMMUNITY_QUERY_LIMIT) sourceTruncated = true
      const ids = [...followupIds].slice(0, COMMUNITY_QUERY_LIMIT)
      const followupResults = await this.queryAuthoritative(
        snapshot.relays,
        [{
          kinds: [7, 5],
          '#e': ids,
          since: periodStart,
          until: periodEnd - 1,
          limit: COMMUNITY_QUERY_LIMIT,
        }],
        'request follow-ups'
      )
      if (followupResults.some((result) => result.events.length >= COMMUNITY_QUERY_LIMIT)) {
        sourceTruncated = true
      }
      followups = followupResults.flatMap((result) => result.events)
    }

    const activity = [
      ...discovered,
      ...responses,
      ...followups,
      ...snapshot.profileListEvents,
    ]
    const rootsToResolve = collectReferences(activity)
    originals.forEach((event) => {
      rootsToResolve.ids.delete(event.id)
      const address = replaceableAddress(event)
      if (address) rootsToResolve.addresses.delete(address)
    })
    let roots: NostrEvent[] = []
    const rootFilters = referenceFilters(rootsToResolve)
    if (rootFilters.length) {
      if (rootsToResolve.ids.size + rootsToResolve.addresses.size > COMMUNITY_QUERY_LIMIT) {
        sourceTruncated = true
      }
      const rootResults = await this.queryAuthoritative(
        snapshot.relays,
        rootFilters,
        'root and parent resolution'
      )
      roots = exactReferencedEvents(
        rootResults.flatMap((result) => result.events),
        rootsToResolve.ids,
        rootsToResolve.addresses
      )
    }

    const rawEvents = newestEvents(activity)
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    if (rawEvents.length > MAX_COMMUNITY_EVENTS) sourceTruncated = true
    const boundedEvents = rawEvents.slice(0, MAX_COMMUNITY_EVENTS)
    const contextEvents = newestEvents([...forms, ...responses, ...requests, ...originals, ...roots])

    const authors = [
      ...new Set([...boundedEvents, ...contextEvents].map((event) => event.pubkey)),
    ].slice(0, COMMUNITY_QUERY_LIMIT)
    const profileResults = authors.length
      ? await Promise.all(
          snapshot.relays.map((relay) =>
            this.query(relay, [{ kinds: [0], authors, limit: authors.length }])
          )
        )
      : []
    const profiles = new Map<string, { name: string; createdAt: number; id: string }>()
    for (const event of profileResults.flatMap((result) => result.events)) {
      if (!verifyEvent(event)) continue
      try {
        const metadata = JSON.parse(event.content)
        const name = metadata.display_name || metadata.name
        const current = profiles.get(event.pubkey)
        if (
          typeof name === 'string' &&
          name.trim() &&
          (!current ||
            event.created_at > current.createdAt ||
            (event.created_at === current.createdAt && event.id < current.id))
        ) {
          profiles.set(event.pubkey, {
            name: name.trim().slice(0, 100),
            createdAt: event.created_at,
            id: event.id,
          })
        }
      } catch {
        // Invalid profile JSON is non-authoritative display metadata.
      }
    }

    const [handlerKind, handlerPubkey, ...handlerIdentifier] = this.mode.handlerAddress.split(':')
    const handlerResult = await this.query(this.mode.handlerRelay, [
      {
        kinds: [Number(handlerKind)],
        authors: [handlerPubkey],
        '#d': [handlerIdentifier.join(':')],
        limit: 5,
      },
    ])
    const handlerTemplate = selectCommunityHandlerTemplate(
      handlerResult.events,
      this.mode.handlerAddress,
      config.manageUrl
    )

    return normalizeCommunityDigest(
      config,
      userPubkey,
      boundedEvents,
      contextEvents,
      snapshot,
      new Map([...profiles].map(([pubkey, profile]) => [pubkey, profile.name])),
      handlerTemplate,
      periodStart,
      periodEnd,
      sourceTruncated
    )
  }

  close() {
    this.pool.destroy()
    this.context.close()
  }
}
