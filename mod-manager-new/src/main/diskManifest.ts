/**
 * The parts of a mod's manifest.json this manager's main process needs to
 * read off disk - a superset of the UI's trimmed `Manifest`
 * (`renderer/src/lib/manifest-types.ts`, LEI-137) that also carries the
 * fields `validateModFolder`-equivalent checks need (contentFolders,
 * blobsFolders, per-option folders) but the renderer never displays.
 *
 * Mirrors `src/types.ts`'s real `Manifest`/`ManifestOptionData` at the repo
 * root, trimmed to what this manager reads. Not imported directly for the
 * same "build standalone" reason as manifest-types.ts.
 */
export interface DiskManifestOption {
  name: string
  type: "checkbox" | "select" | "conditional"
  group?: string
  enabledByDefault?: boolean
  tooltip?: string
  image?: string
  condition?: string
  contentFolders?: string[]
  blobsFolders?: string[]
}

export interface DiskManifest {
  id: string
  name: string
  description: string
  authors: string[]
  version: string
  frameworkVersion: string
  updateCheck?: string
  contentFolders?: string[]
  blobsFolders?: string[]
  options?: DiskManifestOption[]
}
