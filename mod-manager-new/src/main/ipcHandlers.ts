import { BrowserWindow, dialog, ipcMain } from "electron"
import type { AppPaths } from "./paths"
import { addKnownMods, loadSettings, mergeSettings, resolveDefaultUiPaths, resolveModsDir } from "./settings"
import { fromUiPatch, toUiConfig } from "./configMapping"
import { deriveGamePathInfo } from "./gameDetect"
import { runAnalyseMod, type DeployPipelineLogLine } from "./deployPipeline"
import { ModIndex } from "./modIndex"
import { setModImageRoot } from "./modImages"
import { removeModFolder, runAddModTask, type TaskEmit } from "./modOps"
import { DeployManager } from "./deployManager"
import type { Config, DefaultPaths } from "../renderer/src/lib/manifest-types"

/**
 * Registers every `ipcMain.handle` channel this app's preload bridges to the
 * renderer as `window.smf` (see preload/index.ts) - the real backend for the
 * `SmfApi` contract pinned down in `renderer/src/lib/ipc.ts` during LEI-137.
 *
 * This is the one place in the whole app that touches `fs`/`child_process`
 * for mod management - everything else (modIndex.ts, modOps.ts, archive.ts,
 * deployManager.ts, deployPipeline.ts, settings.ts) is plain Node modules
 * with no Electron dependency of their own, called from here.
 */
export function registerIpcHandlers(paths: AppPaths): void {
  const getModsDir = () => resolveModsDir(paths, loadSettings(paths))
  const index = new ModIndex(getModsDir)
  setModImageRoot(getModsDir)

  function broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  const deployManager = new DeployManager(paths, (progress) => broadcast("deploy:progress", progress))

  ipcMain.handle("config:get", (): Config => toUiConfig(loadSettings(paths), paths))

  ipcMain.handle("config:getDefaultPaths", (): DefaultPaths => resolveDefaultUiPaths(paths))

  ipcMain.handle("config:merge", (_event, patch: Partial<Config>): Config => {
    // No retailPath/runtimePath/platform to re-derive and store here anymore - only gamePath
    // itself is persisted (see settings.ts's doc comment), so a typed-in path just gets validated
    // fresh, from scratch, the next time it's actually needed (deploy start/analyseMod below).
    const settings = mergeSettings(paths, fromUiPatch(patch))
    return toUiConfig(settings, paths)
  })

  // The one real directory-picker dialog (LEI-133) - validates the pick the same way
  // src/main.ts:76-90 always has (see gameDetect.ts's deriveGamePathInfo) purely for immediate
  // feedback in the picker; only `gamePath` itself gets persisted; retailPath/runtimePath/platform
  // are re-derived from it on demand wherever they're actually needed instead.
  ipcMain.handle("config:pickGameDirectory", async (event): Promise<{ ok: true; config: Config } | { ok: false; error: string }> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: "Select your game's Retail folder",
      buttonLabel: "Select",
      properties: ["openDirectory"]
    })

    if (result.canceled || !result.filePaths[0]) {
      return { ok: false, error: "" }
    }

    const detection = deriveGamePathInfo(result.filePaths[0], paths)
    if (!detection.ok) {
      return { ok: false, error: detection.error }
    }

    const settings = mergeSettings(paths, { gamePath: result.filePaths[0] })

    return { ok: true, config: toUiConfig(settings, paths) }
  })

  // A plain, unvalidated directory picker for the cache/mod path fields - unlike the game
  // directory, these don't need anything derived from them, just a real folder on disk.
  ipcMain.handle("system:pickDirectory", async (event, options?: { title?: string }): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      title: options?.title ?? "Select a folder",
      buttonLabel: "Select",
      properties: ["openDirectory", "createDirectory"]
    })

    return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
  })

  ipcMain.handle("mods:list", () => {
    const list = index.list()
    // Covers the case mods:rebuildIndex's own comment doesn't: mods that were already sitting in
    // the Mods folder the very first time this app ever launches (e.g. migrated from the old Mod
    // Manager) go through ModIndex's lazy rebuild-on-first-list (see modIndex.ts's ensureBuilt()),
    // never modOps.ts's install path - so without this same write-through here, "enable" would be
    // broken for every pre-existing mod on a fresh install, not just newly-added ones.
    addKnownMods(paths, list.map((m) => m.id))
    return list
  })

  ipcMain.handle("mods:rebuildIndex", () => {
    index.rebuild()
    const list = index.list()
    // Same write-through mods:beginAdd's install paths do (see modOps.ts's addKnownMods() calls) -
    // a rebuild can surface mods that were dropped into the Mods folder outside this app entirely,
    // and those need registering in knownMods/modOrder too or they'll hit the exact same
    // can't-enable-it bug a normally-installed mod would without it.
    addKnownMods(paths, list.map((m) => m.id))
    return list
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

    const disk = loadSettings(paths)
    mergeSettings(paths, {
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
  //
  // Before this rebuild()'d the index and returned index.list()'s existing entry (whose manifest
  // was already read at that first list() call) unchanged - so if the user replaced the mod's
  // files on disk with a newer version *without* going through Add a Mod (e.g. hand-copying an
  // updated folder over the old one), the "outdated" badge and its "click to update" button just
  // silently did nothing, over and over, because ModIndex only re-reads manifest.json when
  // something calls rebuild(). Forcing that rebuild here at least means clicking Update reflects
  // whatever's actually on disk right now, not a stale in-memory read from whenever the app
  // started.
  ipcMain.handle("mods:updateOutdated", (_event, modId: string) => {
    index.rebuild()
    const entry = index.list().find((m) => m.id === modId)
    if (!entry) throw new Error(`"${modId}" isn't installed.`)
    return entry
  })

  ipcMain.handle("deploy:start", () => {
    const settings = loadSettings(paths)
    return deployManager.start(settings.loadOrder)
  })

  ipcMain.handle("deploy:getActiveSnapshot", () => deployManager.getActiveSnapshot())

  // LEI-108 already assumes this channel exists ("background analyseMod, off the deploy critical
  // path") - LEI-133's job is just to wire it up to a real in-process analysis, not to decide when
  // it gets called (that's LEI-108's - e.g. after mods:beginAdd finishes, or when a mod's selected
  // options change).
  ipcMain.handle("deploy:analyseMod", async (event, modId: string): Promise<{ ok: boolean; error?: string }> => {
    if (deployManager.isActive()) {
      return { ok: false, error: "A deploy is currently running." }
    }

    const settings = loadSettings(paths)
    const detection = settings.gamePath ? deriveGamePathInfo(settings.gamePath, paths) : ({ ok: false, error: "" } as const)
    if (!detection.ok) {
      return { ok: false, error: detection.error || "No valid game folder is set - open Settings and pick your game's Retail folder first." }
    }

    const onLog = (line: DeployPipelineLogLine) => event.sender.send("deploy:analyseModLog", { modId, ...line })
    return runAnalyseMod(paths, settings, detection, modId, onLog)
  })
}
