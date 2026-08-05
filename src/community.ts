import { SimplePool, verifyEvent, type Event as NostrEvent, type Filter } from 'nostr-tools'
import type { EligibilityGate, EligibilityResult } from './actions.js'
import type { CommunityMode, CommunityServiceDescriptor } from './mode.js'
import { normalizeRelayUrl, ValidationError } from './subscription.js'

export const COMMUNITY_DEFINITION_KIND = 10222
export const PROFILE_LIST_KIND = 30000
export const REPORT_KIND = 1984
export const DELETE_KIND = 5

export type CommunityRole = 'admin' | 'moderator' | 'member'

export type CommunityKindReference = {
  kind: number
  subtype?: string
}

export type ProfileListReference = {
  address: string
  owner: string
  identifier: string
  relay?: string
  section: number
}

export type CommunityContentSection = {
  name: string
  kinds: CommunityKindReference[]
  profileLists: ProfileListReference[]
}

export type CommunityDefinition = {
  event: NostrEvent
  relays: string[]
  sections: CommunityContentSection[]
  profileLists: ProfileListReference[]
}

export type CommunitySnapshot = CommunityDefinition & {
  admins: Set<string>
  moderators: Set<string>
  members: Set<string>
  banned: Set<string>
  profileListEvents: NostrEvent[]
  moderationEvents: NostrEvent[]
  profileListsByAddress: Map<string, NostrEvent>
}

export type CommunityRelayResult = {
  relay: string
  events: NostrEvent[]
  eose: boolean
  reason?: string
}

export type CommunityQuery = (
  relay: string,
  filters: Filter[],
  maxWait?: number
) => Promise<CommunityRelayResult>

export type ProfileListQueryPlan = {
  relay: string
  references: ProfileListReference[]
  filters: Filter[]
}

const PUBKEY = /^[0-9a-f]{64}$/
const PROFILE_LIST_ADDRESS = /^30000:([0-9a-f]{64}):([^\u0000-\u001f\u007f]{1,200})$/

const newest = (events: NostrEvent[]) =>
  [...events].sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]

const exactServiceTag = (descriptor: CommunityServiceDescriptor) => [
  'service',
  'community-alerts',
  descriptor.servicePubkey,
  descriptor.requestRelay,
  descriptor.handlerAddress,
  descriptor.handlerRelay,
]

const validSectionName = (value: string | undefined) =>
  Boolean(value?.trim() && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value))

export function parseCommunityDefinition(
  event: NostrEvent,
  communityPubkey: string,
  descriptor: CommunityServiceDescriptor,
  verify = verifyEvent
): CommunityDefinition {
  if (!verify(event) || event.kind !== COMMUNITY_DEFINITION_KIND || event.pubkey !== communityPubkey) {
    throw new ValidationError('community definition is not a valid signed kind 10222 event')
  }
  const serviceTags = event.tags.filter(
    (tag) => tag[0] === 'service' && tag[1] === 'community-alerts'
  )
  if (
    !serviceTags.some(
      (serviceTag) => JSON.stringify(serviceTag) === JSON.stringify(exactServiceTag(descriptor))
    )
  ) {
    throw new ValidationError('latest community definition does not advertise this service descriptor')
  }

  const relays = event.tags
    .filter((tag) => tag[0] === 'r' && tag[1])
    .map((tag, index) => normalizeRelayUrl(tag[1], `community.r[${index}]`))
  const uniqueRelays = [...new Set(relays)]
  if (!uniqueRelays.length || uniqueRelays.length > 20) {
    throw new ValidationError('community definition must advertise 1 to 20 activity relays')
  }

  const sections: CommunityContentSection[] = []
  for (const tag of event.tags) {
    if (tag[0] === 'content') {
      if (tag.length !== 2 || !validSectionName(tag[1])) {
        throw new ValidationError('community content section name is invalid')
      }
      sections.push({ name: tag[1].trim(), kinds: [], profileLists: [] })
      continue
    }
    const section = sections.at(-1)
    if (!section) continue
    if (tag[0] === 'k') {
      if (tag.length < 2 || tag.length > 3 || !/^\d+$/.test(tag[1] || '')) {
        throw new ValidationError(`community section ${section.name} has an invalid k tag`)
      }
      const kind = Number(tag[1])
      if (!Number.isSafeInteger(kind) || kind < 0 || kind > 65535) {
        throw new ValidationError(`community section ${section.name} has an invalid event kind`)
      }
      if (
        tag[2] !== undefined &&
        (!tag[2] || tag[2].length > 200 || /[\u0000-\u001f\u007f]/.test(tag[2]))
      ) {
        throw new ValidationError(`community section ${section.name} has an invalid event subtype`)
      }
      section.kinds.push({ kind, ...(tag[2] !== undefined ? { subtype: tag[2] } : {}) })
      continue
    }
    if (tag[0] === 'a') {
      if (tag.length < 2 || tag.length > 3) {
        throw new ValidationError(`community section ${section.name} has an invalid profile-list tag`)
      }
      const match = tag[1]?.match(PROFILE_LIST_ADDRESS)
      if (!match) {
        throw new ValidationError(`community section ${section.name} has an invalid profile-list address`)
      }
      const relay = tag[2]
        ? normalizeRelayUrl(tag[2], `community section ${section.name} profile-list relay`)
        : undefined
      section.profileLists.push({
        address: tag[1],
        owner: match[1],
        identifier: match[2],
        ...(relay ? { relay } : {}),
        section: sections.length - 1,
      })
    }
  }

  const profileLists = sections.flatMap((section) => section.profileLists)
  return { event, relays: uniqueRelays, sections, profileLists }
}

const exactProfileListAddress = (event: NostrEvent) => {
  if (event.kind !== PROFILE_LIST_KIND || !PUBKEY.test(event.pubkey)) return undefined
  const dTags = event.tags.filter((tag) => tag[0] === 'd')
  if (dTags.length !== 1 || !dTags[0][1]) return undefined
  return `${PROFILE_LIST_KIND}:${event.pubkey}:${dTags[0][1]}`
}

const personBanTarget = (event: NostrEvent, communityPubkey: string) => {
  if (
    event.kind !== REPORT_KIND ||
    !event.tags.some((tag) => tag[0] === 'h' && tag[1] === communityPubkey)
  ) {
    return undefined
  }
  const targets = event.tags.filter((tag) => tag[0] === 'p' && PUBKEY.test(tag[1] || ''))
  const reportsAnEvent = event.tags.some((tag) => ['e', 'a'].includes(tag[0]) && tag[1])
  return targets.length === 1 && !reportsAnEvent ? targets[0][1] : undefined
}

const effectivePersonBans = (
  definition: CommunityDefinition,
  moderationEvents: NostrEvent[]
) => {
  const valid = moderationEvents.filter(
    (event) =>
      verifyEvent(event) &&
      [REPORT_KIND, DELETE_KIND].includes(event.kind) &&
      event.pubkey === definition.event.pubkey &&
      event.tags.some((tag) => tag[0] === 'h' && tag[1] === definition.event.pubkey)
  )
  const reports = valid.filter(
    (event) => event.kind === REPORT_KIND && personBanTarget(event, definition.event.pubkey)
  )
  const deleted = new Set<string>()
  for (const deletion of valid.filter((event) => event.kind === DELETE_KIND)) {
    for (const id of deletion.tags.filter((tag) => tag[0] === 'e').map((tag) => tag[1])) {
      const report = reports.find((candidate) => candidate.id === id)
      if (report && deletion.created_at >= report.created_at) deleted.add(id)
    }
  }
  const banned = new Set(
    reports
      .filter((event) => !deleted.has(event.id))
      .map((event) => personBanTarget(event, definition.event.pubkey)!)
  )
  banned.delete(definition.event.pubkey)
  return banned
}

export function buildCommunitySnapshot(
  definition: CommunityDefinition,
  profileListEvents: NostrEvent[],
  moderationEvents: NostrEvent[] = []
): CommunitySnapshot {
  const referenced = new Set(definition.profileLists.map((reference) => reference.address))
  const byAddress = new Map<string, NostrEvent>()
  for (const event of profileListEvents) {
    if (!verifyEvent(event)) continue
    const address = exactProfileListAddress(event)
    if (!address || !referenced.has(address)) continue
    const current = byAddress.get(address)
    if (!current || newest([current, event]) === event) byAddress.set(address, event)
  }

  const admins = new Set<string>([definition.event.pubkey])
  const moderators = new Set<string>()
  const members = new Set<string>()
  for (const reference of definition.profileLists) {
    const event = byAddress.get(reference.address)
    if (!event || event.pubkey !== reference.owner) continue
    moderators.add(reference.owner)
    for (const tag of event.tags) {
      if (tag[0] === 'p' && PUBKEY.test(tag[1] || '')) members.add(tag[1])
    }
  }
  const banned = effectivePersonBans(definition, moderationEvents)
  for (const pubkey of banned) {
    moderators.delete(pubkey)
    members.delete(pubkey)
  }
  return {
    ...definition,
    admins,
    moderators,
    members,
    banned,
    profileListEvents: [...byAddress.values()],
    moderationEvents: moderationEvents.filter((event) => verifyEvent(event)),
    profileListsByAddress: byAddress,
  }
}

export function membershipFor(snapshot: CommunitySnapshot, pubkey: string): EligibilityResult {
  if (snapshot.admins.has(pubkey)) return { eligible: true, role: 'admin' }
  if (snapshot.banned.has(pubkey)) {
    return { eligible: false, reason: 'This pubkey is banned from the configured community' }
  }
  if (snapshot.moderators.has(pubkey)) return { eligible: true, role: 'moderator' }
  if (snapshot.members.has(pubkey)) return { eligible: true, role: 'member' }
  return { eligible: false, reason: 'Current community membership is required' }
}

const kindMatches = (reference: CommunityKindReference, kind: number, subtype?: string) =>
  reference.kind === kind &&
  (reference.subtype ?? '') === (subtype ?? '')

export const sectionsForKind = (
  snapshot: CommunityDefinition,
  kind: number,
  subtype?: string
) => snapshot.sections.filter((section) =>
  section.kinds.some((reference) => kindMatches(reference, kind, subtype))
)

const listMembers = (snapshot: CommunitySnapshot, reference: ProfileListReference) =>
  new Set(
    (snapshot.profileListsByAddress.get(reference.address)?.tags || [])
      .filter((tag) => tag[0] === 'p' && PUBKEY.test(tag[1] || ''))
      .map((tag) => tag[1])
  )

export function isAuthorizedForKind(
  snapshot: CommunitySnapshot,
  pubkey: string,
  kind: number,
  subtype?: string
) {
  if (snapshot.admins.has(pubkey)) return true
  if (snapshot.banned.has(pubkey)) return false
  const sections = sectionsForKind(snapshot, kind, subtype)
  return sections.some((section) =>
    section.profileLists.some(
      (reference) =>
        snapshot.profileListsByAddress.has(reference.address) &&
        (reference.owner === pubkey || listMembers(snapshot, reference).has(pubkey))
    )
  )
}

export function canModerateKind(
  snapshot: CommunitySnapshot,
  pubkey: string,
  kind: number,
  subtype?: string
) {
  if (snapshot.admins.has(pubkey)) return true
  if (snapshot.banned.has(pubkey)) return false
  return sectionsForKind(snapshot, kind, subtype).some((section) =>
    section.profileLists.some(
      (reference) =>
        reference.owner === pubkey && snapshot.profileListsByAddress.has(reference.address)
    )
  )
}

export function canManageSection(
  snapshot: CommunitySnapshot,
  pubkey: string,
  sectionName: string
) {
  const section = snapshot.sections.find((candidate) => candidate.name === sectionName)
  if (!section) return false
  if (snapshot.admins.has(pubkey)) return true
  if (snapshot.banned.has(pubkey)) return false
  return section.profileLists.some(
    (reference) =>
      reference.owner === pubkey && snapshot.profileListsByAddress.has(reference.address)
  )
}

export function requireCommunityEose(results: CommunityRelayResult[], phase: string) {
  if (!results.some((result) => result.eose)) {
    throw new Error(`Incomplete ${phase} community relay coverage: no authoritative EOSE`)
  }
}

export function buildProfileListQueryPlans(
  definition: CommunityDefinition
): ProfileListQueryPlan[] {
  const referencesByRelay = new Map<string, Map<string, ProfileListReference>>()
  const add = (relay: string, references: ProfileListReference[]) => {
    const current = referencesByRelay.get(relay) || new Map<string, ProfileListReference>()
    references.forEach((reference) => current.set(reference.address, reference))
    referencesByRelay.set(relay, current)
  }
  definition.relays.forEach((relay) => add(relay, definition.profileLists))
  for (const reference of definition.profileLists) {
    if (reference.relay) add(reference.relay, [reference])
  }
  return [...referencesByRelay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relay, byAddress]) => {
      const references = [...byAddress.values()].sort((a, b) => a.address.localeCompare(b.address))
      const byOwner = new Map<string, Set<string>>()
      for (const reference of references) {
        const identifiers = byOwner.get(reference.owner) || new Set<string>()
        identifiers.add(reference.identifier)
        byOwner.set(reference.owner, identifiers)
      }
      const filters = [...byOwner]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([owner, identifiers]): Filter => ({
          kinds: [PROFILE_LIST_KIND],
          authors: [owner],
          '#d': [...identifiers].sort(),
          limit: Math.min(500, identifiers.size * 4),
        }))
      return { relay, references, filters }
    })
}

export function requireProfileListCoverage(
  plans: ProfileListQueryPlan[],
  results: CommunityRelayResult[]
) {
  const covered = new Set<string>()
  plans.forEach((plan, index) => {
    if (results[index]?.eose) plan.references.forEach((reference) => covered.add(reference.address))
  })
  const missing = new Set(
    plans.flatMap((plan) => plan.references.map((reference) => reference.address))
  )
  covered.forEach((address) => missing.delete(address))
  if (missing.size) {
    throw new Error(`Incomplete membership profile-list coverage for ${missing.size} addresses`)
  }
}

export class CommunityContext implements EligibilityGate {
  private readonly pool = new SimplePool({ enablePing: true })
  private readonly query: CommunityQuery
  private snapshot?: CommunitySnapshot
  private refreshing?: Promise<CommunitySnapshot>
  private verified = false
  private timer?: NodeJS.Timeout

  constructor(
    private readonly mode: CommunityMode,
    private readonly descriptor: CommunityServiceDescriptor,
    query?: CommunityQuery
  ) {
    this.query = query || this.queryRelay.bind(this)
  }

  get ready() {
    return this.verified && Boolean(this.snapshot)
  }

  get current() {
    if (!this.snapshot) throw new Error('Community definition is not ready')
    return this.snapshot
  }

  private queryRelay(relayUrl: string, filters: Filter[], maxWait = 6000) {
    return new Promise<CommunityRelayResult>((resolve) => {
      const events = new Map<string, NostrEvent>()
      let finished = false
      let subscription: { close(reason?: string): void } | undefined
      const finish = (eose: boolean, reason?: string) => {
        if (finished) return
        finished = true
        clearTimeout(timeout)
        if (!eose) subscription?.close('anchor community query timeout')
        resolve({ relay: relayUrl, events: [...events.values()], eose, reason })
      }
      const timeout = setTimeout(() => finish(false, 'timeout'), maxWait)
      void this.pool
        .ensureRelay(relayUrl, { connectionTimeout: Math.max(1000, maxWait - 1000) })
        .then((relay) => {
          if (finished) return
          subscription = relay.subscribe(filters, {
            onevent: (event) => events.set(event.id, event),
            oneose: () => {
              finish(true)
              subscription?.close('anchor community query completed')
            },
            onclose: (reason) => finish(false, reason),
            eoseTimeout: maxWait * 2,
          })
        })
        .catch((error) => finish(false, error instanceof Error ? error.message : 'connection failed'))
    })
  }

  async refresh() {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.load()
      .then((snapshot) => {
        this.verified = true
        return snapshot
      })
      .catch((error) => {
        this.verified = false
        throw error
      })
      .finally(() => {
        this.refreshing = undefined
      })
    return this.refreshing
  }

  start(intervalMs = 60_000) {
    if (this.timer) return
    this.timer = setInterval(() => void this.refresh().catch(() => undefined), intervalMs)
    this.timer.unref()
  }

  private async load() {
    const discoveryRelays = [
      ...new Set([...this.mode.bootstrapRelays, ...(this.snapshot?.relays || [])]),
    ]
    const definitionResults = await Promise.all(
      discoveryRelays.map((relay) =>
        this.query(relay, [
          { kinds: [COMMUNITY_DEFINITION_KIND], authors: [this.mode.communityPubkey], limit: 20 },
        ])
      )
    )
    requireCommunityEose(definitionResults, 'definition')
    const validDefinitions = definitionResults
      .filter((result) => result.eose)
      .flatMap((result) => result.events)
      .filter(
        (event) =>
          event.kind === COMMUNITY_DEFINITION_KIND &&
          event.pubkey === this.mode.communityPubkey &&
          verifyEvent(event)
      )
    const latest = newest([...new Map(validDefinitions.map((event) => [event.id, event])).values()])
    if (!latest) throw new Error('No valid community definition was found')
    const definition = parseCommunityDefinition(
      latest,
      this.mode.communityPubkey,
      this.descriptor
    )

    const plans = buildProfileListQueryPlans(definition)
    const listResults = await Promise.all(
      plans.map((plan) => this.query(plan.relay, plan.filters))
    )
    if (plans.length) requireProfileListCoverage(plans, listResults)
    const listEvents = listResults.filter((result) => result.eose).flatMap((result) => result.events)

    const moderationResults = await Promise.all(
      definition.relays.map((relay) =>
        this.query(relay, [
          {
            kinds: [REPORT_KIND, DELETE_KIND],
            '#h': [this.mode.communityPubkey],
            limit: 500,
          },
        ])
      )
    )
    requireCommunityEose(moderationResults, 'person-ban state')
    const completeModeration = moderationResults.filter((result) => result.eose)
    if (completeModeration.some((result) => result.events.length >= 500)) {
      throw new Error('Person-ban state exceeds the safe query bound')
    }

    const snapshot = buildCommunitySnapshot(
      definition,
      listEvents,
      completeModeration.flatMap((result) => result.events)
    )
    this.snapshot = snapshot
    return snapshot
  }

  async check(pubkey: string) {
    const snapshot = await this.refresh()
    return membershipFor(snapshot, pubkey)
  }

  close() {
    if (this.timer) clearInterval(this.timer)
    this.pool.destroy()
  }
}
