import { existsSync } from "node:fs"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import type { AppPaths } from "./paths"
import type { DeployProgress, DeploySnapshot } from "../renderer/src/lib/ipc"

export interface DeployProgressEmit {
  (progress: DeployProgress): void
}

/**
 * Spawns Deploy.exe and turns its output into the structured
 * `{ stage, modIndex, modTotal, currentModId }` shape `ipc.ts` documents as
 * the LEI-136 contract - "if LEI-136 isn't ready when LEI-133/134 land, a v1
 * backend can synthesize this same shape by scraping `Deploying <modId>`
 * lines out of the existing plain-text log against the known snapshot mod
 * list." That's exactly what this does: `--useConsoleLogging` makes those
 * lines show up on stdout in real time (the old app's plain pass-through
 * spawned *without* that flag, so its "log" was really just Deploy.exe's
 * banner/progress-bar output, not per-mod lines) rather than only ever being
 * appended to Deploy.log.
 *
 * Deploy.exe itself is still a separate process, spawned exactly like the
 * old `Mod Manager/src/main/index.ts` did - embedding `src/deploy.ts`
 * in-process is LEI-133's "wire embedded core into main process" scope, not
 * this one.
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

  start(loadOrder: string[]): DeploySnapshot {
    if (this.active) {
      throw new Error("A deploy is already running.")
    }

    const snapshot: DeploySnapshot = {
      snapshotId: randomUUID(),
      snapshotTime: Date.now(),
      loadOrder: [...loadOrder]
    }
    this.active = snapshot

    const exe = join(this.paths.dataRoot, "Deploy.exe")
    if (!existsSync(exe)) {
      // Dev/CI environments without a real portable build won't have
      // Deploy.exe - fail the deploy visibly instead of hanging forever, so
      // the rest of the app (which does have real fs/mod-index behavior) is
      // still testable.
      queueMicrotask(() => {
        this.emit({ stage: "finalizing", stageIndex: 3, stageTotal: 4, logLine: "Deploy.exe was not found - can't run a real deploy here.", done: true, ok: false })
        this.active = null
      })
      return snapshot
    }

    this.emit({ stage: "sorting", stageIndex: 0, stageTotal: 4, modTotal: snapshot.loadOrder.length, logLine: "Sorting load order...", done: false })

    const child = spawn(exe, ["--doNotPause", "--useConsoleLogging"], { cwd: this.paths.dataRoot, windowsHide: true })

    let stage: DeployProgress["stage"] = "sorting"
    let buffer = ""

    const handleChunk = (chunk: Buffer) => {
      buffer += chunk.toString()
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ""
      for (const line of lines) this.handleLine(snapshot, line, (next) => (stage = next), () => stage)
    }

    child.stdout.on("data", handleChunk)
    child.stderr.on("data", handleChunk)

    child.on("close", (code) => {
      this.emit({ stage: "finalizing", stageIndex: 3, stageTotal: 4, logLine: code === 0 ? "Deploy finished." : `Deploy.exe exited with code ${code}.`, done: true, ok: code === 0 })
      this.active = null
    })

    child.on("error", (error) => {
      this.emit({ stage: "finalizing", stageIndex: 3, stageTotal: 4, logLine: `Couldn't start Deploy.exe: ${error.message}`, done: true, ok: false })
      this.active = null
    })

    return snapshot
  }

  private handleLine(snapshot: DeploySnapshot, rawLine: string, setStage: (s: DeployProgress["stage"]) => void, getStage: () => DeployProgress["stage"]): void {
    // Strip a leading ANSI color escape (Deploy.exe colorizes level prefixes).
    // eslint-disable-next-line no-control-regex
    const line = rawLine.replace(/^\x1b\[[0-9;]*m/g, "").trim()
    if (!line) return

    const stageIndexOf = { sorting: 0, extracting: 1, patching: 2, finalizing: 3 } as const

    if (/staging rpkg mod/i.test(line)) {
      setStage("extracting")
      this.emit({ stage: "extracting", stageIndex: stageIndexOf.extracting, stageTotal: 4, logLine: line, done: false })
      return
    }

    const deployingMatch = line.match(/Deploying (\S+)/)
    if (deployingMatch) {
      setStage("patching")
      const currentModId = deployingMatch[1]
      const modIndex = snapshot.loadOrder.indexOf(currentModId)
      this.emit({
        stage: "patching",
        stageIndex: stageIndexOf.patching,
        stageTotal: 4,
        currentModId,
        modIndex: modIndex === -1 ? undefined : modIndex,
        modTotal: snapshot.loadOrder.length,
        logLine: line,
        done: false
      })
      return
    }

    if (/generating rpkgs/i.test(line)) {
      setStage("finalizing")
      this.emit({ stage: "finalizing", stageIndex: stageIndexOf.finalizing, stageTotal: 4, logLine: line, done: false })
      return
    }

    // Anything else - keep it in the raw log without changing the stage.
    this.emit({ stage: getStage(), stageIndex: stageIndexOf[getStage()], stageTotal: 4, logLine: line, done: false })
  }
}
