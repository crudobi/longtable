// ESLint flat config (M-N).
//
// Scope: the TypeScript app (src/) and the root TS config files, plus
// — since Wave 5D (Sec L23) — the plain-JS server-side subprojects
// (appview/, hub/, signaling/, services/, e2e/, scripts/, examples/,
// tools/, and the .mjs files under src/). Those run under Node, so
// they get node globals and the JS recommended rules, but NOT the
// TypeScript rules or the React Hooks plugin (they are plain .mjs).
// Their test suites still run in CI as before; lint is now a second
// gate on the same files.
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
  {
    files: [
      'appview/**/*.mjs',
      'hub/**/*.mjs',
      'signaling/**/*.mjs',
      'services/**/*.mjs',
      'e2e/**/*.mjs',
      'scripts/**/*.mjs',
      'examples/**/*.mjs',
      'tools/**/*.mjs',
      'src/**/*.mjs',
    ],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
)
