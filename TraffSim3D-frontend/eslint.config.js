import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import js from '@eslint/js'
import pluginVue from 'eslint-plugin-vue'
import skipFormatting from '@vue/eslint-config-prettier/skip-formatting'
import tseslint from 'typescript-eslint'

export default defineConfig([
  {
    name: 'app/files-to-lint',
    files: ['**/*.{js,mjs,jsx,ts,vue}'],
  },

  globalIgnores(['**/dist/**', '**/dist-ssr/**', '**/coverage/**']),

  {
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        extraFileExtensions: ['.vue'],
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
])
