/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** '1' only in the CI proof build — see src/debugHooks.ts. */
  readonly VITE_LT_DEBUG_HOOKS?: string
  /** Dev TURN password, injected only into non-release builds — see src/hubs/hubs.ts. */
  readonly VITE_LT_DEV_TURN_PASSWORD?: string
}

