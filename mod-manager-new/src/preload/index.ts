import { contextBridge } from "electron"
import { electronAPI } from "@electron-toolkit/preload"

/**
 * Deliberately inert stub preload (LEI-137 is UI only). No fs, no
 * child_process, no raw ipc.send/receive bridge - that's exactly the
 * anti-pattern LEI-134 exists to remove from the current renderer
 * (see Mod Manager/src/preload/index.ts for the version being replaced).
 *
 * Once LEI-134/LEI-133 land real ipcMain.handle channels, expose them here
 * behind the same SmfApi shape the renderer already codes against
 * (src/renderer/src/lib/ipc.ts), e.g.:
 *
 *   contextBridge.exposeInMainWorld("smf", {
 *     config: { get: () => ipcRenderer.invoke("config:get"), ... },
 *     ...
 *   })
 *
 * and swap the mock in src/renderer/src/main.tsx for a thin wrapper around
 * `window.smf`.
 */
try {
  contextBridge.exposeInMainWorld("electron", electronAPI)
} catch (error) {
  console.error(error)
}
