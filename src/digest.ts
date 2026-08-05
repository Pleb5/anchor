import { SimplePool, verifyEvent, type Event as NostrEvent, type Filter } from 'nostr-tools'
import { naddrEncode, neventEncode } from 'nostr-tools/nip19'
import { getSatoshisAmountFromBolt11, validateZapRequest } from 'nostr-tools/nip57'
import {
  normalizeRelayUrl,
  type RepositoryDigestConfig,
  type DigestOptions,
  type DigestRepository,
} from './subscription.js'

export const GIT_COMMENT = 1111
export const GIT_REACTION = 7
export const GIT_ZAP_REQUEST = 9734
export const GIT_ZAP_RECEIPT = 9735
export const GIT_PULL_REQUEST = 1618
export const GIT_PULL_REQUEST_UPDATE = 1619
export const GIT_ISSUE = 1621
export const GIT_PERMALINK = 1623
export const GIT_STATUS_OPEN = 1630
export const GIT_STATUS_APPLIED = 1631
export const GIT_STATUS_CLOSED = 1632
export const GIT_STATUS_DRAFT = 1633
export const GIT_LABEL = 1985

export const REPOSITORY_RELATION_KINDS = [
  GIT_ISSUE,
  GIT_PULL_REQUEST,
  GIT_PULL_REQUEST_UPDATE,
  GIT_STATUS_OPEN,
  GIT_STATUS_APPLIED,
  GIT_STATUS_CLOSED,
  GIT_STATUS_DRAFT,
  GIT_COMMENT,
  GIT_LABEL,
  GIT_PERMALINK,
]

export const REPOSITORY_ENGAGEMENT_KINDS = [GIT_REACTION, GIT_ZAP_RECEIPT]

export const REPOSITORY_ACTIVITY_KINDS = [
  ...REPOSITORY_RELATION_KINDS,
  ...REPOSITORY_ENGAGEMENT_KINDS,
]

export const MAX_AUTHORITATIVE_REPOSITORY_RELAYS = 20

const STATUS_NAMES = new Map([
  [GIT_STATUS_OPEN, 'Open'],
  [GIT_STATUS_DRAFT, 'Draft'],
  [GIT_STATUS_APPLIED, 'Applied'],
  [GIT_STATUS_CLOSED, 'Closed'],
])

export type RepositoryEvent = {
  repositoryAddress: string
  event: NostrEvent
}

type RepositoryContextEvent = NostrEvent | RepositoryEvent

export type AcceptedRepositoryEvent = RepositoryEvent & {
  root?: NostrEvent
  target?: NostrEvent
  actorPubkey: string
  zapSats?: number
}

export type DigestRow = {
  key: string
  repositoryAddress: string
  repositoryName: string
  title: string
  summary: string
  author: string
  createdAt: number
  link: string
  attention: boolean
  eventCount: number
}

export type DigestCounts = {
  newItems: number
  comments: number
  updates: number
  statuses: number
  assignments: number
  reactions: number
  zaps: number
  zapSats: number
  zapsWithAmount: number
  total: number
}

export type DigestRepositoryData = {
  address: string
  name: string
  counts: DigestCounts
  attentionCount: number
  recentAt: number
  rows: DigestRow[]
}

export type DigestData = {
  periodStart: number
  periodEnd: number
  eventCount: number
  attentionCount: number
  overflow: number
  attention: DigestRow[]
  repositories: DigestRepositoryData[]
}

type MutableRow = {
  key: string
  repository: DigestRepository
  root?: NostrEvent
  events: AcceptedRepositoryEvent[]
  comments: number
  reactions: number
  zaps: number
  zapSats: number
  zapsWithAmount: number
  changes: Set<string>
  statuses: Set<string>
  attention: boolean
}

const getTagValues = (event: NostrEvent, name: string) =>
  event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1])

const eventAddress = (event: NostrEvent) => {
  if (event.kind < 30000 || event.kind >= 40000) return undefined
  const dTags = event.tags.filter((tag) => tag[0] === 'd')
  return dTags.length === 1 && dTags[0][1] !== undefined
    ? `${event.kind}:${event.pubkey}:${dTags[0][1]}`
    : undefined
}

const directRepositoryReferences = (event: NostrEvent) => [
  ...getTagValues(event, 'a'),
  ...getTagValues(event, 'q'),
]

const repositoryAddresses = (event: NostrEvent) =>
  [...directRepositoryReferences(event), ...getTagValues(event, 'A')].filter((value) =>
    /^30617:[0-9a-f]{64}:/.test(value)
  )

const hasCrossRepositoryReference = (event: NostrEvent, repositoryAddress: string) =>
  repositoryAddresses(event).some((address) => address !== repositoryAddress)

const directRepositoryA = (event: NostrEvent, repositoryAddress: string) =>
  getTagValues(event, 'a').includes(repositoryAddress)

const directAcceptedRepositoryReference = (event: NostrEvent, repositoryAddress: string) =>
  directRepositoryReferences(event).includes(repositoryAddress)

const hasAcceptedEventReference = (event: NostrEvent, names: string[], graph: AcceptanceGraph) =>
  event.tags.some((tag) => names.includes(tag[0]) && Boolean(tag[1]) && graph.byId.has(tag[1]))

const orderedEventReferences = (event: NostrEvent) => [
  ...getTagValues(event, 'E'),
  ...event.tags.filter((tag) => tag[0] === 'e' && tag[3] === 'root').map((tag) => tag[1]),
  ...getTagValues(event, 'e'),
  ...getTagValues(event, 'q').filter((value) => /^[0-9a-f]{64}$/.test(value)),
]

const freshSignatureValid = (event: NostrEvent) =>
  verifyEvent({
    id: event.id,
    pubkey: event.pubkey,
    created_at: event.created_at,
    kind: event.kind,
    tags: event.tags.map((tag) => [...tag]),
    content: event.content,
    sig: event.sig,
  })

const repositoryAddressParts = (repositoryAddress: string) => {
  const match = repositoryAddress.match(/^30617:([0-9a-f]{64}):(.+)$/)
  return match ? { pubkey: match[1], identifier: match[2] } : undefined
}

export const isExactRepositoryAnnouncement = (event: NostrEvent, repositoryAddress: string) => {
  const parts = repositoryAddressParts(repositoryAddress)
  if (
    !parts ||
    event.kind !== 30617 ||
    event.pubkey !== parts.pubkey ||
    !freshSignatureValid(event)
  ) {
    return false
  }
  const identifiers = event.tags.filter((tag) => tag[0] === 'd')
  return identifiers.length === 1 && identifiers[0][1] === parts.identifier
}

export const selectRepositoryAnnouncement = (events: NostrEvent[], repositoryAddress: string) =>
  [...events]
    .filter((event) => isExactRepositoryAnnouncement(event, repositoryAddress))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0]

export const isRepositoryAnnouncementDeleted = (
  announcement: NostrEvent,
  events: NostrEvent[],
  repositoryAddress: string
) =>
  announcement.tags.some((tag) => tag[0] === 'deleted') ||
  events.some(
    (event) =>
      event.kind === 5 &&
      event.pubkey === announcement.pubkey &&
      event.created_at >= announcement.created_at &&
      freshSignatureValid(event) &&
      (getTagValues(event, 'a').includes(repositoryAddress) ||
        getTagValues(event, 'e').includes(announcement.id))
  )

export const repositoryAnnouncementRelays = (announcement: NostrEvent) => {
  const tags = announcement.tags.filter((tag) => tag[0] === 'relays')
  if (tags.length !== 1 || tags[0].length < 2) {
    throw new Error('Repository announcement must declare exactly one nonempty relays tag')
  }
  const relays = tags[0]
    .slice(1)
    .map((relay, index) => normalizeRelayUrl(relay, `repository announcement relays[${index}]`))
  if (new Set(relays).size !== relays.length) {
    throw new Error('Repository announcement relays tag contains a duplicate URL')
  }
  if (relays.length > MAX_AUTHORITATIVE_REPOSITORY_RELAYS) {
    throw new Error(
      `Repository announcement declares more than ${MAX_AUTHORITATIVE_REPOSITORY_RELAYS} relays`
    )
  }
  return relays
}

type AcceptanceGraph = {
  byId: Map<string, AcceptedRepositoryEvent>
  byAddress: Map<string, AcceptedRepositoryEvent>
}

const relevantTargetTokens = (
  event: NostrEvent,
  repositoryAddress: string,
  graph: AcceptanceGraph
) => {
  if (hasCrossRepositoryReference(event, repositoryAddress)) return undefined
  const tokens = new Set<string>()
  let unresolved = false
  for (const value of getTagValues(event, 'a')) {
    if (value === repositoryAddress) tokens.add(`repo:${repositoryAddress}`)
    else if (graph.byAddress.has(value)) tokens.add(`event:${graph.byAddress.get(value)!.event.id}`)
    else if (/^\d+:[0-9a-f]{64}:/.test(value)) unresolved = true
  }
  for (const value of [
    ...getTagValues(event, 'e'),
    ...getTagValues(event, 'E'),
    ...getTagValues(event, 'q'),
  ]) {
    if (value === repositoryAddress) {
      tokens.add(`repo:${repositoryAddress}`)
      continue
    }
    if (/^[0-9a-f]{64}$/.test(value)) {
      if (graph.byId.has(value)) tokens.add(`event:${value}`)
      else unresolved = true
    } else if (/^\d+:[0-9a-f]{64}:/.test(value)) unresolved = true
  }
  return unresolved || tokens.size === 0 ? undefined : tokens
}

const setsEqual = (left: Set<string>, right: Set<string>) =>
  left.size === right.size && [...left].every((value) => right.has(value))

const validateRepositoryZap = (
  receipt: NostrEvent,
  repositoryAddress: string,
  graph: AcceptanceGraph
) => {
  if (receipt.kind !== GIT_ZAP_RECEIPT || !freshSignatureValid(receipt)) return undefined
  const descriptions = receipt.tags.filter((tag) => tag[0] === 'description' && tag[1])
  const invoices = receipt.tags.filter((tag) => tag[0] === 'bolt11' && tag[1])
  if (descriptions.length !== 1 || invoices.length !== 1) return undefined
  if (validateZapRequest(descriptions[0][1]) !== null) return undefined
  let request: NostrEvent
  try {
    request = JSON.parse(descriptions[0][1]) as NostrEvent
  } catch {
    return undefined
  }
  if (request.kind !== GIT_ZAP_REQUEST) return undefined
  const receiptTargets = relevantTargetTokens(receipt, repositoryAddress, graph)
  const requestTargets = relevantTargetTokens(request, repositoryAddress, graph)
  if (!receiptTargets || !requestTargets || !setsEqual(receiptTargets, requestTargets)) {
    return undefined
  }
  const receiptRecipients = getTagValues(receipt, 'p')
  const requestRecipients = getTagValues(request, 'p')
  if (
    receiptRecipients.length !== 1 ||
    requestRecipients.length !== 1 ||
    receiptRecipients[0] !== requestRecipients[0]
  ) {
    return undefined
  }
  let zapSats: number | undefined
  try {
    const amount = getSatoshisAmountFromBolt11(invoices[0][1])
    if (Number.isSafeInteger(amount) && amount > 0) zapSats = amount
  } catch {
    // A structurally valid receipt still counts when its invoice amount cannot be decoded safely.
  }
  return { request, zapSats }
}

export function buildAcceptedRepositoryGraph(
  repositoryAddress: string,
  events: NostrEvent[]
): AcceptanceGraph {
  const unique = new Map<string, NostrEvent>()
  events.forEach((event) => unique.set(event.id, event))
  const all = [...unique.values()]
  const allById = new Map(all.map((event) => [event.id, event]))
  const graph: AcceptanceGraph = { byId: new Map(), byAddress: new Map() }

  const announcement = selectRepositoryAnnouncement(all, repositoryAddress)
  if (!announcement || isRepositoryAnnouncementDeleted(announcement, all, repositoryAddress)) {
    return graph
  }
  const announcementRelation: AcceptedRepositoryEvent = {
    repositoryAddress,
    event: announcement,
    root: announcement,
    actorPubkey: announcement.pubkey,
  }
  graph.byId.set(announcement.id, announcementRelation)
  graph.byAddress.set(repositoryAddress, announcementRelation)

  for (let pass = 0; pass < all.length + 1; pass++) {
    let changed = false
    for (const event of all) {
      if (
        graph.byId.has(event.id) ||
        event.kind === 30617 ||
        !REPOSITORY_ACTIVITY_KINDS.includes(event.kind) ||
        hasCrossRepositoryReference(event, repositoryAddress)
      ) {
        continue
      }
      const referencedIds = orderedEventReferences(event)
      if (
        referencedIds.some((id) => {
          const target = allById.get(id)
          return (
            target && repositoryAddresses(target).some((address) => address !== repositoryAddress)
          )
        })
      ) {
        continue
      }
      const targets = referencedIds.flatMap((id) => {
        const target = graph.byId.get(id)
        return target ? [target] : []
      })
      for (const address of [...getTagValues(event, 'a'), ...getTagValues(event, 'A')]) {
        if (address === repositoryAddress) continue
        const target = graph.byAddress.get(address)
        if (target) targets.push(target)
      }
      const target = targets[0]
      const conversationRoot = [target?.root, target?.event].find(
        (candidate) => candidate && [GIT_ISSUE, GIT_PULL_REQUEST].includes(candidate.kind)
      )
      const directA = directRepositoryA(event, repositoryAddress)
      const directAcceptedReference = directAcceptedRepositoryReference(event, repositoryAddress)
      const acceptedReference = Boolean(target)
      let accepted = false
      let root: NostrEvent | undefined
      let actorPubkey = event.pubkey
      let zapSats: number | undefined

      if (event.kind === GIT_ISSUE) {
        accepted = directA
        root = event
      } else if (event.kind === GIT_PULL_REQUEST) {
        const commits = event.tags.filter((tag) => tag[0] === 'c')
        accepted = directA && commits.length === 1 && Boolean(commits[0][1]?.trim())
        root = event
      } else if (event.kind === GIT_PULL_REQUEST_UPDATE) {
        const commits = event.tags.filter((tag) => tag[0] === 'c')
        const roots = event.tags.filter((tag) => tag[0] === 'E')
        const rootAuthors = event.tags.filter((tag) => tag[0] === 'P')
        const pullRequest = roots.length === 1 ? graph.byId.get(roots[0][1]) : undefined
        accepted =
          directA &&
          commits.length === 1 &&
          Boolean(commits[0][1]?.trim()) &&
          roots.length === 1 &&
          Boolean(roots[0][1]) &&
          rootAuthors.length === 1 &&
          Boolean(rootAuthors[0][1]) &&
          pullRequest?.event.kind === GIT_PULL_REQUEST &&
          rootAuthors[0][1] === pullRequest.event.pubkey
        root = pullRequest?.root || pullRequest?.event
      } else if (event.kind === GIT_COMMENT) {
        accepted = directAcceptedReference || acceptedReference
        root = conversationRoot
      } else if (STATUS_NAMES.has(event.kind)) {
        const statusTarget = targets.find((candidate) =>
          [GIT_ISSUE, GIT_PULL_REQUEST].includes(candidate.event.kind)
        )
        accepted = directA || Boolean(statusTarget)
        root = statusTarget?.event
      } else if (event.kind === GIT_LABEL) {
        accepted = directA || acceptedReference
        root = conversationRoot
      } else if (event.kind === GIT_PERMALINK) {
        accepted = directA || hasAcceptedEventReference(event, ['e'], graph)
        root = conversationRoot
      } else if (event.kind === GIT_REACTION) {
        accepted = directAcceptedReference || acceptedReference
        root = conversationRoot
      } else if (event.kind === GIT_ZAP_RECEIPT) {
        const validated = validateRepositoryZap(event, repositoryAddress, graph)
        accepted = Boolean(validated && (directAcceptedReference || acceptedReference))
        root = conversationRoot
        actorPubkey = validated?.request.pubkey || event.pubkey
        zapSats = validated?.zapSats
      }
      if (!accepted) continue
      const relation: AcceptedRepositoryEvent = {
        repositoryAddress,
        event,
        ...(root ? { root } : {}),
        ...(target ? { target: target.event } : {}),
        actorPubkey,
        ...(zapSats !== undefined ? { zapSats } : {}),
      }
      graph.byId.set(event.id, relation)
      const address = eventAddress(event)
      if (address) graph.byAddress.set(address, relation)
      changed = true
    }
    if (!changed) break
  }
  return graph
}

export function resolveAcceptedRepositoryEvents(
  repositoryAddress: string,
  candidates: NostrEvent[],
  contextEvents: NostrEvent[]
) {
  const candidateIds = new Set(candidates.map((event) => event.id))
  const graph = buildAcceptedRepositoryGraph(repositoryAddress, [...contextEvents, ...candidates])
  return [...graph.byId.values()].filter((relation) => candidateIds.has(relation.event.id))
}

const isAssignment = (event: NostrEvent, userPubkey: string) => {
  if (event.kind !== GIT_LABEL) return false
  const deleted = event.tags.some(
    (tag) =>
      tag[0] === 'del' ||
      (tag[0] === 'l' && tag[1] === 'del') ||
      tag.slice(2).some((value) => value.toLowerCase() === 'del')
  )
  const namespace = event.tags.some((tag) => tag[0] === 'L' && tag[1] === 'org.nostr.git.role')
  const assignee = event.tags.some(
    (tag) =>
      tag[0] === 'l' &&
      tag[1] === 'assignee' &&
      !tag.slice(2).some((value) => value.toLowerCase() === 'del')
  )
  return !deleted && namespace && assignee && getTagValues(event, 'p').includes(userPubkey)
}

const statusEnabled = (kind: number, options: DigestOptions) => {
  if (kind === GIT_STATUS_OPEN) return options.status.open
  if (kind === GIT_STATUS_DRAFT) return options.status.draft
  if (kind === GIT_STATUS_APPLIED) return options.status.applied
  if (kind === GIT_STATUS_CLOSED) return options.status.closed
  return false
}

const selectionFor = (
  relation: AcceptedRepositoryEvent,
  options: DigestOptions,
  userPubkey: string
) => {
  const { event, root, actorPubkey } = relation
  if (event.pubkey === userPubkey || actorPubkey === userPubkey) return undefined
  if (event.kind === GIT_ISSUE && options.issues.new) return 'New issue'
  if (event.kind === GIT_PULL_REQUEST && options.prs.new) return 'New pull request'
  if (event.kind === GIT_PULL_REQUEST_UPDATE && options.prs.updates) {
    return 'Pull request updated'
  }
  if (event.kind === GIT_COMMENT) {
    if (root?.kind === GIT_ISSUE && options.issues.comments) return 'Comment'
    if (root?.kind === GIT_PULL_REQUEST && options.prs.comments) return 'Comment'
    return undefined
  }
  if (STATUS_NAMES.has(event.kind) && statusEnabled(event.kind, options)) return 'Status'
  if (isAssignment(event, userPubkey) && options.assignments) return 'Assignment'
  if (event.kind === GIT_REACTION && options.engagement.reactions) return 'Reaction'
  if (event.kind === GIT_ZAP_RECEIPT && options.engagement.zaps) return 'Zap'
  return undefined
}

const firstLine = (event?: NostrEvent) => {
  if (!event) return 'Repository activity'
  const lines = event.content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const subject = lines.find((line) => /^subject:/i.test(line))
  const value = subject ? subject.replace(/^subject:\s*/i, '') : lines[0]
  if (!value) return event.kind === GIT_PULL_REQUEST ? 'Pull request' : 'Issue'
  return value.length > 180 ? `${value.slice(0, 177)}...` : value
}

const shortPubkey = (pubkey: string) => `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`

const replaceAll = (value: string, token: string, replacement: string) =>
  value.split(`<${token}>`).join(replacement)

const repositoryNaddr = (address: string, relays: string[]) => {
  const [kind, pubkey, ...identifier] = address.split(':')
  return naddrEncode({
    kind: Number(kind),
    pubkey,
    identifier: identifier.join(':'),
    relays,
  })
}

export function buildBudabitLink(
  template: string,
  repository: DigestRepository,
  event: NostrEvent,
  root?: NostrEvent
) {
  const target = root || event
  const section = target.kind === GIT_PULL_REQUEST ? 'patches' : 'issues'
  let link = template
  if (link.includes('<repo_naddr>') || link.includes('<section>') || link.includes('<id>')) {
    link = replaceAll(link, 'repo_naddr', repositoryNaddr(repository.address, repository.relays))
    link = replaceAll(link, 'section', section)
    link = replaceAll(link, 'id', target.id)
  } else {
    const nevent = neventEncode({ id: target.id, relays: repository.relays, author: target.pubkey })
    link = link.includes('<bech32>') ? replaceAll(link, 'bech32', nevent) : `${link}${nevent}`
  }

  try {
    const url = new URL(link)
    return url.protocol === 'https:' ? url.toString() : '#'
  } catch {
    return '#'
  }
}

const emptyCounts = (): DigestCounts => ({
  newItems: 0,
  comments: 0,
  updates: 0,
  statuses: 0,
  assignments: 0,
  reactions: 0,
  zaps: 0,
  zapSats: 0,
  zapsWithAmount: 0,
  total: 0,
})

const countSelection = (counts: DigestCounts, selection: string) => {
  counts.total++
  if (selection.startsWith('New ')) counts.newItems++
  if (selection === 'Comment') counts.comments++
  if (selection === 'Pull request updated') counts.updates++
  if (selection === 'Status') counts.statuses++
  if (selection === 'Assignment') counts.assignments++
  if (selection === 'Reaction') counts.reactions++
  if (selection === 'Zap') counts.zaps++
}

export function normalizeDigest(
  config: RepositoryDigestConfig,
  userPubkey: string,
  repositoryEvents: RepositoryEvent[],
  contextEvents: RepositoryContextEvent[],
  profiles: Map<string, string>,
  handlerTemplate: string,
  periodStart: number,
  periodEnd: number
): DigestData {
  const repositories = new Map(
    config.repositories.map((repository) => [repository.address, repository])
  )
  const deduplicated = new Map<string, RepositoryEvent>()
  for (const item of [...repositoryEvents].sort(
    (a, b) =>
      a.repositoryAddress.localeCompare(b.repositoryAddress) || a.event.id.localeCompare(b.event.id)
  )) {
    if (!deduplicated.has(item.event.id)) deduplicated.set(item.event.id, item)
  }

  const candidatesByRepository = new Map<string, NostrEvent[]>()
  for (const { repositoryAddress, event } of deduplicated.values()) {
    const candidates = candidatesByRepository.get(repositoryAddress) || []
    candidates.push(event)
    candidatesByRepository.set(repositoryAddress, candidates)
  }
  const graphsByRepository = new Map(
    [...repositories.keys()].map((repositoryAddress) => [
      repositoryAddress,
      buildAcceptedRepositoryGraph(repositoryAddress, [
        ...contextEvents.flatMap((item) =>
          'repositoryAddress' in item
            ? item.repositoryAddress === repositoryAddress
              ? [item.event]
              : []
            : [item]
        ),
        ...(candidatesByRepository.get(repositoryAddress) || []),
      ]),
    ])
  )
  const acceptedRepositoriesByEventId = new Map<string, Set<string>>()
  for (const [repositoryAddress, graph] of graphsByRepository) {
    for (const eventId of graph.byId.keys()) {
      const addresses = acceptedRepositoriesByEventId.get(eventId) || new Set<string>()
      addresses.add(repositoryAddress)
      acceptedRepositoriesByEventId.set(eventId, addresses)
    }
  }
  const accepted = [...candidatesByRepository].flatMap(([repositoryAddress, candidates]) => {
    const candidateIds = new Set(candidates.map((event) => event.id))
    return [...graphsByRepository.get(repositoryAddress)!.byId.values()].filter((relation) => {
      if (!candidateIds.has(relation.event.id)) return false
      return !orderedEventReferences(relation.event).some((eventId) =>
        [...(acceptedRepositoriesByEventId.get(eventId) || [])].some(
          (acceptedRepository) => acceptedRepository !== repositoryAddress
        )
      )
    })
  })

  const grouped = new Map<string, MutableRow>()
  const countsByRepository = new Map<string, DigestCounts>()
  for (const relation of accepted.sort(
    (a, b) => a.event.created_at - b.event.created_at || a.event.id.localeCompare(b.event.id)
  )) {
    const { repositoryAddress, event, root } = relation
    if (event.created_at < periodStart || event.created_at >= periodEnd) continue
    const repository = repositories.get(repositoryAddress)
    if (!repository) continue
    const selection = selectionFor(relation, repository.options, userPubkey)
    if (!selection) continue

    const engagement = [GIT_REACTION, GIT_ZAP_RECEIPT].includes(event.kind)
    const groupId = root?.id || (engagement ? 'repository-engagement' : event.id)
    const rowRoot =
      root || (event.kind === GIT_ISSUE || event.kind === GIT_PULL_REQUEST ? event : undefined)
    const key = `${repository.address}:${groupId}`
    const row = grouped.get(key) || {
      key,
      repository,
      root: rowRoot,
      events: [],
      comments: 0,
      reactions: 0,
      zaps: 0,
      zapSats: 0,
      zapsWithAmount: 0,
      changes: new Set<string>(),
      statuses: new Set<string>(),
      attention: false,
    }
    if (!row.root && rowRoot) row.root = rowRoot
    row.events.push(relation)
    if (selection === 'Comment') row.comments++
    else if (selection === 'Status') row.statuses.add(STATUS_NAMES.get(event.kind)!)
    else if (selection === 'Assignment') row.attention = true
    else if (selection === 'Reaction') row.reactions++
    else if (selection === 'Zap') {
      row.zaps++
      if (relation.zapSats !== undefined) {
        row.zapSats += relation.zapSats
        row.zapsWithAmount++
      }
    } else row.changes.add(selection)
    grouped.set(key, row)

    const counts = countsByRepository.get(repository.address) || emptyCounts()
    countSelection(counts, selection)
    if (selection === 'Zap' && relation.zapSats !== undefined) {
      counts.zapSats += relation.zapSats
      counts.zapsWithAmount++
    }
    countsByRepository.set(repository.address, counts)
  }

  const rows = [...grouped.values()].map((row): DigestRow => {
    const recent = [...row.events].sort(
      (a, b) => b.event.created_at - a.event.created_at || a.event.id.localeCompare(b.event.id)
    )[0]
    const details = [...row.changes].sort()
    if (row.comments) details.push(`${row.comments} comment${row.comments === 1 ? '' : 's'}`)
    if (row.reactions) details.push(`${row.reactions} reaction${row.reactions === 1 ? '' : 's'}`)
    if (row.zaps) {
      const amount = row.zapsWithAmount === row.zaps ? ` (${row.zapSats} sats)` : ''
      details.push(`${row.zaps} zap${row.zaps === 1 ? '' : 's'}${amount}`)
    }
    if (row.statuses.size) details.push(`Status: ${[...row.statuses].sort().join(', ')}`)
    if (row.attention) details.push('Assigned to you')
    return {
      key: row.key,
      repositoryAddress: row.repository.address,
      repositoryName: row.repository.name,
      title: row.root ? firstLine(row.root) : row.repository.name,
      summary: details.join(' | '),
      author: profiles.get(recent.actorPubkey) || shortPubkey(recent.actorPubkey),
      createdAt: recent.event.created_at,
      link: buildBudabitLink(handlerTemplate, row.repository, recent.event, row.root),
      attention: row.attention,
      eventCount: row.events.length,
    }
  })

  const allRepositories = [...countsByRepository.entries()].map(
    ([address, counts]): DigestRepositoryData => {
      const repository = repositories.get(address)!
      const repositoryRows = rows.filter((row) => row.repositoryAddress === address)
      return {
        address,
        name: repository.name,
        counts,
        attentionCount: repositoryRows.filter((row) => row.attention).length,
        recentAt: Math.max(...repositoryRows.map((row) => row.createdAt)),
        rows: [],
      }
    }
  )
  allRepositories.sort(
    (a, b) =>
      b.attentionCount - a.attentionCount ||
      b.recentAt - a.recentAt ||
      a.name.localeCompare(b.name) ||
      a.address.localeCompare(b.address)
  )

  let remaining = 50
  const attention = rows
    .filter((row) => row.attention)
    .sort(
      (a, b) =>
        b.createdAt - a.createdAt ||
        a.repositoryName.localeCompare(b.repositoryName) ||
        a.key.localeCompare(b.key)
    )
    .slice(0, remaining)
  remaining -= attention.length

  for (const repository of allRepositories) {
    repository.rows = rows
      .filter((row) => row.repositoryAddress === repository.address && !row.attention)
      .sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key))
      .slice(0, remaining)
    remaining -= repository.rows.length
  }

  const renderedRows =
    attention.length + allRepositories.reduce((sum, repo) => sum + repo.rows.length, 0)
  return {
    periodStart,
    periodEnd,
    eventCount: [...countsByRepository.values()].reduce((sum, counts) => sum + counts.total, 0),
    attentionCount: rows.filter((row) => row.attention).length,
    overflow: Math.max(0, rows.length - renderedRows),
    attention,
    repositories: allRepositories,
  }
}

export type RelayQueryResult = {
  relay: string
  events: NostrEvent[]
  eose: boolean
  reason?: string
}

export type RepositoryQuery = (
  relay: string,
  filters: Filter[],
  maxWait?: number
) => Promise<RelayQueryResult>

const query = (pool: SimplePool, relayUrl: string, filters: Filter[], maxWait = 6000) =>
  new Promise<RelayQueryResult>((resolve) => {
    const events = new Map<string, NostrEvent>()
    let finished = false
    let subscription: { close(reason?: string): void } | undefined
    const finish = (eose: boolean, reason?: string) => {
      if (finished) return
      finished = true
      clearTimeout(timeout)
      if (!eose) subscription?.close('anchor query timeout')
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
            subscription?.close('anchor query completed')
          },
          onclose: (reason) => finish(false, reason),
          eoseTimeout: maxWait * 2,
        })
      })
      .catch((error) => finish(false, error instanceof Error ? error.message : 'connection failed'))
  })

type RelayRepositoryPlan = {
  relay: string
  repositoryAddresses: string[]
}

type CoverageResponse = {
  plan: Pick<RelayRepositoryPlan, 'repositoryAddresses'>
  result: Pick<RelayQueryResult, 'eose'>
}

export function requireRepositoryCoverage(
  repositoryAddresses: string[],
  responses: CoverageResponse[],
  phase: string
) {
  const covered = new Set(
    responses.filter(({ result }) => result.eose).flatMap(({ plan }) => plan.repositoryAddresses)
  )
  const missing = repositoryAddresses.filter((address) => !covered.has(address))
  if (missing.length > 0) {
    throw new Error(`Incomplete ${phase} relay coverage for ${missing.length} repositories`)
  }
}

export const buildRelayRepositoryPlans = (
  repositories: DigestRepository[]
): RelayRepositoryPlan[] => {
  const addressesByRelay = new Map<string, Set<string>>()
  for (const repository of repositories) {
    for (const relay of repository.relays) {
      const addresses = addressesByRelay.get(relay) || new Set<string>()
      addresses.add(repository.address)
      addressesByRelay.set(relay, addresses)
    }
  }
  return [...addressesByRelay]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([relay, addresses]) => ({ relay, repositoryAddresses: [...addresses].sort() }))
}

export const attributeRepositoryAddresses = (event: NostrEvent, allowedAddresses: string[]) => {
  const references = new Set(directRepositoryReferences(event))
  return allowedAddresses.filter((address) => references.has(address))
}

export const buildRepositoryAnnouncementFilters = (repositoryAddress: string): Filter[] => {
  const parts = repositoryAddressParts(repositoryAddress)
  if (!parts) throw new Error('Invalid repository address')
  return [
    {
      kinds: [30617],
      authors: [parts.pubkey],
      '#d': [parts.identifier],
      limit: 20,
    },
  ]
}

export const buildRepositoryAnnouncementDeletionFilters = (
  repositoryAddress: string,
  announcementId: string
): Filter[] => {
  const parts = repositoryAddressParts(repositoryAddress)
  if (!parts) throw new Error('Invalid repository address')
  return [
    { kinds: [5], authors: [parts.pubkey], '#a': [repositoryAddress], limit: 500 },
    { kinds: [5], authors: [parts.pubkey], '#e': [announcementId], limit: 500 },
  ]
}

export const buildRepositoryPrimaryFilters = (
  repositoryAddresses: string[],
  periodStart: number,
  periodEnd: number
): Filter[] => {
  const period = { since: periodStart, until: periodEnd - 1, limit: 500 }
  return [
    { kinds: REPOSITORY_ACTIVITY_KINDS, '#a': repositoryAddresses, ...period },
    {
      kinds: [GIT_REACTION, GIT_COMMENT, GIT_ZAP_RECEIPT],
      '#q': repositoryAddresses,
      ...period,
    },
  ]
}

export const buildRepositoryEngagementFilters = (
  acceptedIds: string[],
  periodStart: number,
  periodEnd: number
): Filter[] => {
  const ids = acceptedIds.slice(0, 500)
  const period = { since: periodStart, until: periodEnd - 1, limit: 500 }
  return ids.length
    ? [
        { kinds: REPOSITORY_ACTIVITY_KINDS, '#e': ids, ...period },
        { kinds: REPOSITORY_ACTIVITY_KINDS, '#E': ids, ...period },
        { kinds: REPOSITORY_ACTIVITY_KINDS, '#q': ids, ...period },
      ]
    : []
}

const mapConcurrent = async <T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T) => Promise<R>
) => {
  const results = new Array<R>(items.length)
  let index = 0
  const worker = async () => {
    while (index < items.length) {
      const current = index++
      results[current] = await operation(items[current])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

export const getFallbackHandlerTemplate = (manageUrl: string) =>
  `${new URL(manageUrl).origin}/git/<repo_naddr>/<section>/<id>`

const isValidHandlerTemplate = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > 2048) return false
  const hasItemTarget =
    value.includes('<bech32>') ||
    (value.includes('<repo_naddr>') && value.includes('<section>') && value.includes('<id>'))
  if (!hasItemTarget) return false
  try {
    const sample = new URL(value.replace(/<[^>]+>/g, 'value'))
    return (
      sample.protocol === 'https:' &&
      Boolean(sample.hostname) &&
      !sample.username &&
      !sample.password &&
      !sample.hash
    )
  } catch {
    return false
  }
}

const exactHandlerEvent = (event: NostrEvent, address: string) => {
  const match = address.match(/^31990:([0-9a-f]{64}):([^\u0000-\u001f\u007f]{1,200})$/)
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
    event.kind === 31990 &&
    event.pubkey === match[1] &&
    dTags.length === 1 &&
    dTags[0][1] === match[2]
  )
}

export const selectHandlerTemplate = (
  events: NostrEvent[],
  manageUrl: string,
  handlerAddress: string
) =>
  [...events]
    .filter((event) => exactHandlerEvent(event, handlerAddress))
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .flatMap((event) => event.tags)
    .find((tag) => tag[0] === 'web' && isValidHandlerTemplate(tag[1]))?.[1] ||
  getFallbackHandlerTemplate(manageUrl)

export class DigestCollector {
  private readonly pool = new SimplePool({ enablePing: true })
  private readonly query: RepositoryQuery

  constructor(queryRepository?: RepositoryQuery) {
    this.query =
      queryRepository || ((relay, filters, maxWait) => query(this.pool, relay, filters, maxWait))
  }

  private async preflightRepositories(repositories: DigestRepository[]) {
    const lookupPlans = repositories.flatMap((repository) =>
      repository.relays.map((relay) => ({
        relay,
        repositoryAddresses: [repository.address],
        repository,
      }))
    )
    const lookupResponses = await mapConcurrent(lookupPlans, 6, async (plan) => ({
      plan,
      result: await this.query(
        plan.relay,
        buildRepositoryAnnouncementFilters(plan.repository.address)
      ),
    }))
    requireRepositoryCoverage(
      repositories.map((repository) => repository.address),
      lookupResponses,
      'announcement lookup'
    )

    const announcements = new Map<string, NostrEvent>()
    for (const repository of repositories) {
      const candidates = lookupResponses
        .filter(({ plan, result }) => plan.repository.address === repository.address && result.eose)
        .flatMap(({ result }) => result.events)
      const announcement = selectRepositoryAnnouncement(candidates, repository.address)
      if (announcement) announcements.set(repository.address, announcement)
    }
    const missing = repositories.filter((repository) => !announcements.has(repository.address))
    if (missing.length) {
      throw new Error(`Missing accepted repository announcement for ${missing.length} repositories`)
    }

    const deletionPlans = lookupPlans.map((plan) => ({
      ...plan,
      announcement: announcements.get(plan.repository.address)!,
    }))
    const deletionResponses = await mapConcurrent(deletionPlans, 6, async (plan) => ({
      plan,
      result: await this.query(
        plan.relay,
        buildRepositoryAnnouncementDeletionFilters(plan.repository.address, plan.announcement.id)
      ),
    }))
    requireRepositoryCoverage(
      repositories.map((repository) => repository.address),
      deletionResponses,
      'announcement deletion lookup'
    )

    const deleted = repositories.filter((repository) => {
      const announcement = announcements.get(repository.address)!
      const deletions = deletionResponses
        .filter(({ plan }) => plan.repository.address === repository.address)
        .flatMap(({ result }) => result.events)
      return isRepositoryAnnouncementDeleted(announcement, deletions, repository.address)
    })
    if (deleted.length) {
      throw new Error(`Deleted repository announcement for ${deleted.length} repositories`)
    }

    const accepted = repositories.map((repository) => ({
      ...repository,
      relays: repositoryAnnouncementRelays(announcements.get(repository.address)!),
    }))
    const uniqueRelays = new Set(accepted.flatMap((repository) => repository.relays))
    if (uniqueRelays.size > MAX_AUTHORITATIVE_REPOSITORY_RELAYS) {
      throw new Error(
        `Repository announcements declare more than ${MAX_AUTHORITATIVE_REPOSITORY_RELAYS} unique relays`
      )
    }
    return {
      repositories: accepted,
      announcements,
    }
  }

  async collect(
    config: RepositoryDigestConfig,
    userPubkey: string,
    periodStart: number,
    periodEnd: number
  ) {
    const preflight = await this.preflightRepositories(config.repositories)
    const effectiveConfig: RepositoryDigestConfig = {
      ...config,
      repositories: preflight.repositories,
    }
    const plans = buildRelayRepositoryPlans(effectiveConfig.repositories)
    const responses = await mapConcurrent(plans, 6, async (plan) => ({
      plan,
      result: await this.query(
        plan.relay,
        buildRepositoryPrimaryFilters(plan.repositoryAddresses, periodStart, periodEnd)
      ),
    }))
    requireRepositoryCoverage(
      effectiveConfig.repositories.map((repository) => repository.address),
      responses,
      'primary'
    )

    const attributed = responses.flatMap(({ plan, result }) =>
      result.events.flatMap((event) =>
        attributeRepositoryAddresses(event, plan.repositoryAddresses).map(
          (repositoryAddress): RepositoryEvent => ({ repositoryAddress, event })
        )
      )
    )
    attributed.sort(
      (a, b) =>
        b.event.created_at - a.event.created_at ||
        a.event.id.localeCompare(b.event.id) ||
        a.repositoryAddress.localeCompare(b.repositoryAddress)
    )

    const repositoryEvents: RepositoryEvent[] = []
    const seen = new Set<string>()
    for (const item of attributed) {
      if (seen.size >= 500) break
      if (seen.has(item.event.id)) continue
      seen.add(item.event.id)
      repositoryEvents.push(item)
    }

    const fallbackHandler = getFallbackHandlerTemplate(effectiveConfig.manageUrl)

    const eventsByRepository = new Map<string, NostrEvent[]>()
    for (const item of repositoryEvents) {
      const events = eventsByRepository.get(item.repositoryAddress) || []
      events.push(item.event)
      eventsByRepository.set(item.repositoryAddress, events)
    }

    const fetchContext = async (idsByRepository: Map<string, Set<string>>, phase: string) => {
      const contextPlans = effectiveConfig.repositories
        .flatMap((repository) => {
          const ids = [...(idsByRepository.get(repository.address) || [])].slice(0, 500)
          if (!ids.length) return []
          return repository.relays.map((relay) => ({
            relay,
            repositoryAddresses: [repository.address],
            ids,
          }))
        })
        .sort((a, b) => a.relay.localeCompare(b.relay))
      const contextResponses = await mapConcurrent(contextPlans, 6, async (plan) => ({
        plan,
        result: await this.query(plan.relay, [{ ids: plan.ids, limit: plan.ids.length }]),
      }))
      requireRepositoryCoverage(
        [...idsByRepository].filter(([, ids]) => ids.size).map(([address]) => address),
        contextResponses,
        phase
      )
      return contextResponses.flatMap(({ plan, result }) =>
        result.events.map((event) => ({
          repositoryAddress: plan.repositoryAddresses[0],
          event,
        }))
      )
    }

    const knownIdsByRepository = new Map(
      effectiveConfig.repositories.map((repository) => [
        repository.address,
        new Set([
          preflight.announcements.get(repository.address)!.id,
          ...(eventsByRepository.get(repository.address) || []).map((event) => event.id),
        ]),
      ])
    )
    const firstIdsByRepository = new Map(
      effectiveConfig.repositories.map((repository) => [
        repository.address,
        new Set(
          (eventsByRepository.get(repository.address) || [])
            .flatMap((event) => orderedEventReferences(event))
            .filter((id) => !knownIdsByRepository.get(repository.address)!.has(id))
        ),
      ])
    )
    const firstContext = await fetchContext(firstIdsByRepository, 'root')
    const firstContextByRepository = new Map(
      effectiveConfig.repositories.map((repository) => [
        repository.address,
        new Map(
          firstContext
            .filter((item) => item.repositoryAddress === repository.address)
            .map((item) => [item.event.id, item.event])
        ),
      ])
    )
    const secondIdsByRepository = new Map(
      effectiveConfig.repositories.map((repository) => {
        const requested = firstIdsByRepository.get(repository.address) || new Set<string>()
        const firstContextById = firstContextByRepository.get(repository.address)!
        const ids = new Set(
          [...requested]
            .flatMap((id) => {
              const event = firstContextById.get(id)
              return event ? orderedEventReferences(event) : []
            })
            .filter(
              (id) =>
                !knownIdsByRepository.get(repository.address)!.has(id) && !firstContextById.has(id)
            )
        )
        return [repository.address, ids]
      })
    )
    const secondContext = await fetchContext(secondIdsByRepository, 'root follow-up')
    const contextEvents = [
      ...effectiveConfig.repositories.map((repository) => ({
        repositoryAddress: repository.address,
        event: preflight.announcements.get(repository.address)!,
      })),
      ...firstContext,
      ...secondContext,
    ].filter(
      (item, index, items) =>
        items.findIndex(
          (candidate) =>
            candidate.repositoryAddress === item.repositoryAddress &&
            candidate.event.id === item.event.id
        ) === index
    )

    const acceptedIdsByRepository = new Map(
      effectiveConfig.repositories.map((repository) => {
        const graph = buildAcceptedRepositoryGraph(repository.address, [
          ...(eventsByRepository.get(repository.address) || []),
          ...contextEvents
            .filter((item) => item.repositoryAddress === repository.address)
            .map((item) => item.event),
        ])
        return [repository.address, new Set([...graph.byId.keys()].slice(0, 500))]
      })
    )
    const engagementPlans = effectiveConfig.repositories.flatMap((repository) => {
      const ids = [...(acceptedIdsByRepository.get(repository.address) || [])].slice(0, 500)
      if (!ids.length) return []
      return repository.relays.map((relay) => ({
        relay,
        repositoryAddresses: [repository.address],
        ids,
      }))
    })
    const engagementResponses = await mapConcurrent(engagementPlans, 6, async (plan) => ({
      plan,
      result: await this.query(
        plan.relay,
        buildRepositoryEngagementFilters(plan.ids, periodStart, periodEnd)
      ),
    }))
    requireRepositoryCoverage(
      [...acceptedIdsByRepository].filter(([, ids]) => ids.size).map(([address]) => address),
      engagementResponses,
      'engagement'
    )
    for (const { plan, result } of engagementResponses) {
      for (const event of result.events) {
        if (seen.has(event.id) || seen.size >= 500) continue
        const references = new Set(orderedEventReferences(event))
        let attributed = false
        for (const repositoryAddress of plan.repositoryAddresses) {
          const acceptedIds = acceptedIdsByRepository.get(repositoryAddress) || new Set<string>()
          if ([...references].some((id) => acceptedIds.has(id))) {
            repositoryEvents.push({ repositoryAddress, event })
            attributed = true
          }
        }
        if (attributed) seen.add(event.id)
      }
    }

    const preliminary = normalizeDigest(
      effectiveConfig,
      userPubkey,
      repositoryEvents,
      contextEvents,
      new Map(),
      fallbackHandler,
      periodStart,
      periodEnd
    )
    if (preliminary.eventCount === 0) return preliminary

    const authors = [
      ...new Set([
        ...[
          ...repositoryEvents.map(({ event }) => event),
          ...contextEvents.map(({ event }) => event),
        ].map((event) => event.pubkey),
        ...repositoryEvents.flatMap(({ event }) => {
          if (event.kind !== GIT_ZAP_RECEIPT) return []
          const description = event.tags.find((tag) => tag[0] === 'description')?.[1]
          if (!description) return []
          try {
            const request = JSON.parse(description)
            return typeof request.pubkey === 'string' ? [request.pubkey] : []
          } catch {
            return []
          }
        }),
      ]),
    ]
    const declaredRelays = plans.map((plan) => plan.relay)
    const profileEvents = (
      await mapConcurrent(declaredRelays, 6, (relay) =>
        this.query(relay, [{ kinds: [0], authors, limit: authors.length }])
      )
    ).flatMap((result) => result.events)
    const profiles = new Map<string, { name: string; createdAt: number; id: string }>()
    for (const event of profileEvents) {
      try {
        const metadata = JSON.parse(event.content)
        const name = metadata.display_name || metadata.name
        const existing = profiles.get(event.pubkey)
        if (
          typeof name === 'string' &&
          name.trim() &&
          (!existing ||
            existing.createdAt < event.created_at ||
            (existing.createdAt === event.created_at && event.id < existing.id))
        ) {
          profiles.set(event.pubkey, {
            name: name.trim().slice(0, 100),
            createdAt: event.created_at,
            id: event.id,
          })
        }
      } catch {
        // Invalid profile metadata is ignored.
      }
    }

    let handlerEvents: NostrEvent[] = []
    try {
      const [handlerKind, handlerPubkey, ...handlerId] = effectiveConfig.handler.address.split(':')
      handlerEvents = (
        await this.query(effectiveConfig.handler.relay, [
          {
            kinds: [Number(handlerKind)],
            authors: [handlerPubkey],
            '#d': [handlerId.join(':')],
            limit: 1,
          },
        ])
      ).events
    } catch {
      // Handler metadata is optional because manageUrl provides a safe Budabit fallback.
    }
    const handler = selectHandlerTemplate(
      handlerEvents,
      effectiveConfig.manageUrl,
      effectiveConfig.handler.address
    )

    return normalizeDigest(
      effectiveConfig,
      userPubkey,
      repositoryEvents,
      contextEvents,
      new Map([...profiles].map(([pubkey, profile]) => [pubkey, profile.name])),
      handler,
      periodStart,
      periodEnd
    )
  }

  async close() {
    this.pool.destroy()
  }
}
