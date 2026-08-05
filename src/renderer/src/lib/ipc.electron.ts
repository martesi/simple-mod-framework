import type { Config, DefaultPaths, ModEntry } from "./manifest-types"
import type { DeployProgress, DeploySnapshot, ModBuildInfo, ModTaskUpdate, SmfApi, Unsubscribe } from "./ipc"

/**
 * The real `SmfApi` implementation (LEI-134), backed by the `smf` bridge
 * `preload/index.ts` exposes via `contextBridge`. Swap point named in
 * `ipc.ts`'s own doc comment and `main.tsx` - nothing in `src/components`
 * imports this file (or `window.smf`) directly, so the mock/real split stays
 * invisible to every screen.
 */
export function createElectronSmfApi(): SmfApi {
  const bridge = window.smf

  return {
    config: {
      get: () => bridge.config.get() as Promise<Config>,
      merge: (patch) => bridge.config.merge(patch) as Promise<Config>,
      pickGameDirectory: (persist) => bridge.config.pickGameDirectory(persist) as Promise<{ ok: true; config: Config } | { ok: false; error: string }>,
      getDefaultPaths: () => bridge.config.getDefaultPaths() as Promise<DefaultPaths>,
      previewPaths: (gamePath) => bridge.config.previewPaths(gamePath) as Promise<{ cachePath: string; modPath: string }>
    },

    system: {
      pickDirectory: (options) => bridge.system.pickDirectory(options)
    },

    mods: {
      list: () => bridge.mods.list() as Promise<ModEntry[]>,

      previewFolder: (dir) => bridge.mods.previewFolder(dir) as Promise<{ exists: boolean; count: number }>,

      rebuildIndex: () => bridge.mods.rebuildIndex() as Promise<ModEntry[]>,

      beginAdd: (file) => bridge.mods.beginAdd(file),

      onTaskUpdate: (cb: (update: ModTaskUpdate) => void): Unsubscribe => bridge.mods.onTaskUpdate((update) => cb(update as ModTaskUpdate)),

      onCacheProgress: (cb: (progress: { scanned: number; total: number }) => void): Unsubscribe =>
        bridge.mods.onCacheProgress((progress) => cb(progress as { scanned: number; total: number })),

      remove: (modId) => bridge.mods.remove(modId) as Promise<{ ok: boolean; reason?: string }>,

      buildStatuses: () => bridge.mods.buildStatuses() as Promise<ModBuildInfo[]>,

      rebuildCacheDb: () => bridge.mods.rebuildCacheDb() as Promise<{ ok: boolean; reason?: string }>
    },

    deploy: {
      start: () => bridge.deploy.start() as Promise<DeploySnapshot>,

      onProgress: (cb: (progress: DeployProgress) => void): Unsubscribe => bridge.deploy.onProgress((progress) => cb(progress as DeployProgress)),

      getActiveSnapshot: () => {
        // SmfApi types this synchronous, but an IPC round-trip to main can't
        // be. Nothing in src/components actually calls this today (the store
        // seeds its deploy state from `deploy.start()`'s own return value and
        // keeps it current via `onProgress()`), so "no known active deploy"
        // is a safe default rather than a throw - see the doc comment above.
        return null
      },

      analyseMod: (modId) => bridge.deploy.analyseMod(modId) as Promise<{ ok: boolean; error?: string }>,

      cancel: (snapshotId) => bridge.deploy.cancel(snapshotId) as Promise<{ ok: boolean; error?: string }>
    }
  }
}
