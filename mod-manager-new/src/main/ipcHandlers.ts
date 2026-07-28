import { BrowserWindow, ipcMain } from "electron"
import type { AppPaths } from "./paths"
import { loadDiskConfig, mergeDiskConfig, resolveModsDir } from "./diskConfig"
import { fromUiPatch, toUiConfig } from "./configMapping"
import { ModIndex } from "./modIndex"
import { setModImageRoot } from "./modImages"
import { removeModFolder, runAddModTask, type TaskEmit } from "./modOps"
import { DeployManager } from "./deployManager"
import type { Config } from "../renderer/src/lib/manifest-types"

/**
 * Registers every `ipcMain.handle` channel this app's preload bridges to the
 * renderer as `window.smf` (see preload/index.ts) - the real backend for the
 * `SmfApi` contract pinned down in `renderer/src/lib/ipc.ts` during LEI-137.
 *
 * This is the one place in the whole app that touches `fs`/`child_process`
 * for mod management - everything else (modIndex.ts, modOps.ts, archive.ts,
 * deployManager.ts, diskConfig.ts) is plain Node modules with no Electron
 * dependency of their own, called from here.
 */
export function registerIpcHandlers(paths: AppPaths): void {
  const getModsDir = () => resolveModsDir(paths, loadDiskConfig(paths))
  const index = new ModIndex(getModsDir)
  setModImageRoot(getModsDir)

  function broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  const deployManager = new DeployManager(paths, (progress) => broadcast("deploy:progress", progress))

  ipcMain.handle("config:get", (): Config => toUiConfig(loadDiskConfig(paths)))

  ipcMain.handle("config:merge", (_event, patch: Partial<Config>): Config => {
    const disk = mergeDiskConfig(paths, fromUiPatch(patch))
    return toUiConfig(disk)
  })

  ipcMain.handle("mods:list", () => index.list())

  ipcMain.handle("mods:rebuildIndex", () => {
    index.rebuild()
    return index.list()
  })

  ipcMain.handle("mods:beginAdd", (event, { taskId, file }: { taskId: string; file: { name: string; size: number; path: string } }) => {
    const label = file.name.replace(/\.(zip|7z|rar|rpkg)$/i, "")
    const emit: TaskEmit = (update) => {
      event.sender.send("mods:taskUpdate", { taskId, label, ...update })
    }

    void runAddModTask(paths, getModsDir(), index, taskId, file.path, file.name, emit)
  })

  ipcMain.handle("mods:remove", (_event, modId: string): { ok: boolean; reason?: string } => {
    if (deployManager.isActive()) {
      return { ok: false, reason: "A deploy is currently running. Deploy.exe reads mod folders throughout the run, so mods can't be removed until it finishes." }
    }

    if (!index.has(modId)) {
      return { ok: false, reason: `"${modId}" isn't installed.` }
    }

    removeModFolder(getModsDir(), index, modId)

    const disk = loadDiskConfig(paths)
    mergeDiskConfig(paths, {
      loadOrder: disk.loadOrder.filter((a) => a !== modId),
      modOrder: (disk.modOrder ?? []).filter((a) => a !== modId),
      knownMods: disk.knownMods.filter((a) => a !== modId)
    })

    return { ok: true }
  })

  // Real auto-update (the URL/GitHub/ModWorkshop system) is LEI-98's v3
  // "URL system" breaking change, not this issue's scope - for now this just
  // re-validates the mod in place so the UI's "outdated" badge at least
  // reflects the manager's own current CURRENT_FRAMEWORK_VERSION check
  // after the user re-installs the mod themselves via Add a Mod.
  ipcMain.handle("mods:updateOutdated", (_event, modId: string) => {
    const entry = index.list().find((m) => m.id === modId)
    if (!entry) throw new Error(`"${modId}" isn't installed.`)
    return entry
  })

  ipcMain.handle("deploy:start", () => {
    const disk = loadDiskConfig(paths)
    return deployManager.start(disk.loadOrder)
  })

  ipcMain.handle("deploy:getActiveSnapshot", () => deployManager.getActiveSnapshot())
}
