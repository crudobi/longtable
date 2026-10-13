/** Longtable recipe schema. One Y.Doc per recipe. */

export interface Recipe {
  title: string
  ingredients: string[]
  steps: string[]
  /** optional, minutes */
  prepMinutes?: number
  /** optional, minutes */
  cookMinutes?: number
  /** data URLs (image/*), downscaled on import */
  photos: string[]
  /**
   * Sharing tier (Phase 2). Absent/'private' = this device only.
   * 'friends-only' = encrypted shares exist for chosen friends; the
   * plaintext still lives only in this device's doc — encryption happens
   * at publish time, never in the stored document.
   */
  visibility?: 'private' | 'friends-only'
  /** ISO-8601 timestamps */
  createdAt: string
  updatedAt: string
}

/** Fields the user supplies; timestamps are assigned by the store. */
export type RecipeInput = Omit<Recipe, 'createdAt' | 'updatedAt'>

/** Partial update — every field optional. */
export interface RecipePatch {
  title?: string
  visibility?: 'private' | 'friends-only'
  ingredients?: string[]
  steps?: string[]
  prepMinutes?: number
  cookMinutes?: number
  photos?: string[]
}

/** Lightweight list entry kept in the recipe index document. */
export interface RecipeSummary {
  id: string
  title: string
  url: string
  updatedAt: string
}

/** Shape of the dedicated Yjs index document (recipe list -> doc URLs). */
export interface RecipeIndexDoc {
  recipes: Record<string, { title: string; url: string; updatedAt: string }>
}
