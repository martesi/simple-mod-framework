/**
 * The IPC contract for the Mod Manager UI (LEI-137).
 *
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * The old Svelte app exposes raw `window.fs` / `window.child_process` / a
 * bare `window.ipc.send/receive` bridge straight to the renderer (see
 * `Mod Manager/src/preload/index.ts`) - that's the anti-pattern LEI-134
 * removed here: `preload/index.ts` now exposes a fixed, typed `smf` object
 * backed by `ipcMain.handle` channels (`src/main/ipcHandlers.ts`), and
 * `ipc.electron.ts` adapts it to the `SmfApi` shape below. Embedding the
 * framework core directly in-process (replacing the Deploy.exe subprocess
 * spawn, a real game-directory picker, userData settings) is still LEI-133.
 *
 * Every screen talks *only* to the `SmfApi` interface below, obtained via
 * `getSmfApi()`. Nothing in `src/components` imports `window.fs`,
 * `window.smf`, etc. directly - `main.tsx` is the only place that chooses
 * between `ipc.electron.ts`'s real implementation and `ipc.mock.ts`'s
 * in-memory one (used when this renderer runs outside a real Electron
 * shell), so the component tree never needs to change either way.
 *
 * ----------------------------------------------------------------------------
 * CONCURRENCY / DISK-SAFETY CONTRACT (see LEI-137 description)
 * ----------------------------------------------------------------------------
 * - `mods.beginAdd` is fire-and-forget per call - adding mod A never blocks
 *   adding mod B. Progress comes back through `mods.onTaskUpdate`, keyed by
 *   the returned `taskId`, so each row can render its own spinner/result.
 * - `config.merge` (enable/disable, reorder, per-mod options) always mutates
 *   the *live* config and is never blocked by a running deploy.
 * - `mods.remove` is expected to be REJECTED by the real handler while a
 *   deploy is in flight (Deploy.exe reads mod folders throughout the run, not
 *   just at the start - deleting one mid-deploy can corrupt it). The mock
 *   enforces this too, but the real backend must enforce it independently;
 *   the UI disabling the button is not a sufficient guard on its own.
 * - `deploy.start` takes an explicit, timestamped snapshot of the config
 *   server-side (main-process-side in the real implementation, to avoid a
 *   client/server race) and returns it. The deploy runs against that frozen
 *   copy; subsequent `config.merge` calls must not affect it. The UI surfaces
 *   the snapshot's timestamp so the user can see what a running deploy is
 *   actually using.
 * - `deploy.onProgress` delivers a structured `{ stage, modIndex, modTotal,
 *   currentModId }` shape - this is the contract LEI-136 needs to satisfy.
 *   LEI-134's backend (`src/main/deployManager.ts`) is the "v1" version this
 *   doc comment originally anticipated: it synthesizes this shape by
 *   scraping `Deploying <modId>` lines out of Deploy.exe's own stdout
 *   (spawned with `--useConsoleLogging`) against the known snapshot mod
 *   list, rather than a real structured progress channel from the deployer
 *   itself - swap it out once LEI-136 lands one.
 */

import type { Config, DefaultPaths, ModEntry } from "./manifest-types"

export type ModTaskStatus = "queued" | "extracting" | "validating" | "installing" | "done" | "error"

export interface ModTaskUpdate {
  taskId: string
  /** Best-effort display name until the task resolves far enough to know the real mod ID. */
  label: string
  status: ModTaskStatus
  message?: string
  /** Present once status is "done". */
  modId?: string
}

export type DeployStage = "sorting" | "extracting" | "patching" | "finalizing"

export interface DeployProgress {
  stage: DeployStage
  stageIndex: number
  stageTotal: number
  /** Which mod (if any) is actively being processed within the current stage. */
  currentModId?: string
  modIndex?: number
  modTotal?: number
  /** Raw log line appended, for the "show raw log" disclosure. */
  logLine?: string
  done: boolean
  ok?: boolean
}

export interface DeploySnapshot {
  snapshotId: string
  /** epoch ms, so the UI can render "deploying against config frozen at 3:42pm" */
  snapshotTime: number
  loadOrder: string[]
}

export type Unsubscribe = () => void

export interface SmfApi {
  config: {
    get(): Promise<Config>
    /** Shallow-merges into the live config. Never blocked by an in-flight deploy. */
    merge(patch: Partial<Config>): Promise<Config>
    /**
     * Opens a native `dialog.showOpenDialog` folder picker for the game's Retail folder, validates
     * the pick the same way `src/main.ts` always has (chunk0.rpkg/HITMAN3.exe), derives
     * runtimePath/platform from it, and persists all of it server-side in one step (LEI-133) -
     * `config.get()`'s next call reflects the result. `error` is `""` (not surfaced) if the user
     * just canceled the dialog.
     */
    pickGameDirectory(): Promise<{ ok: true; config: Config } | { ok: false; error: string }>
    /** Example paths for the Settings/wizard placeholder text - see settings.ts's `resolveDefaultUiPaths()` doc comment for why these come from main rather than being hardcoded in the renderer. */
    getDefaultPaths(): Promise<DefaultPaths>
  }

  /** Plain OS-level helpers with no config/validation semantics of their own. */
  system: {
    /** A native folder picker with no validation - used by the cache/mod path Browse buttons. Resolves to `null` if the user cancels. */
    pickDirectory(options?: { title?: string }): Promise<string | null>
  }

  mods: {
    list(): Promise<ModEntry[]>
    /**
     * Forces a full re-derive of the mod list straight from disk, bypassing whatever's already
     * sitting in the main process's in-memory index (see modIndex.ts's ModIndex - built lazily
     * once per app launch, then only ever kept current by narrow write-throughs). The one case
     * those write-throughs can't cover on their own: someone hand-edited files *inside* an
     * existing mod folder without adding/removing/renaming it, so there's no folder-name change
     * for anything to notice. Mirrors the old Mod Manager's "Rebuild cache" button
     * (`Mod Manager/src/lib/utils.ts`'s `rebuildModIndex()`).
     */
    rebuildIndex(): Promise<ModEntry[]>
    /**
     * Kicks off installing a mod from a dropped/picked file. Returns
     * immediately with a task id; does not await completion, and never blocks
     * a subsequent call for a different file. Only a same-destination-folder
     * collision should ever be guarded server-side.
     *
     * `path` is the file's real absolute on-disk path - obtained in the
     * renderer via `window.smf.getPathForFile(file)` (Electron's
     * `webUtils.getPathForFile`, the post-`File.path`-removal replacement),
     * since the main process needs it to actually read the archive and has
     * no other way to resolve a bare `File` object back to a filesystem path
     * without raw Node access in the renderer (see LEI-134).
     */
    beginAdd(file: { name: string; size: number; path: string }): string
    onTaskUpdate(cb: (update: ModTaskUpdate) => void): Unsubscribe
    /**
     * Fires while the main process is (re)walking the Mods/ folder from scratch - the cold first
     * `list()` this launch, an explicit `rebuildIndex()`, or a `modPath` switch (see config.merge's
     * doc comment). The scan itself is chunked and yields between folders specifically so it never
     * blocks long enough to make the app look hung; this lets the UI show real progress ("scanned
     * 120 of 400") during that window instead of the old full-screen "Loading..." block.
     */
    onCacheProgress(cb: (progress: { scanned: number; total: number }) => void): Unsubscribe
    /** Rejected while a deploy is active - real handler must enforce this independently of the UI. */
    remove(modId: string): Promise<{ ok: boolean; reason?: string }>
    updateOutdated(modId: string): Promise<ModEntry>
  }

  deploy: {
    start(): Promise<DeploySnapshot>
    onProgress(cb: (progress: DeployProgress) => void): Unsubscribe
    getActiveSnapshot(): DeploySnapshot | null
    /** Analyses a single mod in-process without running a full deploy (LEI-133/LEI-108) - rejected while a deploy is active. */
    analyseMod(modId: string): Promise<{ ok: boolean; error?: string }>
  }
}

let apiSingleton: SmfApi | null = null

/**
 * Swap point for the real backend. Call this once, e.g. from main.tsx, before
 * any component reads `getSmfApi()`. Defaults to the in-memory mock.
 */
export function setSmfApi(api: SmfApi) {
  apiSingleton = api
}

export function getSmfApi(): SmfApi {
  if (!apiSingleton) {
    throw new Error("SmfApi not initialized - call setSmfApi() first (see src/main.tsx)")
  }
  return apiSingleton
}
