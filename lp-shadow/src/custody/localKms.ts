import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

  /** Development-only persistent master key for resumable devnet proofs. The
   * file must live in an ignored local directory and is created owner-only. */
  static async fromDevelopmentKeyFile(path: string): Promise<LocalKmsAdapter> {
    let masterKey: Buffer;
    try {
      masterKey = await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(dirname(path), { recursive: true });
      masterKey = randomBytes(32);
      try {
        await writeFile(path, masterKey, { flag: 'wx', mode: 0o600 });
      } catch (writeError) {
        masterKey.fill(0);
        if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
        masterKey = await readFile(path);
      }
    }
    if (masterKey.byteLength !== 32) {
      masterKey.fill(0);
      throw new Error('development KMS key file must contain exactly 32 bytes');
    }
    const copy = Uint8Array.from(masterKey);
    masterKey.fill(0);
    return new LocalKmsAdapter(copy);
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
