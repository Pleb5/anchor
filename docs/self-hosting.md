# Self-hosting Anchor

This guide deploys Anchor with local SQLite, Postmark, systemd, and an HTTPS reverse proxy. One build supports repository and community mode, but each mode/community is a separate process with its own public origin, Nostr key, database, log, Postmark stream, and webhook secret. Commands use `/home/anchor/anchor`; adjust paths for your host.

Read [How Anchor Works](how-it-works.md) before operating a public service.

## Requirements

You need:

- a Linux server with a public DNS name;
- HTTPS and WebSocket proxying for that name;
- Node.js 22 and pnpm, or Nix with flakes enabled;
- Git, SQLite, and a native build toolchain for the `sqlite3` dependency;
- a Postmark server, verified sender, and outbound message stream;
- a dedicated Nostr private key for Anchor;
- persistent local storage for SQLite and structured logs;
- outbound HTTPS access to Postmark and outbound WSS access to repository announcement lookup hints, announcement-declared Repo relays, or community bootstrap/definition relays.

Do not reuse a personal Nostr key or share a key between Anchor processes. `ANCHOR_SECRET` decrypts subscriber configuration and signs status events.

Anchor is designed as one process per local SQLite database. Database metadata binds it to schema version, mode, and community pubkey. Do not run replicas against copied or network-mounted databases, and never point two modes at one database.

## 1. Create the service account and directories

Create an unprivileged account and private state directories:

```sh
sudo useradd --system --create-home --home-dir /home/anchor --shell /usr/sbin/nologin anchor
sudo install -d -o anchor -g anchor -m 0750 /var/lib/anchor /var/log/anchor
sudo -u anchor git clone https://github.com/Pleb5/anchor.git /home/anchor/anchor
```

If the account or directories already exist, verify their ownership instead of recreating them.

## 2. Install dependencies and build

With system Node.js 22 and pnpm:

```sh
sudo -u anchor bash -lc 'cd /home/anchor/anchor && pnpm install --frozen-lockfile && pnpm run build'
```

With Nix:

```sh
sudo -u anchor bash -lc 'cd /home/anchor/anchor && nix develop -c pnpm install --frozen-lockfile && nix develop -c pnpm run build'
```

The build compiles JavaScript and copies runtime pages and MJML templates into `dist/`. `pnpm start` does not build; always build after pulling a new revision.

For a non-Nix installation, the native `sqlite3` package may require Python 3, `pkg-config`, Make, and a C/C++ compiler when a prebuilt binary is unavailable.

Generate Anchor's dedicated key on a trusted machine with a Nostr key tool. After installing dependencies, `nostr-tools` can generate the required 32-byte secret as 64 lowercase hexadecimal characters:

```sh
node --input-type=module -e "import { generateSecretKey } from 'nostr-tools'; console.log(Buffer.from(generateSecretKey()).toString('hex'))"
```

Store the output only as `ANCHOR_SECRET`. Do not publish it or reuse it for another identity.

Generate a separate secret for every repository/community process.

## 3. Configure Anchor

Create a private environment file:

```sh
sudo install -o anchor -g anchor -m 0600 /home/anchor/anchor/.env.template /home/anchor/anchor/.env
sudoedit /home/anchor/anchor/.env
sudo chown anchor:anchor /home/anchor/anchor/.env
sudo chmod 0600 /home/anchor/anchor/.env
```

A production configuration looks like:

```dotenv
ANCHOR_SECRET=<64-character Nostr private key in hex>
ANCHOR_MODE=repository
ANCHOR_NAME=My Email Digest
ANCHOR_URL=https://anchor.example.com
ANCHOR_DB_PATH=/var/lib/anchor/anchor.db
ANCHOR_LOG_FILE=/var/log/anchor/digest.jsonl
POSTMARK_API_KEY=<Postmark server token>
POSTMARK_SENDER_ADDRESS=notifications@example.com
POSTMARK_MESSAGE_STREAM=outbound
POSTMARK_WEBHOOK_USERNAME=anchor
POSTMARK_WEBHOOK_SECRET=<long random secret>
HOST=127.0.0.1
PORT=4738
SCHEDULER_POLL_MS=30000
```

Configuration rules:

- `ANCHOR_URL` must be the externally visible HTTPS origin with no path, query, fragment, or trailing slash. Its exact WSS equivalent is used for NIP-42 authentication.
- `ANCHOR_SECRET`, `POSTMARK_API_KEY`, and `POSTMARK_WEBHOOK_SECRET` are secrets. Never commit `.env`.
- Keep `HOST=127.0.0.1` when using a local reverse proxy. Anchor trusts exactly one proxy hop, so do not expose the application port publicly.
- Use absolute database and log paths. Their directories must be writable by the `anchor` account.
- `POSTMARK_SENDER_ADDRESS` must be verified in the same Postmark server as the API token.
- Set `POSTMARK_MESSAGE_STREAM` to an existing transactional stream.
- `ANCHOR_MODE` is `repository` or `community`. It defaults to `repository` only so existing repository deployments keep their mode when the variable is absent.
- This clean-break schema has no migration. An existing database without identity metadata is rejected; configure a fresh path.

A community process instead includes:

```dotenv
ANCHOR_MODE=community
ANCHOR_SECRET=<different 64-character service key>
ANCHOR_NAME=My Community Alerts
ANCHOR_URL=https://community-alerts.example.com
ANCHOR_COMMUNITY_PUBKEY=<64-character community pubkey>
ANCHOR_COMMUNITY_BOOTSTRAP_RELAYS=wss://relay-one.example,wss://relay-two.example
ANCHOR_HANDLER_ADDRESS=31990:<handler-pubkey>:<identifier>
ANCHOR_HANDLER_RELAY=wss://handler.example
ANCHOR_DB_PATH=/var/lib/anchor/community.db
ANCHOR_LOG_FILE=/var/log/anchor/community.jsonl
POSTMARK_API_KEY=<Postmark server token>
POSTMARK_SENDER_ADDRESS=notifications@example.com
POSTMARK_MESSAGE_STREAM=community-digests
POSTMARK_WEBHOOK_USERNAME=anchor-community
POSTMARK_WEBHOOK_SECRET=<different long random secret>
HOST=127.0.0.1
PORT=4739
SCHEDULER_POLL_MS=30000
```

Community `ANCHOR_URL` must be an HTTPS origin. Bootstrap/handler relays must be WSS. Startup fetches the latest valid signed kind `10222`; `/ready` remains 503 unless it advertises the exact service pubkey, public WSS request URL, handler address, and handler relay. Section profile-list references may delegate to other owners and add WSS relay hints; Anchor verifies exact owner/`d` events before granting eligibility. Handler metadata must also be signed and exactly match configured kind/pubkey/`d`. Subscriber payloads cannot override these values.

## 4. Install the systemd service

First locate the Node.js binary available to the service account:

```sh
sudo -u anchor bash -lc 'command -v node'
```

Use that absolute path as `ExecStart`. A typical system installation uses `/usr/bin/node`:

```ini
[Unit]
Description=Anchor Budabit email digest
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=anchor
Group=anchor
WorkingDirectory=/home/anchor/anchor
Environment=NODE_ENV=production
EnvironmentFile=/home/anchor/anchor/.env
ExecStart=/usr/bin/node /home/anchor/anchor/dist/index.js
Restart=on-failure
RestartSec=5s
KillSignal=SIGTERM
TimeoutStopSec=40s
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/var/lib/anchor /var/log/anchor
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6

[Install]
WantedBy=multi-user.target
```

Save it as `/etc/systemd/system/anchor.service`, then enable it:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now anchor
sudo systemctl status anchor --no-pager
```

If Node is supplied only by `nix develop`, either install a stable system Node.js 22 runtime for systemd or use a NixOS service definition that puts Node in the service path. Do not assume `/usr/bin/node` exists.

Anchor handles `SIGTERM` and `SIGINT`, stops accepting traffic, drains active websocket work, stops the scheduler, closes relay connections, and closes SQLite. A process-wide 35-second safety timeout can force exit, so `TimeoutStopSec` should be at least 40 seconds.

### Side-by-side systemd

For repository and community services on one VPS, keep shared build files read-only and use two private environment files:

```text
/etc/anchor/repository.env
/etc/anchor/community.env
```

Create `anchor-repository.service` and `anchor-community.service` from the unit above. Change `Description` and `EnvironmentFile`; both can use the same `WorkingDirectory` and `ExecStart`. Their env files must use different `ANCHOR_SECRET`, `ANCHOR_URL`, `ANCHOR_DB_PATH`, `ANCHOR_LOG_FILE`, `PORT`, `POSTMARK_MESSAGE_STREAM`, and `POSTMARK_WEBHOOK_SECRET`. Extend `ReadWritePaths` to both state/log directories. Start independently:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now anchor-repository anchor-community
```

## 5. Configure the reverse proxy

Terminate TLS at the proxy and forward HTTP and WebSocket upgrades to loopback. An nginx location is:

```nginx
location / {
    proxy_pass http://127.0.0.1:4738;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
}
```

Install a valid TLS certificate, reload nginx, and confirm that the public origin exactly matches `ANCHOR_URL`. Redirect plain HTTP to HTTPS.

### Side-by-side nginx

Use separate HTTPS virtual hosts. The repository host proxies to `4738`; the community host proxies to `4739` with the same websocket headers:

```nginx
server {
    server_name digest.example.com;
    location / {
        proxy_pass http://127.0.0.1:4738;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}

server {
    server_name community-alerts.example.com;
    location / {
        proxy_pass http://127.0.0.1:4739;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
    }
}
```

Issue TLS certificates for both names. Do not route both origins to one process: NIP-42 and the advertised community descriptor bind to the exact public URL.

Because Anchor sets `trust proxy` to one hop, the application port must remain reachable only through the trusted local proxy. The HTTP and websocket routes after health checks have an in-memory limit of 60 requests per five minutes per perceived client IP.

## 6. Configure Postmark

In the Postmark server selected by `POSTMARK_API_KEY`:

1. Verify `POSTMARK_SENDER_ADDRESS` or its domain.
2. Create or select the transactional message stream in `POSTMARK_MESSAGE_STREAM`.
3. Configure bounce and spam-complaint webhooks to `https://anchor.example.com/webhooks/postmark`.
4. Set HTTP Basic authentication to `POSTMARK_WEBHOOK_USERNAME` and `POSTMARK_WEBHOOK_SECRET`.

Anchor also accepts the secret as a Bearer token or `X-Anchor-Webhook-Secret`, but Basic authentication is the recommended Postmark dashboard configuration. Do not embed webhook credentials in the URL.

Use separate transactional streams and webhook configurations for repository and community processes. Each webhook points to its process origin and uses that process's Basic credentials. Postmark metadata includes `mode` and, in community mode, `community`; do not route suppression solely by message tag.

Spam complaints and bounces marked `Inactive: true` suppress a matching active subscription. Soft bounces are acknowledged without suppression.

## 7. Verify the deployment

Check local and public health:

```sh
curl --fail --silent --show-error http://127.0.0.1:4738/health
curl --fail --silent --show-error https://anchor.example.com/health
curl --fail --silent --show-error https://anchor.example.com/ready
```

Fetch NIP-11 metadata and record the service pubkey:

```sh
curl --fail --silent --show-error \
  -H 'Accept: application/nostr+json' \
  https://anchor.example.com/
```

Expected behavior:

- `/health` returns `status: ok` when the process is alive;
- `/ready` returns HTTP 200 after SQLite responds and the scheduler completes a successful poll;
- NIP-11 returns the configured name, Anchor pubkey, `mode`, and community pubkey when applicable;
- `wss://anchor.example.com/` accepts a websocket connection and immediately sends an `AUTH` challenge.

Readiness does not test Postmark. Repository readiness does not test external repository relays. Community readiness requires a currently verified exact service advertisement, but a later activity query can still fail. Complete an end-to-end test with an eligible separate Nostr account: publish a subscription, confirm its email, generate selected activity from another member, and verify the next scheduled digest and Postmark `MessageID`.

## Client discovery

A compatible client needs:

- the Anchor pubkey;
- the public WSS request URL;
- the kind `31990` Budabit handler address and relay used for email deep links.

Repository clients receive those values through their deployment configuration. Community clients discover the service through kind `10222`; community Anchor validates the latest definition and refuses readiness/registration when its exact descriptor is absent.

## Logs and status

System service logs:

```sh
sudo journalctl -u anchor -n 100 --no-pager
sudo journalctl -u anchor -f
```

Structured delivery logs are appended to `ANCHOR_LOG_FILE`. Configure host log rotation for that file. It contains service state and pubkeys and should not be public.

Useful service checks:

```sh
sudo systemctl is-active anchor
sudo systemctl is-enabled anchor
sudo ss -ltnp | grep ':4738'
```

The application should listen only on `127.0.0.1:4738` when the reverse proxy is local.

## Database backup

SQLite uses WAL mode, so do not back it up by copying only `anchor.db` while the service is running. Use SQLite's online backup command:

```sh
sudo install -d -o anchor -g anchor -m 0750 /var/backups/anchor
sudo -u anchor sqlite3 /var/lib/anchor/anchor.db \
  ".backup '/var/backups/anchor/anchor-$(date -u +%Y%m%dT%H%M%SZ).db'"
```

Protect backups like the live database: they contain decrypted email configuration and bearer tokens. Test restoration on a separate host.

The current schema is for fresh databases and has no general migration framework. A database without identity metadata is rejected. Back up before every upgrade and review release changes for schema instructions.

## Updating Anchor

Back up SQLite first. Then pull, install exactly from the lockfile, run checks, build, and restart:

```sh
sudo -u anchor bash -lc 'cd /home/anchor/anchor && git pull --ff-only'
sudo -u anchor bash -lc 'cd /home/anchor/anchor && pnpm install --frozen-lockfile'
sudo -u anchor bash -lc 'cd /home/anchor/anchor && pnpm run check && pnpm test && pnpm run build'
sudo systemctl restart anchor
curl --fail --silent --show-error https://anchor.example.com/health
curl --fail --silent --show-error https://anchor.example.com/ready
```

For a Nix-based build, prefix pnpm commands with `nix develop -c`:

```sh
sudo -u anchor bash -lc 'cd /home/anchor/anchor && git pull --ff-only'
sudo -u anchor bash -lc 'cd /home/anchor/anchor && nix develop -c pnpm install --frozen-lockfile'
sudo -u anchor bash -lc 'cd /home/anchor/anchor && nix develop -c pnpm run check && nix develop -c pnpm test && nix develop -c pnpm run build'
sudo systemctl restart anchor
```

Do not restart if installation, checks, tests, or build fail. The running process keeps its already loaded JavaScript until restart, although runtime templates live in `dist`, so schedule maintenance appropriately.

## Recovery notes

- An interrupted run is recovered from SQLite when the scheduler starts.
- Empty periods are advanced without sending email.
- After four failed delivery attempts, the subscription enters `error`; the user must publish a newer same-email subscription to reactivate it.
- Community membership loss or a ban enters `ineligible`, cancels scheduling, and requires a newer subscription after eligibility returns.
- A failed confirmation email is not automatically retried; the user must publish a newer subscription.
- Bounce or complaint suppression should be resolved with the recipient and Postmark before administrative intervention. A same-email replacement does not bypass suppression; a different address must be confirmed before delivery can resume.
- A crash after Postmark accepts a digest but before Anchor stores its `MessageID` can result in a duplicate retry.

## Security checklist

- Keep `.env`, SQLite, backups, and structured logs readable only by the service operator.
- Bind Anchor to loopback and firewall port `4738` from external access.
- Use a unique high-entropy webhook secret and HTTPS only.
- Keep the reverse proxy forwarding host, protocol, and client IP headers exactly once.
- Run as the unprivileged `anchor` account.
- Monitor filesystem capacity because SQLite WAL, backups, journal logs, and structured logs grow independently.
- Monitor `/ready`, Postmark delivery, and the structured log; readiness alone does not prove external delivery.
- In repository mode subscriber-provided lookup hints create outbound WSS connections only for exact announcement/deletion preflight; verified kind `30617` announcements then control authoritative Repo-relay destinations, capped at 20 unique URLs per run. Community mode uses only configured bootstrap/handler relays and relays from verified kind `10222`. Apply network egress policy appropriate to the selected mode.
