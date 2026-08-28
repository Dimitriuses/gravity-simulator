import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint rules, in ESLint's flat-config format.
 *
 * `tsc --strict` with `noUnusedLocals` had caught everything worth catching up
 * to now, so this is deliberately not a style police: the rules kept are the
 * ones that catch *mistakes* a type checker cannot see. Formatting is left
 * alone entirely — there is no formatter in this project and adding one would
 * rewrite every file in it.
 *
 * Three environments, and they are genuinely different: `src/` is TypeScript
 * for a browser, `tests/` is TypeScript for Node with Vitest's globals off
 * (this project imports `describe`/`it` explicitly), and `tools/` is plain
 * ESM JavaScript for Node with no type information at all.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'screenshots/**'],
  },

  js.configs.recommended,

  // ── src and tests: TypeScript ─────────────────────────────────────────────
  {
    files: ['src/**/*.ts', 'tests/**/*.ts', 'vite.config.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      // The type checker already refuses an unused local; what it does not
      // refuse is an unused *parameter*, and a leading underscore is this
      // project's existing way of saying "deliberately ignored".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // `any` is a hole in the one guarantee the rest of the project relies on.
      '@typescript-eslint/no-explicit-any': 'error',
      // Both of these are bugs that typecheck cleanly: a `==` that coerces, and
      // a `case` that falls into the next one because a `break` was forgotten.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-fallthrough': 'error',
      // A promise nobody waits for is an error nobody sees.
      'no-async-promise-executor': 'error',
      // The one layout rule this project enforces. See the note at the top of
      // this file: there is no formatter, so the conventions the docs claim are
      // kept by hand — and a claim nothing checks is a claim that drifts.
      'max-len': ['error', { code: 100, ignoreUrls: true }],
    },
  },

  // ── tools: Node, plain JavaScript ─────────────────────────────────────────
  {
    files: ['tools/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // The smoke test hands functions to the browser as source text, which is
      // the only way to run a pixel scan inside the page. Warn rather than
      // error: it is doing something unusual on purpose, and the call sites say
      // so.
      'no-new-func': 'warn',
      // Same limit as `src`, but not applied to strings: these tools print
      // markdown, and a table row is one string whose length is the width of
      // the table rather than a matter of layout.
      'max-len': [
        'error',
        { code: 100, ignoreUrls: true, ignoreStrings: true, ignoreTemplateLiterals: true },
      ],
    },
  },

  // The smoke test's page.evaluate callbacks run in the browser, so both sets
  // of globals are in scope in one file.
  {
    files: ['tools/smoketest.mjs'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  }
);
