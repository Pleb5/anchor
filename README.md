# Anchor Email Digest

Anchor is an authenticated Nostr relay and scheduler for Budabit repository email digests. It accepts one encrypted digest subscription per user, collects configured Git activity only from user-declared relays, and sends grouped email through Postmark.

Legacy alert tag arrays, push registrations, and per-alert cron jobs are not supported.

## Protocol

Subscriptions are replaceable kind `32830` events. Their only outer tags must be:

```json
[
  ["d", "budabit/email-digest"],
  ["p", "<Anchor pubkey>"]
]
```

The NIP-44 encrypted content must be a JSON object:

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
      "relays": ["wss://relay.example"],
      "options": {
        "issues": { "new": true, "comments": true },
        "prs": { "new": true, "comments": true, "updates": true },
        "status": { "open": true, "draft": true, "applied": true, "closed": true },
        "assignments": true
      }
    }
  ]
}
```

`manageUrl` is required and must be an absolute HTTPS URL without credentials or a fragment. It is used for the email settings link and its origin supplies the safe item-link fallback `/git/<repo_naddr>/<section>/<id>` when NIP-89 handler metadata is unavailable.

Status is returned as encrypted JSON in kind `32831`. Events older than 24 hours or more than five minutes in the future are rejected. Payloads are limited to 64 KiB, repositories to 50, repository relays to three each, and unique repository relays to 20. The NIP-89 handler relay does not count toward the repository-relay limit.

A same-email replacement remains confirmed and retains its next run when cadence is unchanged. A replacement with a different email pauses delivery and stores the new configuration as pending until that address is confirmed. Confirmation and unsubscribe links render a confirmation page on GET and mutate only on POST.

## Scheduling

Cadence is based on local calendar days and the configured IANA timezone, including DST transitions. `next_run_at` and each half-open `[period_start, period_end)` are persisted in SQLite. The scheduler polls all due subscriptions, runs at most three concurrently, consolidates missed boundaries into one digest, advances empty periods without sending, and makes up to three retries after the initial attempt.

Each configured repository must receive a genuine EOSE from at least one declared relay for primary activity and any required root-context query. Incomplete coverage fails the run so the same period is retried. Primary collection is intentionally capped at 500 unique events per digest window as a service-protection limit; activity beyond that cap is not paginated in the current version.

SQLite uses WAL mode and a five-second busy timeout. The current schema is created with `CREATE TABLE IF NOT EXISTS` for a fresh database; legacy `alerts` data is ignored.

Run identities and atomic claims prevent concurrent duplicate processing. Exactly-once email delivery cannot be guaranteed across the external Postmark boundary: a process crash after Postmark accepts a message but before its `MessageID` is persisted can cause that run to be retried.

## Configuration

Copy `.env.template` to `.env` and set:

- `ANCHOR_SECRET`: Nostr private key used for NIP-44 and status signatures.
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

Configure Postmark bounce and spam complaint webhooks with the HTTPS endpoint `https://<anchor-host>/webhooks/postmark`. In Postmark, set HTTP Basic authentication to `POSTMARK_WEBHOOK_USERNAME` and `POSTMARK_WEBHOOK_SECRET` through the dashboard or deployment secret manager; do not place credentials in checked-in URLs or command examples. Bearer authentication and `X-Anchor-Webhook-Secret` remain supported. Spam complaints and bounces marked `Inactive: true` suppress matching active subscriptions; soft bounces are acknowledged without suppression. Delivery metadata includes `run_id`, `subscription_pubkey`, and `period_end`.

## Build And Test

```sh
pnpm install
pnpm run check
pnpm test
pnpm run build
```

`pnpm run build:server` compiles the service and email/page templates without requiring `web/node_modules`.

Run the built service with:

```sh
pnpm start
```

Operational endpoints:

- `GET /health`: process liveness.
- `GET /ready`: verifies SQLite and scheduler readiness.
- `GET /` with `Accept: application/nostr+json`: NIP-11 metadata.

## Systemd

```ini
[Unit]
Description=Anchor Budabit email digest
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=anchor
Group=anchor
WorkingDirectory=/srv/anchor
EnvironmentFile=/srv/anchor/.env
ExecStart=/usr/bin/node /srv/anchor/dist/index.js
Restart=on-failure
KillSignal=SIGTERM

[Install]
WantedBy=multi-user.target
```

The process handles `SIGTERM` and `SIGINT` by stopping new HTTP work, closing relay connections, draining websocket handlers with a bounded timeout, stopping the scheduler, closing collector sockets, and closing SQLite. A final process-level timeout prevents shutdown from hanging indefinitely.

## Reverse Proxy

Anchor trusts exactly one proxy hop. Preserve the public host and forwarding headers:

```nginx
location / {
    proxy_pass http://127.0.0.1:4738;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```
