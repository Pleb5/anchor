# Anchor Email Digests

Anchor is an authenticated Nostr relay and scheduler for Budabit email digests. The same build runs in either `repository` mode for watched Git repositories or `community` mode pinned to one community. Deploy the modes as separate processes with separate URLs, Nostr keys, SQLite databases, Postmark streams, and webhook secrets.

Legacy alert tag arrays, push registrations, and per-alert cron jobs are not supported.

## Documentation

- [How Anchor works](docs/how-it-works.md): authentication, subscription lifecycle, scheduling, relay collection, filtering, compaction, delivery, and reliability limits.
- [Self-hosting Anchor](docs/self-hosting.md): production installation, systemd, reverse proxy, Postmark, backups, updates, recovery, and security.

## Repository Protocol

Subscriptions are addressable kind `32830` events. Their only outer tags must be:

```json
[
  ["d", "budabit/email-digest"],
  ["p", "<Anchor pubkey>"]
]
```

The expected NIP-44 encrypted content must be a JSON object:

```json
{
  "version": 1,
  "channel": "email-digest",
  "email": "person@example.com",
  "manageUrl": "https://budabit.example/settings/notifications",
  "locale": "en-US",
  "cadence": {
    "intervalDays": 2,
    "localTime": "09:00",
    "timezone": "America/New_York"
  },
  "handler": {
    "address": "31990:<pubkey>:<id>",
    "relay": "wss://handler.example"
  },
  "repositories": [
    {
      "address": "30617:<pubkey>:<id>",
      "name": "Repository name",
      "relays": ["wss://announcement-lookup.example"],
      "options": {
        "issues": { "new": true, "comments": true },
        "prs": { "new": true, "comments": true, "updates": true },
        "status": { "open": true, "draft": true, "applied": true, "closed": true },
        "engagement": { "reactions": true, "zaps": true },
        "assignments": true
      }
    }
  ]
}
```

`manageUrl` is required and must be an absolute HTTPS URL without credentials or a fragment. It is used for the email settings link and its origin supplies the safe item-link fallback `/git/<repo_naddr>/<section>/<id>` when NIP-89 handler metadata is unavailable.

Only NIP-44 subscription content is accepted. Status is returned as NIP-44 encrypted JSON in kind `32831` with exact tags `d=budabit/email-digest/<subscriber pubkey>` and `p=<subscriber pubkey>`. There is no old shared-status identifier fallback. Events older than 24 hours or more than five minutes in the future are rejected. Decrypted plaintext is limited to 64 KiB, repositories to 50, announcement lookup hints to three per repository, and unique lookup hints to 20. `repositories[].relays` are bootstrap hints for fetching only the configured kind `30617` address; they are not activity relays. The NIP-89 handler relay does not count toward the lookup-hint limit.

A same-email replacement remains confirmed and retains its next run when cadence is unchanged. A replacement with a different email pauses delivery and stores the new configuration as pending until that address is confirmed. Unsubscribed, delivery-error, and validly deleted subscriptions can be reactivated by a newer same-email replacement. A same-email replacement does not bypass bounce or complaint suppression; changing to a newly confirmed address clears it. Confirmation and unsubscribe links render a confirmation page on GET and mutate only on POST.

A kind `5` deletion must contain only an `a` tag for `32830:<subscriber pubkey>:budabit/email-digest` followed by a `p` tag for the Anchor pubkey. See [How Anchor Works](docs/how-it-works.md) for status fields and state transitions.

## Community Protocol

Community mode is pinned by `ANCHOR_COMMUNITY_PUBKEY`. A kind `32830` subscription has exactly:

```json
[
  ["d", "budabit/community-alerts/<community-pubkey>"],
  ["p", "<Anchor service pubkey>"]
]
```

Its strict NIP-44 JSON payload is:

```json
{
  "version": 1,
  "channel": "community-alerts",
  "community": "<configured-community-pubkey>",
  "email": "member@example.com",
  "manageUrl": "https://budabit.example/settings/notifications",
  "locale": "en-US",
  "cadence": { "intervalDays": 1, "localTime": "08:30", "timezone": "UTC" },
  "preferences": {
    "density": "compact",
    "engagement": { "replies": true, "mentions": true, "reactions": true, "zaps": true },
    "access": { "membership": true, "publishing": true, "moderatorRequests": true },
    "moderation": { "reports": true, "actions": true },
    "highlights": { "rooms": true, "threads": true, "calendar": true, "goals": true }
  }
}
```

Every listed field except `locale` is required; unknown fields are rejected. A subscriber cannot provide community relays or a handler. Status kind `32831` has exact tags `d=budabit/community-alerts/<community>/<subscriber>` and `p=<subscriber>`. Deletion has exact tags `a=32830:<subscriber>:budabit/community-alerts/<community>` and `p=<service>`.

Registration requires current admin, moderator, or member status from the latest verified community definition and referenced profile lists. The definition author is the sole admin; a delegated list owner is a moderator only when that exact current list was loaded; any `p` in any referenced current list is a member. Current admin-authored kind `1984` person bans override member/moderator eligibility but never the admin root. Anchor rechecks membership during scheduler polling and immediately before delivery. Loss marks the record `ineligible` with client summary `inactive`, clears scheduling, cancels open runs, and requires a newer registration event after membership is restored.

Community email has separate HTML, text, and subjects with `Needs attention`, `For you`, `Appreciation`, and `Community highlights`. It renders at most 40 grouped rows, reserves personal/action rows before highlights, reports row overflow and source truncation, and never renders application answers or report bodies.

## Scheduling

Cadence is based on local calendar days and the configured IANA timezone, including DST transitions. `next_run_at` and each half-open `[period_start, period_end)` are persisted in SQLite. The scheduler polls all due subscriptions, runs at most three concurrently, consolidates missed boundaries into one digest, advances empty periods without sending, and makes up to three retries after the initial attempt.

Each configured repository must receive a genuine EOSE from at least one lookup hint for announcement/deletion preflight and from at least one announcement-declared relay for primary activity and required context/reference queries. Community mode similarly requires an EOSE from at least one verified community relay for core and required resolution phases. Incomplete coverage fails the run so the same period is retried. Collection is bounded; community volume beyond source limits is reported rather than retried forever.

Repository engagement is admitted only after Anchor fetches the current valid, exact, non-deleted kind `30617` announcement from lookup hints. Its `relays` tag is authoritative for repository activity, context, accepted-reference follow-ups, profiles, and link relay hints; subscriber or generic relay fallback is never used. Reactions and structurally valid NIP-57 receipts must directly use lowercase `a=<repository>` or `q=<repository>`, or resolve through the accepted announcement/event graph; orphan and conflicting cross-repository references are omitted. Pull requests and updates require a lowercase repository `a` plus the local NIP-34 `c`/root structure. Anchor relies on serving Repo relays to have performed Git commit/ref checks that cannot be reproduced from Nostr events alone.

Anchor accepts at most 20 unique authoritative repository relays in one collection run. An announcement with more than 20 relays, or a set of announcements exceeding 20 unique relays, fails the run without truncation or fallback so coverage is never silently weakened.

SQLite uses WAL mode and a five-second busy timeout. Schema version, mode, and community identity are stored in the database. Startup aborts on a wrong mode/community or on an old database without identity metadata. This clean-break release requires a fresh database; there is no legacy migration.

Run identities and atomic claims prevent concurrent duplicate processing. Exactly-once email delivery cannot be guaranteed across the external Postmark boundary: a process crash after Postmark accepts a message but before its `MessageID` is persisted can cause that run to be retried.

## Configuration

Copy `.env.template` to `.env` and set:

- `ANCHOR_SECRET`: Nostr private key used for NIP-44 and status signatures.
- `ANCHOR_MODE`: `repository` or `community`; omitted existing deployments default to `repository`.
- `ANCHOR_NAME`: public service name.
- `ANCHOR_URL`: externally visible HTTP(S) URL. NIP-42 matching derives the exact WS(S) URL from it.
- `ANCHOR_DB_PATH`: SQLite path, default `anchor.db`.
- `ANCHOR_LOG_FILE`: structured delivery log path.
- `POSTMARK_API_KEY`: Postmark server token.
- `POSTMARK_SENDER_ADDRESS`: verified sender address.
- `POSTMARK_MESSAGE_STREAM`: explicit Postmark stream, default `outbound`.
- `POSTMARK_WEBHOOK_USERNAME`: HTTP Basic webhook username, default `anchor`.
- `POSTMARK_WEBHOOK_SECRET`: HTTP Basic webhook password and shared Bearer/header secret.
- `HOST`: listen address, default `127.0.0.1`.
- `PORT`: listen port, default `4738`.
- `SCHEDULER_POLL_MS`: due-work polling interval, default `30000`.

Community mode additionally requires `ANCHOR_COMMUNITY_PUBKEY`, comma-separated WSS `ANCHOR_COMMUNITY_BOOTSTRAP_RELAYS`, `ANCHOR_HANDLER_ADDRESS` as a kind `31990` address, and WSS `ANCHOR_HANDLER_RELAY`. `ANCHOR_URL` must be an HTTPS origin in community mode. Readiness stays unavailable unless the latest cryptographically valid kind `10222` advertises the exact running descriptor `[service,community-alerts,servicePubkey,publicRequestRelay,handlerAddress,handlerRelay]`.

Configure Postmark bounce and spam complaint webhooks with the HTTPS endpoint `https://<anchor-host>/webhooks/postmark`. Use separate streams and webhook credentials for repository and community processes. In Postmark, set HTTP Basic authentication to `POSTMARK_WEBHOOK_USERNAME` and `POSTMARK_WEBHOOK_SECRET` through the dashboard or deployment secret manager; do not place credentials in checked-in URLs or command examples. Bearer authentication and `X-Anchor-Webhook-Secret` remain supported. Spam complaints and bounces marked `Inactive: true` suppress matching active subscriptions; soft bounces are acknowledged without suppression. Delivery metadata includes `run_id`, `subscription_pubkey`, `period_end`, `mode`, and community pubkey when applicable.

## Build And Test

```sh
pnpm install
pnpm run check
pnpm test
pnpm run build
```

Anchor targets Node.js 22. The included Nix flake provides Node.js, pnpm, SQLite, and native build tools. `pnpm run build:server` compiles the service and copies email/page templates into `dist`.

Run the built service with:

```sh
pnpm start
```

Operational endpoints:

- `GET /health`: process liveness.
- `GET /ready`: verifies SQLite and scheduler readiness.
- `GET /` with `Accept: application/nostr+json`: NIP-11 metadata.
- `WS /`: NIP-42 authenticated subscription relay.

For production systemd, proxy, persistence, Postmark, health checks, backup, and upgrade instructions, follow the complete [self-hosting guide](docs/self-hosting.md).
