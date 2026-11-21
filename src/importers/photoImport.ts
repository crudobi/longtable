/**
 * Photo importer: attach local photos to a recipe.
 *
 * No network involved — files are read locally and stored as data URLs in
 * the recipe document. Large images are downscaled to a maximum
 * dimension of 1280px so IndexedDB stays reasonable.
 *
 * Failure is fail-visible (M18): a file that cannot be decoded is
 * reported in `failed` (by file name) instead of being kept at full
 * size as if the downscale had worked, and `attachPhotos` callers show
 * that list. `filesToDataUrls` keeps the old fail-the-batch contract
 * for any caller that wants it; `filesToDataUrlsDetailed` is the
 * partial-success form the form uses.
 */

const MAX_DIMENSION = 1280

/** Result of attaching a batch of photos: the good ones, and the names
 *  of the files that could not be read as images. */
export interface PhotoAttachResult {
  urls: string[]
  failed: string[]
}

/**
 * Output encoding for a downscaled photo: PNG stays PNG so transparency
 * survives (M18 — a transparent PNG downscaled to JPEG used to come
 * out with a black background); anything else becomes JPEG.
 */
export function downscaleOutputMime(fileType: string): 'image/png' | 'image/jpeg' {
  return fileType === 'image/png' ? 'image/png' : 'image/jpeg'
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'))
    reader.onload = () => resolve(reader.result as string)
    reader.readAsDataURL(file)
  })
}

/** Draw a decoded image (or bitmap) down to MAX_DIMENSION, or return
 *  the original data URL when no downscale is needed — or when the
 *  platform cannot provide a canvas context at all. */
function downscaleToDataUrl(
  source: CanvasImageSource & { width: number; height: number },
  fileType: string,
  original: string,
): string {
  const scale = Math.min(1, MAX_DIMENSION / Math.max(source.width, source.height))
  if (scale >= 1 || source.width === 0) return original
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.width * scale)
  canvas.height = Math.round(source.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return original
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas.toDataURL(downscaleOutputMime(fileType), 0.85)
}

/** Decode via an <img> element. Rejects when the bytes are not a
 *  decodable image — the caller reports the file instead of keeping
 *  the undecodable original as a "photo". */
function loadViaImageElement(original: string, fileType: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onerror = () =>
      reject(new Error('could not be decoded as an image — the file may be damaged or in an unsupported format'))
    img.onload = () => {
      try {
        resolve(downscaleToDataUrl(img, fileType, original))
      } catch (e) {
        reject(e instanceof Error ? e : new Error('could not be downscaled'))
      }
    }
    img.src = original
  })
}

async function imageFileToDataUrl(file: File): Promise<string> {
  const original = await readFileAsDataUrl(file)
  // EXIF-aware decode when the platform offers it: createImageBitmap
  // with imageOrientation 'from-image' applies the photo's orientation
  // tag, so a portrait phone photo no longer lands sideways (M18).
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      try {
        return downscaleToDataUrl(bitmap, file.type, original)
      } finally {
        bitmap.close()
      }
    } catch {
      // A bitmap decode failure is not conclusive (older WebViews reject
      // the options object) — fall through to the <img> path, which
      // rejects for real when the bytes are undecodable.
    }
  }
  return loadViaImageElement(original, file.type)
}

export async function filesToDataUrlsDetailed(
  files: Iterable<File>,
): Promise<PhotoAttachResult> {
  const urls: string[] = []
  const failed: string[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    try {
      urls.push(await imageFileToDataUrl(file))
    } catch {
      failed.push(file.name || 'an unnamed image')
    }
  }
  return { urls, failed }
}

export async function filesToDataUrls(files: Iterable<File>): Promise<string[]> {
  const { urls, failed } = await filesToDataUrlsDetailed(files)
  if (failed.length > 0) {
    throw new Error(
      `Could not read ${failed.length === 1 ? 'this photo' : 'these photos'} as images: ${failed.join(', ')}.`,
    )
  }
  return urls
}
