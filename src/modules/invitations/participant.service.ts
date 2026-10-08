// The public participant flow (ARCHITECTURE §6 "public participant flow", §7
// "Participant link"): a link token identifies the invitation, a one-time
// code proves the mailbox, and the link session that follows opens the
// assessment, which the assessments module owns. Every handler here runs
// under a system context scoped to the invitation's operator — there is no
// signed-in user — and an unknown token is a plain 404.
import type { LinkSession } from '../../core/auth/link.js';
import { systemContext, type SystemContext } from '../../core/auth/system.js';
import { AppError } from '../../core/errors.js';
import { idString } from '../../core/ids.js';
import { logger } from '../../core/logger.js';
import type { AssessmentFormDto, DraftDto, PatchAnswersResult, ReadinessDto } from '../assessments/assessments.schemas.js';
import { send } from '../notifications/notifications.service.js';

import {
  afterFailedAttempt,
  canResend,
  evaluateOtpAttempt,
  OTP_POLICY,
  otpExpiresAt,
  summariseSends,
  type OtpAttemptBlock,
} from './domain/otpPolicy.js';
import { effectiveState, isExpired, isLive, transition } from './domain/states.js';
import { generateOtp, hashOtp, maskEmail, maskName, otpMatches } from './domain/token.js';
import { invitationsConfig } from './invitations.config.js';
import { contactNameOf, operatorFacts } from './invitations.mail.js';
import { InvitationModel, type InvitationDoc } from './invitations.model.js';
import {
  assessmentDraft,
  assessmentForm,
  assessmentReadiness,
  bumpStarted,
  getOrCreateAssessment,
  patchAssessmentAnswers,
  submitAssessment,
} from './invitations.peers.js';
import type { AnswersInput, OtpDto, ParticipantStatusDto, SubmitDto, VerifyDto } from './invitations.schemas.js';
import { getByToken, requireCycle } from './invitations.service.js';
import { otpIpLimiter } from './otp-limiter.js';

/** The participant link session lives 12 hours (§6 `/verify`). */
export const SESSION_TTL_SECONDS = 12 * 60 * 60;

/** What the system does on a participant's behalf; the operator it may touch is spelled out. */
export interface ParticipantContext extends SystemContext {
  readonly invitationId: string;
  readonly acoId: string;
}

export function participantContext(invitation: Pick<InvitationDoc, '_id' | 'acoId'>): ParticipantContext {
  const invitationId = idString(invitation._id);
  const acoId = idString(invitation.acoId);
  return { ...systemContext(`participant link: invitation ${invitationId} (aco ${acoId})`), invitationId, acoId };
}

// --- lookup ------------------------------------------------------------------

/** Unknown, malformed and never-sent tokens all read the same: 404. */
async function requireInvitation(token: string): Promise<InvitationDoc> {
  const invitation = await getByToken(token);
  if (!invitation) throw new AppError('NOT_FOUND', 'Invitation not found');
  return invitation;
}

/** The link must still be usable: not past the window, not revoked, not already submitted. */
function assertLive(invitation: InvitationDoc, now: Date): void {
  if (isExpired(invitation, now)) throw new AppError('LINK_EXPIRED', 'The assessment window has closed');
  if (isLive(invitation.state)) return;
  if (invitation.state === 'SUBMITTED') throw new AppError('PRECONDITION_FAILED', 'This assessment has already been submitted');
  throw new AppError('LINK_EXPIRED', 'This invitation is no longer valid');
}

// --- status ------------------------------------------------------------------

/** `GET /public/assess/:token`: the page's facts; a first visit moves SENT → OPENED. */
export async function participantStatus(token: string, now = new Date()): Promise<ParticipantStatusDto> {
  const invitation = await markOpened(await requireInvitation(token), now);
  const cycle = await requireCycle(participantContext(invitation), idString(invitation.cycleId));
  const operator = await operatorFacts(invitation.acoId);
  return {
    state: effectiveState(invitation, now),
    cycle: { id: cycle.id, name: cycle.name, tz: cycle.tz, assessmentEnd: cycle.assessment.end.toISOString() },
    operator: { name: operator.name, airport: operator.airport },
    surveyType: invitation.surveyType,
    customer: { nameMasked: maskName(invitation.customer.name), emailMasked: maskEmail(invitation.email), type: invitation.customer.type },
    submittedAt: invitation.submittedAt?.toISOString() ?? null,
    expiresAt: invitation.expiresAt.toISOString(),
  };
}

async function markOpened(invitation: InvitationDoc, now: Date): Promise<InvitationDoc> {
  if (invitation.state !== 'SENT' || isExpired(invitation, now)) return invitation;
  const updated = await InvitationModel.findOneAndUpdate(
    { _id: invitation._id, state: 'SENT' },
    { $set: { state: 'OPENED', openedAt: now } },
    { new: true },
  ).lean<InvitationDoc>();
  return updated ?? invitation;
}

// --- one-time code -----------------------------------------------------------

export interface OtpRequestOptions {
  /** The caller's network address, for the per-address budget; omitted in service-level calls. */
  ip?: string | undefined;
  now?: Date | undefined;
}

/**
 * `POST /public/assess/:token/otp`: a six-digit code valid ten minutes, hashed
 * on the invitation, e-mailed to the sampled address. Throttled per token
 * (30 s cooldown, three per ten minutes — `canResend`) and per address.
 * Requesting a code counts as opening the link.
 */
export async function requestOtp(token: string, options: OtpRequestOptions = {}): Promise<OtpDto> {
  const now = options.now ?? new Date();
  const invitation = await requireInvitation(token);
  assertLive(invitation, now);
  if (options.ip !== undefined) {
    const verdict = otpIpLimiter.check(options.ip, now);
    if (!verdict.allowed) {
      throw new AppError('RATE_LIMITED', 'Too many codes requested from this address; try again later', { reason: 'ADDRESS', retryAfterMs: verdict.retryAfterMs });
    }
  }
  const resend = canResend({ ...summariseSends(invitation.otp.sentAts, now), now });
  if (!resend.allowed) {
    const message = resend.reason === 'COOLDOWN' ? 'Please wait a moment before requesting another code' : 'Too many codes requested; try again later';
    throw new AppError('RATE_LIMITED', message, { reason: resend.reason, retryAfterMs: resend.retryAfterMs });
  }

  const otp = generateOtp();
  const expiresAt = otpExpiresAt(now);
  const opened = transition(invitation.state, 'OPEN');
  if (!opened.ok) throw new AppError('PRECONDITION_FAILED', opened.reason);
  const windowStart = now.getTime() - OTP_POLICY.resendWindowMs;
  const sentAts = [...invitation.otp.sentAts.filter((at) => at.getTime() > windowStart), now];
  const updated = await InvitationModel.findOneAndUpdate(
    { _id: invitation._id, state: invitation.state },
    {
      $set: {
        state: opened.state,
        openedAt: invitation.openedAt ?? now,
        'otp.hash': hashOtp(otp, otpScope(invitation)),
        'otp.expiresAt': expiresAt,
        'otp.attempts': 0,
        'otp.sentAts': sentAts,
      },
    },
    { new: true },
  ).lean<InvitationDoc>();
  if (!updated) throw new AppError('CONFLICT', 'The invitation changed; reload and try again');
  if (options.ip !== undefined) otpIpLimiter.record(options.ip, now);

  const operator = await operatorFacts(updated.acoId);
  await send({
    template: 'assessment-otp',
    to: updated.email,
    vars: { contactName: contactNameOf(updated), operatorName: operator.name, otp, expiresInMinutes: OTP_POLICY.ttlMs / 60_000 },
    refs: { cycleId: idString(updated.cycleId), acoId: idString(updated.acoId), customerId: idString(updated.customerId), invitationId: idString(updated._id) },
  });
  return { sent: true, expiresAt: expiresAt.toISOString(), ...(invitationsConfig().revealOtp ? { devOtp: otp } : {}) };
}

/** The OTP hash is scoped by the invitation id, so a code in flight survives a reminder's token rotation. */
function otpScope(invitation: Pick<InvitationDoc, '_id'>): string {
  return idString(invitation._id);
}

const OTP_BLOCK_MESSAGE: Record<OtpAttemptBlock, string> = {
  NO_OTP: 'Request a code first',
  EXPIRED: 'The code has expired; request a new one',
  LOCKED: 'Too many wrong attempts; request a new code',
};

/**
 * `POST /public/assess/:token/verify`: checks the code (five wrong guesses
 * lock it until a new one is requested), moves the invitation to VERIFIED,
 * consumes the code, makes sure the assessment exists and signs the link
 * session `{ inv, asg, aco }`. The first verification counts the participant
 * as started.
 */
export async function verifyOtp(token: string, otp: string, now = new Date()): Promise<VerifyDto> {
  const invitation = await requireInvitation(token);
  assertLive(invitation, now);
  const attempt = evaluateOtpAttempt({ attempts: invitation.otp.attempts, expiresAt: invitation.otp.expiresAt, now });
  if (!attempt.allowed || invitation.otp.hash === null) {
    const reason = attempt.reason ?? 'NO_OTP';
    throw new AppError('OTP_INVALID', OTP_BLOCK_MESSAGE[reason], { reason, attemptsLeft: 0 });
  }
  if (!otpMatches(otp, otpScope(invitation), invitation.otp.hash)) {
    const outcome = afterFailedAttempt(invitation.otp.attempts);
    await InvitationModel.updateOne({ _id: invitation._id, 'otp.hash': invitation.otp.hash }, { $inc: { 'otp.attempts': 1 } });
    throw new AppError('OTP_INVALID', outcome.locked ? OTP_BLOCK_MESSAGE.LOCKED : 'Incorrect code', {
      reason: outcome.locked ? 'LOCKED' : 'MISMATCH',
      attemptsLeft: outcome.attemptsLeft,
    });
  }

  const opened = transition(invitation.state, 'OPEN');
  const verified = transition(opened.ok ? opened.state : invitation.state, 'VERIFY');
  if (!verified.ok) throw new AppError('PRECONDITION_FAILED', verified.reason);
  const firstVerification = invitation.verifiedAt === null;
  const updated = await InvitationModel.findOneAndUpdate(
    { _id: invitation._id, state: invitation.state, 'otp.hash': invitation.otp.hash },
    {
      $set: {
        state: verified.state,
        openedAt: invitation.openedAt ?? now,
        verifiedAt: invitation.verifiedAt ?? now,
        'otp.hash': null,
        'otp.expiresAt': null,
        'otp.attempts': 0,
      },
    },
    { new: true },
  ).lean<InvitationDoc>();
  if (!updated) throw new AppError('OTP_INVALID', 'The code was already used; request a new one', { reason: 'CONSUMED', attemptsLeft: 0 });

  const assessmentId = await ensureAssessment(updated);
  if (firstVerification) await countStarted(updated);

  const invitationId = idString(updated._id);
  const sessionToken = await invitationsConfig().links.sign({
    audience: 'participant',
    subject: invitationId,
    claims: { inv: invitationId, asg: assessmentId, aco: idString(updated.acoId) },
    ttlSeconds: SESSION_TTL_SECONDS,
  });
  return { sessionToken, expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(), assessmentId };
}

/** One invitation ⇒ one assessment: created by assessments on first verification, remembered on the invitation. */
async function ensureAssessment(invitation: InvitationDoc): Promise<string> {
  if (invitation.assessmentId) return idString(invitation.assessmentId);
  const assessmentId = await getOrCreateAssessment(invitation);
  await InvitationModel.updateOne({ _id: invitation._id, assessmentId: null }, { $set: { assessmentId } });
  return assessmentId;
}

/** `cycle_participants.stats.started` is derived data: a missing participant is logged, never a failed verification. */
async function countStarted(invitation: InvitationDoc): Promise<void> {
  try {
    await bumpStarted(idString(invitation.cycleId), idString(invitation.acoId));
  } catch (error) {
    if (error instanceof AppError && error.code === 'NOT_FOUND') {
      logger.warn({ invitationId: idString(invitation._id), err: error }, 'Participant stats not updated: participant not found');
      return;
    }
    throw error;
  }
}

// --- with the link session ---------------------------------------------------

export interface LinkedInvitation {
  invitation: InvitationDoc;
  assessmentId: string;
  ctx: ParticipantContext;
}

/**
 * The session must belong to the invitation the URL names (`inv`) and to the
 * assessment the invitation owns (`asg`); the invitation must be verified
 * (or submitted: the answers stay readable) and inside the window. A session
 * from before a resend no longer matches a SENT invitation.
 */
export async function requireLinkedInvitation(token: string, link: LinkSession, now = new Date()): Promise<LinkedInvitation> {
  const invitation = await requireInvitation(token);
  const invitationId = idString(invitation._id);
  if (link.subject !== invitationId || link.claims['inv'] !== invitationId) throw new AppError('NOT_FOUND', 'Invitation not found');
  if (isExpired(invitation, now)) throw new AppError('LINK_EXPIRED', 'The assessment window has closed');
  if (invitation.state === 'REVOKED') throw new AppError('LINK_EXPIRED', 'This invitation is no longer valid');
  if (invitation.state !== 'VERIFIED' && invitation.state !== 'SUBMITTED') {
    throw new AppError('UNAUTHENTICATED', 'Verify the one-time code first');
  }
  const assessmentId = invitation.assessmentId ? idString(invitation.assessmentId) : null;
  if (assessmentId === null || link.claims['asg'] !== assessmentId) {
    throw new AppError('UNAUTHENTICATED', 'This session does not match the invitation; verify the code again');
  }
  return { invitation, assessmentId, ctx: participantContext(invitation) };
}

export async function participantForm(token: string, link: LinkSession): Promise<AssessmentFormDto> {
  const { assessmentId } = await requireLinkedInvitation(token, link);
  return assessmentForm(assessmentId);
}

export async function participantDraft(token: string, link: LinkSession): Promise<DraftDto> {
  const { assessmentId } = await requireLinkedInvitation(token, link);
  return assessmentDraft(assessmentId);
}

export async function participantPatchAnswers(token: string, link: LinkSession, input: AnswersInput): Promise<PatchAnswersResult> {
  const { assessmentId } = await requireLinkedInvitation(token, link);
  return patchAssessmentAnswers(assessmentId, input.answers);
}

export async function participantReadiness(token: string, link: LinkSession): Promise<ReadinessDto> {
  const { assessmentId } = await requireLinkedInvitation(token, link);
  return assessmentReadiness(assessmentId);
}

/**
 * `POST …/submit`: assessments locks the answers and emits
 * `assessment.submitted`; this module's listener turns the invitation
 * SUBMITTED and sends the thank-you inside that same transaction.
 */
export async function participantSubmit(token: string, link: LinkSession): Promise<SubmitDto> {
  const { invitation, assessmentId } = await requireLinkedInvitation(token, link);
  if (invitation.state === 'SUBMITTED') throw new AppError('PRECONDITION_FAILED', 'This assessment has already been submitted');
  const assessment = await submitAssessment(link, assessmentId);
  const after = await InvitationModel.findById(invitation._id).lean<InvitationDoc>();
  return { state: after?.state ?? 'SUBMITTED', submittedAt: after?.submittedAt?.toISOString() ?? null, assessment };
}
