import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { Worker } from "node:worker_threads"
import type { AppPaths } from "./paths"
import type { AppSettings } from "./settings"
import { loadSettings, resolveModsDir } from "./settings"
import type { ModsConfig } from "./modsConfig"
import { loadModsConfig } from "./modsConfig"
import { deriveGamePathInfo } from "./gameDetect"
import { finishModBuildFailed, getMod, getModBuild } from "./db"
import type { DeployWorkerMessage, DeployWorkerRequest } from "./deployWorker"
import type { DeployProgress, DeploySnapshot } from "../renderer/src/lib/ipc"
import type { DeployPipelineLogLine } from "./deployPipeline"

export interface DeployProgressEmit {
  (progress: DeployProgress): void
}

/**
 * Resolves the on-disk path to deployWorker.cjs next to this bundle at runtime. Mirrors the same
 * pattern `src/workerPool.ts` uses for patchWorker (see electron.vite.config.ts's rollupOptions
 * input, which emits both index.cjs and patchWorker.cjs into out/main/).
 *
 * __dirname is the out/main/ directory when running under electron-vite dev or after a build.
 */
function resolveDeployWorkerPath(): string {
  let currentDir = __dirname
  while (true) {
    for (const name of ["deployWorker.cjs", "deployWorker.js"]) {
      const candidate = resolve(currentDir, name)
      try {
        require.resolve(candidate)
        return candidate
      } catch {
        // Try next candidate
      }
    }
    const parentDir = resolve(currentDir, "..")
    if (parentDir === currentDir) {
      break
    }
    currentDir = parentDir
  }
  return resolve(__dirname, "deployWorker.cjs")
}

const STAGE_INDEX = { "waiting-for-cache-build": 0, sorting: 1, extracting: 2, patching: 3, finalizing: 4 } as const
const STAGE_TOTAL = 5

/** How long the queue-aware deploy gate waits for every mod's eager build to reach `ready` before giving up and reporting a failed deploy. Generous on purpose - a big collection's first-ever build wave (e.g. right after a `cache.db` rebuild-from-scratch) can legitimately take a while. */
const BUILD_WAIT_TIMEOUT_MS = 10 * 60 * 1000
const BUILD_POLL_INTERVAL_MS = 500

/**
 * Offloads each deploy/analyseMod run to a dedicated `node:worker_threads` Worker so the Electron
 * main process event loop is never blocked while the framework core is running (dynamic TypeScript
 * compilation, RPKG extraction, large JSON diffing). The worker streams log lines back via
 * `postMessage` exactly as the old in-process `runFullDeploy` called `onLog`, so the progress IPC
 * channel (deploy:progress → renderer) works identically from the renderer's perspective.
 *
 * LEI-141: `start()` is now queue-aware instead of gated-and-rejected. The deploy button is always
 * clickable - if any mod in the load order doesn't have a `ready` eager build yet in `cache.db`,
 * this reports a `"waiting-for-cache-build"` stage, kicks off (or waits out) a build for anything
 * not already `ready`/`building`, and only spawns the real deploy worker once every mod clears -
 * there is no inline fallback rebuild hidden inside the deploy path itself anymore (that used to
 * live in `deploy.ts`'s per-mod loop; see `deploy.ts`'s "Analyse mods" section for what replaced it).
 */
export class DeployManager {
  private active: DeploySnapshot | null = null
  private nextTaskId = 0

  constructor(
    private paths: AppPaths,
    private emit: DeployProgressEmit
  ) {}

  getActiveSnapshot(): DeploySnapshot | null {
    return this.active
  }

  isActive(): boolean {
    return this.active !== null
  }

  /**
   * Every framework mod in `loadOrder` that doesn't currently have a `ready` build in `cache.db`.
   * RPKG-only mods (and, defensively, ids `cache.db`'s `mods` table doesn't know about at all - a
   * `resolveModFolder()` miss surfaces its own clear error later, in `deploy.ts` itself) are never
   * "not ready" - they have nothing to build in the first place.
   */
  private findNotReadyMods(loadOrder: string[]): string[] {
    const notReady: string[] = []
    for (const mod of loadOrder) {
      const row = getMod(mod)
      if (!row || !row.isFrameworkMod) continue
      const build = getModBuild(row.id)
      if (!build || build.status !== "ready") notReady.push(row.id)
    }
    return notReady
  }

  /**
   * Takes an explicit, timestamped snapshot of the settings server-side and spawns a worker to
   * run the deploy against that frozen copy - later `config:merge` calls must not (and don't -
   * `settings`/`modsConfig` are plain values captured right here, not re-read mid-deploy) affect an
   * already-started deploy. See ipc.ts's "CONCURRENCY / DISK-SAFETY CONTRACT" doc comment.
   */
  start(loadOrder: string[], modsConfig: ModsConfig): DeploySnapshot {
    if (this.active) {
      throw new Error("A deploy is already running.")
    }

    const settings: AppSettings = loadSettings(this.paths)

    const snapshot: DeploySnapshot = {
      snapshotId: randomUUID(),
      snapshotTime: Date.now(),
      loadOrder: [...loadOrder]
    }
    this.active = snapshot

    // gamePath is only ever re-derived (and re-persisted to cache.db) when it's set or changed -
    // see gameDetect.ts's one-shot `deriveGamePathInfo()`. This call is a cache hit in the
    // overwhelmingly common case (gamePath unchanged since it was last picked).
    const detection = settings.gamePath ? deriveGamePathInfo(settings.gamePath, this.paths) : ({ ok: false, error: "" } as const)
    if (!detection.ok) {
      queueMicrotask(() => {
        this.emit({
          stage: "finalizing",
          stageIndex: STAGE_INDEX.finalizing,
          stageTotal: STAGE_TOTAL,
          logLine: detection.error || "No valid game folder is set - open Settings and pick your game's Retail folder first.",
          done: true,
          ok: false
        })
        this.active = null
      })
      return snapshot
    }

    void this.waitForBuildsThenDeploy(snapshot, settings, modsConfig)

    return snapshot
  }

  /**
   * The queue-aware gate: waits (triggering builds as needed) until every mod in the snapshot's
   * load order is `ready`, then spawns the real deploy worker. Runs entirely in the background -
   * `start()` has already returned the snapshot synchronously, same as before this existed.
   */
  private async waitForBuildsThenDeploy(snapshot: DeploySnapshot, settings: AppSettings, modsConfig: ModsConfig): Promise<void> {
    const triggered = new Set<string>()
    const deadline = Date.now() + BUILD_WAIT_TIMEOUT_MS

    let notReady = this.findNotReadyMods(snapshot.loadOrder)

    if (notReady.length) {
      this.emit({
        stage: "waiting-for-cache-build",
        stageIndex: STAGE_INDEX["waiting-for-cache-build"],
        stageTotal: STAGE_TOTAL,
        logLine: `Waiting for ${notReady.length} mod${notReady.length === 1 ? "" : "s"} to finish building...`,
        done: false
      })
    }

    while (notReady.length) {
      if (Date.now() > deadline) {
        this.emit({
          stage: "finalizing",
          stageIndex: STAGE_INDEX.finalizing,
          stageTotal: STAGE_TOTAL,
          logLine: `Timed out waiting for these mods to finish building: ${notReady.join(", ")}. Check Settings for build errors, then try again.`,
          done: true,
          ok: false
        })
        this.active = null
        return
      }

      for (const modId of notReady) {
        // A `'building'` row on disk only means something *this instance* can trust once it's the
        // one that put the mod in `triggered` - per mod_build's doc comment in db.ts, that status
        // exists purely for crash-safety, not as a staleness signal. A row left `'building'` by a
        // now-dead process (app restart, killed worker, previous crash) looks identical on disk to
        // one this run's own worker is still working through, so trusting the status alone here
        // means a stale row is never retried - the mod just sits `notReady` until the deploy times
        // out. Only skip when *we* already triggered this mod this wait cycle.
        if (triggered.has(modId)) {
          const build = getModBuild(modId)
          if (build?.status === "building") continue // our own trigger for this mod is still in flight
          if (build?.status === "failed") continue // already tried once this wait cycle, don't hammer a genuinely broken mod
        }
        triggered.add(modId)
        this.triggerBuild(modId).catch(() => {
          // Best-effort - a failed trigger just means this mod stays in `notReady` until the
          // deadline above, which reports it explicitly.
        })
      }

      await new Promise((r) => setTimeout(r, BUILD_POLL_INTERVAL_MS))
      notReady = this.findNotReadyMods(snapshot.loadOrder)
    }

    this.spawnDeployWorker(snapshot, settings, modsConfig)
  }

  private spawnDeployWorker(snapshot: DeploySnapshot, settings: AppSettings, modsConfig: ModsConfig): void {
    const detection = settings.gamePath ? deriveGamePathInfo(settings.gamePath, this.paths) : ({ ok: false, error: "" } as const)
    if (!detection.ok) {
      this.emit({
        stage: "finalizing",
        stageIndex: STAGE_INDEX.finalizing,
        stageTotal: STAGE_TOTAL,
        logLine: detection.error || "No valid game folder is set - open Settings and pick your game's Retail folder first.",
        done: true,
        ok: false
      })
      this.active = null
      return
    }

    this.emit({ stage: "sorting", stageIndex: STAGE_INDEX.sorting, stageTotal: STAGE_TOTAL, modTotal: snapshot.loadOrder.length, logLine: "Sorting load order...", done: false })

    const taskId = this.nextTaskId++
    const worker = new Worker(resolveDeployWorkerPath())

    let stage: DeployProgress["stage"] = "sorting"

    worker.on("message", (msg: DeployWorkerMessage) => {
      if (msg.id !== taskId) return // stray message from a previous run - ignore

      if (msg.type === "log") {
        stage = this.handleLine(snapshot, msg.line, stage)
      } else if (msg.type === "done") {
        this.emit({
          stage: "finalizing",
          stageIndex: STAGE_INDEX.finalizing,
          stageTotal: STAGE_TOTAL,
          logLine: msg.ok ? "Deploy finished." : `Deploy failed: ${msg.error}`,
          done: true,
          ok: msg.ok
        })
        this.active = null
        void worker.terminate()
      }
    })

    worker.on("error", (err) => {
      this.emit({
        stage: "finalizing",
        stageIndex: STAGE_INDEX.finalizing,
        stageTotal: STAGE_TOTAL,
        logLine: `Deploy worker crashed: ${err.message}`,
        done: true,
        ok: false
      })
      this.active = null
      void worker.terminate()
    })

    worker.on("exit", (code) => {
      // If the worker exits non-zero without having sent a "done" message (e.g. OOM), make sure we
      // don't leave `active` set forever - the emit above from the "error" handler covers the crash
      // message, so here we only need to ensure the snapshot is cleared.
      if (code !== 0 && this.active?.snapshotId === snapshot.snapshotId) {
        this.active = null
      }
    })

    // GamePathInfo includes the `ok` discriminant field - strip it to the plain data the worker expects.
    const { ok: _ok, ...game } = detection
    const req: DeployWorkerRequest = {
      id: taskId,
      type: "deploy",
      paths: this.paths,
      settings,
      modsConfig: { ...modsConfig, loadOrder: snapshot.loadOrder },
      game
    }
    worker.postMessage(req)
  }

  /**
   * Runs analyseMod in the deploy worker (same thread isolation rationale as start()) - rejected
   * while a *full deploy* is active (a build can safely run alongside the queue-aware wait a deploy
   * is itself doing - see `triggerBuild()`, which this delegates to without that check). Returns a
   * plain Promise<result> rather than the streaming snapshot pattern since the caller (eager-build
   * trigger points in `ipcHandlers.ts`) awaits the full result.
   */
  runAnalyseMod(modId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.active) {
      return Promise.resolve({ ok: false, error: "A deploy is currently running." })
    }

    return this.triggerBuild(modId)
  }

  /** The actual build-trigger primitive - spawns a worker to run `analyseMod(modId)`, writing `cache.db`'s `mod_build` row. Used both by the public, active-deploy-guarded `runAnalyseMod()` and internally by the queue-aware deploy gate (which legitimately runs *during* an active deploy's own wait phase). */
  private triggerBuild(modId: string): Promise<{ ok: boolean; error?: string }> {
    const settings: AppSettings = loadSettings(this.paths)
    const detection = settings.gamePath ? deriveGamePathInfo(settings.gamePath, this.paths) : ({ ok: false, error: "" } as const)
    if (!detection.ok) {
      return Promise.resolve({ ok: false, error: detection.error || "No valid game folder is set - open Settings and pick your game's Retail folder first." })
    }

    const modsConfig: ModsConfig = loadModsConfig(resolveModsDir(this.paths, settings))

    const taskId = this.nextTaskId++
    const worker = new Worker(resolveDeployWorkerPath())
    const { ok: _ok, ...game } = detection

    const req: DeployWorkerRequest = {
      id: taskId,
      type: "analyseMod",
      paths: this.paths,
      settings,
      modsConfig,
      game,
      modId
    }

    return new Promise<{ ok: boolean; error?: string }>((resolvePromise, reject) => {
      let settled = false

      worker.on("message", (msg: DeployWorkerMessage) => {
        if (msg.id !== taskId) return
        if (msg.type === "done") {
          settled = true
          void worker.terminate()
          resolvePromise(msg.ok ? { ok: true } : { ok: false, error: msg.error })
        }
        // "log" messages from analyseMod are intentionally ignored here - the caller's own
        // event.sender.send("deploy:analyseModLog") wiring in ipcHandlers.ts is unchanged.
      })

      // A worker that crashes outright (uncaught exception/unhandled rejection in framework core
      // code, rather than the graceful try/catch in deployPipeline.ts) never sends a "done" message.
      // Without marking the row 'failed' here, beginModBuild()'s 'building' row for this mod would
      // stay 'building' forever - the queue-aware gate in waitForBuildsThenDeploy() only stops
      // retriggering a mod once it sees 'failed', so an orphaned 'building' row just silently waits
      // out the full BUILD_WAIT_TIMEOUT_MS instead of surfacing the failure.
      worker.on("error", (err) => {
        if (settled) return
        settled = true
        finishModBuildFailed(modId, err.message)
        void worker.terminate()
        reject(err)
      })

      worker.on("exit", (code) => {
        if (settled) return
        if (code !== 0) {
          settled = true
          const message = `Build worker exited unexpectedly (code ${code})`
          finishModBuildFailed(modId, message)
          reject(new Error(message))
        }
      })

      worker.postMessage(req)
    })
  }

  private handleLine(snapshot: DeploySnapshot, { text }: DeployPipelineLogLine, stage: DeployProgress["stage"]): DeployProgress["stage"] {
    if (/staging rpkg mod/i.test(text)) {
      this.emit({ stage: "extracting", stageIndex: STAGE_INDEX.extracting, stageTotal: STAGE_TOTAL, logLine: text, done: false })
      return "extracting"
    }

    const deployingMatch = text.match(/Deploying (\S+)/)
    if (deployingMatch) {
      const currentModId = deployingMatch[1]
      const modIndex = snapshot.loadOrder.indexOf(currentModId)
      this.emit({
        stage: "patching",
        stageIndex: STAGE_INDEX.patching,
        stageTotal: STAGE_TOTAL,
        currentModId,
        modIndex: modIndex === -1 ? undefined : modIndex,
        modTotal: snapshot.loadOrder.length,
        logLine: text,
        done: false
      })
      return "patching"
    }

    if (/generating rpkgs/i.test(text)) {
      this.emit({ stage: "finalizing", stageIndex: STAGE_INDEX.finalizing, stageTotal: STAGE_TOTAL, logLine: text, done: false })
      return "finalizing"
    }

    // Anything else - keep it in the raw log without changing the stage.
    this.emit({ stage, stageIndex: STAGE_INDEX[stage], stageTotal: STAGE_TOTAL, logLine: text, done: false })
    return stage
  }
}
