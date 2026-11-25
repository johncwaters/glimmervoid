import crypto from 'node:crypto';
import { z } from 'zod';

type GithubWebhookEvent =
  | { kind: 'installation-changed'; installationId: number; senderUserId: number | null }
  | { kind: 'authorization-revoked'; senderUserId: number }
  | { kind: 'ignored' };

const SIGNATURE_PREFIX = 'sha256=';
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/;
const DELIVERY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALLATION_EVENT_NAMES: ReadonlySet<string> = new Set(['installation', 'installation_repositories']);
const AUTHORIZATION_EVENT_NAME = 'github_app_authorization';

const PositiveInt = z.number().int().positive();
const Sender = z.object({ id: PositiveInt });
const InstallationPayload = z.object({ installation: z.object({ id: PositiveInt }), sender: Sender.nullish() });
const AuthorizationPayload = z.object({ sender: Sender });

function isSignatureShaped(signatureHeader: string | undefined): signatureHeader is string {
  return signatureHeader !== undefined && SIGNATURE_PATTERN.test(signatureHeader);
}

function isSignatureValid(secret: Buffer, rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!isSignatureShaped(signatureHeader)) return false;
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(rawBody).digest('hex'), 'hex');
  const presented = Buffer.from(signatureHeader.slice(SIGNATURE_PREFIX.length), 'hex');
  return crypto.timingSafeEqual(expected, presented);
}

function isDeliveryId(deliveryId: string | undefined): deliveryId is string {
  return deliveryId !== undefined && DELIVERY_ID_PATTERN.test(deliveryId);
}

function webhookEventOf(eventName: string | undefined, payload: unknown): GithubWebhookEvent {
  if (eventName === AUTHORIZATION_EVENT_NAME) {
    const authorization = AuthorizationPayload.safeParse(payload);
    return authorization.success ? { kind: 'authorization-revoked', senderUserId: authorization.data.sender.id } : { kind: 'ignored' };
  }
  if (eventName === undefined || !INSTALLATION_EVENT_NAMES.has(eventName)) return { kind: 'ignored' };
  const installation = InstallationPayload.safeParse(payload);
  if (!installation.success) return { kind: 'ignored' };
  return { kind: 'installation-changed', installationId: installation.data.installation.id, senderUserId: installation.data.sender?.id ?? null };
}

function createSeenDeliveries(maxRemembered: number) {
  const seenDeliveryIds = new Set<string>();

  function isNew(deliveryId: string): boolean {
    const normalizedId = deliveryId.toLowerCase();
    if (seenDeliveryIds.has(normalizedId)) return false;
    seenDeliveryIds.add(normalizedId);
    if (seenDeliveryIds.size > maxRemembered) seenDeliveryIds.delete(seenDeliveryIds.values().next().value ?? normalizedId);
    return true;
  }

  function forget(deliveryId: string): void {
    seenDeliveryIds.delete(deliveryId.toLowerCase());
  }

  return { isNew, forget };
}

export { createSeenDeliveries, isDeliveryId, isSignatureShaped, isSignatureValid, webhookEventOf };
export type { GithubWebhookEvent };
