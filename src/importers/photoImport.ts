/**
 * Photo importer: attach local photos to a recipe.
 *
 * No network involved — files are read locally and stored as data URLs in
 * the recipe's Automerge document. Large images are downscaled to a maximum
 * dimension of 1280px (JPEG, quality 0.85) so IndexedDB stays reasonable.
 */

const MAX_DIMENSION = 1280

export async function filesToDataUrls(files: Iterable<File>): Promise<string[]> {
  const out: string[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue
    out.push(await imageFileToDataUrl(file))
  }
  return out
}

function imageFileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'))
    reader.onload = () => {
      const original = reader.result as string
      const img = new Image()
      img.onerror = () => resolve(original) // unparseable image: keep the original bytes
      img.onload = () => {
        const scale = Math.min(1, MAX_DIMENSION / Math.max(img.width, img.height))
        if (scale >= 1 || img.width === 0) {
          resolve(original)
          return
        }
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.width * scale)
        canvas.height = Math.round(img.height * scale)
        const ctx = canvas.getContext('2d')
        if (!ctx) {
          resolve(original)
          return
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
        resolve(canvas.toDataURL('image/jpeg', 0.85))
      }
      img.src = original
    }
    reader.readAsDataURL(file)
  })
}
