import { ServerClient } from 'postmark'
import { createHash } from 'node:crypto'
import type { Message } from 'postmark'
import type { DigestData, DigestRepositoryData, DigestRow } from './digest.js'
import type { CommunityDigestData, CommunityDigestRow } from './community-digest.js'
import type { DigestRun, Subscription } from './database.js'
import { render } from './templates.js'

type MailSettings = {
  apiKey: string
  sender: string
  anchorName: string
  anchorUrl: string
  messageStream: string
  mode?: 'repository' | 'community'
  communityPubkey?: string
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
  mode?: 'repository' | 'community'
  communityPubkey?: string
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

export function buildCommunityDigestSubject(data: CommunityDigestData) {
  const personal = data.needsAttention.length + data.forYou.length
  if (personal) return `[Budabit] ${plural(personal, 'community item')} for you`
  return `[Budabit] ${plural(data.eventCount, 'community update')}`
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
    repository.counts.reactions ? plural(repository.counts.reactions, 'reaction') : '',
    repository.counts.zaps
      ? `${plural(repository.counts.zaps, 'zap')}${
          repository.counts.zapsWithAmount === repository.counts.zaps
            ? ` (${repository.counts.zapSats} sats)`
            : ''
        }`
      : '',
  ].filter(Boolean)
  return values.join(' / ')
}

const postmarkRunId = (runId: string) => {
  if (runId.length <= 80) return runId
  const suffix = runId.slice(runId.lastIndexOf(':') + 1)
  return suffix.length <= 80 ? suffix : createHash('sha256').update(runId).digest('hex')
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

export function buildCommunityDigestText(
  data: CommunityDigestData,
  locale: string | undefined,
  timezone: string,
  manageUrl: string,
  unsubscribeUrl: string
) {
  const lines = [
    buildCommunityDigestSubject(data),
    '',
    `${formatDate(data.periodStart, locale, timezone)} to ${formatDate(data.periodEnd, locale, timezone)}`,
  ]
  const addSection = (title: string, rows: CommunityDigestRow[]) => {
    if (!rows.length) return
    lines.push('', title.toUpperCase())
    for (const row of rows) lines.push(`- ${row.title}`, `  ${row.summary}`, `  ${row.link}`)
  }
  addSection('Needs attention', data.needsAttention)
  addSection('For you', data.forYou)
  addSection('Appreciation', data.appreciation)
  addSection('Community highlights', data.highlights)
  if (data.overflow) lines.push('', `${data.overflow} additional grouped rows were omitted.`)
  if (data.sourceTruncated) {
    lines.push('', 'High-volume source results were truncated at the service safety limit.')
  }
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
    Tag: input.mode === 'community' ? 'community-alerts' : 'email-digest',
    Metadata: {
      // Postmark limits metadata values to 80 characters; durable run IDs include a 64-char event prefix.
      run_id: postmarkRunId(input.runId),
      subscription_pubkey: input.subscriptionPubkey,
      period_end: String(input.periodEnd),
      mode: input.mode || 'repository',
      ...(input.communityPubkey ? { community: input.communityPubkey } : {}),
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
    const community = subscription.pendingConfig?.channel === 'community-alerts'
    return this.client.sendEmail({
      From: this.settings.sender,
      To: email,
      Subject: community
        ? '[Budabit] Confirm your community alerts'
        : '[Budabit] Confirm your email digest',
      HtmlBody: `
        <div style="font-family:system-ui,sans-serif;max-width:560px;margin:auto;color:#172033">
           <h1 style="font-size:24px">Confirm your Budabit ${community ? 'community alerts' : 'digest'}</h1>
           <p>Confirm this address before ${community ? 'community' : 'repository'} activity is delivered.</p>
          <p><a href="${confirmationUrl}" style="background:#f15a37;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none">Review and confirm</a></p>
          <p style="font-size:12px;color:#697386">If you did not request this, no action is needed.</p>
        </div>`,
      TextBody: `Confirm your Budabit ${community ? 'community alerts' : 'email digest'}: ${confirmationUrl}\n\nIf you did not request this, no action is needed.`,
      MessageStream: this.settings.messageStream,
      Tag: community ? 'community-alerts-confirmation' : 'email-digest-confirmation',
      Metadata: {
        subscription_pubkey: subscription.pubkey,
        mode: community ? 'community' : 'repository',
        ...(community && subscription.pendingConfig?.channel === 'community-alerts'
          ? { community: subscription.pendingConfig.community }
          : {}),
      },
    })
  }

  async sendDigest(
    subscription: Subscription,
    run: DigestRun,
    data: DigestData | CommunityDigestData
  ) {
    if (!subscription.config || !subscription.confirmedEmail) {
      throw new Error('Subscription is not deliverable')
    }
    const locale = subscription.config.locale
    const timezone = subscription.config.cadence.timezone
    const unsubscribeUrl = `${this.settings.anchorUrl}/unsubscribe?token=${encodeURIComponent(subscription.unsubscribeToken)}`
    const manageUrl = subscription.config.manageUrl
    if (subscription.config.channel === 'community-alerts') {
      const communityData = data as CommunityDigestData
      const rowView = (row: CommunityDigestRow) => ({
        ...row,
        timestamp: formatTimestamp(row.createdAt, locale, timezone),
      })
      const view = {
        preheader: `${plural(communityData.eventCount, 'community update')}`,
        dateRange: `${formatDate(communityData.periodStart, locale, timezone)} - ${formatDate(communityData.periodEnd, locale, timezone)}`,
        total: communityData.eventCount,
        needsAttention: communityData.needsAttention.map(rowView),
        forYou: communityData.forYou.map(rowView),
        appreciation: communityData.appreciation.map(rowView),
        highlights: communityData.highlights.map(rowView),
        hasNeedsAttention: communityData.needsAttention.length > 0,
        hasForYou: communityData.forYou.length > 0,
        hasAppreciation: communityData.appreciation.length > 0,
        hasHighlights: communityData.highlights.length > 0,
        overflow: communityData.overflow,
        hasOverflow: communityData.overflow > 0,
        sourceTruncated: communityData.sourceTruncated,
        manageUrl,
        unsubscribeUrl,
        anchorName: this.settings.anchorName,
      }
      const html = await render('emails/community-digest.mjml', view)
      const message = buildPostmarkDigestMessage({
        to: subscription.confirmedEmail,
        sender: this.settings.sender,
        stream: this.settings.messageStream,
        subscriptionPubkey: subscription.pubkey,
        runId: run.runId,
        periodEnd: run.periodEnd,
        subject: buildCommunityDigestSubject(communityData),
        html,
        text: buildCommunityDigestText(
          communityData,
          locale,
          timezone,
          manageUrl,
          unsubscribeUrl
        ),
        unsubscribeUrl,
        mode: 'community',
        communityPubkey: subscription.config.community,
      })
      const response = await this.client.sendEmail(message)
      return response.MessageID
    }
    const repositoryData = data as DigestData
    const repositories = repositoryData.repositories.map((repository) => ({
      ...repository,
      countsText: countsText(repository),
      rows: repository.rows.map((row) => rowView(row, locale, timezone)),
      hasRows: repository.rows.length > 0,
    }))
    const view = {
      preheader: `${plural(repositoryData.eventCount, 'update')} from ${plural(repositoryData.repositories.length, 'repository', 'repositories')}`,
      dateRange: `${formatDate(repositoryData.periodStart, locale, timezone)} - ${formatDate(repositoryData.periodEnd, locale, timezone)}`,
      total: repositoryData.eventCount,
      repositoryCount: repositoryData.repositories.length,
      attentionCount: repositoryData.attentionCount,
      hasAttention: repositoryData.attention.length > 0,
      attention: repositoryData.attention.map((row) => rowView(row, locale, timezone)),
      repositories,
      overflow: repositoryData.overflow,
      hasOverflow: repositoryData.overflow > 0,
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
      subject: buildDigestSubject(repositoryData),
      html,
      text: buildDigestText(repositoryData, locale, timezone, manageUrl, unsubscribeUrl),
      unsubscribeUrl,
      mode: 'repository',
    })
    const response = await this.client.sendEmail(message)
    return response.MessageID
  }
}
