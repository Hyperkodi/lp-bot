import tseslint from 'typescript-eslint';

/**
 * The architectural rule from the spec (§4/§15.4), enforced rather than
 * documented: decision/ and virtual/ are pure. They may not import anything
 * from poller/, ledger/ or report/, and they may not reach the network or the
 * clock. Break that and the replay harness stops meaning anything.
 */
const pureLayerRules = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['**/poller/*', '**/ledger/*', '**/report/*', '../poller/*', '../ledger/*', '../report/*'],
          message:
            'decision/ and virtual/ must stay pure: no imports from the I/O layers (poller, ledger, report).',
        },
        {
          group: ['**/clock.js', '../clock.js'],
          message: 'decision/ and virtual/ must not read the clock; use snapshot.ts.',
        },
      ],
    },
  ],
  'no-restricted-globals': [
    'error',
    { name: 'fetch', message: 'the pure layer must not perform I/O' },
    { name: 'setTimeout', message: 'the pure layer must not schedule work' },
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'the pure layer must not read the clock; use snapshot.ts' },
    { object: 'Math', property: 'random', message: 'the pure layer must be deterministic' },
  ],
};

export default tseslint.config(
  { ignores: ['src/generated/**', 'node_modules/**', 'dist/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      // Underscore-prefixed bindings are intentional discards — the rest-object
      // idiom for dropping fields needs them.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['src/decision/**/*.ts', 'src/virtual/**/*.ts', 'src/signals/**/*.ts', 'src/binMath.ts'],
    rules: pureLayerRules,
  },
  {
    // Phase 1 holds no keys. If any of these words ever appear in the source,
    // something has gone very wrong and lint should say so loudly.
    files: ['src/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value=/keypair|bip39|ed25519-hd-key|@solana\\/wallet/i]",
          message: 'Phase 1 must not import anything capable of holding or deriving a key.',
        },
      ],
    },
  },
);
