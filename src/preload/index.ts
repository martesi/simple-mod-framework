import { contextBridge, ipcRenderer, webUtils } from "electron"
import { electronAPI } from "@electron-toolkit/preload"

/**
 * LEI-134: the real bridge, replacing the inert LEI-137 stub. No `fs`, no
 * `child_process`, no raw `ipcRenderer.send/on` handed to the renderer
 * wholesale - only this fixed, typed set of channels, matching the `SmfApi`
 * shape the renderer already codes against (`renderer/src/lib/ipc.ts`).
 *
 * `beginAdd` is the one call that isn't a plain `invoke` passthrough: the
 * `SmfApi` contract needs it to return a task id *synchronously* (so the UI
 * can key a progress row on it immediately), but `ipcRenderer.invoke` is
 * always async. The id is minted here instead and sent along with the
 * `mods:beginAdd` call - main never has to await anything to know which task
 * a given `mods:taskUpdate` push belongs to.
 */
const smf = {
  config: {
    get: () => ipcRenderer.invoke("config:get"),
    merge: (patch: unknown) => ipcRenderer.invoke("config:merge", patch),
    pickGameDirectory: () => ipcRenderer.invoke("config:pickGameDirectory"),
    getDefaultPaths: () => ipcRenderer.invoke("config:getDefaultPaths")
  },

  system: {
    pickDirectory: (options?: { title?: string }) => ipcRenderer.invoke("system:pickDirectory", options)
  },

  mods: {
    list: () => ipcRenderer.invoke("mods:list"),
    rebuildIndex: () => ipcRenderer.invoke("mods:rebuildIndex"),

    beginAdd: (file: { name: string; size: number; path: string }): string => {
      // No node:crypto here on purpose - Electron's sandboxed preload loader
      // (webPreferences.sandbox: true, src/main/index.ts) only polyfills a
      // small allowlist of Node builtins (events/timers/url) and rejects
      // *any* `require`/`import` of "crypto", prefixed or not, with "module
      // not found". The Web Crypto API's randomUUID() is a real browser
      // global available in this context regardless (same as calling
      // `crypto.randomUUID()` from the renderer itself), so it needs no
      // require at all.
      const taskId = crypto.randomUUID()
      void ipcRenderer.invoke("mods:beginAdd", { taskId, file })
      return taskId
    },

    onTaskUpdate: (callback: (update: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, update: unknown) => callback(update)
      ipcRenderer.on("mods:taskUpdate", listener)
      return () => ipcRenderer.removeListener("mods:taskUpdate", listener)
    },

    onCacheProgress: (callback: (progress: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on("mods:cacheProgress", listener)
      return () => ipcRenderer.removeListener("mods:cacheProgress", listener)
    },

    remove: (modId: string) => ipcRenderer.invoke("mods:remove", modId),
    updateOutdated: (modId: string) => ipcRenderer.invoke("mods:updateOutdated", modId)
  },

  deploy: {
    start: () => ipcRenderer.invoke("deploy:start"),

    onProgress: (callback: (progress: unknown) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: unknown) => callback(progress)
      ipcRenderer.on("deploy:progress", listener)
      return () => ipcRenderer.removeListener("deploy:progress", listener)
    },

    getActiveSnapshot: () => ipcRenderer.invoke("deploy:getActiveSnapshot"),

    analyseMod: (modId: string) => ipcRenderer.invoke("deploy:analyseMod", modId)
  },

  /** Electron 32+'s replacement for the removed `File.path` - the only way for the renderer to learn a dropped/picked file's real on-disk path without raw Node access. */
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

try {
  contextBridge.exposeInMainWorld("electron", electronAPI)
  contextBridge.exposeInMainWorld("smf", smf)
} catch (error) {
  console.error(error)
}
