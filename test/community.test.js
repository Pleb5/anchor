import test from 'node:test'
import assert from 'node:assert/strict'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'
import { Nip01Signer } from '@welshman/signer'
import {
  CommunityContext,
  buildCommunitySnapshot,
  buildProfileListQueryPlans,
  canManageSection,
  membershipFor,
  parseCommunityDefinition,
  requireCommunityEose,
} from '../dist/community.js'
import {
  CommunityDigestCollector,
  authorizeCommunityEvents,
  buildCommunityDiscoveryFilters,
  communityKindSubtype,
  getCommunityFallbackHandlerTemplate,
  getCommunityReferences,
  isRoomEvent,
  normalizeCommunityDigest,
  selectCommunityHandlerTemplate,
  wrapperReference,
} from '../dist/community-digest.js'
import { ActionError, SubscriptionService, getSubscriptionStatus } from '../dist/actions.js'
import { communityDescriptor, parseAnchorMode } from '../dist/mode.js'
import { communityConfig } from './helpers.js'

const communitySecret = generateSecretKey()
const serviceSecret = generateSecretKey()
const memberSecret = generateSecretKey()
const moderatorSecret = generateSecretKey()
const formOwnerSecret = generateSecretKey()
const missingOwnerSecret = generateSecretKey()
const otherSecret = generateSecretKey()
const bannedSecret = generateSecretKey()
const applicantSecret = generateSecretKey()
const communityPubkey = getPublicKey(communitySecret)
const servicePubkey = getPublicKey(serviceSecret)
const memberPubkey = getPublicKey(memberSecret)
const moderatorPubkey = getPublicKey(moderatorSecret)
const formOwnerPubkey = getPublicKey(formOwnerSecret)
const missingOwnerPubkey = getPublicKey(missingOwnerSecret)
const otherPubkey = getPublicKey(otherSecret)
const bannedPubkey = getPublicKey(bannedSecret)
const applicantPubkey = getPublicKey(applicantSecret)

const sign = (secret, kind, created_at, tags = [], content = '') =>
  finalizeEvent({ kind, created_at, tags, content }, secret)

const mode = {
  mode: 'community',
  communityPubkey,
  bootstrapRelays: ['wss://bootstrap.example/'],
  handlerAddress: `31990:${otherPubkey}:budabit`,
  handlerRelay: 'wss://handler.example/',
}
const descriptor = communityDescriptor(mode, servicePubkey, 'https://alerts.example')
const refs = {
  threads: `30000:${moderatorPubkey}:threads`,
  moderation: `30000:${moderatorPubkey}:moderation`,
  publishing: `30000:${formOwnerPubkey}:publishing`,
  calendar: `30000:${moderatorPubkey}:calendar`,
  absent: `30000:${missingOwnerPubkey}:absent`,
}

const definition = (createdAt = 100, service = descriptor) =>
  sign(communitySecret, 10222, createdAt, [
    ['r', 'wss://community.example'],
    [
      'service',
      'community-alerts',
      service.servicePubkey,
      service.requestRelay,
      service.handlerAddress,
      service.handlerRelay,
    ],
    ['p', otherPubkey, '', 'admin'],
    ['content', 'Conversations'],
    ['k', '9', 'room-message'],
    ['k', '11', 'room'],
    ['k', '11', 'threads'],
    ['k', '1111'],
    ['k', '7'],
    ['a', refs.threads, 'wss://delegated.example'],
    ['content', 'Moderation'],
    ['k', '1984'],
    ['k', '1985'],
    ['k', '5'],
    ['a', refs.moderation],
    ['content', 'Publishing'],
    ['a', refs.publishing],
    ['content', 'Calendar and goals'],
    ['k', '31922'],
    ['k', '31923'],
    ['k', '9041'],
    ['a', refs.calendar],
    ['content', 'Absent delegation'],
    ['k', '1234'],
    ['a', refs.absent],
  ])

const list = (secret, identifier, pubkeys, createdAt = 100) =>
  sign(secret, 30000, createdAt, [
    ['d', identifier],
    ...pubkeys.map((pubkey) => ['p', pubkey]),
  ])

const profileLists = () => [
  list(moderatorSecret, 'threads', [memberPubkey, bannedPubkey]),
  list(moderatorSecret, 'moderation', [memberPubkey, bannedPubkey]),
  list(formOwnerSecret, 'publishing', [memberPubkey, bannedPubkey]),
  list(moderatorSecret, 'calendar', [memberPubkey, bannedPubkey]),
]

const parsedDefinition = () => parseCommunityDefinition(definition(), communityPubkey, descriptor)
const snapshot = (moderationEvents = []) =>
  buildCommunitySnapshot(parsedDefinition(), profileLists(), moderationEvents)

test('mode configuration defaults repository and validates all community settings', () => {
  assert.deepEqual(parseAnchorMode({}), { mode: 'repository' })
  assert.deepEqual(
    parseAnchorMode({
      ANCHOR_MODE: 'community',
      ANCHOR_COMMUNITY_PUBKEY: communityPubkey,
      ANCHOR_COMMUNITY_BOOTSTRAP_RELAYS: 'wss://one.example,wss://two.example',
      ANCHOR_HANDLER_ADDRESS: mode.handlerAddress,
      ANCHOR_HANDLER_RELAY: mode.handlerRelay,
    }),
    { ...mode, bootstrapRelays: ['wss://one.example/', 'wss://two.example/'] }
  )
  assert.throws(() => parseAnchorMode({ ANCHOR_MODE: 'community' }), /ANCHOR_COMMUNITY_PUBKEY/)
})

test('definition parses ordered content/k/a sections with delegated owners and relay hints', () => {
  const parsed = parsedDefinition()
  assert.deepEqual(parsed.relays, ['wss://community.example/'])
  assert.deepEqual(parsed.sections.map((section) => section.name), [
    'Conversations',
    'Moderation',
    'Publishing',
    'Calendar and goals',
    'Absent delegation',
  ])
  assert.deepEqual(parsed.sections[0].kinds.slice(0, 3), [
    { kind: 9, subtype: 'room-message' },
    { kind: 11, subtype: 'room' },
    { kind: 11, subtype: 'threads' },
  ])
  assert.deepEqual(parsed.sections[0].profileLists[0], {
    address: refs.threads,
    owner: moderatorPubkey,
    identifier: 'threads',
    relay: 'wss://delegated.example/',
    section: 0,
  })
  assert.equal(parsed.profileLists.some((reference) => reference.owner === communityPubkey), false)

  const plans = buildProfileListQueryPlans(parsed)
  const communityPlan = plans.find((plan) => plan.relay === 'wss://community.example/')
  assert.ok(communityPlan.filters.some((filter) => filter.authors[0] === moderatorPubkey))
  assert.ok(communityPlan.filters.some((filter) => filter.authors[0] === formOwnerPubkey))
  const hintPlan = plans.find((plan) => plan.relay === 'wss://delegated.example/')
  assert.deepEqual(hintPlan.references.map((reference) => reference.address), [refs.threads])
})

test('latest community definition still requires the exact running service descriptor', async () => {
  const wrong = { ...descriptor, requestRelay: 'wss://other.example/' }
  const additional = { ...descriptor, servicePubkey: otherPubkey }
  const multiple = sign(communitySecret, 10222, 102, [
    ...definition().tags,
    [
      'service',
      'community-alerts',
      additional.servicePubkey,
      additional.requestRelay,
      additional.handlerAddress,
      additional.handlerRelay,
    ],
  ])
  assert.doesNotThrow(() => parseCommunityDefinition(multiple, communityPubkey, descriptor))
  assert.throws(
    () => parseCommunityDefinition(definition(101, wrong), communityPubkey, descriptor),
    /does not advertise/
  )
  const context = new CommunityContext(mode, descriptor, async () => ({
    relay: 'wss://bootstrap.example/',
    events: [definition(100), definition(101, wrong)],
    eose: true,
  }))
  await assert.rejects(context.refresh(), /does not advertise/)
  assert.equal(context.ready, false)
  context.close()
})

test('context loads exact delegated owner+d lists from community and hinted relays', async () => {
  const calls = []
  const lists = profileLists()
  const context = new CommunityContext(mode, descriptor, async (relay, filters) => {
    calls.push({ relay, filters })
    if (filters.some((filter) => filter.kinds?.includes(10222))) {
      return { relay, events: [definition()], eose: true }
    }
    if (filters.some((filter) => filter.kinds?.includes(1984))) {
      return { relay, events: [], eose: true }
    }
    const authors = new Set(filters.flatMap((filter) => filter.authors || []))
    return {
      relay,
      events: lists.filter((event) => authors.has(event.pubkey)),
      eose: true,
    }
  })
  const current = await context.refresh()
  assert.deepEqual(membershipFor(current, memberPubkey), { eligible: true, role: 'member' })
  assert.deepEqual(membershipFor(current, moderatorPubkey), { eligible: true, role: 'moderator' })
  assert.ok(calls.some((call) => call.relay === 'wss://delegated.example/'))
  context.close()
})

test('eligibility is admin root, loaded delegated owner, or p in any referenced current list', () => {
  const current = snapshot()
  assert.deepEqual(membershipFor(current, communityPubkey), { eligible: true, role: 'admin' })
  assert.deepEqual(membershipFor(current, moderatorPubkey), {
    eligible: true,
    role: 'moderator',
  })
  assert.deepEqual(membershipFor(current, formOwnerPubkey), {
    eligible: true,
    role: 'moderator',
  })
  assert.deepEqual(membershipFor(current, memberPubkey), { eligible: true, role: 'member' })
  assert.equal(membershipFor(current, missingOwnerPubkey).eligible, false)
  assert.equal(membershipFor(current, otherPubkey).eligible, false)
  assert.equal(canManageSection(current, formOwnerPubkey, 'Publishing'), true)
  assert.equal(canManageSection(current, moderatorPubkey, 'Publishing'), false)
  assert.equal(canManageSection(current, communityPubkey, 'Publishing'), true)

  const wrongOwner = list(communitySecret, 'threads', [otherPubkey], 200)
  const missing = buildCommunitySnapshot(parsedDefinition(), [wrongOwner])
  assert.equal(membershipFor(missing, moderatorPubkey).eligible, false)
  assert.equal(membershipFor(missing, otherPubkey).eligible, false)
})

test('current admin-authored person bans remove members, never admin, and honor admin deletion', () => {
  const memberBan = sign(communitySecret, 1984, 110, [
    ['h', communityPubkey],
    ['p', memberPubkey, 'spam'],
  ])
  const adminBan = sign(communitySecret, 1984, 111, [
    ['h', communityPubkey],
    ['p', communityPubkey, 'other'],
  ])
  const delegatedBan = sign(moderatorSecret, 1984, 112, [
    ['h', communityPubkey],
    ['p', bannedPubkey, 'spam'],
  ])
  let current = snapshot([memberBan, adminBan, delegatedBan])
  assert.match(membershipFor(current, memberPubkey).reason, /banned/)
  assert.deepEqual(membershipFor(current, communityPubkey), { eligible: true, role: 'admin' })
  assert.deepEqual(membershipFor(current, bannedPubkey), { eligible: true, role: 'member' })

  const deletion = sign(communitySecret, 5, 113, [
    ['h', communityPubkey],
    ['e', memberBan.id],
  ])
  current = snapshot([memberBan, deletion])
  assert.deepEqual(membershipFor(current, memberPubkey), { eligible: true, role: 'member' })
})

test('community query phases require a genuine authoritative EOSE', () => {
  assert.doesNotThrow(() =>
    requireCommunityEose(
      [
        { relay: 'wss://one.example', events: [], eose: false },
        { relay: 'wss://two.example', events: [], eose: true },
      ],
      'core activity'
    )
  )
  assert.throws(
    () => requireCommunityEose([{ relay: 'wss://one.example', events: [], eose: false }], 'core'),
    /no authoritative EOSE/
  )
})

test('wrappers use p community plus k original kind and resolve exact originals with safe r hints', async () => {
  const current = snapshot()
  const original = sign(memberSecret, 31922, 105, [['d', 'calendar-item']], 'Calendar event')
  const wrapper = sign(memberSecret, 30222, 110, [
    ['p', communityPubkey],
    ['k', '31922'],
    ['a', `31922:${memberPubkey}:calendar-item`],
    ['r', 'wss://hint.example'],
  ])
  const reference = wrapperReference(wrapper, communityPubkey)
  assert.equal(reference.kind, 31922)
  assert.deepEqual([...reference.addresses], [`31922:${memberPubkey}:calendar-item`])
  assert.deepEqual([...reference.relays], ['wss://hint.example/'])

  const discoveryFilters = buildCommunityDiscoveryFilters(communityPubkey, moderatorPubkey, 100, 200)
  const wrapperFilter = discoveryFilters.find((filter) => filter.kinds?.includes(30222))
  assert.deepEqual(wrapperFilter['#p'], [communityPubkey])
  assert.deepEqual(wrapperFilter['#k'], ['31922', '31923', '9041'])
  assert.equal(wrapperFilter['#h'], undefined)

  const handler = sign(otherSecret, 31990, 100, [
    ['d', 'budabit'],
    ['web', 'https://app.example/<bech32>'],
  ])
  const calls = []
  const collector = new CommunityDigestCollector(
    { async refresh() { return current }, close() {} },
    mode,
    async (relay, filters) => {
      calls.push({ relay, filters })
      if (filters.some((filter) => filter.kinds?.includes(30222))) {
        return { relay, events: [wrapper], eose: true }
      }
      if (filters.some((filter) => filter.kinds?.includes(31922))) {
        return { relay, events: [original], eose: true }
      }
      if (filters.some((filter) => filter.kinds?.includes(31990))) {
        return { relay, events: [handler], eose: true }
      }
      return { relay, events: [], eose: true }
    }
  )
  const data = await collector.collect(
    communityConfig({ community: communityPubkey }),
    moderatorPubkey,
    100,
    200
  )
  assert.equal(data.highlights.length, 1)
  assert.match(data.highlights[0].summary, /calendar update/)
  assert.ok(calls.some((call) => call.relay === 'wss://hint.example/'))
  await collector.close()
})

test('uppercase roots, q room parents, and bare room markers drive grouping', () => {
  const current = snapshot()
  const room = sign(moderatorSecret, 11, 90, [
    ['h', communityPubkey],
    ['room'],
  ], 'Builders room')
  const parent = sign(memberSecret, 9, 100, [
    ['h', communityPubkey],
    ['E', room.id],
  ], 'Earlier message')
  const message = sign(memberSecret, 9, 110, [
    ['h', communityPubkey],
    ['E', room.id],
    ['q', parent.id],
  ], 'Room update')
  const thread = sign(moderatorSecret, 11, 91, [['h', communityPubkey]], 'Owned thread')
  const comment = sign(memberSecret, 1111, 111, [
    ['h', communityPubkey],
    ['E', thread.id],
    ['A', `30023:${moderatorPubkey}:thread`],
    ['e', parent.id],
    ['a', `30023:${memberPubkey}:parent`],
    ['p', moderatorPubkey],
  ], 'Reply')
  assert.equal(isRoomEvent(room), true)
  assert.equal(communityKindSubtype(room), 'room')
  assert.equal(communityKindSubtype(parent), 'room-message')
  assert.equal(communityKindSubtype(thread), 'threads')
  assert.equal(communityKindSubtype(comment), undefined)
  assert.deepEqual(
    new Set(authorizeCommunityEvents([room, parent, message, thread, comment], current).map((event) => event.id)),
    new Set([room.id, parent.id, message.id, thread.id, comment.id])
  )
  assert.deepEqual(getCommunityReferences(message), {
    rootId: room.id,
    rootAddress: undefined,
    parentId: parent.id,
    parentAddress: undefined,
  })
  assert.equal(getCommunityReferences(comment).rootId, thread.id)
  assert.equal(getCommunityReferences(comment).rootAddress, `30023:${moderatorPubkey}:thread`)
  assert.equal(getCommunityReferences(comment).parentId, parent.id)
  assert.equal(getCommunityReferences(comment).parentAddress, `30023:${memberPubkey}:parent`)

  const data = normalizeCommunityDigest(
    communityConfig({ community: communityPubkey }),
    moderatorPubkey,
    [message, comment],
    [room, parent, thread],
    current,
    new Map(),
    'https://budabit.example/<bech32>',
    100,
    200
  )
  assert.equal(data.forYou.length, 1)
  assert.equal(data.forYou[0].title, 'Owned thread')
  assert.equal(data.highlights.length, 1)
  assert.equal(data.highlights[0].title, 'Builders room')
})

test('admission and moderator-request follow-ups use staged exact targets without exposing bodies', () => {
  const current = snapshot()
  const expanded = communityConfig({
    community: communityPubkey,
    preferences: { ...communityConfig().preferences, density: 'expanded' },
  })
  const form = sign(formOwnerSecret, 30168, 80, [
    ['d', 'publishing-form'],
    ['a', `10222:${communityPubkey}:`],
    ['content', 'Publishing'],
  ], 'PRIVATE FORM CONTENT')
  const formAddress = `30168:${formOwnerPubkey}:publishing-form`
  const response = sign(applicantSecret, 1069, 110, [['a', formAddress]], 'PRIVATE APPLICATION ANSWERS')
  const review = sign(formOwnerSecret, 7, 111, [
    ['e', response.id],
    ['p', applicantPubkey],
  ], '+')
  const unauthorizedReview = sign(moderatorSecret, 7, 112, [['e', response.id]], '+')
  const request = sign(memberSecret, 30000, 109, [
    ['d', 'moderator-request'],
    ['a', `10222:${communityPubkey}:`],
  ], 'PRIVATE REQUEST CONTENT')
  const requestReview = sign(communitySecret, 7, 113, [['e', request.id]], '+')
  const unauthorizedForm = sign(moderatorSecret, 30168, 81, [
    ['d', 'unauthorized-form'],
    ['a', `10222:${communityPubkey}:`],
    ['content', 'Publishing'],
  ], 'PRIVATE UNAUTHORIZED FORM')
  const unauthorizedResponse = sign(applicantSecret, 1069, 114, [
    ['a', `30168:${moderatorPubkey}:unauthorized-form`],
  ], 'PRIVATE ANSWERS')
  const bodyOnlyForm = sign(formOwnerSecret, 30168, 82, [
    ['d', 'body-only-form'],
    ['a', `10222:${communityPubkey}:`],
  ], 'Publishing')
  const bodyOnlyResponse = sign(applicantSecret, 1069, 115, [
    ['a', `30168:${formOwnerPubkey}:body-only-form`],
  ], 'PRIVATE ANSWERS')

  assert.equal(membershipFor(current, applicantPubkey).eligible, false)
  assert.deepEqual(
    authorizeCommunityEvents([response, review, unauthorizedReview, request, requestReview], current, [form]),
    [response, review, request, requestReview]
  )
  assert.deepEqual(
    authorizeCommunityEvents(
      [unauthorizedForm, unauthorizedResponse],
      current,
      [unauthorizedForm]
    ),
    []
  )
  assert.deepEqual(
    authorizeCommunityEvents([bodyOnlyForm, bodyOnlyResponse], current, [bodyOnlyForm]),
    []
  )
  const applicantData = normalizeCommunityDigest(
    expanded,
    applicantPubkey,
    [review],
    [form, response, request],
    current,
    new Map(),
    'https://budabit.example/<bech32>',
    100,
    200
  )
  assert.equal(applicantData.needsAttention.length, 1)
  assert.doesNotMatch(
    JSON.stringify(applicantData),
    /PRIVATE FORM CONTENT|PRIVATE APPLICATION ANSWERS|PRIVATE REQUEST CONTENT/
  )

  const moderatorData = normalizeCommunityDigest(
    expanded,
    formOwnerPubkey,
    [response],
    [form],
    current,
    new Map(),
    'https://budabit.example/<bech32>',
    100,
    200
  )
  assert.equal(moderatorData.needsAttention.length, 1)
  assert.equal(moderatorData.needsAttention[0].title, 'Publishing request')

  const adminData = normalizeCommunityDigest(
    expanded,
    communityPubkey,
    [response, request],
    [form],
    current,
    new Map(),
    'https://budabit.example/<bech32>',
    100,
    200
  )
  assert.equal(adminData.needsAttention.length, 2)
})

test('collector stages responses and admin follow-ups from discovered exact form/request targets', async () => {
  const current = snapshot()
  const form = sign(formOwnerSecret, 30168, 80, [
    ['d', 'publishing-form'],
    ['a', `10222:${communityPubkey}:`],
    ['content', 'Publishing'],
  ], 'PRIVATE FORM CONTENT')
  const formAddress = `30168:${formOwnerPubkey}:publishing-form`
  const response = sign(applicantSecret, 1069, 110, [['a', formAddress]], 'PRIVATE ANSWERS')
  const request = sign(memberSecret, 30000, 109, [
    ['d', 'moderator-request'],
    ['a', `10222:${communityPubkey}:`],
  ], 'PRIVATE REQUEST')
  const review = sign(formOwnerSecret, 7, 111, [['e', response.id]], '+')
  const requestReview = sign(communitySecret, 7, 112, [['e', request.id]], '+')
  const handler = sign(otherSecret, 31990, 100, [
    ['d', 'budabit'],
    ['web', 'https://app.example/<bech32>'],
  ])
  const calls = []
  const collector = new CommunityDigestCollector(
    { async refresh() { return current }, close() {} },
    mode,
    async (relay, filters) => {
      calls.push({ relay, filters })
      if (filters.some((filter) => filter.kinds?.includes(30168))) {
        return { relay, events: [form, request], eose: true }
      }
      if (filters.length === 1 && filters[0].kinds?.includes(1069)) {
        return { relay, events: [response], eose: true }
      }
      if (
        filters.length === 1 &&
        filters[0].kinds?.includes(7) &&
        filters[0]['#e']
      ) {
        return { relay, events: [review, requestReview], eose: true }
      }
      if (filters.some((filter) => filter.kinds?.includes(31990))) {
        return { relay, events: [handler], eose: true }
      }
      return { relay, events: [], eose: true }
    }
  )
  const data = await collector.collect(
    communityConfig({ community: communityPubkey }),
    communityPubkey,
    100,
    200
  )
  const responseCall = calls.find((call) =>
    call.filters.some((filter) => filter.kinds?.includes(1069))
  )
  assert.deepEqual(responseCall.filters[0]['#a'], [formAddress])
  const followupCall = calls.find((call) =>
    call.filters.some((filter) => filter.kinds?.includes(7) && filter['#e'])
  )
  assert.deepEqual(new Set(followupCall.filters[0]['#e']), new Set([response.id, request.id]))
  assert.equal(data.needsAttention.length, 2)
  await collector.close()
})

test('classification keeps personal/action capacity before highlights and hides report bodies', () => {
  const current = snapshot()
  const expanded = communityConfig({
    community: communityPubkey,
    preferences: { ...communityConfig().preferences, density: 'expanded' },
  })
  const root = sign(moderatorSecret, 11, 90, [['h', communityPubkey]], 'Owned thread')
  const reply = sign(memberSecret, 1111, 110, [
    ['h', communityPubkey],
    ['E', root.id],
    ['p', moderatorPubkey],
  ], 'Reply')
  const report = sign(memberSecret, 1984, 111, [
    ['h', communityPubkey],
    ['e', root.id],
    ['p', bannedPubkey, 'spam'],
  ], 'PRIVATE REPORT BODY')
  const highlights = Array.from({ length: 45 }, (_, index) =>
    sign(memberSecret, 11, 120 + index, [['h', communityPubkey]], `Thread ${index}`)
  )
  const data = normalizeCommunityDigest(
    expanded,
    moderatorPubkey,
    [reply, report, ...highlights],
    [root],
    current,
    new Map(),
    'https://budabit.example/<bech32>',
    100,
    200,
    true
  )
  assert.equal(data.needsAttention.length, 1)
  assert.equal(data.forYou.length, 1)
  assert.equal(data.highlights.length, 38)
  assert.equal(data.overflow, 7)
  assert.equal(data.eventCount, 47)
  assert.equal(data.sourceTruncated, true)
  assert.doesNotMatch(JSON.stringify(data), /PRIVATE REPORT BODY/)
})

test('handler selection requires a valid signature and exact configured kind/pubkey/d', () => {
  const manageUrl = 'https://budabit.example/settings/notifications'
  assert.equal(getCommunityFallbackHandlerTemplate(manageUrl), 'https://budabit.example/<bech32>')
  const handler = sign(otherSecret, 31990, 100, [
    ['d', 'budabit'],
    ['web', 'https://app.example/open/<bech32>'],
  ])
  const forged = {
    ...handler,
    created_at: 200,
    tags: [['d', 'budabit'], ['web', 'https://evil.example/<bech32>']],
    sig: '0'.repeat(128),
  }
  const wrongD = sign(otherSecret, 31990, 201, [
    ['d', 'other'],
    ['web', 'https://wrong.example/<bech32>'],
  ])
  const wrongOwner = sign(memberSecret, 31990, 202, [
    ['d', 'budabit'],
    ['web', 'https://wrong.example/<bech32>'],
  ])
  assert.equal(
    selectCommunityHandlerTemplate([forged, wrongD, wrongOwner, handler], mode.handlerAddress, manageUrl),
    'https://app.example/open/<bech32>'
  )
  assert.equal(
    selectCommunityHandlerTemplate([forged, wrongD], mode.handlerAddress, manageUrl),
    'https://budabit.example/<bech32>'
  )
})

test('status identities remain per-user and ineligible uses inactive client summary', async () => {
  const signer = Nip01Signer.ephemeral()
  const subscription = {
    pubkey: memberPubkey,
    state: 'ineligible',
    config: communityConfig({ community: communityPubkey }),
    confirmedAt: 100,
    nextRunAt: undefined,
  }
  assert.equal(getSubscriptionStatus(subscription).status, 'inactive')
  assert.equal(getSubscriptionStatus(subscription).state, 'ineligible')

  const repository = new SubscriptionService({}, {}, signer)
  assert.deepEqual((await repository.createStatusEvent(subscription)).tags, [
    ['d', `budabit/email-digest/${memberPubkey}`],
    ['p', memberPubkey],
  ])
  const community = new SubscriptionService({}, {}, signer, undefined, mode, {
    ready: true,
    async check() { return { eligible: true, role: 'member' } },
  })
  assert.deepEqual((await community.createStatusEvent(subscription)).tags, [
    ['d', `budabit/community-alerts/${communityPubkey}/${memberPubkey}`],
    ['p', memberPubkey],
  ])
})

test('community registration rejects an initially ineligible authenticated member', async () => {
  let writes = 0
  const service = new SubscriptionService(
    { async upsertSubscription() { writes++; throw new Error('unexpected write') } },
    {},
    Nip01Signer.ephemeral(),
    () => 100,
    mode,
    { ready: true, async check() { return { eligible: false, reason: 'not a member' } } }
  )
  await assert.rejects(
    service.add(
      sign(memberSecret, 32830, 100, [
        ['d', `budabit/community-alerts/${communityPubkey}`],
        ['p', servicePubkey],
      ]),
      communityConfig({ community: communityPubkey })
    ),
    (error) => error instanceof ActionError && /not a member/.test(error.message)
  )
  assert.equal(writes, 0)
})
