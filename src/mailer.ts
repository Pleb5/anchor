import { ServerClient } from 'postmark'
import type { Message } from 'postmark'
import type { DigestData, DigestRepositoryData, DigestRow } from './digest.js'
import type { DigestRun, Subscription } from './database.js'
import { render } from './templates.js'

type MailSettings = {
  apiKey: string
  sender: string
  anchorName: string
  anchorUrl: string
  messageStream: string
}

type DigestMessageInput = {
  to: string
  sender: string
  stream: string
  subscriptionPubkey: string
  runId: string
  periodEnd: number
  subject: string
  html: string
  text: string
  unsubscribeUrl: string
}

type PostmarkClient = {
  sendEmail(message: Message): Promise<{ MessageID: string }>
}

const plural = (count: number, singular: string, pluralValue = `${singular}s`) =>
  `${count} ${count === 1 ? singular : pluralValue}`

export function buildDigestSubject(data: DigestData) {
  const updates = plural(data.eventCount, 'update')
  const repositories = plural(data.repositories.length, 'repository', 'repositories')
  if (data.attentionCount > 0) {
    const verb = data.attentionCount === 1 ? 'needs' : 'need'
    return `[Budabit] ${plural(data.attentionCount, 'item')} ${verb} you, ${updates} in ${repositories}`
  }
  return `[Budabit] ${updates} in ${repositories}`
}

const formatTimestamp = (seconds: number, locale: string | undefined, timezone: string) =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(seconds * 1000))

const formatDate = (seconds: number, locale: string | undefined, timezone: string) =>
  new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone: timezone,
  }).format(new Date(seconds * 1000))

const countsText = (repository: DigestRepositoryData) => {
  const values = [
    repository.counts.newItems ? plural(repository.counts.newItems, 'new item') : '',
    repository.counts.comments ? plural(repository.counts.comments, 'comment') : '',
    repository.counts.updates ? plural(repository.counts.updates, 'PR update') : '',
    repository.counts.statuses ? plural(repository.counts.statuses, 'status change') : '',
    repository.counts.assignments ? plural(repository.counts.assignments, 'assignment') : '',
  ].filter(Boolean)
  return values.join(' / ')
}

const rowView = (row: DigestRow, locale: string | undefined, timezone: string) => ({
  ...row,
  timestamp: formatTimestamp(row.createdAt, locale, timezone),
})

export function buildDigestText(
  data: DigestData,
  locale: string | undefined,
  timezone: string,
  manageUrl: string,
  unsubscribeUrl: string
) {
  const lines = [
    buildDigestSubject(data),
    '',
    `${formatDate(data.periodStart, locale, timezone)} to ${formatDate(data.periodEnd, locale, timezone)}`,
    `${plural(data.eventCount, 'update')} across ${plural(data.repositories.length, 'repository', 'repositories')}`,
  ]

  if (data.attention.length) {
    lines.push('', 'NEEDS ATTENTION')
    for (const row of data.attention) {
      lines.push(`- ${row.repositoryName}: ${row.title}`, `  ${row.summary}`, `  ${row.link}`)
    }
  }

  for (const repository of data.repositories) {
    lines.push('', repository.name.toUpperCase(), countsText(repository))
    for (const row of repository.rows) {
      lines.push(`- ${row.title}`, `  ${row.summary} by ${row.author}`, `  ${row.link}`)
    }
  }

  if (data.overflow) lines.push('', `${data.overflow} additional grouped rows were omitted.`)
  lines.push('', `Manage settings: ${manageUrl}`, `Unsubscribe: ${unsubscribeUrl}`)
  return lines.join('\n')
}

export function buildPostmarkDigestMessage(input: DigestMessageInput): Message {
  return {
    From: input.sender,
    To: input.to,
    Subject: input.subject,
    HtmlBody: input.html,
    TextBody: input.text,
    MessageStream: input.stream,
    Tag: 'email-digest',
    Metadata: {
      run_id: input.runId,
      subscription_pubkey: input.subscriptionPubkey,
      period_end: String(input.periodEnd),
    },
    Headers: [
      { Name: 'List-Unsubscribe', Value: `<${input.unsubscribeUrl}>` },
      { Name: 'List-Unsubscribe-Post', Value: 'List-Unsubscribe=One-Click' },
    ],
  }
}

export class EmailService {
  private readonly client: PostmarkClient

  constructor(private readonly settings: MailSettings, client?: PostmarkClient) {
    this.client = client || new ServerClient(settings.apiKey)
  }

  async sendConfirmation(subscription: Subscription, email: string, confirmationToken: string) {
    const confirmationUrl = `${this.settings.anchorUrl}/confirm?token=${encodeURIComponent(confirmationToken)}`
    return this.client.sendEmail({
      From: this.settings.sender,
      To: email,
      Subject: '[Budabit] Confirm your email digest',
      HtmlBody: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#172033">
          <h1 style="font-size:24px">Confirm your Budabit digest</h1>
          <p>Confirm this address before repository activity is delivered.</p>
          <p><a href="${confirmationUrl}" style="background:#f15a37;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Review and confirm</a></p>
          <p style="font-size:12px;color:#697386">If you did not request this, no action is needed.</p>
        </div>`,
      TextBody: `Confirm your Budabit email digest: ${confirmationUrl}\n\nIf you did not request this, no action is needed.`,
      MessageStream: this.settings.messageStream,
      Tag: 'email-digest-confirmation',
      Metadata: { subscription_pubkey: subscription.pubkey },
    })
  }

  async sendDigest(subscription: Subscription, run: DigestRun, data: DigestData) {
    if (!subscription.config || !subscription.confirmedEmail) {
      throw new Error('Subscription is not deliverable')
    }
    const locale = subscription.config.locale
    const timezone = subscription.config.cadence.timezone
    const unsubscribeUrl = `${this.settings.anchorUrl}/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeToken)}`
    const manageUrl = subscription.config.manageUrl
    const repositories = data.repositories.map((repository) => ({
      ...repository,
      countsText: countsText(repository),
      rows: repository.rows.map((row) => rowView(row, locale, timezone)),
      hasRows: repository.rows.length > 0,
    }))
    const view = {
      preheader: `${plural(data.eventCount, 'update')} from ${plural(data.repositories.length, 'repository', 'repositories')}`,
      dateRange: `${formatDate(data.periodStart, locale, timezone)} - ${formatDate(data.periodEnd, locale, timezone)}`,
      total: data.eventCount,
      repositoryCount: data.repositories.length,
      attentionCount: data.attentionCount,
      hasAttention: data.attention.length > 0,
      attention: data.attention.map((row) => rowView(row, locale, timezone)),
      repositories,
      overflow: data.overflow,
      hasOverflow: data.overflow > 0,
      manageUrl,
      unsubscribeUrl,
      anchorName: this.settings.anchorName,
    }
    const html = await render('emails/digest.mjml', view)
    const message = buildPostmarkDigestMessage({
      to: subscription.confirmedEmail,
      sender: this.settings.sender,
      stream: this.settings.messageStream,
      subscriptionPubkey: subscription.pubkey,
      runId: run.runId,
      periodEnd: run.periodEnd,
      subject: buildDigestSubject(data),
      html,
      text: buildDigestText(data, locale, timezone, manageUrl, unsubscribeUrl),
      unsubscribeUrl,
    })
    const response = await this.client.sendEmail(message)
    return response.MessageID
  }
}
