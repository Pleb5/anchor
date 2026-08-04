# How Anchor Works

Anchor is a single-process Nostr relay and scheduler for repository email digests. It stores one addressable subscription per Nostr pubkey, confirms the destination email address, collects selected repository activity from relays chosen by the subscriber, and sends grouped HTML and text email through Postmark.

This document describes the behavior implemented by the current protocol version. See [Self-hosting](self-hosting.md) for deployment and operations.

## End-to-end flow

1. A client connects to the Anchor websocket endpoint and completes NIP-42 authentication.
2. The client publishes a signed kind `32830` subscription event. Its encrypted content contains the email address, cadence, watched repositories, relay URLs, activity options, and Budabit link handler.
3. Anchor verifies the signature, authenticated author, event freshness, exact outer tags, decrypted payload, URLs, limits, and activity selection.
4. A new or changed email address receives a confirmation message. No digest period starts before confirmation.
5. Anchor persists the active subscription, its next local-calendar boundary, and each delivery run in SQLite.
6. At a due boundary, Anchor queries only the relays declared for each watched repository. A run is retried if relay coverage is incomplete.
7. Events are deduplicated, filtered through the repository's options, grouped under their issue or pull-request root, and capped for email rendering.
8. Empty periods advance without email. Non-empty periods are rendered as matching HTML and plain text and sent through Postmark.
9. Postmark bounce and spam-complaint webhooks can suppress an active subscription.
10. The client can reconnect and request an encrypted kind `32831` status event at any time.

## Relay protocol

Anchor serves HTTP and WebSocket traffic at the same public origin. A websocket connection immediately receives a NIP-42 `AUTH` challenge.

A valid authentication event must:

- be a signed kind `22242` event from the connecting user;
- be no more than five minutes old or future-dated;
- contain Anchor's issued challenge;
- contain the exact public relay URL derived from `ANCHOR_URL`, with `http` changed to `ws` or `https` changed to `wss`.

Before authentication, reads are closed with `auth-required` and writes are rejected. After authentication:

- `EVENT` accepts kind `32830` subscriptions and kind `5` deletions authored by the authenticated pubkey;
- `REQ` is always scoped to that pubkey's one stored subscription and current status, regardless of the requested filters;
- Anchor returns the stored subscription event when it has not been deleted, a freshly signed status event, and `EOSE`.

NIP-42 proves control of a Nostr key. Anchor does not apply a separate membership or pubkey allowlist.

## Subscription event

The subscription is an addressable kind `32830` event identified by the subscriber pubkey and fixed `d` tag. Its only outer tags are:

```json
[
  ["d", "budabit/email-digest"],
  ["p", "<Anchor pubkey>"]
]
```

The expected content encryption is NIP-44 between the subscriber and Anchor. The current decryptor also accepts legacy NIP-04 ciphertext for compatibility. Status events are always encrypted with NIP-44.

Anchor accepts subscription events up to 24 hours old and up to five minutes in the future. The decrypted UTF-8 payload is limited to 64 KiB. Validation is strict: unknown fields and malformed values are rejected.

The version 1 payload is documented in the [README](../README.md#protocol). Important limits are:

| Item                     | Limit                                      |
| ------------------------ | ------------------------------------------ |
| Cadence                  | 1 to 30 local calendar days                |
| Repositories             | 1 to 50 unique kind `30617` addresses      |
| Repository relays        | 1 to 3 unique WSS URLs per repository      |
| Unique repository relays | 20 across the subscription                 |
| Repository name          | 200 characters                             |
| Handler                  | One kind `31990` address and one WSS relay |
| Manage URL               | Absolute HTTPS URL, up to 2048 characters  |

At least one activity option must be enabled across the subscription. The handler relay is separate and does not count toward the 20 repository-relay limit.

## Status event

Anchor signs a fresh kind `32831` event with the fixed `d` tag and a `p` tag for the subscriber. Its NIP-44 encrypted content has this shape:

```json
{
  "version": 1,
  "channel": "email-digest",
  "status": "pending",
  "state": "pending",
  "message": "Confirm the email address before digest delivery starts.",
  "emailConfirmed": false,
  "nextRunAt": null,
  "lastCompletedAt": null
}
```

`status` is the client-facing summary `pending`, `ok`, `error`, or `inactive`. `state` is the persisted state `pending`, `active`, `unsubscribed`, `suppressed`, `deleted`, or `error`.

## Confirmation and replacement

The first subscription for an email address is pending until the recipient confirms it. Confirmation starts the first period at confirmation time and schedules the first future local-time boundary. Activity before confirmation is not delivered.

Replacement behavior depends on the current state and email:

- An active same-email replacement applies immediately without another email confirmation.
- If the cadence is unchanged, the existing period and next run are retained.
- If the cadence changes, the next boundary is recalculated while retaining the current period start.
- A different email address pauses delivery and requires confirmation of the new address.
- A same-email replacement can reactivate an unsubscribed, delivery-error, or validly deleted subscription.
- A same-email replacement of a suppressed subscription remains suppressed. Changing to a different email requires confirmation and clears suppression only when that new address is confirmed.
- Failure to send the confirmation email is not retried automatically. The client must publish a newer replacement to try again.

Confirmation and unsubscribe links use non-mutating `GET` confirmation pages followed by mutating `POST` requests. Digest email also includes RFC 8058 one-click unsubscribe headers.

A signed kind `5` event can delete the subscription. Its only tags, in order, must be an `a` tag for `32830:<subscriber pubkey>:budabit/email-digest` followed by a `p` tag for the Anchor pubkey.

## Scheduling and delivery

Cadence uses local calendar days in the configured IANA timezone, not fixed 24-hour durations. Daylight-saving transitions therefore preserve the requested local delivery time where possible.

Each run has a persisted half-open period:

```text
[period_start, period_end)
```

The scheduler polls immediately at startup and then every `SCHEDULER_POLL_MS`. It processes at most three subscriptions concurrently.

- Missed boundaries are consolidated into one period ending at the latest due boundary.
- A period with no selected external activity is recorded as empty and sends no email.
- A failed run retries after 1 minute, 5 minutes, and 15 minutes.
- The fourth failed attempt marks the run failed and the subscription `error`.
- Restarting Anchor recovers interrupted attempts from SQLite.
- A newer replacement, deletion, or unsubscribe cancels stale pending work where possible.

Anchor rechecks deliverability before sending, but Postmark is an external boundary. A crash after Postmark accepts a message and before its `MessageID` is persisted can result in a duplicate retry. Exactly-once email delivery cannot be guaranteed.

## Activity collection

Anchor queries the relay URLs stored with each repository. Shared relays are batched and up to six relay requests run concurrently.

The selected Nostr Git activity kinds are:

| Activity            |   Kind | Configuration                                           |
| ------------------- | -----: | ------------------------------------------------------- |
| Comment             | `1111` | `issues.comments` or `prs.comments`, based on root kind |
| New pull request    | `1618` | `prs.new`                                               |
| Pull-request update | `1619` | `prs.updates`                                           |
| New issue           | `1621` | `issues.new`                                            |
| Open status         | `1630` | `status.open`                                           |
| Applied status      | `1631` | `status.applied`                                        |
| Closed status       | `1632` | `status.closed`                                         |
| Draft status        | `1633` | `status.draft`                                          |
| Assignment label    | `1985` | `assignments`                                           |

Events are attributed through exact configured `a` tags. Kind `1111` comments may also be attributed through `q` tags. Every event authored by the subscriber is excluded, including activity on a watched repository.

Each configured repository must receive a genuine `EOSE` from at least one declared relay for the primary query. When events reference issue or pull-request roots, the root-context phase has the same coverage requirement. Incomplete coverage fails the run instead of sending a digest known to be partial.

A comment is selectable only when its root event can be found and is a kind `1621` issue or kind `1618` pull request. A generic comment rooted directly at a repository has no current subscription category and is omitted. A relay can complete a root query without returning a missing event; in that case the unclassifiable comment is omitted.

## Deduplication and compaction

Counts in the email are selected events. Rows are grouped conversations. One row can therefore represent several updates.

Anchor applies these rules in order:

1. Combine responses from the declared repository relays.
2. Attribute each event to a configured repository through `a`, or through `q` for comments.
3. Keep the newest 500 unique event IDs for the digest window.
4. Deduplicate repeated copies received from multiple relays.
5. Exclude events authored by the subscriber.
6. Apply each repository's issue, PR, status, and assignment options.
7. Resolve the root from the first uppercase `E` tag, then an `e` tag marked `root`, then the first `e` tag.
8. Group selected events by repository and root issue or pull request.
9. Preserve the root title and deep link even when the newest activity is a comment or status.
10. Render assignments first in `Needs attention`, without repeating those rows in the repository section.
11. Render at most 50 grouped rows and report the number of additional grouped rows omitted.

Within a row:

- comments display as `1 comment` or `N comments`;
- any number of PR update events display once as `Pull request updated`, while the repository summary counts every selected update;
- status events display their distinct names once, such as `Status: Open, Closed`, while the repository summary counts every selected status event;
- any matching assignment adds `Assigned to you` and marks the entire root row as needing attention;
- the row author and timestamp come from its most recent selected event.

For example, this repository summary:

```text
2 new items / 3 comments / 2 status changes
```

can render as only two rows:

```text
Issue A: New issue | Status: Open
Issue B: New issue | 3 comments | Status: Open
```

Those rows represent two and five selected events respectively, for seven total updates.

The 500-event collection cap is a service-protection limit and is not currently paginated. The 50-row email cap applies after grouping and reports omitted rows; it does not report activity excluded by the collection cap.

## Links and profiles

Anchor optionally fetches kind `0` profiles from the repository relays to display author names. Missing profile metadata falls back to a shortened pubkey.

For item links, Anchor fetches the configured kind `31990` handler from its declared relay and uses the newest valid HTTPS `web` template. If handler metadata is unavailable, Anchor safely falls back to:

```text
<manageUrl origin>/git/<repo_naddr>/<section>/<id>
```

Root context may be older than the digest period. It is used for classification, title, and linking but is not counted as new activity unless the root event itself falls within the period and its option is enabled.

## Storage and privacy

SQLite is the durable source of truth. It stores the original encrypted event, decrypted active or pending configuration, destination email, repository relay URLs, confirmation and unsubscribe state, scheduling boundaries, run attempts, and Postmark message IDs. SQLite uses WAL mode, foreign keys, and a five-second busy timeout.

The database and structured log must be treated as private service data:

- decrypted email addresses and configuration are stored at rest;
- unsubscribe tokens are bearer credentials;
- `ANCHOR_SECRET` can decrypt subscriptions and sign status events;
- repository and handler relay URLs are subscriber-controlled outbound destinations.

Run one Anchor process against one local SQLite database. The current project does not provide database migrations or a multi-replica coordination model. Back up the database before upgrades.

## HTTP endpoints

| Endpoint                                      | Purpose                                  |
| --------------------------------------------- | ---------------------------------------- |
| `GET /`                                       | Human-readable landing page              |
| `GET /` with `Accept: application/nostr+json` | NIP-11 relay metadata and Anchor pubkey  |
| `WS /`                                        | Authenticated subscription relay         |
| `GET /health`                                 | Process liveness only                    |
| `GET /ready`                                  | SQLite and scheduler readiness           |
| `GET`, `POST /confirm`                        | Scanner-safe email confirmation          |
| `GET`, `POST /unsubscribe`                    | Scanner-safe and one-click unsubscribe   |
| `POST /webhooks/postmark`                     | Postmark bounce and complaint processing |

The aliases `/webhooks/postmark/bounce` and `/webhooks/postmark/spam` use the same webhook handler. Readiness does not test Postmark or external relay connectivity.
