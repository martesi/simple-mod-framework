import { parentPort } from 'node:worker_threads'
import { type DeployPipelineLogLine, runAnalyseMod, runFullDeploy } from './deployPipeline'
import type { KnownGamePathInfo } from './gameDetect'
import type { ModsConfig } from './modsConfig'
import type { AppPaths } from './paths'
import type { AppSettings } from './settings'

/**
 * Worker-thread counterpart to DeployManager. Receives one task at a time over parentPort, runs
 * the heavy framework-core work (discover → difference → deploy, or analyseMod) entirely off the
 * main thread so the Electron main process event loop stays free to handle IPC while a deploy is
 * in flight, then posts the result (and streamed log lines) back.
 *
 * Protocol (all messages carry `id` so the main side can correlate if it ever needs to):
 *   main → worker  { id, type: "deploy" | "analyseMod", paths, settings, game[, modId] }
 *   main → worker  { id, type: "cancel" }                             (mid-task, deploy only - see cancel.ts)
 *   worker → main  { id, type: "log",  line: DeployPipelineLogLine }   (zero or more)
 *   worker → main  { id, type: "done", ok: true }                      (on success)
 *   worker → main  { id, type: "done", ok: false, error: string, cancelled?: boolean } (on failure/cancel)
 *
 * `port.on("message", ...)` stays registered for the worker's whole lifetime (not a one-shot
 * listener), so a "cancel" message can arrive and be handled while the "deploy"/"analyseMod"
 * handler for the original message is still `await`-suspended partway through - Node delivers the
 * new message event as soon as the event loop is free, same realm, no extra plumbing needed.
 */

export type DeployWorkerRequest =
  | {
      id: number
      type: 'deploy'
      paths: AppPaths
      settings: AppSettings
      modsConfig: ModsConfig
      game: KnownGamePathInfo
    }
  | {
      id: number
      type: 'analyseMod'
      paths: AppPaths
      settings: AppSettings
      modsConfig: ModsConfig
      game: KnownGamePathInfo
      modId: string
    }
  | { id: number; type: 'cancel' }

export type DeployWorkerMessage =
  | { id: number; type: 'log'; line: DeployPipelineLogLine }
  | { id: number; type: 'done'; ok: true }
  | { id: number; type: 'done'; ok: false; error: string; cancelled?: boolean }

if (!parentPort) {
  throw new Error('deployWorker.ts must be run inside a worker thread')
}

const port = parentPort

port.on('message', async (req: DeployWorkerRequest) => {
  if (req.type === 'cancel') {
    const { requestCancel } = await import('./core/cancel')
    requestCancel()
    return
  }

  const onLog = (line: DeployPipelineLogLine) =>
    port.postMessage({ id: req.id, type: 'log', line } satisfies DeployWorkerMessage)

  try {
    const result =
      req.type === 'deploy'
        ? await runFullDeploy(req.paths, req.settings, req.modsConfig, req.game, onLog)
        : await runAnalyseMod(req.paths, req.settings, req.modsConfig, req.game, req.modId, onLog)

    port.postMessage(
      result.ok
        ? ({ id: req.id, type: 'done', ok: true } satisfies DeployWorkerMessage)
        : ({
            id: req.id,
            type: 'done',
            ok: false,
            error: result.error,
            cancelled: 'cancelled' in result ? result.cancelled : undefined,
          } satisfies DeployWorkerMessage)
    )
  } catch (err) {
    port.postMessage({
      id: req.id,
      type: 'done',
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    } satisfies DeployWorkerMessage)
  }
})
