// ESLint flat config (M-N).
//
// Scope: the TypeScript app (src/) and the root TS config files. The
// plain-JS subprojects (appview/, hub/, signaling/, services/, e2e/)
// run under their own test suites in CI; bringing them under this
// config is a separate step.
import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  {
    ignores: ['dist/**', 'android/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'vite.config.ts', 'capacitor.config.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      // Error, not warn: when this config landed, the whole tree —
      // including App.tsx's deliberate ref-mirrors of callbacks for
      // the localhost API host — measured zero violations, so the
      // gate holds the line from a clean start.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
)
