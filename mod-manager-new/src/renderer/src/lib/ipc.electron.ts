import type { Config, DefaultPaths, ModEntry } from "./manifest-types"
import type { DeployProgress, DeploySnapshot, ModTaskUpdate, SmfApi, Unsubscribe } from "./ipc"

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
      pickGameDirectory: () => bridge.config.pickGameDirectory() as Promise<{ ok: true; config: Config } | { ok: false; error: string }>,
      getDefaultPaths: () => bridge.config.getDefaultPaths() as Promise<DefaultPaths>
    },

    system: {
      pickDirectory: (options) => bridge.system.pickDirectory(options)
    },

    mods: {
      list: () => bridge.mods.list() as Promise<ModEntry[]>,

      rebuildIndex: () => bridge.mods.rebuildIndex() as Promise<ModEntry[]>,

      beginAdd: (file) => bridge.mods.beginAdd(file),

      onTaskUpdate: (cb: (update: ModTaskUpdate) => void): Unsubscribe => bridge.mods.onTaskUpdate((update) => cb(update as ModTaskUpdate)),

      remove: (modId) => bridge.mods.remove(modId) as Promise<{ ok: boolean; reason?: string }>,

      updateOutdated: (modId) => bridge.mods.updateOutdated(modId) as Promise<ModEntry>
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

      analyseMod: (modId) => bridge.deploy.analyseMod(modId) as Promise<{ ok: boolean; error?: string }>
    }
  }
}
