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
    // The bot layer talks to src/service and nothing deeper. This is an
    // ALLOWLIST, not a denylist: everything is restricted except the contract
    // barrel, sibling bot files, grammy, and node built-ins — so a new backend
    // module is covered by default instead of forgotten, and deep service
    // imports (../service/handoff.js), src-root files, scripts/, and packages
    // like @prisma/client or @solana/web3.js all fail lint from src/bot.
    files: ['src/bot/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // Restrict everything EXCEPT: same-directory bot files, the
              // service barrel, grammy, and node built-ins. (A regex, because
              // gitignore-style negations do not handle ./ and ../ prefixed
              // specifiers.)
              regex: '^(?!(\\./[^/]+|\\.\\./service/index\\.js|grammy(/.+)?|node:.+)$).*$',
              message:
                'src/bot may only import src/service/index.js, sibling bot files, grammy, and node built-ins — the contract is src/service/index.ts.',
            },
          ],
        },
      ],
    },
  },
  {
    // Custody is reachable only from execution. Tests may exercise the public
    // custody contract, but no other shipping layer can import it.
    files: ['src/**/*.ts'],
    ignores: ['src/custody/**/*.ts', 'src/execution/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/custody/*', './custody/*', '../custody/*'],
              message: 'only src/execution may import src/custody; key material cannot cross layers.',
            },
          ],
        },
      ],
    },
  },
  {
    // Phase 1 holds no keys. If any of these words ever appear in the source,
    // something has gone very wrong and lint should say so loudly. Applies to
    // scripts/ and test/ too — a key-capable import is no more acceptable in a
    // dev aid than in the loop.
    files: ['src/**/*.ts', 'scripts/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/custody/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value=/keypair|bip39|ed25519-hd-key|@solana\\/wallet/i]",
          message: 'Phase 1 must not import anything capable of holding or deriving a key.',
        },
        {
          selector: "ImportSpecifier[imported.name='Keypair']",
          message:
            'Phase 1 must not touch Keypair — no code path may hold or derive a key.',
        },
        {
          selector:
            "ImportExpression[source.value=/keypair|bip39|ed25519-hd-key|@solana\\/wallet/i]",
          message: 'Phase 1 must not import anything capable of holding or deriving a key.',
        },
      ],
    },
  },
  {
    // Dynamic import() would bypass every import rule above. Banned outright
    // in shipping code; tests keep it because vitest's vi.mock factories need
    // `await import(...)` (their key-capable variants are still caught by the
    // literal selector in the previous block).
    files: ['src/**/*.ts', 'scripts/**/*.ts'],
    ignores: ['src/custody/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "ImportDeclaration[source.value=/keypair|bip39|ed25519-hd-key|@solana\\/wallet/i]",
          message: 'Phase 1 must not import anything capable of holding or deriving a key.',
        },
        {
          selector: "ImportSpecifier[imported.name='Keypair']",
          message:
            'Phase 1 must not touch Keypair — no code path may hold or derive a key.',
        },
        {
          selector: 'ImportExpression',
          message:
            'dynamic import() bypasses the boundary and no-keys lint rules; use static imports.',
        },
      ],
    },
  },
  {
    files: ['src/custody/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression',
          message: 'dynamic import() bypasses the boundary rules; use static imports.',
        },
      ],
    },
  },
);
