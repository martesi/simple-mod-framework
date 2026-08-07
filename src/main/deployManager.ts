import { randomUUID } from "node:crypto"
import { cpus } from "node:os"
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

/** LEI-143: a `status='building'` row older than this without a live build in `buildInFlight` is treated as orphaned (left by a crashed process) and re-triggered. */
const STALE_BUILD_TIMEOUT_MS = 5 * 60 * 1000

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

  /**
   * The worker + task id for the currently-running full deploy, so `cancel()` can reach it. Only
   * ever set/cleared alongside `active` in `spawnDeployWorker` - not used for build workers (see
   * `buildWorkers`/`buildGeneration` below, a separate cancel-and-restart mechanism since build
   * output never touches the game's Runtime folder and doesn't need the safe-window restriction).
   */
  private activeWorker: Worker | null = null
  private activeTaskId: number | null = null

  /** Set by `cancel()` when a deploy is still in the (main-process, worker-less) "waiting for cache build" gate - see `waitForBuildsThenDeploy`. That phase never touches the game's Runtime folder at all, so it's always safe to cancel. */
  private waitCancelled = false

  /** Mirrors the active deploy worker's current stage (kept in sync in `spawnDeployWorker`'s message handler) so `cancel()` can reject once the worker has entered the safe-window lockout, without waiting on a round trip to the worker itself. Null whenever no worker-backed deploy is active. */
  private activeStage: DeployProgress["stage"] | null = null

  /**
   * LEI-144: in-process dedup registry. `triggerBuild()` stores each mod's in-flight Promise here
   * and returns the existing one to any subsequent caller for the same modId, so concurrent trigger
   * points (the deploy wait-loop and `triggerEagerBuild` from ipcHandlers.ts) never spawn two
   * workers for the same mod simultaneously. Removed when the build settles (success or failure).
   */
  private readonly buildInFlight = new Map<string, Promise<{ ok: boolean; error?: string }>>()

  /**
   * The live build Worker for each in-flight `analyseMod` run, keyed by modId - lets a rapid
   * option change kill and immediately restart the build instead of letting a now-stale build run
   * to completion first (see `triggerBuild()`). Safe to hard-kill: unlike a full deploy,
   * `analyseMod` only ever writes to `cache.db`/temp locations, never the game's live Retail/
   * Runtime folder, so there's no safe-window restriction here.
   */
  private readonly buildWorkers = new Map<string, Worker>()

  /**
   * Bumped every `triggerBuild(modId)` call, including ones that reuse an already-in-flight
   * promise. Closed over by that call's worker handlers so a worker whose generation has since
   * been superseded (killed and replaced by a newer option change) knows not to write a `failed`
   * result to `cache.db` for a build that's actually about to be re-run with current config, and
   * so its `.finally()` cleanup doesn't release a semaphore slot the newer run still holds.
   */
  private readonly buildGeneration = new Map<string, number>()

  /** LEI-145: number of build workers currently running (not queued). */
  private buildActiveCount = 0

  /**
   * LEI-145: at most this many build workers run at once. Same formula as deploy.ts's patchWorker
   * pool - generous enough to use available cores, conservative enough not to OOM on a big
   * collection rebuild.
   */
  private readonly BUILD_CONCURRENCY_CAP = Math.max(2, Math.ceil(cpus().length / 4))

  /** LEI-145: resolve callbacks waiting for a semaphore slot in the build concurrency cap. */
  private readonly buildWaiters: Array<() => void> = []

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
   * Requests cancellation of the currently-running deploy. `snapshotId` must match the active
   * deploy so a stale renderer (e.g. a leftover toast from a previous deploy) can't cancel a
   * different, newer one. Cooperative and safe-window only - see cancel.ts: the worker honours
   * this at its next per-mod/per-instruction loop boundary and ignores it entirely once it has
   * entered the finalize phase (Contract destinations onward) - see cancel.ts's doc comment for
   * why the lockout still applies there even though its Runtime writes are now atomic (LEI-151).
   */
  cancel(snapshotId: string): { ok: boolean; error?: string } {
    if (!this.active || this.active.snapshotId !== snapshotId) {
      return { ok: false, error: "No matching active deploy." }
    }

    if (!this.activeWorker || this.activeTaskId === null) {
      // Still in the worker-less "waiting for cache build" gate - nothing has touched Runtime yet,
      // always safe. waitForBuildsThenDeploy's loop checks this flag at its next poll tick.
      this.waitCancelled = true
      return { ok: true }
    }

    if (this.activeStage === "finalizing") {
      // Mirrors ipc.mock.ts's cancel(): once the worker has logged "Finalizing deploy" it's past the
      // point cancel.ts's isCancelActive() will ever honour again, so report that up front instead of
      // silently posting a message the worker is guaranteed to ignore.
      return { ok: false, error: "Deploy is finalizing and can no longer be cancelled." }
    }

    this.activeWorker.postMessage({ id: this.activeTaskId, type: "cancel" } satisfies DeployWorkerRequest)
    return { ok: true }
  }

  /**
   * LEI-145: wait for all currently in-flight build workers to settle before the caller does
   * something that requires the DB to be quiescent (e.g. `mods:rebuildCacheDb` closing and
   * deleting cache.db). Returns immediately if no builds are running.
   */
  waitForAllBuilds(): Promise<void> {
    return Promise.allSettled([...this.buildInFlight.values()]).then(() => undefined)
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
   *
   * LEI-143/144: uses `buildInFlight` (in-process set of currently running builds) instead of a
   * `triggered` Set so the loop correctly distinguishes "our worker is still running" from "stale
   * row from a crashed previous process". A local `attempted` Set replaces `triggered`'s secondary
   * role of "don't re-trigger a mod that already failed this deploy cycle."
   */
  private async waitForBuildsThenDeploy(snapshot: DeploySnapshot, settings: AppSettings, modsConfig: ModsConfig): Promise<void> {
    const attempted = new Set<string>()
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
      if (this.bailIfWaitCancelled()) return

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
        // LEI-144: if our build is already in flight (tracked in-process, not via DB), skip.
        // This correctly handles the window between triggerBuild() and beginModBuild() writing its
        // row, which the old `triggered`+DB-status check treated as "needs retrigger" → spawn storm.
        if (this.buildInFlight.has(modId)) continue

        const build = getModBuild(modId)

        // LEI-143: a 'building' row with no live build in buildInFlight is orphaned (left by a
        // crashed process). Give it a grace period before retriggering - a cold start with a very
        // slow tsc import could legitimately look like this for a few seconds, and we don't want to
        // double-trigger a build that's actually running in a worker we just don't know about.
        if (build?.status === "building") {
          if (Date.now() - build.startedAt < STALE_BUILD_TIMEOUT_MS) continue
          // Older than timeout with no in-flight entry - treat as orphaned, fall through to retrigger.
        }

        // Don't re-trigger a mod that already failed during this deploy's wait cycle. A mod that
        // failed in a previous session (before this deploy started) gets one retry; `attempted` is
        // only set below, not carried across deploys.
        if (attempted.has(modId) && build?.status === "failed") continue

        attempted.add(modId)
        this.triggerBuild(modId).catch(() => {
          // Best-effort - a failed trigger just means this mod stays in `notReady` until the
          // deadline above, which reports it explicitly.
        })
      }

      await new Promise((r) => setTimeout(r, BUILD_POLL_INTERVAL_MS))
      notReady = this.findNotReadyMods(snapshot.loadOrder)
    }

    // Re-check here too, not just at the top of the loop above: a cancel that lands during the very
    // last poll (right as `notReady` empties out) would otherwise fall straight through into spawning
    // the real worker, and `waitCancelled` would then linger `true` and wrongly cancel the *next*
    // deploy the first time it hits this gate.
    if (this.bailIfWaitCancelled()) return

    this.spawnDeployWorker(snapshot, settings, modsConfig)
  }

  /** Consumes a pending `waitCancelled` request, if any, emitting the cancellation and clearing `active`. Returns whether it did so - callers should return immediately when it does. */
  private bailIfWaitCancelled(): boolean {
    if (!this.waitCancelled) return false
    this.waitCancelled = false
    this.emit({
      stage: "finalizing",
      stageIndex: STAGE_INDEX.finalizing,
      stageTotal: STAGE_TOTAL,
      logLine: "Deploy cancelled.",
      done: true,
      ok: false
    })
    this.active = null
    return true
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
    this.activeWorker = worker
    this.activeTaskId = taskId
    this.activeStage = "sorting"

    let stage: DeployProgress["stage"] = "sorting"

    // LEI-146: track whether any handler has already emitted a terminal event, so the `exit`
    // handler doesn't leave the toast spinning when the worker dies without sending "done" or
    // firing "error" (e.g. OOM kill).
    let settled = false

    worker.on("message", (msg: DeployWorkerMessage) => {
      if (msg.id !== taskId) return // stray message from a previous run - ignore

      if (msg.type === "log") {
        stage = this.handleLine(snapshot, msg.line, stage)
        this.activeStage = stage
      } else if (msg.type === "done") {
        settled = true
        this.emit({
          stage: "finalizing",
          stageIndex: STAGE_INDEX.finalizing,
          stageTotal: STAGE_TOTAL,
          logLine: msg.ok ? "Deploy finished." : msg.cancelled ? "Deploy cancelled." : `Deploy failed: ${msg.error}`,
          done: true,
          ok: msg.ok
        })
        this.active = null
        this.activeWorker = null
        this.activeTaskId = null
        this.activeStage = null
        void worker.terminate()
      }
    })

    worker.on("error", (err) => {
      if (settled) return
      settled = true
      this.emit({
        stage: "finalizing",
        stageIndex: STAGE_INDEX.finalizing,
        stageTotal: STAGE_TOTAL,
        logLine: `Deploy worker crashed: ${err.message}`,
        done: true,
        ok: false
      })
      this.active = null
      this.activeWorker = null
      this.activeTaskId = null
      this.activeStage = null
      void worker.terminate()
    })

    worker.on("exit", (code) => {
      // LEI-146: if neither "done" nor "error" fired (e.g. OOM, uncaught exception that didn't
      // surface as an error event), emit a terminal progress event so the deploy toast resolves
      // instead of spinning forever.
      if (settled) return
      if (code !== 0) {
        settled = true
        this.active = null
        this.activeWorker = null
        this.activeTaskId = null
        this.activeStage = null
        this.emit({
          stage: "finalizing",
          stageIndex: STAGE_INDEX.finalizing,
          stageTotal: STAGE_TOTAL,
          logLine: `Deploy worker exited unexpectedly (code ${code})`,
          done: true,
          ok: false
        })
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

  /**
   * The build-trigger primitive - spawns a worker to run `analyseMod(modId)`, writing `cache.db`'s
   * `mod_build` row. Used both by the public `runAnalyseMod()` and the queue-aware deploy gate.
   *
   * LEI-144's dedup is now cancel-and-restart rather than pure dedup: a call for a modId that's
   * already in flight kills that stale worker (safe here - `analyseMod` never touches the game's
   * Runtime folder, unlike a full deploy) and starts a fresh one immediately with current config,
   * instead of letting the stale run finish uselessly and only then re-triggering. This avoids
   * wasting a full build's worth of time on every intermediate state when a user changes a mod's
   * options repeatedly in quick succession - only the *last* change's config ever actually
   * completes and gets written to `cache.db`. See `buildGeneration`'s doc comment for how a
   * superseded worker's late-arriving result is silently dropped instead of corrupting the newer
   * run's outcome.
   *
   * LEI-145: enforces a concurrency cap (`BUILD_CONCURRENCY_CAP`) so a batch rebuild of a large
   * collection doesn't saturate CPU with simultaneous tsc imports. Excess triggers queue and run as
   * slots free up. A cancel-and-restart reuses the semaphore slot the superseded build already
   * held rather than releasing and re-queueing behind it.
   */
  private triggerBuild(modId: string): Promise<{ ok: boolean; error?: string }> {
    const generation = (this.buildGeneration.get(modId) ?? 0) + 1
    this.buildGeneration.set(modId, generation)

    const staleWorker = this.buildWorkers.get(modId)
    if (staleWorker) {
      void staleWorker.terminate()
      this.buildWorkers.delete(modId)

      // Restart in place - this modId already holds a semaphore slot (buildActiveCount was
      // incremented when the stale build started and isn't decremented here), so go straight to a
      // fresh worker instead of back through the concurrency-cap queue below.
      const promise = this._runBuildWorker(modId, generation).finally(() => this._releaseBuildSlot(modId, generation))
      this.buildInFlight.set(modId, promise)
      return promise
    }

    // LEI-144: return existing promise if already in flight (no stale worker to replace - i.e.
    // this modId isn't building at all right now, or another caller already reused the current
    // in-flight run).
    const existing = this.buildInFlight.get(modId)
    if (existing) return existing

    const promise = new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const start = (): void => {
        this.buildActiveCount++
        this._runBuildWorker(modId, generation)
          .then(resolve, reject)
          .finally(() => this._releaseBuildSlot(modId, generation))
      }

      // LEI-145: concurrency cap - queue if at capacity.
      if (this.buildActiveCount < this.BUILD_CONCURRENCY_CAP) {
        start()
      } else {
        this.buildWaiters.push(start)
      }
    })

    this.buildInFlight.set(modId, promise)
    return promise
  }

  /** Releases a build's semaphore slot and wakes the next queued build, if any - but only for the generation that's still current. A superseded (killed-and-restarted) run's eventual settlement calls this too; the generation mismatch makes it a no-op so the slot it's replaced by is released exactly once, by whichever generation actually finishes. */
  private _releaseBuildSlot(modId: string, generation: number): void {
    if (this.buildGeneration.get(modId) !== generation) return
    this.buildInFlight.delete(modId)
    this.buildActiveCount--
    this.buildWaiters.shift()?.()
  }

  /**
   * Actual build worker spawn logic, separated from `triggerBuild` to keep dedup/semaphore
   * bookkeeping clean. The outer `triggerBuild` already holds the semaphore slot when this runs.
   */
  private _runBuildWorker(modId: string, generation: number): Promise<{ ok: boolean; error?: string }> {
    const settings: AppSettings = loadSettings(this.paths)
    const detection = settings.gamePath ? deriveGamePathInfo(settings.gamePath, this.paths) : ({ ok: false, error: "" } as const)
    if (!detection.ok) {
      return Promise.resolve({ ok: false, error: detection.error || "No valid game folder is set - open Settings and pick your game's Retail folder first." })
    }

    const modsConfig: ModsConfig = loadModsConfig(resolveModsDir(this.paths, settings))

    const taskId = this.nextTaskId++
    const worker = new Worker(resolveDeployWorkerPath())
    this.buildWorkers.set(modId, worker)
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

      // Only this worker's own map entry should be cleared - if it's already been superseded (a
      // newer triggerBuild() call already overwrote buildWorkers.get(modId) with a fresh worker
      // before this one's terminate-induced exit fires), leave that newer entry alone.
      const clearWorkerEntry = (): void => {
        if (this.buildWorkers.get(modId) === worker) this.buildWorkers.delete(modId)
      }
      const isCurrent = (): boolean => this.buildGeneration.get(modId) === generation

      worker.on("message", (msg: DeployWorkerMessage) => {
        if (msg.id !== taskId) return
        if (msg.type === "done") {
          settled = true
          clearWorkerEntry()
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
      //
      // If this run has been superseded (isCurrent() false - triggerBuild() already killed this
      // worker to restart with newer config), skip the cache.db write: the mod isn't actually
      // failed, a fresh build for it is already running, and writing 'failed' here would flash a
      // spurious error in the UI right before the real result lands.
      worker.on("error", (err) => {
        if (settled) return
        settled = true
        clearWorkerEntry()
        void worker.terminate()
        if (isCurrent()) finishModBuildFailed(modId, err.message)
        reject(err)
      })

      worker.on("exit", (code) => {
        if (settled) return
        if (code !== 0) {
          settled = true
          clearWorkerEntry()
          const message = `Build worker exited unexpectedly (code ${code})`
          if (isCurrent()) finishModBuildFailed(modId, message)
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

    if (/^Finalizing deploy|generating rpkgs/i.test(text)) {
      // "Finalizing deploy" (logged right after the "Execute instructions" loop, before any
      // Runtime-writing stage) is the authoritative signal that cancellation is now locked out -
      // see cancel.ts. "generating rpkgs" is kept as a fallback stage match for log lines that
      // arrive without ever having matched the finalize marker (shouldn't normally happen).
      this.emit({ stage: "finalizing", stageIndex: STAGE_INDEX.finalizing, stageTotal: STAGE_TOTAL, logLine: text, done: false })
      return "finalizing"
    }

    // Anything else - keep it in the raw log without changing the stage.
    this.emit({ stage, stageIndex: STAGE_INDEX[stage], stageTotal: STAGE_TOTAL, logLine: text, done: false })
    return stage
  }
}
