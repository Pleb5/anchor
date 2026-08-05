import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools'

export const PUBKEY = 'a'.repeat(64)
export const ANCHOR_PUBKEY = 'b'.repeat(64)
export const REPO_SECRET = generateSecretKey()
export const REPO_PUBKEY = getPublicKey(REPO_SECRET)
export const REPO_ADDRESS = `30617:${REPO_PUBKEY}:anchor`
export const COMMUNITY_PUBKEY = 'd'.repeat(64)

export const repositoryAnnouncement = (createdAt = 80, relays = ['wss://repo.example']) =>
  finalizeEvent(
    {
      kind: 30617,
      created_at: createdAt,
      tags: [
        ['d', 'anchor'],
        ['relays', ...relays],
      ],
      content: '',
    },
    REPO_SECRET
  )

export const REPO_ANNOUNCEMENT = repositoryAnnouncement()

export const repositoryDeletion = (createdAt, tags = [['a', REPO_ADDRESS]]) =>
  finalizeEvent({ kind: 5, created_at: createdAt, tags, content: '' }, REPO_SECRET)

export const options = (overrides = {}) => ({
  issues: { new: true, comments: true },
  prs: { new: true, comments: true, updates: true },
  status: { open: true, draft: true, applied: true, closed: true },
  engagement: { reactions: true, zaps: true },
  assignments: true,
  ...overrides,
})

export const config = (overrides = {}) => ({
  version: 1,
  channel: 'email-digest',
  email: 'person@example.com',
  manageUrl: 'https://budabit.example/settings/notifications',
  locale: 'en-US',
  cadence: { intervalDays: 2, localTime: '09:00', timezone: 'America/New_York' },
  handler: {
    address: `31990:${'d'.repeat(64)}:budabit`,
    relay: 'wss://handler.example',
  },
  repositories: [
    {
      address: REPO_ADDRESS,
      name: 'Anchor',
      relays: ['wss://relay.example'],
      options: options(),
    },
  ],
  ...overrides,
})

export const communityConfig = (overrides = {}) => ({
  version: 1,
  channel: 'community-alerts',
  community: COMMUNITY_PUBKEY,
  email: 'member@example.com',
  manageUrl: 'https://budabit.example/settings/notifications',
  locale: 'en-US',
  cadence: { intervalDays: 1, localTime: '08:30', timezone: 'UTC' },
  preferences: {
    density: 'compact',
    engagement: { replies: true, mentions: true, reactions: true, zaps: true },
    access: { membership: true, publishing: true, moderatorRequests: true },
    moderation: { reports: true, actions: true },
    highlights: { rooms: true, threads: true, calendar: true, goals: true },
  },
  ...overrides,
})

export const subscriptionEvent = (createdAt, id = '1'.repeat(64)) => ({
  id,
  pubkey: PUBKEY,
  created_at: createdAt,
  kind: 32830,
  tags: [
    ['d', 'budabit/email-digest'],
    ['p', ANCHOR_PUBKEY],
  ],
  content: 'ciphertext',
  sig: 'f'.repeat(128),
})

export const nostrEvent = (
  kind,
  idCharacter,
  createdAt,
  tags = [['a', REPO_ADDRESS]],
  content = 'Activity title',
  pubkey = 'e'.repeat(64)
) => ({
  id: idCharacter.repeat(64),
  pubkey,
  created_at: createdAt,
  kind,
  tags,
  content,
  sig: 'f'.repeat(128),
})
