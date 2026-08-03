import { SimplePool, type Event as NostrEvent, type Filter } from 'nostr-tools'
import { naddrEncode, neventEncode } from 'nostr-tools/nip19'
import type { DigestConfig, DigestOptions, DigestRepository } from './subscription.js'

export const GIT_COMMENT = 1111
export const GIT_PULL_REQUEST = 1618
export const GIT_PULL_REQUEST_UPDATE = 1619
export const GIT_ISSUE = 1621
export const GIT_STATUS_OPEN = 1630
export const GIT_STATUS_APPLIED = 1631
export const GIT_STATUS_CLOSED = 1632
export const GIT_STATUS_DRAFT = 1633
export const GIT_LABEL = 1985

const PRIMARY_KINDS = [
  GIT_ISSUE,
  GIT_PULL_REQUEST,
  GIT_PULL_REQUEST_UPDATE,
  GIT_STATUS_OPEN,
  GIT_STATUS_APPLIED,
  GIT_STATUS_CLOSED,
  GIT_STATUS_DRAFT,
  GIT_COMMENT,
  GIT_LABEL,
]

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
  events: NostrEvent[]
  comments: number
  changes: Set<string>
  statuses: Set<string>
  attention: boolean
}

const getTagValues = (event: NostrEvent, name: string) =>
  event.tags.filter((tag) => tag[0] === name && tag[1]).map((tag) => tag[1])

const getRootId = (event: NostrEvent) => {
  const uppercase = getTagValues(event, 'E')[0]
  if (uppercase) return uppercase
  const root = event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'root')?.[1]
  return root || getTagValues(event, 'e')[0]
}

const isAssignment = (event: NostrEvent, userPubkey: string) => {
  if (event.kind !== GIT_LABEL) return false
  const deleted = event.tags.some(
    (tag) =>
      tag[0] === 'del' ||
      (tag[0] === 'l' && tag[1] === 'del') ||
      tag.slice(2).some((value) => value.toLowerCase() === 'del')
  )
  const namespace = event.tags.some(
    (tag) => tag[0] === 'L' && tag[1] === 'org.nostr.git.role'
  )
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
  event: NostrEvent,
  root: NostrEvent | undefined,
  options: DigestOptions,
  userPubkey: string
) => {
  if (event.pubkey === userPubkey) return undefined
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
  total: 0,
})

const countSelection = (counts: DigestCounts, selection: string) => {
  counts.total++
  if (selection.startsWith('New ')) counts.newItems++
  if (selection === 'Comment') counts.comments++
  if (selection === 'Pull request updated') counts.updates++
  if (selection === 'Status') counts.statuses++
  if (selection === 'Assignment') counts.assignments++
}

export function normalizeDigest(
  config: DigestConfig,
  userPubkey: string,
  repositoryEvents: RepositoryEvent[],
  contextEvents: NostrEvent[],
  profiles: Map<string, string>,
  handlerTemplate: string,
  periodStart: number,
  periodEnd: number
): DigestData {
  const repositories = new Map(config.repositories.map((repository) => [repository.address, repository]))
  const roots = new Map<string, NostrEvent>()
  for (const event of [...contextEvents, ...repositoryEvents.map(({ event }) => event)]) {
    const existing = roots.get(event.id)
    if (!existing || existing.created_at < event.created_at) roots.set(event.id, event)
  }

  const deduplicated = new Map<string, RepositoryEvent>()
  for (const item of [...repositoryEvents].sort((a, b) =>
    a.repositoryAddress.localeCompare(b.repositoryAddress) || a.event.id.localeCompare(b.event.id)
  )) {
    if (!deduplicated.has(item.event.id)) deduplicated.set(item.event.id, item)
  }

  const grouped = new Map<string, MutableRow>()
  const countsByRepository = new Map<string, DigestCounts>()
  for (const { repositoryAddress, event } of [...deduplicated.values()].sort(
    (a, b) => a.event.created_at - b.event.created_at || a.event.id.localeCompare(b.event.id)
  )) {
    if (event.created_at < periodStart || event.created_at >= periodEnd) continue
    const repository = repositories.get(repositoryAddress)
    if (!repository) continue
    const rootId = getRootId(event)
    const root = rootId ? roots.get(rootId) : undefined
    const selection = selectionFor(event, root, repository.options, userPubkey)
    if (!selection) continue

    const groupId = root?.id || event.id
    const key = `${repository.address}:${groupId}`
    const row = grouped.get(key) || {
      key,
      repository,
      root,
      events: [],
      comments: 0,
      changes: new Set<string>(),
      statuses: new Set<string>(),
      attention: false,
    }
    row.events.push(event)
    if (selection === 'Comment') row.comments++
    else if (selection === 'Status') row.statuses.add(STATUS_NAMES.get(event.kind)!)
    else if (selection === 'Assignment') row.attention = true
    else row.changes.add(selection)
    grouped.set(key, row)

    const counts = countsByRepository.get(repository.address) || emptyCounts()
    countSelection(counts, selection)
    countsByRepository.set(repository.address, counts)
  }

  const rows = [...grouped.values()].map((row): DigestRow => {
    const recent = [...row.events].sort(
      (a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id)
    )[0]
    const details = [...row.changes].sort()
    if (row.comments) details.push(`${row.comments} comment${row.comments === 1 ? '' : 's'}`)
    if (row.statuses.size) details.push(`Status: ${[...row.statuses].sort().join(', ')}`)
    if (row.attention) details.push('Assigned to you')
    return {
      key: row.key,
      repositoryAddress: row.repository.address,
      repositoryName: row.repository.name,
      title: firstLine(row.root || recent),
      summary: details.join(' | '),
      author: profiles.get(recent.pubkey) || shortPubkey(recent.pubkey),
      createdAt: recent.created_at,
      link: buildBudabitLink(handlerTemplate, row.repository, recent, row.root),
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

  const renderedRows = attention.length + allRepositories.reduce((sum, repo) => sum + repo.rows.length, 0)
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

const query = (
  pool: SimplePool,
  relayUrl: string,
  filters: Filter[],
  maxWait = 6000
) =>
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
  phase: 'primary' | 'root'
) {
  const covered = new Set(
    responses
      .filter(({ result }) => result.eose)
      .flatMap(({ plan }) => plan.repositoryAddresses)
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

export const attributeRepositoryAddresses = (
  event: NostrEvent,
  allowedAddresses: string[]
) => {
  const references = new Set(getTagValues(event, 'a'))
  if (event.kind === GIT_COMMENT) {
    for (const address of getTagValues(event, 'q')) references.add(address)
  }
  return allowedAddresses.filter((address) => references.has(address))
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

export const selectHandlerTemplate = (events: NostrEvent[], manageUrl: string) =>
  [...events]
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
    .flatMap((event) => event.tags)
    .find((tag) => tag[0] === 'web' && isValidHandlerTemplate(tag[1]))?.[1] ||
  getFallbackHandlerTemplate(manageUrl)

export class DigestCollector {
  private readonly pool = new SimplePool({ enablePing: true })

  async collect(
    config: DigestConfig,
    userPubkey: string,
    periodStart: number,
    periodEnd: number
  ) {
    const plans = buildRelayRepositoryPlans(config.repositories)
    const responses = await mapConcurrent(plans, 6, async (plan) => ({
      plan,
      result: await query(this.pool, plan.relay, [
        {
          kinds: PRIMARY_KINDS,
          '#a': plan.repositoryAddresses,
          since: periodStart,
          until: periodEnd - 1,
          limit: 500,
        },
        {
          kinds: [GIT_COMMENT],
          '#q': plan.repositoryAddresses,
          since: periodStart,
          until: periodEnd - 1,
          limit: 500,
        },
      ]),
    }))
    requireRepositoryCoverage(
      config.repositories.map((repository) => repository.address),
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

    const fallbackHandler = getFallbackHandlerTemplate(config.manageUrl)
    if (repositoryEvents.length === 0) {
      return normalizeDigest(
        config,
        userPubkey,
        [],
        [],
        new Map(),
        fallbackHandler,
        periodStart,
        periodEnd
      )
    }

    const eventsByRepository = new Map<string, NostrEvent[]>()
    for (const item of repositoryEvents) {
      const events = eventsByRepository.get(item.repositoryAddress) || []
      events.push(item.event)
      eventsByRepository.set(item.repositoryAddress, events)
    }

    const rootPlansByRelay = new Map<
      string,
      { relay: string; repositoryAddresses: Set<string>; ids: Set<string> }
    >()
    const rootRepositoryAddresses = new Set<string>()
    for (const repository of config.repositories) {
      const ids = new Set(
        (eventsByRepository.get(repository.address) || []).flatMap((event) => {
          const root = getRootId(event)
          return root ? [root] : []
        })
      )
      if (ids.size > 0) rootRepositoryAddresses.add(repository.address)
      for (const relay of repository.relays) {
        const plan = rootPlansByRelay.get(relay) || {
          relay,
          repositoryAddresses: new Set<string>(),
          ids: new Set<string>(),
        }
        if (ids.size > 0) plan.repositoryAddresses.add(repository.address)
        for (const id of ids) plan.ids.add(id)
        rootPlansByRelay.set(relay, plan)
      }
    }
    const rootPlans = [...rootPlansByRelay.values()]
      .filter(({ ids }) => ids.size > 0)
      .sort((a, b) => a.relay.localeCompare(b.relay))
      .map((plan) => ({
        relay: plan.relay,
        repositoryAddresses: [...plan.repositoryAddresses].sort(),
        ids: [...plan.ids].sort(),
      }))
    const rootResponses = await mapConcurrent(rootPlans, 6, async (plan) => ({
      plan,
      result: await query(this.pool, plan.relay, [{ ids: plan.ids, limit: plan.ids.length }]),
    }))
    requireRepositoryCoverage([...rootRepositoryAddresses], rootResponses, 'root')
    const contextEvents = rootResponses.flatMap(({ result }) => result.events)

    const preliminary = normalizeDigest(
      config,
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
      ...new Set([...repositoryEvents.map(({ event }) => event), ...contextEvents].map((event) => event.pubkey)),
    ]
    const declaredRelays = plans.map((plan) => plan.relay)
    const profileEvents = (
      await mapConcurrent(declaredRelays, 6, (relay) =>
        query(this.pool, relay, [{ kinds: [0], authors, limit: authors.length }])
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
      const [handlerKind, handlerPubkey, ...handlerId] = config.handler.address.split(':')
      handlerEvents = (
        await query(this.pool, config.handler.relay, [
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
    const handler = selectHandlerTemplate(handlerEvents, config.manageUrl)

    return normalizeDigest(
      config,
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
