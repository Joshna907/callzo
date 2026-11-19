import { createHmac, timingSafeEqual } from 'node:crypto';

export function isSignatureFormatValid(signature: string | undefined): signature is string {
  return signature !== undefined && /^[a-f\d]{64}$/i.test(signature);
}

export function verifySignature(body: Uint8Array, signature: string, secret: string): boolean {
  if (!isSignatureFormatValid(signature)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'));
}
