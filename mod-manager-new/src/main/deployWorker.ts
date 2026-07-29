import { parentPort } from "node:worker_threads"
import type { AppPaths } from "./paths"
import type { AppSettings } from "./settings"
import type { GamePathInfo } from "./gameDetect"
import { runFullDeploy, runAnalyseMod, type DeployPipelineLogLine } from "./deployPipeline"

/**
 * Worker-thread counterpart to DeployManager. Receives one task at a time over parentPort, runs
 * the heavy framework-core work (discover → difference → deploy, or analyseMod) entirely off the
 * main thread so the Electron main process event loop stays free to handle IPC while a deploy is
 * in flight, then posts the result (and streamed log lines) back.
 *
 * Protocol (all messages carry `id` so the main side can correlate if it ever needs to):
 *   main → worker  { id, type: "deploy" | "analyseMod", paths, settings, game[, modId] }
 *   worker → main  { id, type: "log",  line: DeployPipelineLogLine }   (zero or more)
 *   worker → main  { id, type: "done", ok: true }                      (on success)
 *   worker → main  { id, type: "done", ok: false, error: string }      (on failure)
 */

export type DeployWorkerRequest =
  | { id: number; type: "deploy"; paths: AppPaths; settings: AppSettings; game: GamePathInfo }
  | { id: number; type: "analyseMod"; paths: AppPaths; settings: AppSettings; game: GamePathInfo; modId: string }

export type DeployWorkerMessage =
  | { id: number; type: "log"; line: DeployPipelineLogLine }
  | { id: number; type: "done"; ok: true }
  | { id: number; type: "done"; ok: false; error: string }

if (!parentPort) {
  throw new Error("deployWorker.ts must be run inside a worker thread")
}

const port = parentPort

port.on("message", async (req: DeployWorkerRequest) => {
  const onLog = (line: DeployPipelineLogLine) => port.postMessage({ id: req.id, type: "log", line } satisfies DeployWorkerMessage)

  try {
    const result =
      req.type === "deploy"
        ? await runFullDeploy(req.paths, req.settings, req.game, onLog)
        : await runAnalyseMod(req.paths, req.settings, req.game, req.modId, onLog)

    port.postMessage(result.ok ? ({ id: req.id, type: "done", ok: true } satisfies DeployWorkerMessage) : ({ id: req.id, type: "done", ok: false, error: result.error } satisfies DeployWorkerMessage))
  } catch (err) {
    port.postMessage({ id: req.id, type: "done", ok: false, error: err instanceof Error ? err.message : String(err) } satisfies DeployWorkerMessage)
  }
})
