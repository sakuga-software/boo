import { createHmac, timingSafeEqual } from 'node:crypto';

/** True if `header` is the `X-Hub-Signature-256` that GitHub computes for `body` with `secret`. */
export function validSignature(secret: string, body: Buffer, header: string | undefined): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}
