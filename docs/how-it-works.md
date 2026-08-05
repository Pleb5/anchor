# How Anchor Works

Anchor is a single-process Nostr relay and scheduler running in either repository or single-community mode. Each process stores one addressable subscription per Nostr pubkey, confirms the destination email, collects mode-specific activity, and sends grouped HTML and text through Postmark. Repository and community instances do not share a database or key.

This document describes the behavior implemented by the current protocol version. See [Self-hosting](self-hosting.md) for deployment and operations.

## End-to-end flow

1. A client connects to the Anchor websocket endpoint and completes NIP-42 authentication.
2. The client publishes a signed kind `32830` subscription event. Repository content contains watched repositories and announcement lookup hints. Community content contains one configured community and preferences, never relays or a handler.
3. Anchor verifies the signature, authenticated author, event freshness, exact outer tags, decrypted payload, URLs, limits, and activity selection.
4. A new or changed email address receives a confirmation message. No digest period starts before confirmation.
5. Anchor persists the active subscription, its next local-calendar boundary, and each delivery run in SQLite.
6. At a due boundary, repository mode resolves exact announcements from lookup hints, then queries only announcement-declared repository relays. Community mode queries relays in the latest verified kind `10222`. A run is retried if required EOSE coverage is incomplete.
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

NIP-42 proves control of a Nostr key. Community mode additionally requires current admin, moderator, or member eligibility at registration, scheduler polling, run start, and before delivery. A ban wins over all roles.

## Subscription event

The subscription is an addressable kind `32830` event identified by the subscriber pubkey and fixed `d` tag. Its only outer tags are:

```json
[
  ["d", "budabit/email-digest"],
  ["p", "<Anchor pubkey>"]
]
```

Content and status encryption are NIP-44 between the subscriber and Anchor. NIP-04 is not accepted and there is no protocol fallback.

Anchor accepts subscription events up to 24 hours old and up to five minutes in the future. The decrypted UTF-8 payload is limited to 64 KiB. Validation is strict: unknown fields and malformed values are rejected.

The version 1 payload is documented in the [README](../README.md#protocol). Important limits are:

| Item                      | Limit                                      |
| ------------------------- | ------------------------------------------ |
| Cadence                   | 1 to 30 local calendar days                |
| Repositories              | 1 to 50 unique kind `30617` addresses      |
| Announcement lookup hints | 1 to 3 unique WSS URLs per repository      |
| Unique lookup hints       | 20 across the subscription                 |
| Repository name           | 200 characters                             |
| Handler                   | One kind `31990` address and one WSS relay |
| Manage URL                | Absolute HTTPS URL, up to 2048 characters  |

At least one activity option must be enabled across the subscription. `repositories[].relays` are lookup/bootstrap hints only, and the handler relay is separate from their 20-URL limit.

## Status event

Anchor signs a fresh kind `32831` event with a per-user `d` tag and a `p` tag for the subscriber. Repository `d` is `budabit/email-digest/<user>`; community `d` is `budabit/community-alerts/<community>/<user>`. Its NIP-44 encrypted content has this shape:

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

`status` is the client-facing summary `pending`, `ok`, `error`, or `inactive`. `state` is the persisted state `pending`, `active`, `unsubscribed`, `suppressed`, `deleted`, `error`, or `ineligible`; an ineligible subscription has summary `inactive`.

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

In community mode the corresponding address is `32830:<subscriber>:budabit/community-alerts/<community>`. Membership loss sets `ineligible`, cancels open work, and clears `next_run_at`. Restoring membership alone does not reactivate delivery; a strictly newer registration is required.

## Community definition and membership

Community startup and refresh query bootstrap relays plus relays from the last verified definition for the newest valid signed kind `10222` authored by `ANCHOR_COMMUNITY_PUBKEY`. The definition must contain one exact service tag:

```text
[service, community-alerts, servicePubkey, requestRelay, handlerAddress, handlerRelay]
```

The request relay is the public websocket URL derived from `ANCHOR_URL`; handler values come from process configuration. Any mismatch makes readiness fail and blocks membership verification. Activity relays are normalized WSS `r` tags from that definition.

Kind `10222` content authorization is ordered. A `[content,<name>]` tag starts a section; following `[k,<kind>,<optional exact protocol subtype>]` and `[a,30000:<owner>:<d>,<optional WSS relay>]` tags belong to that section until the next `content` tag. Anchor never uses event body content as a subtype: kind `9` derives `room-message`, bare-room kind `11` derives `room`, ordinary kind `11` derives `threads`, and currently supported remaining kinds have no subtype. Profile-list owners may be delegated moderator keys. Anchor groups list queries by exact owner and `d`, queries community relays plus each reference's relay hint, verifies signatures, and accepts only the newest event for an exact referenced address.

Eligibility has no identifier or role-marker inference:

- the kind `10222` author is the only admin;
- a pubkey is a moderator when it owns a referenced list and a current valid event for that exact address was loaded;
- a pubkey is a member when it appears in a `p` tag in any loaded referenced list;
- unsupported `p` tags in kind `10222` have no role meaning.

Current person bans are admin-authored, exact-`h` kind `1984` person reports with one `p` target and no event/address target. A newer valid admin kind `5` deletion of the report revokes it. A community admin cannot ban the community's own admin key. Delegated all-section moderators are not currently allowed to create effective person bans.

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

Anchor first queries each repository's subscriber-provided lookup hints for only its exact kind `30617` kind/pubkey/`d` and deletion records. It verifies signatures, requires exactly one matching `d`, selects newest by `created_at` then lowest event ID, and rejects a current announcement carrying a `deleted` marker or deleted by a valid owner kind `5`. The selected announcement must contain one nonempty `relays` tag of unique WSS URLs. Only those authoritative Repo relays are used afterward; shared relays are batched and up to six requests run concurrently.

Lookup hints retain the subscription limits of three per repository and 20 unique hints. Announcement declarations are separately capped at 20 relays per announcement and 20 unique authoritative relays per run. Exceeding either authoritative limit fails the run without truncation, fallback, or partial delivery.

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
| Reaction            |    `7` | `engagement.reactions`                                  |
| Zap receipt         | `9735` | `engagement.zaps`                                       |

Direct repository attribution requires an exact lowercase `a` tag. Uppercase `A` and repository-valued `q` do not directly scope activity, and any repository-valued `a`/`A`/`q` that conflicts with the configured address rejects that relation. Bounded `e`/`E`/event-ID `q` root and parent references may resolve through already accepted events. Every event authored by the subscriber is excluded, including activity on a watched repository.

Each configured repository must receive a genuine `EOSE` from at least one lookup hint in both announcement and deletion preflight, then from at least one announcement-declared relay for primary, required root-context, and accepted-reference phases. Incomplete coverage fails the run instead of sending a digest known to be partial.

A comment is selectable only when its root event can be found and is a kind `1621` issue or kind `1618` pull request. A generic comment rooted directly at a repository has no current subscription category and is omitted. A relay can complete a root query without returning a missing event; in that case the unclassifiable comment is omitted.

### Repository admission graph

The configured kind `30617` announcement is the prerequisite accepted repository identity. Anchor does not discover arbitrary announcements or query generic application/user relays. It applies a bounded accepted-event graph for each configured repository, then rejects references known to cross those graphs:

- lowercase `a=<repository address>` is the direct scope required by Git-data events; comments, reactions, and zap receipts may also directly reference the accepted repository with lowercase `q`, while uppercase `A` is never direct scope;
- all admitted activity must reference the accepted announcement or an accepted event, directly or through the bounded graph;
- kind `1618` pull requests require a lowercase repository `a` and exactly one nonempty `c`; kind `1619` updates require the lowercase repository `a`, exactly one nonempty `c`, one uppercase `E` resolving to an accepted kind `1618`, and one uppercase `P` equal to that pull request's author;
- kind `1111` comments require the repository or a resolved accepted root;
- kind `1630`-`1633` statuses require the repository or a resolved accepted issue/pull-request root;
- kind `1985` labels require the repository or another accepted event;
- kind `1623` permalinks may extend the graph through accepted `a`/`e` relations but have no digest preference or row of their own;
- kind `7` reactions require a lowercase `a` or `q` reference to the repository, or an `e`/`E`/`q` reference resolving to an accepted event;
- kind `9735` receipts require a valid receipt signature, exactly one embedded valid signed kind `9734` request, a Bolt11 tag, matching receipt/request targets and single recipient `p`, and an accepted repository or event target; kind `9734` is embedded context and is never independently queried;
- orphan references, known cross-repository references, generic user activity, and subscriber-authored reactions/zap requests are omitted.

Engagement targeting an accepted comment, status, or label inherits its issue/pull-request root for grouping. Direct repository-level engagement compacts into one repository row. Zap sats are shown only when every grouped invoice amount was decoded safely; otherwise valid zaps are counted without an amount. Reviews are not inferred from reactions and have no repository preference.

Primary filters query every supported activity kind by lowercase repository `a`, plus direct repository `q` references for comments, reactions, and zap receipts. After accepted roots are resolved, a bounded follow-up queries supported activity through event-ID `e`, `E`, and `q` on the same announcement-declared relays. Kind `9734` is never in a filter. Each root and accepted-reference phase requires EOSE coverage. Anchor does not enumerate all historical comments merely to discover future orphan engagement.

## Deduplication and compaction

Counts in the email are selected events. Rows are grouped conversations. One row can therefore represent several updates.

Anchor applies these rules in order:

1. Combine responses from the selected announcement's authoritative repository relays.
2. Attribute direct events through exact lowercase repository `a` or through a bounded accepted event reference.
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

The 500-event collection cap is a service-protection limit and is not currently paginated. The 50-row email cap applies after grouping and reports omitted rows; it does not report activity excluded by the collection cap. Relation validation is deliberately bounded rather than a full ngit implementation. Anchor checks the available NIP-34 `c`, `E`, and `P` structure for pull requests and updates, but cannot verify that Git objects or `refs/nostr/<event-id>` exist. It relies on acceptance by the authoritative Repo relays for those Git-data checks and does not invent object-network verification.

## Community activity collection

The safe core currently implements:

- verified exact-`h` community events for kinds `11`, `9`, `1111`, `7`, `1984`, `1985`, and `5`;
- kind `30222` wrappers attributed by `p=<community>` and `k=<original kind>`, with exact `e`/`a` original resolution and bounded WSS `r` hints;
- kind `30168` admission forms targeted by `a=10222:<community>:` and carrying one `[content,<section name>]`; the author must be admin or own a loaded list in that exact section. Staged kind `1069` responses may come from nonmembers, target exactly one authorized form address, and receive kind `7`/`5` follow-ups;
- referenced kind `30000` membership lists, plus moderator requests targeted by `a=10222:<community>:` and admin kind `7`/`5` follow-ups;
- NIP-22 comments grouped through uppercase `E`/`A` roots and lowercase `e`/`a` parents;
- reactions and NIP-57 receipts with a valid signed zap request, grouped by target;
- room messages grouped through uppercase `E` room roots and `q` parents; rooms are kind `11` events with a bare `[room]` marker;
- regular kind `11` threads, calendar wrappers for both kind `31922` and `31923`, and kind `9041` goals;
- latest replaceable events, current-role authorization, bans, moderator/owner deletions, root/target resolution, optional profiles, and self exclusion.

Reports, admission forms, responses, and moderator-request bodies are represented only by generic labels and counts; their content is never rendered. Moderator-only reports/actions require section-specific delegated authority or admin status. Events from currently banned or unauthorized authors are excluded, except cryptographically valid zap receipts whose request targets the recipient.

Core, wrapper/original, and root/target phases require a genuine EOSE from at least one relay advertised by verified `10222`; incomplete phases retry the period. Results are bounded to 1,000 primary events and 500 context IDs. Reaching a source bound sets an explicit truncation notice instead of creating an endless volume retry. Emails reserve action/personal rows before highlights and cap output at 40 grouped rows.

Current limitations are deliberate: authorization uses the current membership snapshot rather than reconstructing historical role intervals; zap validation proves the receipt/request structure and signatures available from relays but does not independently settle the Lightning invoice; unsupported community event kinds are omitted rather than assigned an invented category.

## Links and profiles

Anchor optionally fetches kind `0` profiles from the announcement-declared repository relays to display author names. Missing profile metadata falls back to a shortened pubkey.

For item links, Anchor fetches the configured kind `31990` handler from its declared relay and uses only a cryptographically valid event that exactly matches the configured kind, pubkey, and `d`. Repository templates support repository placeholders. Community templates must contain `<bech32>` and fall back to `<manageUrl origin>/<bech32>`. The provider identity remains Anchor's service pubkey, never the handler pubkey. If repository handler metadata is unavailable, Anchor safely falls back to:

```text
<manageUrl origin>/git/<repo_naddr>/<section>/<id>
```

Root context may be older than the digest period. It is used for classification, title, and linking but is not counted as new activity unless the root event itself falls within the period and its option is enabled.

## Storage and privacy

SQLite is the durable source of truth. It stores schema version plus exact mode/community identity, the original encrypted event, decrypted active or pending configuration, destination email, confirmation and unsubscribe state, scheduling boundaries, run attempts, and Postmark message IDs. SQLite uses WAL mode, foreign keys, and a five-second busy timeout. A mode/community mismatch or database without identity metadata aborts startup; this release has no legacy migration.

The database and structured log must be treated as private service data:

- decrypted email addresses and configuration are stored at rest;
- unsubscribe tokens are bearer credentials;
- `ANCHOR_SECRET` can decrypt subscriptions and sign status events;
- repository lookup hints and handler relay URLs are subscriber-controlled outbound destinations; verified announcements control subsequent authoritative repository relay destinations.

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
