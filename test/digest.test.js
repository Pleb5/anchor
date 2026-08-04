import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GIT_COMMENT,
  GIT_ISSUE,
  GIT_LABEL,
  GIT_STATUS_OPEN,
  attributeRepositoryAddresses,
  buildBudabitLink,
  buildRelayRepositoryPlans,
  getFallbackHandlerTemplate,
  normalizeDigest,
  requireRepositoryCoverage,
  selectHandlerTemplate,
} from '../dist/digest.js'
import { PUBKEY, REPO_ADDRESS, config, nostrEvent } from './helpers.js'

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
  const assignment = nostrEvent(
    GIT_LABEL,
    '4',
    113,
    [
      ['a', REPO_ADDRESS],
      ['E', root.id],
      ['L', 'org.nostr.git.role'],
      ['l', 'assignee', 'org.nostr.git.role'],
      ['p', PUBKEY],
    ]
  )
  const review = nostrEvent(
    GIT_LABEL,
    '5',
    114,
    [
      ['a', REPO_ADDRESS],
      ['E', root.id],
      ['L', 'org.nostr.git.role'],
      ['l', 'reviewer', 'org.nostr.git.role'],
      ['p', PUBKEY],
    ]
  )
  const deletedAssignment = nostrEvent(
    GIT_LABEL,
    '6',
    115,
    [
      ['a', REPO_ADDRESS],
      ['E', root.id],
      ['L', 'org.nostr.git.role'],
      ['l', 'assignee', 'org.nostr.git.role', 'del'],
      ['p', PUBKEY],
    ]
  )
  const status = nostrEvent(
    GIT_STATUS_OPEN,
    '7',
    116,
    [
      ['a', REPO_ADDRESS],
      ['E', root.id],
    ]
  )
  const selfAuthored = nostrEvent(
    GIT_ISSUE,
    '8',
    117,
    [['a', REPO_ADDRESS]],
    'Own issue',
    PUBKEY
  )

  const wrapped = [root, second, comment, comment, assignment, review, deletedAssignment, status, selfAuthored].map(
    (event) => ({ repositoryAddress: REPO_ADDRESS, event })
  )
  const digest = normalizeDigest(
    config(),
    PUBKEY,
    wrapped,
    [root, second],
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
    [issue],
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
    [],
    new Map(),
    'https://budabit.example/<repo_naddr>/<section>/<id>',
    100,
    200
  )
  assert.equal(digest.eventCount, 60)
  assert.equal(digest.repositories[0].rows.length, 50)
  assert.equal(digest.overflow, 10)
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
  assert.deepEqual(
    attributeRepositoryAddresses(direct, [REPO_ADDRESS, secondAddress]),
    [REPO_ADDRESS]
  )
  const qComment = nostrEvent(GIT_COMMENT, 'a', 121, [['q', secondAddress]])
  assert.deepEqual(
    attributeRepositoryAddresses(qComment, [REPO_ADDRESS, secondAddress]),
    [secondAddress]
  )

  const fallback = getFallbackHandlerTemplate(config().manageUrl)
  assert.equal(fallback, 'https://budabit.example/git/<repo_naddr>/<section>/<id>')
  assert.match(buildBudabitLink(fallback, first, direct), /^https:\/\/budabit\.example\/git\//)
  assert.equal(selectHandlerTemplate([], config().manageUrl), fallback)
  assert.equal(
    selectHandlerTemplate(
      [
        {
          ...nostrEvent(31990, 'b', 122, [], ''),
          tags: [['web', 'https://handler.example/<repo_naddr>/<section>/<id>']],
        },
      ],
      config().manageUrl
    ),
    'https://handler.example/<repo_naddr>/<section>/<id>'
  )
  assert.equal(
    selectHandlerTemplate(
      [{ ...nostrEvent(31990, 'c', 123, [], ''), tags: [['web', 'http://unsafe.example/']] }],
      config().manageUrl
    ),
    fallback
  )
})

test('handler selection rejects templates that cannot deep-link to an item', () => {
  const manageUrl = 'https://budabit.example/settings/notifications'
  const incomplete = nostrEvent(31990, 'd', 124, [
    ['web', 'https://budabit.example/git/<repo_naddr>/<section>'],
  ])
  const complete = nostrEvent(31990, 'e', 125, [
    ['web', 'https://budabit.example/git/<repo_naddr>/<section>/<id>'],
  ])

  assert.equal(
    selectHandlerTemplate([incomplete], manageUrl),
    'https://budabit.example/git/<repo_naddr>/<section>/<id>'
  )
  assert.equal(
    selectHandlerTemplate([complete], manageUrl),
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
