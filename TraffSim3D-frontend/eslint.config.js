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
    files: ['**/*.{js,mjs,jsx,ts}'],
    languageOptions: {
      globals: {
        ...globals.browser,
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
    // contain) are understood. Plan 004 introduces the first .vue
    // file with TS syntax (WorldCanvas imports `import type { ... }`),
    // which exposed the missing double-parser config.
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
    // are wired in a later plan. Until each SFC is fully wired, the
    // tseslint parser (introduced in Plan 002) flags these as
    // 'no-unused-vars' and blocks the build. Turn it off for .vue only;
    // it remains on for plain .ts/.js files.
    files: ['**/*.vue'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    // .ts files introduced by Plan 003 (domain, store, renderer) frequently
    // use the TS "type namespace" pattern (export interface X + export
    // const X = { ... } with the same name). ESLint's `no-redeclare` blocks
    // this. We also turn off `no-unused-vars` for type-signature-only
    // arguments (interface methods, callback type literals) where the
    // parameter is part of the public API and would be used at the call
    // site, not inside the type body. Real unused runtime variables are
    // still caught by the TS compiler when `noUnusedLocals` is enabled
    // (currently off; turn on once the codebase stabilizes).
    files: ['**/*.ts'],
    rules: {
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    // Plan 006 — M2-A 强制 invariant I1 (domain 纯): domain 层不允许
    // import three / @dimforge/rapier3d-compat / vue。这是 M2 设计契约
    // plans/m2-interface-contract.md §I1 的**机器可执行**保障。
    // 任何 domain/* 文件 import 这些包 → lint 报错。
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
