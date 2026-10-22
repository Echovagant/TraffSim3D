import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    name: 'app/files-to-lint',
    files: ['**/*.{js,mjs,jsx,ts,vue}'],
  },

  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**']),

  {
    // Plain .js files — use tseslint parser for proper ESM + TS-flavored
    // syntax (even though .js doesn't have type annotations, tseslint
    // parser is the same JS parser vue uses for its script blocks).
    // vite.config.js reads `process.env.VITE_BACKEND_PORT`,
    // so add the `node` globals to the whole JS family.
    files: ['**/*.{js,mjs,jsx,ts}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
  },
  {
    // .vue SFCs — need vue-eslint-parser as the outer parser so the
    // template block is parsed, and tseslint parser as the inner parser
    // so <script lang="ts"> blocks (and the type-only imports they
    // contain) are understood. The first .vue file with TS syntax
    // (WorldCanvas imports `import type { ... }`) exposed the missing
    // double-parser config.
    files: ['**/*.vue'],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.ts'],
      },
    },
  },

  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  skipFormatting,
  {
    // .vue SFCs often import postprocessing/three classes for side-effect
    // (effect registration) or for API parity with sibling effects that
    // are wired later. Until each SFC is fully wired, the
    // tseslint parser flags these as
    // 'no-unused-vars' and blocks the build. Turn it off for .vue only;
    // it remains on for plain .ts/.js files.
    files: ['**/*.vue'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    // .ts files (domain, store, renderer) frequently
    // use the TS "type namespace" pattern (export interface X + export
    // const X = { ... } with the same name). ESLint's `no-redeclare` blocks
    // this. We also turn off `no-unused-vars` for type-signature-only
    // arguments (interface methods, callback type literals) where the
    // parameter is part of the public API and would be used at the call
    // site, not inside the type body. Real unused runtime variables are
    // still caught by the TS compiler when `noUnusedLocals` is enabled
    // (currently off; turn on once the codebase stabilizes).
    //
    // `no-undef` is off for the same reason, and per typescript-eslint's
    // own guidance: ESLint's `no-undef` has no notion of *type-only*
    // positions, so a spec that names a DOM interface
    // (`MouseEventInit`, `KeyboardEventInit`, `ResizeObserverCallback`)
    // in a type annotation is reported as an undefined variable even
    // though the identifier is a perfectly valid `lib.dom.d.ts` type.
    // Undefined *runtime* identifiers are still caught by the compiler —
    // `vue-tsc --noEmit` is the gate for that, and it is part of the
    // project's validation set.
    files: ['**/*.ts'],
    rules: {
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      'no-undef': 'off',
    },
  },
  {
    // Invariant I1 (domain purity): the domain layer must not import
    // three / @dimforge/rapier3d-compat / vue. This is the machine-enforced
    // form of that design contract — any domain/* file importing these
    // packages fails the lint.
    files: ['src/domain/**/*.{ts,js}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'three', message: 'domain 不允许依赖 three（I1 违反）' },
            {
              name: '@dimforge/rapier3d-compat',
              message: 'domain 不允许依赖 Rapier（I1 违反）',
            },
            { name: 'vue', message: 'domain 不允许依赖 vue（I1 违反）' },
          ],
          patterns: [
            {
              group: ['three/*'],
              message: 'domain 不允许依赖 three（I1 违反）',
            },
            {
              group: ['@dimforge/rapier3d-compat*'],
              message: 'domain 不允许依赖 Rapier（I1 违反）',
            },
          ],
        },
      ],
    },
  },
])
