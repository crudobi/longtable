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
   * Sharing tier (Phase 2/3). Absent/'private' = this device only.
   * 'friends-only' = encrypted shares exist for chosen friends; the
   * plaintext still lives only in this device's doc — encryption happens
   * at publish time, never in the stored document.
   * 'public' = a signed copy lives on the author's ATProto PDS as a
   * kitchen.longtable.recipe record (plaintext, world-readable); the
   * local document remains the source the record is derived from.
   */
  visibility?: 'private' | 'friends-only' | 'public'
  /** ISO-8601 timestamps */
  createdAt: string
  updatedAt: string
}

/** The three visibility tiers a recipe can sit at. */
export type VisibilityTier = NonNullable<Recipe['visibility']>

/** Fields the user supplies; timestamps are assigned by the store. */
export type RecipeInput = Omit<Recipe, 'createdAt' | 'updatedAt'>

/** Partial update — every field optional. */
export interface RecipePatch {
  title?: string
  visibility?: 'private' | 'friends-only' | 'public'
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
