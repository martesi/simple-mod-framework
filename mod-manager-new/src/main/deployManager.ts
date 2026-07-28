import { randomUUID } from "node:crypto"
import type { AppPaths } from "./paths"
import type { AppSettings } from "./settings"
import { loadSettings } from "./settings"
import { deriveGamePathInfo } from "./gameDetect"
import { runFullDeploy, type DeployPipelineLogLine } from "./deployPipeline"
import type { DeployProgress, DeploySnapshot } from "../renderer/src/lib/ipc"

export interface DeployProgressEmit {
  (progress: DeployProgress): void
}

/**
 * Runs a full deploy by calling straight into the embedded framework core (`deployPipeline.ts`'s
 * `runFullDeploy()`) instead of spawning `Deploy.exe` as a subprocess (LEI-133 - the old version
 * of this file, before this change, did exactly that; see git history / the old `Mod Manager/src/main/index.ts`).
 *
 * The structured `{ stage, modIndex, modTotal, currentModId }` shape below is still the "v1"
 * version `ipc.ts`'s doc comment anticipated: it synthesizes that shape by pattern-matching the
 * same log lines `deploy.ts` has always produced (`Staging RPKG mod: ...`, `Deploying <modId>`,
 * `Generating RPKGs`), just fed from the in-process logger's callback now instead of scraped out
 * of a spawned process's stdout. Swap it out once LEI-136 lands a real structured progress channel
 * from the deployer itself.
 */
export class DeployManager {
  private active: DeploySnapshot | null = null

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
   * Takes an explicit, timestamped snapshot of the settings server-side and runs the deploy
   * against that frozen copy - later `config:merge` calls must not (and don't - `settings` is a
   * plain value here, not re-read mid-deploy) affect an already-started deploy. See ipc.ts's
   * "CONCURRENCY / DISK-SAFETY CONTRACT" doc comment.
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
    // retailPath/runtimePath/platform are derived fresh right here, every deploy, rather than
    // trusting a value stashed away at pick-time that could have gone stale since (game update,
    // reinstall, moved drive, etc).
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

    let stage: DeployProgress["stage"] = "sorting"

    void runFullDeploy(this.paths, { ...settings, loadOrder: snapshot.loadOrder }, detection, (line) => {
      stage = this.handleLine(snapshot, line, stage)
    }).then((result) => {
      this.emit({
        stage: "finalizing",
        stageIndex: 3,
        stageTotal: 4,
        logLine: result.ok ? "Deploy finished." : `Deploy failed: ${result.error}`,
        done: true,
        ok: result.ok
      })
      this.active = null
    })

    return snapshot
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
