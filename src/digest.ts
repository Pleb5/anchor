import { neventEncode, decode } from 'nostr-tools/nip19'
import {
  spec,
  call,
  now,
  sortBy,
  groupBy,
  displayList,
  nth,
  nthEq,
  dateToSeconds,
  secondsToDate,
} from '@welshman/lib'
import { parse, truncate, renderAsHtml } from '@welshman/content'
import {
  TrustedEvent,
  getParentId,
  getIdFilters,
  getReplyFilters,
  displayProfile,
  displayPubkey,
  getTagValue,
  Address,
} from '@welshman/util'
import { Loader, AdapterContext, makeLoader, SocketAdapter } from '@welshman/net'
import { Router, addMinimalFallbacks } from '@welshman/router'
import {
  makeIntersectionFeed,
  simplifyFeed,
  Feed,
  makeCreatedAtFeed,
  makeUnionFeed,
  FeedController,
} from '@welshman/feeds'
import { getCronDate, displayDuration, createElement } from './util.js'
import { EmailAlert, getFormatter, getAlertSocket } from './alert.js'
import { sendDigest } from './mailer.js'
import {
  profilesByPubkey,
  loadRelaySelections,
  loadProfile,
  makeGetPubkeysForScope,
} from './repository.js'
import { appSigner } from './env.js'

type DigestData = {
  events: TrustedEvent[]
  context: TrustedEvent[]
}

const GIT_COMMENT = 1111
const GIT_LABEL = 1985
const GIT_PATCH = 1617
const GIT_PULL_REQUEST = 1618
const GIT_PULL_REQUEST_UPDATE = 1619
const GIT_ISSUE = 1621
const GIT_STATUS_OPEN = 1630
const GIT_STATUS_APPLIED = 1631
const GIT_STATUS_CLOSED = 1632
const GIT_STATUS_DRAFT = 1633

const REPO_KINDS = new Set([
  GIT_COMMENT,
  GIT_LABEL,
  GIT_PATCH,
  GIT_PULL_REQUEST,
  GIT_PULL_REQUEST_UPDATE,
  GIT_ISSUE,
  GIT_STATUS_OPEN,
  GIT_STATUS_APPLIED,
  GIT_STATUS_CLOSED,
  GIT_STATUS_DRAFT,
])

const PATCH_KINDS = new Set([GIT_PATCH, GIT_PULL_REQUEST, GIT_PULL_REQUEST_UPDATE])

export class Digest {
  authd = new Set<string>()
  since: number
  context: AdapterContext
  load: Loader
  feed: Feed

  constructor(readonly alert: EmailAlert) {
    this.since = dateToSeconds(getCronDate(alert.cron, -2))
    this.context = { getAdapter: (url: string) => new SocketAdapter(getAlertSocket(url, alert)) }
    this.load = makeLoader({ delay: 500, timeout: 5000, threshold: 0.8, context: this.context })
    this.feed = simplifyFeed(
      makeIntersectionFeed(makeCreatedAtFeed({ since: this.since }), makeUnionFeed(...alert.feeds))
    )
  }

  loadHandler = async () => {
    const defaultHandler = 'https://coracle.social/'
    const webHandlers = this.alert.handlers.filter(nthEq(3, 'web'))
    const filters = getIdFilters(webHandlers.map(nth(1)))
    const relays = webHandlers.map(nth(2))

    if (filters.length === 0 || relays.length === 0) {
      return defaultHandler
    }

    const events = await this.load({ relays, filters })
    const getTemplates = (e: TrustedEvent) => e.tags.filter(nthEq(0, 'web')).map(nth(1))
    const templates = events.flatMap((e) => getTemplates(e))

    return templates[0] || defaultHandler
  }

  loadData = async () => {
    console.log(`digest: loading relay selections for ${this.alert.address}`)

    await loadRelaySelections(this.alert.pubkey)

    const seen = new Set<string>()
    const events: TrustedEvent[] = []
    const context: TrustedEvent[] = []
    const promises: Promise<unknown>[] = []
    const ctrl = new FeedController({
      feed: this.feed,
      signer: appSigner,
      getPubkeysForScope: makeGetPubkeysForScope(this.alert.pubkey),
      getPubkeysForWOTRange: () => [],
      onEvent: (e) => {
        seen.add(e.id)
        events.push(e)
        context.push(e)

        promises.push(
          call(async () => {
            await loadRelaySelections(e.pubkey)
            await loadProfile(e.pubkey)

            const relays = Router.get().Replies(e).policy(addMinimalFallbacks).getUrls()
            const filters = getReplyFilters(events, { kinds: [GIT_COMMENT] })

            for (const reply of await this.load({
              relays,
              filters,
              signal: AbortSignal.timeout(1000),
            })) {
              if (!seen.has(reply.id)) {
                seen.add(reply.id)
                context.push(reply)
              }
            }
          })
        )
      },
      context: {
        getAdapter: (url: string) => new SocketAdapter(getAlertSocket(url, this.alert)),
      },
    })

    console.log(`digest: loading events for ${this.alert.address}`)

    await ctrl.load(1000)

    console.log(`digest: loading replies for ${this.alert.address}`)

    await Promise.all(promises)

    console.log(`digest: retrieved ${context.length} events for ${this.alert.address}`)

    return { events, context } as DigestData
  }

  buildParameters = async (data: DigestData) => {
    const getEventVariables = (event: TrustedEvent) => {
      const content = getDigestContent(event)

      return {
        Type: getTypeLabel(event),
        Link: buildLink(event, handler),
        Timestamp: formatter.format(secondsToDate(event.created_at)),
        Icon: profilesByPubkey.get().get(event.pubkey)?.picture,
        Name: displayProfileByPubkey(event.pubkey),
        Content: content,
        Replies: repliesByParentId.get(event.id)?.filter(spec({ kind: GIT_COMMENT }))?.length || 0,
      }
    }

    const { events, context } = data
    const formatter = getFormatter(this.alert)
    const handler = await this.loadHandler()
    const repliesByParentId = groupBy(getParentId, context)
    const eventsByPubkey = groupBy((e) => e.pubkey, events)
    const popular = sortBy((e) => -(repliesByParentId.get(e.id)?.length || 0), events).slice(0, 12)
    const topProfiles = sortBy(
      ([k, ev]) => -ev.length,
      Array.from(eventsByPubkey.entries()).filter(([k]) => profilesByPubkey.get().get(k))
    )

    return {
      Total: events.length,
      Duration: displayDuration(now() - this.since),
      Popular: popular.map((e) => getEventVariables(e)),
      HasPopular: popular.length > 0,
      TopProfiles: displayList(topProfiles.map(([pk]) => displayProfileByPubkey(pk))),
    }
  }

  send = async () => {
    const data = await this.loadData()

    if (data.events.length > 0) {
      await sendDigest(this.alert, await this.buildParameters(data))
    }

    return data.events.length > 0
  }
}

// Utilities

const applyTemplate = (template: string, replacements: Record<string, string>) => {
  let output = template
  for (const [key, value] of Object.entries(replacements)) {
    output = output.split(`<${key}>`).join(value)
  }
  return output
}

const getRepoAddress = (event: TrustedEvent) => {
  if (event.kind === GIT_COMMENT) {
    return getTagValue('repo', event.tags) || getTagValue('a', event.tags)
  }

  return getTagValue('a', event.tags)
}

const toRepoNaddr = (repoAddr: string) => {
  const [kindStr, pubkey, ...identifierParts] = repoAddr.split(':')
  const kind = Number.parseInt(kindStr, 10)
  if (!pubkey || identifierParts.length === 0 || Number.isNaN(kind)) {
    return ''
  }

  const identifier = identifierParts.join(':')
  try {
    return new Address(kind, pubkey, identifier).toNaddr()
  } catch {
    return ''
  }
}

const getGitSection = (event: TrustedEvent) => (PATCH_KINDS.has(event.kind) ? 'patches' : 'issues')

const buildGitLink = (event: TrustedEvent, handler: string) => {
  if (
    !handler.includes('<repo_naddr>') &&
    !handler.includes('<section>') &&
    !handler.includes('<id>')
  ) {
    return ''
  }

  const repoAddr = getRepoAddress(event)
  if (!repoAddr) return ''

  const repoNaddr = toRepoNaddr(repoAddr)
  if (!repoNaddr) return ''

  const section = getGitSection(event)
  return applyTemplate(handler, { repo_naddr: repoNaddr, section, id: event.id })
}

const buildLink = (event: TrustedEvent, handler: string) => {
  const gitLink = buildGitLink(event, handler)
  if (gitLink) return gitLink

  const relays = Router.get().Event(event).getUrls()
  const nevent = neventEncode({ ...event, relays })

  if (handler.includes('<bech32>')) {
    return handler.replace('<bech32>', nevent)
  } else {
    return handler + nevent
  }
}

const displayProfileByPubkey = (pubkey: string) =>
  displayProfile(profilesByPubkey.get().get(pubkey), displayPubkey(pubkey))

const renderEntity = (entity: string) => {
  let display = entity.slice(0, 16) + '…'

  try {
    const { type, data } = decode(entity)

    if (type === 'npub') {
      display = '@' + displayProfileByPubkey(data)
    }

    if (type === 'nprofile') {
      display = '@' + displayProfileByPubkey(data.pubkey)
    }
  } catch (e) {
    // Pass
  }

  return display
}

const getTypeLabel = (event: TrustedEvent) => {
  if (event.kind === GIT_ISSUE) return 'Issue'
  if (event.kind === GIT_PATCH) return 'Patch'
  if (event.kind === GIT_PULL_REQUEST) return 'Pull request'
  if (event.kind === GIT_PULL_REQUEST_UPDATE) return 'PR update'
  if (event.kind === GIT_STATUS_OPEN) return 'Status: open'
  if (event.kind === GIT_STATUS_APPLIED) return 'Status: applied'
  if (event.kind === GIT_STATUS_CLOSED) return 'Status: closed'
  if (event.kind === GIT_STATUS_DRAFT) return 'Status: draft'
  if (event.kind === GIT_LABEL) {
    const label = getTagValue('l', event.tags)
    if (label === 'assignee') return 'Assignment'
    if (label === 'reviewer') return 'Review request'
    return 'Label'
  }
  if (event.kind === GIT_COMMENT) return 'Comment'
  return 'Post'
}

const getDigestContent = (event: TrustedEvent) => {
  const isRepoKind = REPO_KINDS.has(event.kind)
  const summary = getRepoSummaryText(event)
  const content = summary || event.content || ''
  const parsed = truncate(
    parse({ ...event, content }),
    isRepoKind
      ? { minLength: 80, maxLength: 280, mediaLength: 0 }
      : { minLength: 400, maxLength: 800, mediaLength: 50 }
  )

  return renderAsHtml(parsed, { createElement, renderEntity }).toString()
}

const getRepoSummaryText = (event: TrustedEvent) => {
  if (!REPO_KINDS.has(event.kind)) return ''

  const content = (event.content || '').trim()
  if (!content) return ''

  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length === 0) return ''

  if (event.kind === GIT_PATCH || event.kind === GIT_PULL_REQUEST) {
    const subject = lines.find((line) => line.toLowerCase().startsWith('subject:'))
    if (subject) return subject.replace(/^subject:\s*/i, '')
    const first = lines.find((line) => !isPatchMetaLine(line))
    return first || lines[0]
  }

  return lines[0]
}

const isPatchMetaLine = (line: string) =>
  line.startsWith('diff --git') ||
  line.startsWith('index ') ||
  line.startsWith('+++') ||
  line.startsWith('---') ||
  line.startsWith('@@') ||
  line.startsWith('From ') ||
  line.startsWith('Date:') ||
  line.startsWith('Signed-off-by')
