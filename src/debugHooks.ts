/**
 * Build-time gate for the e2e debug hooks (`window.__ltFriends`,
 * `window.__ltPublic`).
 *
 * The hooks exist so the emulator proofs can drive pairing, shelf
 * capture, and publishing from outside the WebView. They are powerful —
 * `__ltFriends` exposes friend records including pair secrets, and
 * `__ltPublic.getSession()` returns the ATProto session tokens — so
 * they must never ship in a production artifact.
 *
 * Vite inlines `import.meta.env.VITE_LT_DEBUG_HOOKS` at build time:
 *   - `npm run build` (release / published artifact): flag unset ->
 *     DEBUG_HOOKS_ENABLED is false and the install branches are dead
 *     code, eliminated from the bundle.
 *   - CI proof build (ci/run-pipeline.sh, web-build stage):
 *     VITE_LT_DEBUG_HOOKS=1 -> hooks installed, proofs can drive them.
 *     The pipeline's release-build stage then rebuilds WITHOUT the
 *     flag and publishes that artifact instead, after grepping the
 *     bundle to prove the hooks are absent.
 */
export const DEBUG_HOOKS_ENABLED: boolean =
  import.meta.env.VITE_LT_DEBUG_HOOKS === '1'
