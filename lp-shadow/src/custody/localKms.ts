import { randomBytes } from 'node:crypto';
import { decryptEnvelope, encryptEnvelope } from './crypto.js';
import type { GeneratedDataKey, KmsAdapter } from './types.js';

const MASTER_KEY_ENV = 'LPBOT_LOCAL_KMS_MASTER_KEY';
const WRAP_AAD = Buffer.from('armara:local-kms:data-key:v1');

export class LocalKmsAdapter implements KmsAdapter {
  readonly keyId = 'local-dev-aes256gcm';

  private constructor(private readonly masterKey: Uint8Array) {}

  static fromEnvironment(env: Record<string, string | undefined> = process.env): LocalKmsAdapter {
    const encoded = env[MASTER_KEY_ENV];
    if (!encoded) throw new Error(`${MASTER_KEY_ENV} is required for the development KMS adapter`);
    const decoded = Buffer.from(encoded, 'base64');
    if (decoded.byteLength !== 32) {
      decoded.fill(0);
      throw new Error(`${MASTER_KEY_ENV} must decode to exactly 32 bytes`);
    }
    const masterKey = Uint8Array.from(decoded);
    decoded.fill(0);
    return new LocalKmsAdapter(masterKey);
  }

  async generateDataKey(): Promise<GeneratedDataKey> {
    const plaintextDataKey = Uint8Array.from(randomBytes(32));
    return {
      plaintextDataKey,
      encryptedDataKey: encryptEnvelope(this.masterKey, plaintextDataKey, WRAP_AAD),
    };
  }

  async decryptDataKey(encryptedDataKey: Uint8Array): Promise<Uint8Array> {
    return decryptEnvelope(this.masterKey, encryptedDataKey, WRAP_AAD);
  }
}
