import { Repo } from '@automerge/automerge-repo'
import { IndexedDBStorageAdapter } from '@automerge/automerge-repo-storage-indexeddb'

export const REPO_DB_NAME = 'longtable'

let repo: Repo | undefined

/**
 * App-wide Repo singleton. One Automerge document per recipe, persisted to
 * IndexedDB via the repo's IndexedDB storage adapter. Phase 0: no network
 * adapters are configured, so the repo is purely local.
 */
export function getRepo(): Repo {
  if (!repo) {
    repo = createRepo()
  }
  return repo
}

/** Create a Repo instance against the given IndexedDB database name. */
export function createRepo(dbName: string = REPO_DB_NAME): Repo {
  return new Repo({ storage: new IndexedDBStorageAdapter(dbName) })
}

/** Test hook: drop the singleton so tests can build isolated instances. */
export function resetRepoForTests(): void {
  repo = undefined
}
