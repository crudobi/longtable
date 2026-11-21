/**
 * Getting backup/export files on and off the device — Wave 3 C3.
 *
 * Platform-appropriate path, with no new native dependency:
 *  - Web Share API with files when the platform offers it (Android
 *    share sheet, iOS, modern desktop browsers): the user picks Files,
 *    Drive, email, or any other target themselves.
 *  - Otherwise a plain anchor download (PWA / desktop web).
 *
 * No Capacitor Filesystem/Share plugin is added: the Web Share path
 * covers Android's share sheet (save to Files included), and a new
 * native plugin + `cap sync` + native wiring would be a bigger change
 * for the same user outcome. If a future pass wants direct-to-Files
 * saving without the share sheet, that is the plugin to add.
 */

/** Whether this platform can share a file via the system share sheet. */
export function canShareFiles(file: File): boolean {
  try {
    return (
      typeof navigator !== 'undefined' &&
      typeof navigator.share === 'function' &&
      (typeof navigator.canShare !== 'function' || navigator.canShare({ files: [file] }))
    )
  } catch {
    return false
  }
}

/** Download text content as a file (anchor + blob URL). */
export function downloadTextFile(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoke on the next tick: revoking synchronously can cancel the
    // download in some browsers before it starts.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}

/**
 * Offer a file to the user: system share sheet when available, download
 * otherwise. Returns which path was taken. Throws only when the share
 * itself fails for a reason other than the user dismissing it.
 */
export async function shareOrDownloadFile(
  filename: string,
  text: string,
  mime = 'application/json',
): Promise<'shared' | 'downloaded'> {
  const file = new File([text], filename, { type: mime })
  if (canShareFiles(file)) {
    try {
      await navigator.share({ files: [file] })
      return 'shared'
    } catch (e) {
      // The user dismissing the sheet is not an error: fall through to
      // the download so they still get the file. Anything else is also
      // best served by the download rather than a dead end.
      if (e instanceof Error && e.name !== 'AbortError') {
        console.warn('share failed, falling back to download', e)
      }
    }
  }
  downloadTextFile(filename, text, mime)
  return 'downloaded'
}
