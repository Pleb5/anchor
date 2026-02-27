import 'dotenv/config'
import apn from 'apn'
import fcm from 'firebase-admin'
import webpush from 'web-push'
import { always } from '@welshman/lib'
import { normalizeRelayUrl } from '@welshman/util'
import { netContext } from '@welshman/net'
import { Nip01Signer } from '@welshman/signer'
import { routerContext } from '@welshman/router'

const hasValue = (value?: string) => Boolean(value && value.trim().length > 0)

const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY?.trim()
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY?.trim()
const VAPID_SUBJECT = process.env.VAPID_SUBJECT?.trim()
const FCM_KEY = process.env.FCM_KEY?.trim()
const APN_KEY = process.env.APN_KEY?.trim()
const APN_KEY_ID = process.env.APN_KEY_ID?.trim()
const APN_TEAM_ID = process.env.APN_TEAM_ID?.trim()

const hasAnyVapid =
  hasValue(VAPID_PRIVATE_KEY) || hasValue(VAPID_PUBLIC_KEY) || hasValue(VAPID_SUBJECT)
export const WEB_PUSH_ENABLED =
  hasValue(VAPID_PRIVATE_KEY) && hasValue(VAPID_PUBLIC_KEY) && hasValue(VAPID_SUBJECT)

if (hasAnyVapid && !WEB_PUSH_ENABLED) {
  throw new Error(
    'VAPID_PRIVATE_KEY, VAPID_PUBLIC_KEY, and VAPID_SUBJECT must all be set to enable web push.'
  )
}

export const ANDROID_PUSH_ENABLED = hasValue(FCM_KEY)

const hasAnyApn = hasValue(APN_KEY) || hasValue(APN_KEY_ID) || hasValue(APN_TEAM_ID)
export const IOS_PUSH_ENABLED = hasValue(APN_KEY) && hasValue(APN_KEY_ID) && hasValue(APN_TEAM_ID)

if (hasAnyApn && !IOS_PUSH_ENABLED) {
  throw new Error('APN_KEY, APN_KEY_ID, and APN_TEAM_ID must all be set to enable iOS push.')
}

export const PUSH_ENABLED = WEB_PUSH_ENABLED || ANDROID_PUSH_ENABLED || IOS_PUSH_ENABLED

if (!process.env.ANCHOR_URL) throw new Error('ANCHOR_URL is not defined.')
if (!process.env.ANCHOR_NAME) throw new Error('ANCHOR_NAME is not defined.')
if (!process.env.ANCHOR_SECRET) throw new Error('ANCHOR_SECRET is not defined.')
if (!process.env.POSTMARK_API_KEY) throw new Error('POSTMARK_API_KEY is not defined.')
if (!process.env.POSTMARK_SENDER_ADDRESS) throw new Error('POSTMARK_SENDER_ADDRESS is not defined.')
if (!process.env.DEFAULT_RELAYS) throw new Error('DEFAULT_RELAYS is not defined.')
if (!process.env.INDEXER_RELAYS) throw new Error('INDEXER_RELAYS is not defined.')
if (!process.env.SEARCH_RELAYS) throw new Error('SEARCH_RELAYS is not defined.')
if (!process.env.PORT) throw new Error('PORT is not defined.')

export const ANCHOR_URL = process.env.ANCHOR_URL
export const ANCHOR_NAME = process.env.ANCHOR_NAME
export const appSigner = Nip01Signer.fromSecret(process.env.ANCHOR_SECRET)
export const POSTMARK_API_KEY = process.env.POSTMARK_API_KEY
export const POSTMARK_SENDER_ADDRESS = process.env.POSTMARK_SENDER_ADDRESS
export const DEFAULT_RELAYS = process.env.DEFAULT_RELAYS.split(',').map(normalizeRelayUrl)
export const INDEXER_RELAYS = process.env.INDEXER_RELAYS.split(',').map(normalizeRelayUrl)
export const SEARCH_RELAYS = process.env.SEARCH_RELAYS.split(',').map(normalizeRelayUrl)
export const PORT = process.env.PORT

appSigner.getPubkey().then((pubkey) => {
  console.log(`Running as ${pubkey}`)
})

netContext.pool.get = (url: string) => {
  throw new Error('Attempted to use default pool')
}

routerContext.getDefaultRelays = always(DEFAULT_RELAYS)
routerContext.getIndexerRelays = always(INDEXER_RELAYS)
routerContext.getSearchRelays = always(SEARCH_RELAYS)

if (WEB_PUSH_ENABLED) {
  webpush.setVapidDetails(VAPID_SUBJECT!, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!)
}

if (ANDROID_PUSH_ENABLED) {
  fcm.initializeApp({
    credential: fcm.credential.cert(JSON.parse(FCM_KEY!)),
  })
}

export const apnProvider = IOS_PUSH_ENABLED
  ? new apn.Provider({
      production: process.env.APN_PRODUCTION === 'true',
      token: {
        key: APN_KEY!,
        keyId: APN_KEY_ID!,
        teamId: APN_TEAM_ID!,
      },
    })
  : undefined
