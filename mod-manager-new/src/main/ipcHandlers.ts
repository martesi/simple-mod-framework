import { BrowserWindow, dialog, ipcMain } from "electron"
import type { AppPaths } from "./paths"
import { addKnownMods, loadSettings, mergeSettings, resolveDefaultUiPaths, resolveModsDir } from "./settings"
import { fromUiPatch, toUiConfig } from "./configMapping"
import { deriveGamePathInfo } from "./gameDetect"
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
  const index = new ModIndex(getModsDir, paths.dataRoot)
  setModImageRoot(getModsDir)

  function broadcast(channel: string, payload: unknown): void {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload)
    }
  }

  const deployManager = new DeployManager(paths, (progress) => broadcast("deploy:progress", progress))

  ipcMain.handle("config:get", (): Config => toUiConfig(loadSettings(paths), paths))

  ipcMain.handle("config:getDefaultPaths", (): DefaultPaths => resolveDefaultUiPaths(paths))

  ipcMain.handle("config:merge", async (_event, patch: Partial<Config>): Promise<Config> => {
    // No retailPath/runtimePath/platform to re-derive and store here anymore - only gamePath
    // itself is persisted (see settings.ts's doc comment), so a typed-in path just gets validated
    // fresh, from scratch, the next time it's actually needed (deploy start/analyseMod below).
    const modsDirBefore = patch.modPath !== undefined ? getModsDir() : undefined

    const settings = mergeSettings(paths, fromUiPatch(patch))

    // modPath just changed and actually points somewhere new: the in-memory ModIndex was built
    // (lazily, once) against whatever directory was Mods/ *before* this merge, and has no way to
    // notice out from under it that "Mods/" now resolves somewhere else entirely - see
    // modIndex.ts's ensureBuilt(), which only ever rebuilds once. Left alone, the very next
    // mods:list() would keep serving mods from the old folder. Force the same rebuild
    // mods:rebuildIndex does, right here, so switching mod folders always shows what's actually in
    // the new one instead of stale leftovers from the old one.
    if (modsDirBefore !== undefined && getModsDir() !== modsDirBefore) {
      await index.rebuildInWorker((scanned, total) => broadcast("mods:cacheProgress", { scanned, total }))
      addKnownMods(paths, index.list())
    }

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

  ipcMain.handle("mods:list", async (event) => {
    // First call this launch (or after a modPath switch reset `built` - see config:merge above):
    // the index hasn't been loaded yet. loadOrRebuild() reads the persisted cache file written by a
    // previous launch/action - no directory walk at all in the common case - and only falls back to
    // a full worker-thread scan (broadcasting progress as it goes) if there isn't one yet. That
    // fallback is what used to run unconditionally on every single launch; now it's a one-time cost
    // for a fresh install, not a per-launch one. Subsequent calls this launch just hit the
    // already-built in-memory index below, same as before.
    if (!index.isBuilt) {
      await index.loadOrRebuild((scanned, total) => event.sender.send("mods:cacheProgress", { scanned, total }))
    }

    const list = index.list()
    // Covers the case mods:rebuildIndex's own comment doesn't: mods that were already sitting in
    // the Mods folder the very first time this app ever launches (e.g. migrated from the old Mod
    // Manager) go through ModIndex's lazy rebuild-on-first-list (see modIndex.ts's ensureBuilt()),
    // never modOps.ts's install path - so without this same write-through here, "enable" would be
    // broken for every pre-existing mod on a fresh install, not just newly-added ones.
    addKnownMods(paths, list)
    return list
  })

  ipcMain.handle("mods:rebuildIndex", async (event) => {
    await index.rebuildInWorker((scanned, total) => event.sender.send("mods:cacheProgress", { scanned, total }))
    const list = index.list()
    // Same write-through mods:beginAdd's install paths do (see modOps.ts's addKnownMods() calls) -
    // a rebuild can surface mods that were dropped into the Mods folder outside this app entirely,
    // and those need registering in knownMods/modOrder too or they'll hit the exact same
    // can't-enable-it bug a normally-installed mod would without it. Passing the full list (not
    // just ids) also lets addKnownMods() backfill default modOptions for any mod - new or
    // pre-existing - that has manifest options but no selection yet (see settings.ts's
    // seedDefaultModOptions()).
    addKnownMods(paths, list)
    return list
  })

  ipcMain.handle("mods:beginAdd", (event, { taskId, file }: { taskId: string; file: { name: string; size: number; path: string } }) => {
    const label = file.name.replace(/\.(zip|7z|rar|rpkg)$/i, "")
    const emit: TaskEmit = (update) => {
      event.sender.send("mods:taskUpdate", { taskId, label, ...update })

      // LEI-108's first trigger point (see deploy:analyseMod below): a framework mod just finished
      // installing, so warm its analysis cache now, in the background, instead of leaving the first
      // deploy after every single install to pay for it inline. Fire-and-forget on purpose - this
      // must never hold up the mods:beginAdd task or its "done" status for the renderer, and a
      // failure here is never fatal (deploy.ts's own inline fallback still covers it, same as before
      // this existed). update.modId is only set for a single-mod install (installFrameworkMods only
      // reports one id when the archive contained exactly one mod, and RPKG-only mods have no
      // manifest to analyse at all - see analyseMod.ts) - multi-mod archives just don't get the
      // pre-warm, no different from today.
      if (update.status === "done" && update.modId) {
        deployManager.runAnalyseMod(update.modId).catch(() => {
          // Best-effort - see comment above.
        })
      }
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
  // Before this returned index.list()'s existing entry (whose manifest was already read at that
  // first list() call) unchanged - so if the user replaced the mod's files on disk with a newer
  // version *without* going through Add a Mod (e.g. hand-copying an updated folder over the old
  // one), the "outdated" badge and its "click to update" button just silently did nothing, over
  // and over, because ModIndex only re-reads manifest.json when something calls indexFolder().
  // `reindexOne()` re-reads just this mod's own folder (see its doc comment in modIndex.ts) rather
  // than a full `rebuildChunked()` of the whole Mods/ directory - a single mod's own manifest
  // changing can't affect any *other* mod's outdated/validation status, so re-scanning everything
  // else on every click was pure waste, and with a large mod collection installed it's exactly what
  // made clicking this badge feel like it froze the app.
  ipcMain.handle("mods:updateOutdated", (_event, modId: string) => {
    const entry = index.reindexOne(modId)
    if (!entry) throw new Error(`"${modId}" isn't installed.`)
    return entry
  })

  ipcMain.handle("deploy:start", () => {
    const settings = loadSettings(paths)
    return deployManager.start(settings.loadOrder)
  })

  ipcMain.handle("deploy:getActiveSnapshot", () => deployManager.getActiveSnapshot())

  // LEI-108's "background analyseMod, off the deploy critical path": mods:beginAdd's emit callback
  // above now fires this automatically the moment a mod finishes installing, so this handler mostly
  // exists for the renderer to trigger it explicitly too (e.g. after a mod's selected options
  // change - not wired up anywhere yet, unlike the install case).
  //
  // analyseMod runs in the deploy worker thread (same isolation as deploy:start) so the main
  // process event loop is never blocked while the TypeScript compiler/RPKG analysis runs.
  ipcMain.handle("deploy:analyseMod", async (_event, modId: string): Promise<{ ok: boolean; error?: string }> => {
    return deployManager.runAnalyseMod(modId)
  })
}
