import type { GeneratedDataKey, KmsAdapter } from './types.js';

/**
 * Deliberately unimplemented until the deployment target chooses a KMS.
 * TODO(KMS, design §15.1): implement this adapter for that provider without
 * changing wallet or execution callers.
 */
export class CloudKmsAdapter implements KmsAdapter {
  readonly keyId = 'unconfigured-cloud-kms';

  async generateDataKey(): Promise<GeneratedDataKey> {
    throw new Error('TODO: choose and implement the production KMS provider');
  }

  async decryptDataKey(_encryptedDataKey: Uint8Array): Promise<Uint8Array> {
    throw new Error('TODO: choose and implement the production KMS provider');
  }
}

