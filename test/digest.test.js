import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import {
  GIT_COMMENT,
  GIT_ISSUE,
  GIT_LABEL,
  GIT_PULL_REQUEST,
  GIT_PULL_REQUEST_UPDATE,
  GIT_REACTION,
  GIT_STATUS_OPEN,
  GIT_ZAP_RECEIPT,
  DigestCollector,
  attributeRepositoryAddresses,
  buildRepositoryAnnouncementFilters,
  buildRepositoryEngagementFilters,
  buildRepositoryPrimaryFilters,
  buildBudabitLink,
  buildRelayRepositoryPlans,
  getFallbackHandlerTemplate,
  normalizeDigest,
  requireRepositoryCoverage,
  repositoryAnnouncementRelays,
  selectRepositoryAnnouncement,
  resolveAcceptedRepositoryEvents,
  selectHandlerTemplate,
} from '../dist/digest.js'
import {
  PUBKEY,
  REPO_ADDRESS,
  REPO_ANNOUNCEMENT,
  REPO_SECRET,
  config,
  nostrEvent,
  repositoryAnnouncement,
  repositoryDeletion,
} from './helpers.js'

const handlerSecret = generateSecretKey()
const handlerPubkey = getPublicKey(handlerSecret)
const handlerAddress = `31990:${handlerPubkey}:budabit`
const handlerEvent = (created_at, web, identifier = 'budabit') =>
  finalizeEvent(
    {
      kind: 31990,
      created_at,
      content: '',
      tags: [
        ['d', identifier],
        ['web', web],
      ],
    },
    handlerSecret
  )

const actorSecret = generateSecretKey()
const actorPubkey = getPublicKey(actorSecret)
const zapServiceSecret = generateSecretKey()
const recipientPubkey = getPublicKey(generateSecretKey())
const signedEvent = (secret, kind, created_at, tags = [], content = '') =>
  finalizeEvent({ kind, created_at, tags, content }, secret)

const zapReceipt = (createdAt, request, tags = []) =>
  signedEvent(zapServiceSecret, GIT_ZAP_RECEIPT, createdAt, [
    ...tags,
    ['p', recipientPubkey],
    ['bolt11', 'lnbc1invalidbutpresent'],
    ['description', JSON.stringify(request)],
  ])

test('digest grouping deduplicates, applies options, recognizes only assignments, and excludes self', () => {
  const root = nostrEvent(GIT_ISSUE, '1', 110, [['a', REPO_ADDRESS]], 'First issue')
  const second = nostrEvent(GIT_ISSUE, '2', 111, [['a', REPO_ADDRESS]], 'Second issue')
  const comment = nostrEvent(
    GIT_COMMENT,
    '3',
    112,
    [
      ['a', REPO_ADDRESS],
      ['E', root.id],
    ],
    'A useful comment'
  )
  const assignment = nostrEvent(GIT_LABEL, '4', 113, [
    ['a', REPO_ADDRESS],
    ['E', root.id],
    ['L', 'org.nostr.git.role'],
    ['l', 'assignee', 'org.nostr.git.role'],
    ['p', PUBKEY],
  ])
  const review = nostrEvent(GIT_LABEL, '5', 114, [
    ['a', REPO_ADDRESS],
    ['E', root.id],
    ['L', 'org.nostr.git.role'],
    ['l', 'reviewer', 'org.nostr.git.role'],
    ['p', PUBKEY],
  ])
  const deletedAssignment = nostrEvent(GIT_LABEL, '6', 115, [
    ['a', REPO_ADDRESS],
    ['E', root.id],
    ['L', 'org.nostr.git.role'],
    ['l', 'assignee', 'org.nostr.git.role', 'del'],
    ['p', PUBKEY],
  ])
  const status = nostrEvent(GIT_STATUS_OPEN, '7', 116, [
    ['a', REPO_ADDRESS],
    ['E', root.id],
  ])
  const selfAuthored = nostrEvent(GIT_ISSUE, '8', 117, [['a', REPO_ADDRESS]], 'Own issue', PUBKEY)

  const wrapped = [
    root,
    second,
    comment,
    comment,
    assignment,
    review,
    deletedAssignment,
    status,
    selfAuthored,
  ].map((event) => ({ repositoryAddress: REPO_ADDRESS, event }))
  const digest = normalizeDigest(
    config(),
    PUBKEY,
    wrapped,
    [REPO_ANNOUNCEMENT, root, second],
    new Map(),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )

  assert.equal(digest.eventCount, 5)
  assert.equal(digest.attentionCount, 1)
  assert.equal(digest.attention.length, 1)
  assert.match(digest.attention[0].summary, /Assigned to you/)
  assert.match(digest.attention[0].summary, /1 comment/)
  assert.match(digest.attention[0].summary, /Status: Open/)
  assert.equal(digest.repositories.length, 1)
  assert.equal(digest.repositories[0].rows.length, 1)
  assert.equal(digest.repositories[0].rows[0].title, 'Second issue')
})

test('issue activity compacts comments and statuses under one root row without losing counts', () => {
  const issue = nostrEvent(GIT_ISSUE, '9', 110, [['a', REPO_ADDRESS]], 'Compact issue')
  const comments = ['a', 'b', 'c'].map((seed, index) =>
    nostrEvent(
      GIT_COMMENT,
      seed,
      111 + index,
      [
        ['a', REPO_ADDRESS],
        ['E', issue.id],
      ],
      `Comment ${index + 1}`
    )
  )
  const status = nostrEvent(GIT_STATUS_OPEN, 'd', 114, [
    ['a', REPO_ADDRESS],
    ['E', issue.id],
  ])
  const digest = normalizeDigest(
    config(),
    PUBKEY,
    [issue, ...comments, status].map((event) => ({ repositoryAddress: REPO_ADDRESS, event })),
    [REPO_ANNOUNCEMENT, issue],
    new Map(),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )

  assert.equal(digest.eventCount, 5)
  assert.deepEqual(digest.repositories[0].counts, {
    newItems: 1,
    comments: 3,
    updates: 0,
    statuses: 1,
    assignments: 0,
    reactions: 0,
    zaps: 0,
    zapSats: 0,
    zapsWithAmount: 0,
    total: 5,
  })
  assert.equal(digest.repositories[0].rows.length, 1)
  assert.equal(digest.repositories[0].rows[0].title, 'Compact issue')
  assert.equal(digest.repositories[0].rows[0].summary, 'New issue | 3 comments | Status: Open')
  assert.equal(digest.repositories[0].rows[0].eventCount, 5)
})

test('digest rendering caps grouped rows at 50 and reports overflow', () => {
  const events = Array.from({ length: 60 }, (_, index) => ({
    repositoryAddress: REPO_ADDRESS,
    event: {
      ...nostrEvent(GIT_ISSUE, 'a', 110 + index, [['a', REPO_ADDRESS]], `Issue ${index}`),
      id: index.toString(16).padStart(64, '0'),
    },
  }))
  const digest = normalizeDigest(
    config(),
    PUBKEY,
    events,
    [REPO_ANNOUNCEMENT],
    new Map(),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )
  assert.equal(digest.eventCount, 60)
  assert.equal(digest.repositories[0].rows.length, 50)
  assert.equal(digest.overflow, 10)
})

test('accepted repository engagement compacts reactions and valid zaps under an issue root', () => {
  const issue = nostrEvent(GIT_ISSUE, '1', 90, [['a', REPO_ADDRESS]], 'Accepted issue')
  const comment = nostrEvent(
    GIT_COMMENT,
    '2',
    95,
    [
      ['a', REPO_ADDRESS],
      ['E', issue.id],
    ],
    'Accepted comment'
  )
  const reaction = signedEvent(actorSecret, GIT_REACTION, 110, [['e', comment.id]], '+')
  const request = signedEvent(actorSecret, 9734, 109, [
    ['p', recipientPubkey],
    ['relays', 'wss://relay.example'],
    ['e', comment.id],
  ])
  const receipt = zapReceipt(111, request, [['e', comment.id]])
  const digestConfig = config({
    repositories: [
      {
        ...config().repositories[0],
        options: {
          ...config().repositories[0].options,
          issues: { new: false, comments: false },
          prs: { new: false, comments: false, updates: false },
          status: { open: false, draft: false, applied: false, closed: false },
          assignments: false,
        },
      },
    ],
  })
  const data = normalizeDigest(
    digestConfig,
    PUBKEY,
    [reaction, receipt].map((event) => ({ repositoryAddress: REPO_ADDRESS, event })),
    [REPO_ANNOUNCEMENT, issue, comment],
    new Map([[actorPubkey, 'Contributor']]),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )
  assert.equal(data.eventCount, 2)
  assert.equal(data.repositories[0].rows.length, 1)
  assert.equal(data.repositories[0].rows[0].title, 'Accepted issue')
  assert.equal(data.repositories[0].rows[0].summary, '1 reaction | 1 zap')
  assert.equal(data.repositories[0].rows[0].author, 'Contributor')
  assert.deepEqual(data.repositories[0].counts, {
    newItems: 0,
    comments: 0,
    updates: 0,
    statuses: 0,
    assignments: 0,
    reactions: 1,
    zaps: 1,
    zapSats: 0,
    zapsWithAmount: 0,
    total: 2,
  })
})

test('direct repository engagement is accepted while orphan and cross-repository refs are omitted', () => {
  const issue = nostrEvent(GIT_ISSUE, '3', 90, [['a', REPO_ADDRESS]], 'Issue')
  const direct = signedEvent(actorSecret, GIT_REACTION, 110, [['a', REPO_ADDRESS]], '+')
  const directRequest = signedEvent(actorSecret, 9734, 109, [
    ['p', recipientPubkey],
    ['relays', 'wss://relay.example'],
    ['a', REPO_ADDRESS],
  ])
  const directZap = zapReceipt(110, directRequest, [['a', REPO_ADDRESS]])
  const directQ = signedEvent(actorSecret, GIT_REACTION, 110, [['q', REPO_ADDRESS]], '+')
  const directQRequest = signedEvent(actorSecret, 9734, 109, [
    ['p', recipientPubkey],
    ['relays', 'wss://relay.example'],
    ['q', REPO_ADDRESS],
  ])
  const directQZap = zapReceipt(110, directQRequest, [['q', REPO_ADDRESS]])
  const resolvable = signedEvent(actorSecret, GIT_REACTION, 111, [['e', issue.id]], '+')
  const orphan = signedEvent(actorSecret, GIT_REACTION, 112, [['e', '9'.repeat(64)]], '+')
  const otherRepository = `30617:${'f'.repeat(64)}:other`
  const cross = signedEvent(
    actorSecret,
    GIT_REACTION,
    113,
    [
      ['a', REPO_ADDRESS],
      ['A', otherRepository],
    ],
    '+'
  )
  const uppercaseOnly = signedEvent(actorSecret, GIT_REACTION, 114, [['A', REPO_ADDRESS]], '+')
  const accepted = resolveAcceptedRepositoryEvents(
    REPO_ADDRESS,
    [direct, directZap, directQ, directQZap, resolvable, orphan, cross, uppercaseOnly],
    [REPO_ANNOUNCEMENT, issue]
  )
  assert.deepEqual(
    new Set(accepted.map(({ event }) => event.id)),
    new Set([direct.id, directZap.id, directQ.id, directQZap.id, resolvable.id])
  )

  const data = normalizeDigest(
    config(),
    PUBKEY,
    [direct, directZap, directQ, directQZap, resolvable, orphan, cross, uppercaseOnly].map(
      (event) => ({
        repositoryAddress: REPO_ADDRESS,
        event,
      })
    ),
    [REPO_ANNOUNCEMENT, issue],
    new Map(),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )
  assert.equal(data.eventCount, 5)
  assert.equal(data.repositories[0].counts.reactions, 3)
  assert.equal(data.repositories[0].counts.zaps, 2)
  assert.equal(data.repositories[0].rows.length, 2)
})

test('mismatched, invalid, and subscriber-authored zap requests are omitted', () => {
  const issue = nostrEvent(GIT_ISSUE, '4', 90, [['a', REPO_ADDRESS]], 'Issue')
  const validRequest = signedEvent(actorSecret, 9734, 100, [
    ['p', recipientPubkey],
    ['relays', 'wss://relay.example'],
    ['a', REPO_ADDRESS],
    ['e', issue.id],
  ])
  const mismatch = zapReceipt(110, validRequest, [['a', REPO_ADDRESS]])
  const invalid = {
    ...zapReceipt(111, validRequest, [
      ['a', REPO_ADDRESS],
      ['e', issue.id],
    ]),
    sig: '0'.repeat(128),
  }
  const recipientMismatch = signedEvent(zapServiceSecret, GIT_ZAP_RECEIPT, 112, [
    ['a', REPO_ADDRESS],
    ['e', issue.id],
    ['p', 'e'.repeat(64)],
    ['bolt11', 'lnbc1invalidbutpresent'],
    ['description', JSON.stringify(validRequest)],
  ])
  const selfRequestSecret = generateSecretKey()
  const selfPubkey = getPublicKey(selfRequestSecret)
  const selfRequest = signedEvent(selfRequestSecret, 9734, 102, [
    ['p', recipientPubkey],
    ['relays', 'wss://relay.example'],
    ['a', REPO_ADDRESS],
  ])
  const selfReceipt = zapReceipt(112, selfRequest, [['a', REPO_ADDRESS]])
  const data = normalizeDigest(
    config(),
    selfPubkey,
    [mismatch, invalid, recipientMismatch, selfReceipt].map((event) => ({
      repositoryAddress: REPO_ADDRESS,
      event,
    })),
    [REPO_ANNOUNCEMENT, issue],
    new Map(),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )
  assert.equal(data.eventCount, 0)
})

test('repository engagement options disable selection without conflating reviews', () => {
  const reaction = signedEvent(actorSecret, GIT_REACTION, 110, [['a', REPO_ADDRESS]], '+')
  const disabled = config({
    repositories: [
      {
        ...config().repositories[0],
        options: {
          ...config().repositories[0].options,
          engagement: { reactions: false, zaps: false },
        },
      },
    ],
  })
  const data = normalizeDigest(
    disabled,
    PUBKEY,
    [{ repositoryAddress: REPO_ADDRESS, event: reaction }],
    [REPO_ANNOUNCEMENT],
    new Map(),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )
  assert.equal(data.eventCount, 0)
  assert.deepEqual(data.repositories, [])
})

test('repository relay filters query direct and root-linked engagement only on repository plans', () => {
  const primary = buildRepositoryPrimaryFilters([REPO_ADDRESS], 100, 200)
  const direct = primary[0]
  assert.ok(direct.kinds.includes(GIT_REACTION))
  assert.ok(direct.kinds.includes(GIT_ZAP_RECEIPT))
  assert.ok(direct.kinds.includes(GIT_ISSUE))
  assert.ok(!direct.kinds.includes(9734))
  assert.deepEqual(direct['#a'], [REPO_ADDRESS])
  assert.deepEqual(primary[1]['#q'], [REPO_ADDRESS])
  assert.deepEqual(primary[1].kinds, [GIT_REACTION, GIT_COMMENT, GIT_ZAP_RECEIPT])
  assert.ok(primary.every((filter) => !filter.kinds.includes(9734)))
  const followups = buildRepositoryEngagementFilters(['1'.repeat(64)], 100, 200)
  assert.deepEqual(
    followups.map((filter) => Object.keys(filter).find((key) => ['#e', '#E', '#q'].includes(key))),
    ['#e', '#E', '#q']
  )
  assert.ok(followups.every((filter) => !filter.kinds.includes(9734)))
})

test('repository acceptance is announcement-seeded and enforces pull-request structures', () => {
  const orphan = nostrEvent(GIT_ISSUE, '6', 110, [['a', REPO_ADDRESS]], 'Orphan issue')
  assert.deepEqual(resolveAcceptedRepositoryEvents(REPO_ADDRESS, [orphan], []), [])

  const pullRequest = nostrEvent(
    GIT_PULL_REQUEST,
    '7',
    111,
    [
      ['a', REPO_ADDRESS],
      ['c', 'tip-one'],
    ],
    'Valid PR'
  )
  const update = nostrEvent(GIT_PULL_REQUEST_UPDATE, '8', 112, [
    ['a', REPO_ADDRESS],
    ['E', pullRequest.id],
    ['P', pullRequest.pubkey],
    ['c', 'tip-two'],
  ])
  const missingCommit = nostrEvent(GIT_PULL_REQUEST, '9', 113, [['a', REPO_ADDRESS]])
  const duplicateCommit = nostrEvent(GIT_PULL_REQUEST, 'b', 114, [
    ['a', REPO_ADDRESS],
    ['c', 'one'],
    ['c', 'two'],
  ])
  const wrongAuthor = nostrEvent(GIT_PULL_REQUEST_UPDATE, 'c', 115, [
    ['a', REPO_ADDRESS],
    ['E', pullRequest.id],
    ['P', 'f'.repeat(64)],
    ['c', 'tip-three'],
  ])
  const duplicateRoot = nostrEvent(GIT_PULL_REQUEST_UPDATE, 'd', 116, [
    ['a', REPO_ADDRESS],
    ['E', pullRequest.id],
    ['E', orphan.id],
    ['P', pullRequest.pubkey],
    ['c', 'tip-four'],
  ])
  const missingRepository = nostrEvent(GIT_PULL_REQUEST_UPDATE, 'e', 117, [
    ['E', pullRequest.id],
    ['P', pullRequest.pubkey],
    ['c', 'tip-five'],
  ])
  const accepted = resolveAcceptedRepositoryEvents(
    REPO_ADDRESS,
    [
      pullRequest,
      update,
      missingCommit,
      duplicateCommit,
      wrongAuthor,
      duplicateRoot,
      missingRepository,
    ],
    [REPO_ANNOUNCEMENT]
  )
  assert.deepEqual(
    new Set(accepted.map(({ event }) => event.id)),
    new Set([pullRequest.id, update.id])
  )
})

test('status and permalink admission requires policy-specific reference kinds', () => {
  const issue = nostrEvent(GIT_ISSUE, '1a', 100, [['a', REPO_ADDRESS]], 'Issue')
  const comment = nostrEvent(GIT_COMMENT, '1b', 101, [['e', issue.id]], 'Comment')
  const statusViaComment = nostrEvent(GIT_STATUS_OPEN, '1c', 110, [['e', comment.id]])
  const statusViaIssue = nostrEvent(GIT_STATUS_OPEN, '1d', 111, [['e', issue.id]])
  const permalinkViaQ = nostrEvent(1623, '1e', 112, [['q', issue.id]])
  const permalinkViaE = nostrEvent(1623, '1f', 113, [['e', issue.id]])

  const accepted = resolveAcceptedRepositoryEvents(
    REPO_ADDRESS,
    [statusViaComment, statusViaIssue, permalinkViaQ, permalinkViaE],
    [REPO_ANNOUNCEMENT, issue, comment]
  )
  assert.deepEqual(
    new Set(accepted.map(({ event }) => event.id)),
    new Set([statusViaIssue.id, permalinkViaE.id])
  )
})

test('cross-repository event references are rejected across scoped context graphs', () => {
  const secondSecret = generateSecretKey()
  const secondPubkey = getPublicKey(secondSecret)
  const secondAddress = `30617:${secondPubkey}:second`
  const secondAnnouncement = signedEvent(secondSecret, 30617, 80, [
    ['d', 'second'],
    ['relays', 'wss://second.example'],
  ])
  const firstIssue = nostrEvent(GIT_ISSUE, '2', 90, [['a', REPO_ADDRESS]], 'First')
  const secondIssue = nostrEvent(GIT_ISSUE, '3', 90, [['a', secondAddress]], 'Second')
  const cross = signedEvent(
    actorSecret,
    GIT_REACTION,
    110,
    [
      ['e', firstIssue.id],
      ['q', secondIssue.id],
    ],
    '+'
  )
  const digestConfig = config({
    repositories: [
      config().repositories[0],
      {
        ...config().repositories[0],
        address: secondAddress,
        name: 'Second',
        relays: ['wss://second.example/'],
      },
    ],
  })

  const data = normalizeDigest(
    digestConfig,
    PUBKEY,
    [{ repositoryAddress: REPO_ADDRESS, event: cross }],
    [
      { repositoryAddress: REPO_ADDRESS, event: REPO_ANNOUNCEMENT },
      { repositoryAddress: REPO_ADDRESS, event: firstIssue },
      { repositoryAddress: secondAddress, event: secondAnnouncement },
      { repositoryAddress: secondAddress, event: secondIssue },
    ],
    new Map(),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )
  assert.equal(data.eventCount, 0)
})

test('announcement selection is exact, signature-valid, and deterministic', () => {
  const older = repositoryAnnouncement(70, ['wss://older.example'])
  const tiedOne = repositoryAnnouncement(80, ['wss://one.example'])
  const tiedTwo = repositoryAnnouncement(80, ['wss://two.example'])
  const invalid = { ...repositoryAnnouncement(90), sig: '0'.repeat(128) }
  const duplicateIdentifier = signedEvent(REPO_SECRET, 30617, 90, [
    ['d', 'anchor'],
    ['d', 'anchor'],
    ['relays', 'wss://repo.example'],
  ])
  const expected = [tiedOne, tiedTwo].sort((a, b) => a.id.localeCompare(b.id))[0]
  assert.equal(
    selectRepositoryAnnouncement(
      [invalid, duplicateIdentifier, tiedTwo, older, tiedOne],
      REPO_ADDRESS
    ).id,
    expected.id
  )
  const filters = buildRepositoryAnnouncementFilters(REPO_ADDRESS)
  assert.deepEqual(filters[0].kinds, [30617])
  assert.deepEqual(filters[0].authors, [REPO_ANNOUNCEMENT.pubkey])
  assert.deepEqual(filters[0]['#d'], ['anchor'])
  assert.deepEqual(repositoryAnnouncementRelays(tiedOne), ['wss://one.example/'])
  assert.throws(
    () =>
      repositoryAnnouncementRelays(
        repositoryAnnouncement(
          90,
          Array.from({ length: 21 }, (_, index) => `wss://relay-${index}.example`)
        )
      ),
    /more than 20 relays/
  )

  const deletedMarker = signedEvent(REPO_SECRET, 30617, 100, [
    ['d', 'anchor'],
    ['relays', 'wss://repo.example'],
    ['deleted'],
  ])
  const issue = nostrEvent(GIT_ISSUE, 'f', 110, [['a', REPO_ADDRESS]])
  assert.deepEqual(resolveAcceptedRepositoryEvents(REPO_ADDRESS, [issue], [deletedMarker]), [])
})

test('collector preflights on lookup hints and isolates all repository queries to announcement relays', async () => {
  const lookupRelay = config().repositories[0].relays[0]
  const authoritativeRelay = 'wss://repo.example/'
  const announcement = repositoryAnnouncement(80, [authoritativeRelay])
  const issue = nostrEvent(GIT_ISSUE, 'e', 110, [['a', REPO_ADDRESS]], 'Collected issue')
  const calls = []
  const collector = new DigestCollector(async (relay, filters) => {
    calls.push({ relay, filters })
    if (relay === lookupRelay) {
      if (filters.some((filter) => filter.kinds?.includes(30617))) {
        return { relay, events: [announcement], eose: true }
      }
      if (filters.every((filter) => filter.kinds?.includes(5))) {
        return { relay, events: [], eose: true }
      }
      throw new Error('lookup relay received an activity query')
    }
    if (relay === authoritativeRelay) {
      const events = filters.some((filter) => filter['#a']) ? [issue] : []
      return { relay, events, eose: true }
    }
    if (relay === config().handler.relay) return { relay, events: [], eose: true }
    throw new Error(`unexpected relay ${relay}`)
  })

  const data = await collector.collect(config(), PUBKEY, 100, 200)
  await collector.close()
  assert.equal(data.eventCount, 1)
  assert.ok(
    calls
      .filter((call) => call.relay === lookupRelay)
      .every((call) =>
        call.filters.every((filter) => filter.kinds.every((kind) => [5, 30617].includes(kind)))
      )
  )
  assert.ok(
    calls.some(
      (call) => call.relay === authoritativeRelay && call.filters.some((filter) => filter['#a'])
    )
  )
  assert.ok(
    calls.every((call) =>
      call.filters.every((filter) => !filter.kinds || !filter.kinds.includes(9734))
    )
  )
})

test('collector rejects missing and deleted announcements before repository activity', async () => {
  const lookupRelay = config().repositories[0].relays[0]
  const announcement = repositoryAnnouncement(80)

  const missingCalls = []
  const missingCollector = new DigestCollector(async (relay, filters) => {
    missingCalls.push({ relay, filters })
    return { relay, events: [], eose: true }
  })
  await assert.rejects(
    missingCollector.collect(config(), PUBKEY, 100, 200),
    /Missing accepted repository announcement/
  )
  await missingCollector.close()
  assert.ok(missingCalls.every((call) => call.relay === lookupRelay))

  const deletedCalls = []
  const deletion = repositoryDeletion(90)
  const deletedCollector = new DigestCollector(async (relay, filters) => {
    deletedCalls.push({ relay, filters })
    const events = filters.some((filter) => filter.kinds?.includes(30617))
      ? [announcement]
      : filters.some((filter) => filter.kinds?.includes(5))
        ? [deletion]
        : []
    return { relay, events, eose: true }
  })
  await assert.rejects(
    deletedCollector.collect(config(), PUBKEY, 100, 200),
    /Deleted repository announcement/
  )
  await deletedCollector.close()
  assert.ok(deletedCalls.every((call) => call.relay === lookupRelay))
})

test('collector ignores announcements returned by incomplete lookup responses', async () => {
  const lookupRelays = ['wss://partial.example/', 'wss://complete.example/']
  const digestConfig = config({
    repositories: [{ ...config().repositories[0], relays: lookupRelays }],
  })
  const collector = new DigestCollector(async (relay) => ({
    relay,
    events: relay === lookupRelays[0] ? [repositoryAnnouncement(80)] : [],
    eose: relay === lookupRelays[1],
  }))

  await assert.rejects(
    collector.collect(digestConfig, PUBKEY, 100, 200),
    /Missing accepted repository announcement/
  )
  await collector.close()
})

test('relay plans batch shared relays and preserve address/q attribution', () => {
  const secondAddress = `30617:${'f'.repeat(64)}:second`
  const first = {
    ...config().repositories[0],
    relays: ['wss://one.example/', 'wss://shared.example/'],
  }
  const second = {
    ...config().repositories[0],
    address: secondAddress,
    name: 'Second',
    relays: ['wss://shared.example/', 'wss://two.example/'],
  }
  assert.deepEqual(buildRelayRepositoryPlans([first, second]), [
    { relay: 'wss://one.example/', repositoryAddresses: [REPO_ADDRESS] },
    {
      relay: 'wss://shared.example/',
      repositoryAddresses: [REPO_ADDRESS, secondAddress].sort(),
    },
    { relay: 'wss://two.example/', repositoryAddresses: [secondAddress] },
  ])

  const direct = nostrEvent(GIT_ISSUE, '9', 120, [['a', REPO_ADDRESS]])
  assert.deepEqual(attributeRepositoryAddresses(direct, [REPO_ADDRESS, secondAddress]), [
    REPO_ADDRESS,
  ])
  const qComment = nostrEvent(GIT_COMMENT, 'a', 121, [['q', secondAddress]])
  assert.deepEqual(attributeRepositoryAddresses(qComment, [REPO_ADDRESS, secondAddress]), [
    secondAddress,
  ])

  const fallback = getFallbackHandlerTemplate(config().manageUrl)
  assert.equal(fallback, 'https://budabit.example/git/<repo_naddr>/<section>/<id>')
  assert.match(buildBudabitLink(fallback, first, direct), /^https:\/\/budabit\.example\/git\//)
  assert.equal(selectHandlerTemplate([], config().manageUrl, handlerAddress), fallback)
  assert.equal(
    selectHandlerTemplate(
      [handlerEvent(122, 'https://handler.example/<repo_naddr>/<section>/<id>')],
      config().manageUrl,
      handlerAddress
    ),
    'https://handler.example/<repo_naddr>/<section>/<id>'
  )
  assert.equal(
    selectHandlerTemplate(
      [handlerEvent(123, 'http://unsafe.example/')],
      config().manageUrl,
      handlerAddress
    ),
    fallback
  )
})

test('handler selection rejects templates that cannot deep-link to an item', () => {
  const manageUrl = 'https://budabit.example/settings/notifications'
  const incomplete = handlerEvent(124, 'https://budabit.example/git/<repo_naddr>/<section>')
  const complete = handlerEvent(125, 'https://budabit.example/git/<repo_naddr>/<section>/<id>')

  assert.equal(
    selectHandlerTemplate([incomplete], manageUrl, handlerAddress),
    'https://budabit.example/git/<repo_naddr>/<section>/<id>'
  )
  assert.equal(
    selectHandlerTemplate([complete], manageUrl, handlerAddress),
    'https://budabit.example/git/<repo_naddr>/<section>/<id>'
  )
})

test('repository coverage accepts EOSE success, redundant success, and rejects incomplete coverage', () => {
  const repository = REPO_ADDRESS
  assert.doesNotThrow(() =>
    requireRepositoryCoverage(
      [repository],
      [{ plan: { repositoryAddresses: [repository] }, result: { eose: true } }],
      'primary'
    )
  )
  assert.doesNotThrow(() =>
    requireRepositoryCoverage(
      [repository],
      [
        { plan: { repositoryAddresses: [repository] }, result: { eose: false } },
        { plan: { repositoryAddresses: [repository] }, result: { eose: true } },
      ],
      'root'
    )
  )
  assert.throws(
    () =>
      requireRepositoryCoverage(
        [repository],
        [{ plan: { repositoryAddresses: [repository] }, result: { eose: false } }],
        'primary'
      ),
    /Incomplete primary relay coverage/
  )
})
