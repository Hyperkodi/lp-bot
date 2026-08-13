import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

function checkedKey(key: Uint8Array): Buffer {
  if (key.byteLength !== KEY_BYTES) throw new Error('AES-256-GCM key must be 32 bytes');
  return Buffer.from(key);
}

export function encryptEnvelope(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  const keyCopy = checkedKey(key);
  try {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', keyCopy, iv);
    cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Uint8Array.from(Buffer.concat([Buffer.from([VERSION]), iv, tag, ciphertext]));
  } finally {
    keyCopy.fill(0);
  }
}

export function decryptEnvelope(
  key: Uint8Array,
  envelope: Uint8Array,
  aad: Uint8Array,
): Uint8Array {
  if (envelope.byteLength < 1 + IV_BYTES + TAG_BYTES || envelope[0] !== VERSION) {
    throw new Error('cannot decrypt: invalid ciphertext envelope');
  }
  const keyCopy = checkedKey(key);
  try {
    const bytes = Buffer.from(envelope);
    const iv = bytes.subarray(1, 1 + IV_BYTES);
    const tag = bytes.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
    const ciphertext = bytes.subarray(1 + IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', keyCopy, iv);
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(tag);
    return Uint8Array.from(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } finally {
    keyCopy.fill(0);
  }
}

