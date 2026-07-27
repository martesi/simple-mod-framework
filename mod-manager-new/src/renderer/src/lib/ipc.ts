/**
 * The stubbed IPC contract for the Mod Manager UI (LEI-137).
 *
 * ----------------------------------------------------------------------------
 * WHY THIS FILE EXISTS
 * ----------------------------------------------------------------------------
 * The current Electron app exposes raw `window.fs` / `window.child_process` /
 * a bare `window.ipc.send/receive` bridge straight to the renderer (see
 * `Mod Manager/src/preload/index.ts`) - there is no `ipcMain.handle` contract
 * to build against yet. That hardening work is LEI-134; wiring the embedded
 * core (game directory picker, userData settings, actual deploy) is LEI-133.
 *
 * Rather than block this UI rebuild on that backend work, every screen here
 * talks *only* to the `SmfApi` interface below, obtained via `getSmfApi()`.
 * Nothing in `src/components` imports `window.fs`, `window.ipc`, etc.
 * directly. When LEI-134/133 land, replace `mockSmfApi` (ipc.mock.ts) with a
 * real implementation backed by `contextBridge`-exposed `ipcRenderer.invoke`
 * calls - the component tree does not need to change.
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
 *   currentModId }` shape - this is the contract LEI-136 needs to satisfy. If
 *   LEI-136 isn't ready when LEI-133/134 land, a v1 backend can synthesize
 *   this same shape by scraping `Deploying <modId>` lines out of the existing
 *   plain-text log against the known snapshot mod list.
 */

import type { Config, ModEntry } from "./manifest-types"

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
  }

  mods: {
    list(): Promise<ModEntry[]>
    /**
     * Kicks off installing a mod from a dropped/picked file. Returns
     * immediately with a task id; does not await completion, and never blocks
     * a subsequent call for a different file. Only a same-destination-folder
     * collision should ever be guarded server-side.
     */
    beginAdd(file: { name: string; size: number }): string
    onTaskUpdate(cb: (update: ModTaskUpdate) => void): Unsubscribe
    /** Rejected while a deploy is active - real handler must enforce this independently of the UI. */
    remove(modId: string): Promise<{ ok: boolean; reason?: string }>
    updateOutdated(modId: string): Promise<ModEntry>
  }

  deploy: {
    start(): Promise<DeploySnapshot>
    onProgress(cb: (progress: DeployProgress) => void): Unsubscribe
    getActiveSnapshot(): DeploySnapshot | null
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
