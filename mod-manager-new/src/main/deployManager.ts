import { randomUUID } from "node:crypto"
import { resolve } from "node:path"
import { Worker } from "node:worker_threads"
import type { AppPaths } from "./paths"
import type { AppSettings } from "./settings"
import { loadSettings } from "./settings"
import { deriveGamePathInfo } from "./gameDetect"
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

/**
 * Offloads each deploy/analyseMod run to a dedicated `node:worker_threads` Worker so the Electron
 * main process event loop is never blocked while the framework core is running (dynamic TypeScript
 * compilation, RPKG extraction, large JSON diffing). The worker streams log lines back via
 * `postMessage` exactly as the old in-process `runFullDeploy` called `onLog`, so the progress IPC
 * channel (deploy:progress → renderer) works identically from the renderer's perspective.
 *
 * One short-lived Worker is spawned per deploy run and terminated as soon as it posts `{ type:
 * "done" }` - no persistent pool needed here since the user can only run one deploy at a time.
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
   * Takes an explicit, timestamped snapshot of the settings server-side and spawns a worker to
   * run the deploy against that frozen copy - later `config:merge` calls must not (and don't -
   * `settings` is a plain value captured right here, not re-read mid-deploy) affect an
   * already-started deploy. See ipc.ts's "CONCURRENCY / DISK-SAFETY CONTRACT" doc comment.
   */
  start(loadOrder: string[]): DeploySnapshot {
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

    // gamePath is the only thing about the game install this app persists (see settings.ts) -
    // retailPath/runtimePath/platform are derived fresh right here, every deploy.
    const detection = settings.gamePath ? deriveGamePathInfo(settings.gamePath, this.paths) : ({ ok: false, error: "" } as const)
    if (!detection.ok) {
      queueMicrotask(() => {
        this.emit({
          stage: "finalizing",
          stageIndex: 3,
          stageTotal: 4,
          logLine: detection.error || "No valid game folder is set - open Settings and pick your game's Retail folder first.",
          done: true,
          ok: false
        })
        this.active = null
      })
      return snapshot
    }

    this.emit({ stage: "sorting", stageIndex: 0, stageTotal: 4, modTotal: snapshot.loadOrder.length, logLine: "Sorting load order...", done: false })

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
          stageIndex: 3,
          stageTotal: 4,
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
        stageIndex: 3,
        stageTotal: 4,
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
      settings: { ...settings, loadOrder: snapshot.loadOrder },
      game
    }
    worker.postMessage(req)

    return snapshot
  }

  /**
   * Runs analyseMod in the deploy worker (same thread isolation rationale as start()) - rejected
   * while a deploy is active. Returns a plain Promise<result> rather than the streaming snapshot
   * pattern since the caller (ipcHandlers.ts's deploy:analyseMod handler) awaits the full result.
   */
  runAnalyseMod(modId: string): Promise<{ ok: boolean; error?: string }> {
    if (this.active) {
      return Promise.resolve({ ok: false, error: "A deploy is currently running." })
    }

    const settings: AppSettings = loadSettings(this.paths)
    const detection = settings.gamePath ? deriveGamePathInfo(settings.gamePath, this.paths) : ({ ok: false, error: "" } as const)
    if (!detection.ok) {
      return Promise.resolve({ ok: false, error: detection.error || "No valid game folder is set - open Settings and pick your game's Retail folder first." })
    }

    const taskId = this.nextTaskId++
    const worker = new Worker(resolveDeployWorkerPath())
    const { ok: _ok, ...game } = detection

    const req: DeployWorkerRequest = {
      id: taskId,
      type: "analyseMod",
      paths: this.paths,
      settings,
      game,
      modId
    }

    return new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      worker.on("message", (msg: DeployWorkerMessage) => {
        if (msg.id !== taskId) return
        if (msg.type === "done") {
          void worker.terminate()
          resolve(msg.ok ? { ok: true } : { ok: false, error: msg.error })
        }
        // "log" messages from analyseMod are intentionally ignored here - the caller's own
        // event.sender.send("deploy:analyseModLog") wiring in ipcHandlers.ts is unchanged.
      })

      worker.on("error", (err) => {
        void worker.terminate()
        reject(err)
      })

      worker.postMessage(req)
    })
  }

  private handleLine(snapshot: DeploySnapshot, { text }: DeployPipelineLogLine, stage: DeployProgress["stage"]): DeployProgress["stage"] {
    const stageIndexOf = { sorting: 0, extracting: 1, patching: 2, finalizing: 3 } as const

    if (/staging rpkg mod/i.test(text)) {
      this.emit({ stage: "extracting", stageIndex: stageIndexOf.extracting, stageTotal: 4, logLine: text, done: false })
      return "extracting"
    }

    const deployingMatch = text.match(/Deploying (\S+)/)
    if (deployingMatch) {
      const currentModId = deployingMatch[1]
      const modIndex = snapshot.loadOrder.indexOf(currentModId)
      this.emit({
        stage: "patching",
        stageIndex: stageIndexOf.patching,
        stageTotal: 4,
        currentModId,
        modIndex: modIndex === -1 ? undefined : modIndex,
        modTotal: snapshot.loadOrder.length,
        logLine: text,
        done: false
      })
      return "patching"
    }

    if (/generating rpkgs/i.test(text)) {
      this.emit({ stage: "finalizing", stageIndex: stageIndexOf.finalizing, stageTotal: 4, logLine: text, done: false })
      return "finalizing"
    }

    // Anything else - keep it in the raw log without changing the stage.
    this.emit({ stage, stageIndex: stageIndexOf[stage], stageTotal: 4, logLine: text, done: false })
    return stage
  }
}
