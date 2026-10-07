import type { FilterQuery } from 'mongoose';

import type { RequestContext } from '../../core/auth/session.js';
import { AppError } from '../../core/errors.js';
import { and } from '../../core/filters.js';
import { idString, toId } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import { pageOf, parseSort, searchFilter, skipLimit, type Page } from '../../core/pagination.js';
import { audit } from '../audit/audit.service.js';

import { NotificationModel, type NotificationDoc, type NotificationRefs } from './notifications.model.js';
import type { NotificationDto, NotificationListQuery } from './notifications.schemas.js';
import type { Transport } from './notifications.transport.js';
import { renderTemplate, type TemplateCommon, type TemplateName, type TemplateVars } from './templates/index.js';

export interface NotificationsConfig {
  transport: Transport;
  from: string;
  webUrl: string;
  brandName: string;
}

let config: NotificationsConfig | null = null;

/** Called once by `createApp`; tests get the LOG transport because SMTP_URL is unset. */
export function configureNotifications(next: NotificationsConfig): void {
  config = next;
}

function requireConfig(): NotificationsConfig {
  if (!config) throw new AppError('INTERNAL', 'Notifications are not configured; call configureNotifications() first');
  return config;
}

export type SendRefs = Partial<Record<keyof NotificationRefs, string | null>>;

export interface SendInput<T extends TemplateName> {
  template: T;
  to: string;
  vars: TemplateVars<T>;
  refs?: SendRefs;
}

function refsToIds(refs: SendRefs | undefined): NotificationRefs {
  const pick = (value: string | null | undefined) => (value ? toId(value) : null);
  return {
    cycleId: pick(refs?.cycleId),
    acoId: pick(refs?.acoId),
    customerId: pick(refs?.customerId),
    invitationId: pick(refs?.invitationId),
    userId: pick(refs?.userId),
  };
}

function toDto(doc: NotificationDoc): NotificationDto {
  return {
    id: idString(doc._id),
    channel: doc.channel,
    template: doc.template,
    to: doc.to,
    subject: doc.subject,
    body: doc.body,
    vars: doc.vars,
    refs: {
      cycleId: doc.refs.cycleId ? idString(doc.refs.cycleId) : null,
      acoId: doc.refs.acoId ? idString(doc.refs.acoId) : null,
      customerId: doc.refs.customerId ? idString(doc.refs.customerId) : null,
      invitationId: doc.refs.invitationId ? idString(doc.refs.invitationId) : null,
      userId: doc.refs.userId ? idString(doc.refs.userId) : null,
    },
    status: doc.status,
    error: doc.error,
    sentAt: doc.sentAt?.toISOString() ?? null,
    resendOf: doc.resendOf ? idString(doc.resendOf) : null,
    createdAt: doc.createdAt.toISOString(),
  };
}

/** Delivers a QUEUED row and records SENT or FAILED. Delivery failures never throw. */
async function deliver(doc: NotificationDoc): Promise<NotificationDoc> {
  const { transport, from } = requireConfig();
  try {
    await transport.deliver({ from, to: doc.to, subject: doc.subject, text: doc.body, html: doc.html });
    const sent = await NotificationModel.findByIdAndUpdate(
      doc._id,
      { $set: { status: 'SENT', sentAt: new Date(), error: null } },
      { new: true },
    ).lean<NotificationDoc>();
    return sent ?? doc;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, notificationId: idString(doc._id), to: doc.to }, 'Notification delivery failed');
    const failed = await NotificationModel.findByIdAndUpdate(
      doc._id,
      { $set: { status: 'FAILED', error: message } },
      { new: true },
    ).lean<NotificationDoc>();
    return failed ?? doc;
  }
}

/**
 * Renders a template, writes the notifications row (QUEUED → SENT/FAILED) and
 * delivers it through the configured transport. This is the one way any
 * module sends e-mail.
 */
export async function send<T extends TemplateName>(input: SendInput<T>): Promise<NotificationDto> {
  const { transport, webUrl, brandName } = requireConfig();
  const common: TemplateCommon = { webUrl, brandName };
  const rendered = renderTemplate(input.template, input.vars, common);
  const created = await NotificationModel.create({
    channel: transport.channel,
    template: input.template,
    to: input.to.trim().toLowerCase(),
    subject: rendered.subject,
    body: rendered.text,
    html: rendered.html,
    vars: input.vars,
    refs: refsToIds(input.refs),
    status: 'QUEUED',
  });
  return toDto(await deliver(created.toObject()));
}

function scopeFilter(ctx: RequestContext): FilterQuery<NotificationDoc> {
  switch (ctx.scope.kind) {
    case 'PLATFORM':
      return {};
    case 'ACO':
      return { 'refs.acoId': toId(ctx.scope.acoId) };
    case 'AIRPORT':
      // Notifications are not linked to airports yet; airport users see none.
      return { _id: { $in: [] } };
  }
}

const SORTABLE = ['createdAt', 'status', 'template', 'to'] as const;

export async function listNotifications(ctx: RequestContext, query: NotificationListQuery): Promise<Page<NotificationDto>> {
  const requested: FilterQuery<NotificationDoc> = {};
  if (query.cycleId) requested['refs.cycleId'] = toId(query.cycleId);
  if (query.acoId) requested['refs.acoId'] = toId(query.acoId);
  if (query.userId) requested['refs.userId'] = toId(query.userId);
  if (query.template) requested.template = query.template;
  if (query.status) requested.status = query.status;
  // and() keeps the scope filter authoritative even when the caller passes acoId.
  const filter = and<NotificationDoc>(scopeFilter(ctx), searchFilter<NotificationDoc>(query.q, ['to', 'subject']), requested);
  const sort = parseSort(query.sort, SORTABLE, '-createdAt');
  const { skip, limit } = skipLimit(query);
  const [docs, total] = await Promise.all([
    NotificationModel.find(filter).sort(sort).skip(skip).limit(limit).lean<NotificationDoc[]>(),
    NotificationModel.countDocuments(filter),
  ]);
  return pageOf(docs.map(toDto), total, query);
}

/** Re-delivers an existing notification as a new row linked through `resendOf`; audited. */
export async function resendNotification(ctx: RequestContext, id: string): Promise<NotificationDto> {
  const original = await NotificationModel.findOne(and<NotificationDoc>({ _id: toId(id) }, scopeFilter(ctx))).lean<NotificationDoc>();
  if (!original) throw new AppError('NOT_FOUND', 'Notification not found');
  const { transport } = requireConfig();
  const created = await NotificationModel.create({
    channel: transport.channel,
    template: original.template,
    to: original.to,
    subject: original.subject,
    body: original.body,
    html: original.html,
    vars: original.vars,
    refs: original.refs,
    status: 'QUEUED',
    resendOf: original._id,
  });
  const delivered = await deliver(created.toObject());
  await audit(ctx, {
    action: 'notification.resent',
    entity: 'notification',
    entityId: idString(delivered._id),
    before: { resendOf: idString(original._id), to: original.to, template: original.template },
    after: { status: delivered.status },
    orgId: original.refs.acoId ? idString(original.refs.acoId) : ctx.org.id,
  });
  return toDto(delivered);
}
