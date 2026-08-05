import { normalizeHttpsUrl, normalizeRelayUrl, ValidationError } from './subscription.js'

export type RepositoryMode = { mode: 'repository' }

export type CommunityMode = {
  mode: 'community'
  communityPubkey: string
  bootstrapRelays: string[]
  handlerAddress: string
  handlerRelay: string
}

export type AnchorMode = RepositoryMode | CommunityMode

export type CommunityServiceDescriptor = {
  servicePubkey: string
  requestRelay: string
  handlerAddress: string
  handlerRelay: string
}

const hexPubkey = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new ValidationError(`${field} must be a 64-character lowercase hex pubkey`)
  }
  return value
}

const handlerAddress = (value: unknown, field: string) => {
  if (typeof value !== 'string' || !/^31990:[0-9a-f]{64}:[^\u0000-\u001f\u007f]{1,200}$/.test(value)) {
    throw new ValidationError(`${field} must be a kind 31990 address`)
  }
  return value
}

export const publicRequestRelay = (anchorUrl: string) => {
  const url = new URL(anchorUrl)
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new ValidationError('ANCHOR_URL must produce a valid public websocket URL')
  }
  return url.toString()
}

export function parseAnchorMode(environment: NodeJS.ProcessEnv): AnchorMode {
  const mode = environment.ANCHOR_MODE?.trim() || 'repository'
  if (mode === 'repository') return { mode }
  if (mode !== 'community') {
    throw new ValidationError('ANCHOR_MODE must be repository or community')
  }

  const communityPubkey = hexPubkey(
    environment.ANCHOR_COMMUNITY_PUBKEY?.trim(),
    'ANCHOR_COMMUNITY_PUBKEY'
  )
  const relayValues = environment.ANCHOR_COMMUNITY_BOOTSTRAP_RELAYS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  if (!relayValues?.length) {
    throw new ValidationError('ANCHOR_COMMUNITY_BOOTSTRAP_RELAYS must contain at least one relay')
  }
  const bootstrapRelays = relayValues.map((relay, index) =>
    normalizeRelayUrl(relay, `ANCHOR_COMMUNITY_BOOTSTRAP_RELAYS[${index}]`)
  )
  if (new Set(bootstrapRelays).size !== bootstrapRelays.length) {
    throw new ValidationError('ANCHOR_COMMUNITY_BOOTSTRAP_RELAYS contains a duplicate relay')
  }
  if (bootstrapRelays.length > 10) {
    throw new ValidationError('ANCHOR_COMMUNITY_BOOTSTRAP_RELAYS cannot contain more than 10 relays')
  }

  return {
    mode,
    communityPubkey,
    bootstrapRelays,
    handlerAddress: handlerAddress(
      environment.ANCHOR_HANDLER_ADDRESS?.trim(),
      'ANCHOR_HANDLER_ADDRESS'
    ),
    handlerRelay: normalizeRelayUrl(
      environment.ANCHOR_HANDLER_RELAY?.trim(),
      'ANCHOR_HANDLER_RELAY'
    ),
  }
}

export function communityDescriptor(
  mode: CommunityMode,
  servicePubkey: string,
  anchorUrl: string
): CommunityServiceDescriptor {
  const publicUrl = normalizeHttpsUrl(anchorUrl, 'ANCHOR_URL')
  const url = new URL(publicUrl)
  if (url.pathname !== '/' || url.search) {
    throw new ValidationError('ANCHOR_URL must be an HTTPS origin in community mode')
  }
  return {
    servicePubkey: hexPubkey(servicePubkey, 'service pubkey'),
    requestRelay: publicRequestRelay(publicUrl),
    handlerAddress: mode.handlerAddress,
    handlerRelay: mode.handlerRelay,
  }
}

export const subscriptionIdentifier = (mode: AnchorMode) =>
  mode.mode === 'community'
    ? `budabit/community-alerts/${mode.communityPubkey}`
    : 'budabit/email-digest'

export const statusIdentifier = (mode: AnchorMode, userPubkey: string) =>
  `${subscriptionIdentifier(mode)}/${hexPubkey(userPubkey, 'user pubkey')}`
