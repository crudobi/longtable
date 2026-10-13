import { defineConfig } from 'vitest/config'

// AppView is a standalone package inside the repo. Its test files use the
// `.appview-test.mjs` suffix so the ROOT package's vitest sweep (which runs
// in CI without appview's node_modules installed) does not try to execute
// them; run `npm test` here, where appview's deps exist.
export default defineConfig({
  test: {
    include: ['test/**/*.appview-test.mjs'],
  },
})
