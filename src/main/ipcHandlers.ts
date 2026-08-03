import { BrowserWindow, dialog, ipcMain } from "electron"
import { join } from "node:path"
import type { AppPaths } from "./paths"
import { loadSettings, mergeSettings, readLegacyModListFields, resolveDefaultUiPaths, resolveModsDir, resolveTempDir } from "./settings"
import { addNewlyKnownMods, invalidateModsConfigCache, loadModsConfig, mergeModsConfig, migrateFromLegacySettings } from "./modsConfig"
import { fromUiPatch, toUiConfig } from "./configMapping"
import { deriveGamePathInfo } from "./gameDetect"
import { ModIndex, MANAGED_FOLDER } from "./modIndex"
import { setModImageRoot } from "./modImages"
import { removeModFolder, runAddModTask, type TaskEmit } from "./modOps"
import { DeployManager } from "./deployManager"
import { clearAllContentCache, closeDb, openDb, listModBuilds } from "./db"
import { existsSync, readdirSync, rmSync, statSync } from "node:fs"
import type { Config, DefaultPaths } from "../renderer/src/lib/manifest-types"
import type { ModBuildInfo } from "../renderer/src/lib/ipc"

/**
 * Registers every `ipcMain.handle` channel this app's preload bridges to the
 * renderer as `window.smf` (see preload/index.ts) - the real backend for the
 * `SmfApi` contract pinned down in `renderer/src/lib/ipc.ts` during LEI-137.
 *
 * This is the one place in the whole app that touches `fs`/`child_process`
 * for mod management - everything else (modIndex.ts, modOps.ts, archive.ts,
 * deployManager.ts, deployPipeline.ts, settings.ts, modsConfig.ts) is plain
 * Node modules with no Electron dependency of their own, called from here.
 */
export function registerIpcHandlers(paths: AppPaths): void {
	const getModsDir = () => resolveModsDir(paths, loadSettings(paths))
	const getModsConfig = () => loadModsConfig(getModsDir())

	/**
	 * cache.db lives under the resolved temp dir (LEI-141 - see settings.ts's `resolveTempDir()`),
	 * not necessarily `paths.dataRoot` anymore. Opened lazily here, on the first IPC call that
	 * touches mod management, rather than eagerly at app startup - a genuinely fresh install with no
	 * `gamePath` picked yet would otherwise force the "no game known" fallback location (`dataRoot`)
	 * to become permanent (once `cache.db` exists anywhere, `legacyTempDirHasData()` finds it and
	 * pins the temp dir there forever - see that function's doc comment). Calling this again after
	 * `gamePath` changes (see `config:merge`/`config:pickGameDirectory` below) is a cheap no-op if
	 * the resolved location hasn't actually changed, and cleanly reopens at the new location if it has.
	 */
	function ensureDb(): void {
		const settings = loadSettings(paths)
		openDb(join(resolveTempDir(paths, settings), "cache.db"))
	}

	ensureDb()

	// One-time upgrade path for installs that had load order/options sitting in the old
	// settings.json (pre-LEI-141) - see modsConfig.ts's doc comment. No-op if Mods/config.json
	// already exists, or if there was nothing to migrate.
	migrateFromLegacySettings(getModsDir(), readLegacyModListFields(paths))

	const index = new ModIndex(getModsDir)
	setModImageRoot(getModsDir)

	function broadcast(channel: string, payload: unknown): void {
		for (const win of BrowserWindow.getAllWindows()) {
			win.webContents.send(channel, payload)
		}
	}

	const deployManager = new DeployManager(paths, (progress) => broadcast("deploy:progress", progress))

	/** Fire-and-forget eager build trigger - shared by every mutation point that can invalidate a mod's build (add, update, options change, explicit rebuild). Never awaited by its caller's own IPC response; failures surface later as that mod's `mod_build.status === "failed"`, readable via `mods:buildStatuses`. */
	function triggerEagerBuild(modId: string): void {
		deployManager.runAnalyseMod(modId).catch(() => {
			// Best-effort - see doc comment above.
		})
	}

	ipcMain.handle("config:get", (): Config => {
		ensureDb()
		return toUiConfig(loadSettings(paths), getModsConfig(), paths)
	})

	ipcMain.handle("config:getDefaultPaths", (): DefaultPaths => resolveDefaultUiPaths(paths, loadSettings(paths)))

	/**
	 * "What would cachePath/modPath resolve to if gamePath were this?" - without writing anything.
	 * The setup wizard stages every field locally and only actually calls config:merge once, at
	 * "Save & finish" (see SetupWizard.tsx's doc comment) - it still needs to preview cachePath's
	 * game-root-relative default (resolveTempDir()) as the user types/picks a game path on the step
	 * before it, which this gives it via the same resolver `config:get`/`config:merge` already use,
	 * just fed a hypothetical `gamePath` instead of whatever's on disk.
	 */
	ipcMain.handle("config:previewPaths", (_event, gamePath: string): { cachePath: string; modPath: string } => {
		const preview = resolveDefaultUiPaths(paths, { ...loadSettings(paths), gamePath })
		return { cachePath: preview.cachePath, modPath: preview.modPath }
	})

	ipcMain.handle("config:merge", async (_event, patch: Partial<Config>): Promise<Config> => {
		const modsDirBefore = patch.modPath !== undefined ? getModsDir() : undefined
		const gamePathBefore = loadSettings(paths).gamePath

		const { settingsPatch, modsConfigPatch } = fromUiPatch(patch)

		// Diff modOptions *before* merging, so a fire-and-forget rebuild only fires for mods whose
		// resolved options actually changed - not every mod that happens to have an entry in the
		// (potentially full-object) patch. This is LEI-141's confirmed gap: an options change used to
		// never trigger `runAnalyseMod` at all, silently relying on deploy's old inline fallback to
		// catch up instead.
		let changedOptionModIds: string[] = []
		if (modsConfigPatch.modOptions) {
			const before = getModsConfig().modOptions
			changedOptionModIds = Object.entries(modsConfigPatch.modOptions)
				.filter(([modId, options]) => JSON.stringify(before[modId]) !== JSON.stringify(options))
				.map(([modId]) => modId)
		}

		const settings = mergeSettings(paths, settingsPatch)

		if (Object.keys(modsConfigPatch).length) {
			mergeModsConfig(getModsDir(), modsConfigPatch)
		}

		// modPath just changed and actually points somewhere new: the in-memory ModIndex was built
		// (lazily, once) against whatever directory was Mods/ *before* this merge, and the portable
		// Mods/config.json cache (modsConfig.ts) is keyed the same way - both need to catch up to the
		// new folder instead of quietly continuing to serve the old one's data.
		if (modsDirBefore !== undefined && getModsDir() !== modsDirBefore) {
			invalidateModsConfigCache()
			await index.rebuildInWorker((scanned, total) => broadcast("mods:cacheProgress", { scanned, total }))
			addNewlyKnownMods(getModsDir(), index.list())
			migrateFromLegacySettings(getModsDir(), readLegacyModListFields(paths))
		}

		// gamePath just changed: one-shot re-derive (deriveGamePathInfo() itself notices the mismatch
		// against whatever's stored in cache.db and only actually re-hashes/re-persists in that case -
		// see gameDetect.ts). Also re-checks whether the temp dir's *default* location should move
		// (only takes effect for a genuinely fresh install with no data at the legacy location yet -
		// see resolveTempDir()'s doc comment).
		if (settingsPatch.gamePath !== undefined && settingsPatch.gamePath !== gamePathBefore) {
			if (settings.gamePath) deriveGamePathInfo(settings.gamePath, paths)
			ensureDb()
		}

		for (const modId of changedOptionModIds) {
			if (index.has(modId)) triggerEagerBuild(modId)
		}

		return toUiConfig(settings, getModsConfig(), paths)
	})

	// The one real directory-picker dialog (LEI-133) - validates the pick the same way
	// src/main.ts:76-90 always has (see gameDetect.ts's deriveGamePathInfo) purely for immediate
	// feedback in the picker; only `gamePath` itself gets persisted; retailPath/runtimePath/platform
	// are re-derived (one-shot, cache.db-persisted) from it on demand wherever they're actually needed.
	//
	// `persist` (default true, Settings' own Browse button) writes `gamePath` to settings.json
	// immediately, same as it always has. The setup wizard passes `false`: it stages every field
	// locally and only actually persists once, at "Save & finish" (see SetupWizard.tsx's doc
	// comment) - `deriveGamePathInfo`'s own cache.db write still runs either way (it's a validation
	// cache keyed on the picked path, not a settings.json field - harmless even if the user goes on
	// to pick a different path before finishing).
	ipcMain.handle("config:pickGameDirectory", async (event, persist: boolean = true): Promise<{ ok: true; config: Config } | { ok: false; error: string }> => {
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

		if (!persist) {
			// A preview, same shape as the persisted path below (toUiConfig against a hypothetical
			// gamePath) so the wizard can read `.config.cachePath`/`.config.modPath` off it exactly the
			// same way it would the real thing.
			return { ok: true, config: toUiConfig({ ...loadSettings(paths), gamePath: result.filePaths[0] }, getModsConfig(), paths) }
		}

		const settings = mergeSettings(paths, { gamePath: result.filePaths[0] })
		ensureDb()

		return { ok: true, config: toUiConfig(settings, getModsConfig(), paths) }
	})

	// A plain, unvalidated directory picker for the mod/temp path fields - unlike the game
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

	/**
	 * Read-only "does this look like a mod folder" check for a candidate path that hasn't been
	 * committed as the real `modPath` yet - the setup wizard's mod-path step (SetupWizard.tsx) uses
	 * this instead of `mods:list`/`config:merge`'s modsDir-changed branch, since either of those
	 * would write through to `Mods/config.json`/cache.db against a folder the user might still back
	 * out of or change before finishing. Counts top-level subfolders the same way ModIndex actually
	 * would (see modIndex.ts's scanSync()/rebuildChunked() - any directory other than
	 * `MANAGED_FOLDER` counts as a mod, manifest.json or not) without touching the index, cache.db,
	 * or any config file.
	 */
	ipcMain.handle("mods:previewFolder", (_event, dir: string): { exists: boolean; count: number } => {
		if (!dir || !existsSync(dir)) return { exists: false, count: 0 }
		try {
			const count = readdirSync(dir).filter((f) => f !== MANAGED_FOLDER && statSync(join(dir, f)).isDirectory()).length
			return { exists: true, count }
		} catch {
			return { exists: false, count: 0 }
		}
	})

	ipcMain.handle("mods:list", async (event) => {
		ensureDb()

		// First call this launch (or after a modPath switch reset `built` - see config:merge above):
		// the index hasn't been loaded yet. loadOrRebuild() reads the persisted cache.db rows written
		// by a previous launch/action - no directory walk at all in the common case - and only falls
		// back to a full worker-thread scan (broadcasting progress as it goes) if there isn't one yet.
		if (!index.isBuilt) {
			await index.loadOrRebuild((scanned, total) => event.sender.send("mods:cacheProgress", { scanned, total }))
		}

		const list = index.list()
		// Covers the case mods:rebuildIndex's own comment doesn't: mods that were already sitting in
		// the Mods folder the very first time this app ever launches (e.g. migrated from the old Mod
		// Manager) go through ModIndex's lazy rebuild-on-first-list (see modIndex.ts's ensureBuilt()),
		// never modOps.ts's install path - so without this same write-through here, "enable" would be
		// broken for every pre-existing mod on a fresh install, not just newly-added ones.
		addNewlyKnownMods(getModsDir(), list)
		return list
	})

	ipcMain.handle("mods:rebuildIndex", async (event) => {
		ensureDb()
		await index.rebuildInWorker((scanned, total) => event.sender.send("mods:cacheProgress", { scanned, total }))
		const list = index.list()
		// Same write-through mods:beginAdd's install paths do (see modsConfig.ts's addNewlyKnownMods()
		// calls) - a rebuild can surface mods that were dropped into the Mods folder outside this app
		// entirely, and those need registering in modOrder too or they'll hit the exact same
		// can't-enable-it bug a normally-installed mod would without it.
		addNewlyKnownMods(getModsDir(), list)
		return list
	})

	ipcMain.handle("mods:beginAdd", (event, { taskId, file }: { taskId: string; file: { name: string; size: number; path: string } }) => {
		ensureDb()
		const label = file.name.replace(/\.(zip|7z|rar|rpkg)$/i, "")
		const emit: TaskEmit = (update) => {
			event.sender.send("mods:taskUpdate", { taskId, label, ...update })

			// LEI-108/LEI-141's first eager-build trigger point: a framework mod just finished
			// installing, so build its cache.db entry now, in the background, instead of leaving the
			// first deploy after every single install to discover it isn't ready and wait on it right
			// then. Fire-and-forget on purpose - this must never hold up the mods:beginAdd task or its
			// "done" status for the renderer. update.modId is only set for a single-mod install
			// (installFrameworkMods only reports one id when the archive contained exactly one mod,
			// and RPKG-only mods have no manifest to build at all - see analyseMod.ts) - multi-mod
			// archives just don't get the pre-warm, no different from today.
			if (update.status === "done" && update.modId) {
				triggerEagerBuild(update.modId)
			}
		}

		void runAddModTask(paths, getModsDir(), index, taskId, file.path, file.name, emit)
	})

	ipcMain.handle("mods:remove", (_event, modId: string): { ok: boolean; reason?: string } => {
		ensureDb()

		if (deployManager.isActive()) {
			return { ok: false, reason: "A deploy is currently running. Deploy reads mod folders throughout the run, so mods can't be removed until it finishes." }
		}

		if (!index.has(modId)) {
			return { ok: false, reason: `"${modId}" isn't installed.` }
		}

		removeModFolder(getModsDir(), index, modId)

		const modsConfig = getModsConfig()
		mergeModsConfig(getModsDir(), {
			loadOrder: modsConfig.loadOrder.filter((a) => a !== modId),
			modOrder: (modsConfig.modOrder ?? []).filter((a) => a !== modId)
		})

		return { ok: true }
	})

	// Real auto-update (the URL/GitHub/ModWorkshop system) is LEI-98's v3
	// "URL system" breaking change, not this issue's scope - for now this just
	// re-validates the mod in place so the UI's "outdated" badge at least
	// reflects the manager's own current CURRENT_FRAMEWORK_VERSION check
	// after the user re-installs the mod themselves via Add a Mod.
	ipcMain.handle("mods:updateOutdated", (_event, modId: string) => {
		ensureDb()
		const entry = index.reindexOne(modId)
		if (!entry) throw new Error(`"${modId}" isn't installed.`)
		// LEI-141 eager-build trigger: the mod's on-disk content may have changed as part of
		// whatever "update" the user just did (re-running Add a Mod over the same folder) - rebuild
		// its cache.db entry rather than leaving the old one to go stale.
		triggerEagerBuild(modId)
		return entry
	})

	ipcMain.handle("deploy:start", () => {
		ensureDb()
		const modsConfig = getModsConfig()
		return deployManager.start(modsConfig.loadOrder, modsConfig)
	})

	ipcMain.handle("deploy:getActiveSnapshot", () => deployManager.getActiveSnapshot())

	// LEI-108/LEI-141's "background analyseMod, off the deploy critical path" - also the explicit
	// "rebuild this mod's cache" trigger point the design calls for, wired up to the options-change
	// path automatically (see config:merge above) as well as being callable directly (e.g. a
	// per-mod "Rebuild" action in the UI, or after mods:updateOutdated - both already call
	// triggerEagerBuild() themselves, this handler is for anything else, including manual retries
	// of a mod whose last build failed).
	ipcMain.handle("deploy:analyseMod", async (_event, modId: string): Promise<{ ok: boolean; error?: string }> => {
		ensureDb()
		return deployManager.runAnalyseMod(modId)
	})

	ipcMain.handle("mods:buildStatuses", (): ModBuildInfo[] => {
		ensureDb()
		return listModBuilds().map((b) => ({ modId: b.modId, status: b.status, error: b.error }))
	})

	/**
	 * LEI-141's "must be a real, exercised code path, not assumed-to-work" rebuild-from-scratch:
	 * deletes `cache.db` and rebuilds it entirely from the three untouched sources - `Mods/`'s actual
	 * contents, `Mods/config.json` (never touched by this), and `AppSettings.gamePath`. Distinct from
	 * `mods:rebuildIndex` (which only re-walks the mod list against whatever `cache.db` already has).
	 *
	 * Deliberately reuses the exact same bootstrap a first-ever launch takes, rather than a bespoke
	 * "rebuild" implementation: `openDb()` always runs its `CREATE TABLE IF NOT EXISTS` migration
	 * unconditionally, so a freshly-deleted-and-recreated file comes back with an empty schema
	 * exactly like a brand new install's would; `index.forceReload()` + `loadOrRebuild()` then take
	 * the same "no persisted index yet -> full worker-thread scan" branch `mods:list` always falls
	 * back to on a genuinely first launch (see `modIndex.ts`'s `loadOrRebuild()` doc comment).
	 */
	ipcMain.handle("mods:rebuildCacheDb", async (event) => {
		if (deployManager.isActive()) {
			return { ok: false, reason: "A deploy is currently running." }
		}

		const settings = loadSettings(paths)
		const modsDir = getModsDir()
		const dbPath = join(resolveTempDir(paths, settings), "cache.db")

		// LEI-145: drain in-flight build workers before closing the DB. Without this, a worker mid-
		// write on Windows keeps the SQLite file handle open, rmSync() below fails silently, and the
		// "rebuild" does nothing - cache.db is never actually deleted or reset.
		await deployManager.waitForAllBuilds()

		closeDb()
		try {
			if (existsSync(dbPath)) rmSync(dbPath)
			if (existsSync(`${dbPath}-wal`)) rmSync(`${dbPath}-wal`)
			if (existsSync(`${dbPath}-shm`)) rmSync(`${dbPath}-shm`)
		} catch {
			// Best-effort - if the old file can't be removed (e.g. locked), openDb() below will still
			// succeed against whatever's there; worst case this "rebuild" only clears what a fresh
			// CREATE TABLE IF NOT EXISTS can't already fix, which is nothing in the vast majority of
			// real corruption scenarios.
		}
		// LEI-142: also wipe the loose content_cache/ tree so the rebuilt DB starts with a
		// genuinely clean state rather than potentially stale artifact files from the previous run.
		// openDb() sets contentCacheRoot, so clearAllContentCache() must be called after it.
		openDb(dbPath)
		clearAllContentCache()

		if (settings.gamePath) deriveGamePathInfo(settings.gamePath, paths)

		index.forceReload()
		await index.loadOrRebuild((scanned, total) => event.sender.send("mods:cacheProgress", { scanned, total }))

		const list = index.list()
		addNewlyKnownMods(modsDir, list)

		for (const mod of list) {
			if (mod.isFrameworkMod) triggerEagerBuild(mod.id)
		}

		return { ok: true }
	})
}
