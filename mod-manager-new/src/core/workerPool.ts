import { Worker } from "worker_threads"

/**
 * Hand-rolled replacement for Piscina (see LEI-132). The only thing this project ever needed from
 * a worker pool is "run N independent async jobs against a fixed set of worker threads, cap
 * concurrency at maxThreads, get one result (or error) back per job" - not any of Piscina's
 * fancier features (dynamic pool scaling, cross-task-type queueing, transferable-aware
 * scheduling, etc). Piscina was originally dropped-in to work around Tauri's `pkg` bundling
 * breaking its worker-thread module resolution (LEI-105) - now that this runs under Electron's own
 * Node (or the CLI's own bundled `patchWorker.js`, see scripts/build.js) instead of a `pkg`
 * snapshot, that problem doesn't exist, so owning this directly is simpler than carrying the
 * dependency.
 *
 * Protocol with the worker side (see patchWorker.ts): each task is sent as
 * `worker.postMessage({ id, data })`; the worker replies on the same channel with either
 * `{ id, ok: true, result }` or `{ id, ok: false, error }`. Each worker only ever has one task in
 * flight at a time (the pool doesn't hand out a second task until the first one's reply comes
 * back), so `id` isn't load-bearing for correlation today - it's there so a stray/late message
 * can be told apart from the task currently expected, and so the wire format is self-describing if
 * this ever needs debugging.
 */

interface WorkerRequest<TData> {
	id: number
	data: TData
}

interface WorkerSuccessResponse<TResult> {
	id: number
	ok: true
	result: TResult
}

interface WorkerErrorResponse {
	id: number
	ok: false
	error: { name: string; message: string; stack: string | undefined } | unknown
}

type WorkerResponse<TResult> = WorkerSuccessResponse<TResult> | WorkerErrorResponse

interface QueuedTask<TData, TResult> {
	id: number
	data: TData
	resolve: (value: TResult) => void
	reject: (reason: unknown) => void
}

function toError(error: WorkerErrorResponse["error"]): unknown {
	if (error && typeof error === "object" && "message" in error) {
		const reconstructed = new Error((error as { message: string }).message)
		reconstructed.name = (error as { name?: string }).name ?? reconstructed.name
		reconstructed.stack = (error as { stack?: string }).stack ?? reconstructed.stack
		return reconstructed
	}

	return error
}

export class WorkerPool<TData = unknown, TResult = unknown> {
	private readonly filename: string

	private readonly workers: Worker[] = []
	private readonly idleWorkers: Worker[] = []

	/** Rejects whatever task the given worker currently has in flight - used when the worker itself dies mid-task rather than replying normally. */
	private readonly inFlightRejections = new Map<Worker, (reason: unknown) => void>()

	private readonly queue: QueuedTask<TData, TResult>[] = []

	private nextTaskId = 0
	private destroyed = false

	constructor(filename: string, maxThreads: number) {
		this.filename = filename

		for (let i = 0; i < Math.max(1, maxThreads); i++) {
			const worker = this.spawnWorker()
			this.workers.push(worker)
			this.idleWorkers.push(worker)
		}
	}

	private spawnWorker(): Worker {
		const worker = new Worker(this.filename)

		// A worker crashing outright (as opposed to the task it's running failing normally, which
		// comes back as a `{ ok: false }` message) shouldn't take out the whole pool or leave
		// run() callers hanging forever - fail whatever task it was running and replace it so the
		// pool keeps its configured concurrency for anything left in the queue.
		worker.on("error", (error) => this.handleWorkerCrash(worker, error))
		worker.on("exit", (code) => {
			if (code !== 0) {
				this.handleWorkerCrash(worker, new Error(`patchWorker thread stopped with exit code ${code}`))
			}
		})

		return worker
	}

	private handleWorkerCrash(worker: Worker, error: unknown): void {
		if (this.destroyed) {
			return
		}

		const workerIndex = this.workers.indexOf(worker)
		if (workerIndex === -1) {
			return // already replaced as part of handling this same crash
		}

		this.inFlightRejections.get(worker)?.(error)
		this.inFlightRejections.delete(worker)

		const idleIndex = this.idleWorkers.indexOf(worker)
		if (idleIndex !== -1) {
			this.idleWorkers.splice(idleIndex, 1)
		}

		const replacement = this.spawnWorker()
		this.workers[workerIndex] = replacement
		this.idleWorkers.push(replacement)

		this.pump()
	}

	run(data: TData): Promise<TResult> {
		if (this.destroyed) {
			return Promise.reject(new Error("Cannot run a task on a destroyed WorkerPool"))
		}

		return new Promise<TResult>((resolve, reject) => {
			this.queue.push({ id: this.nextTaskId++, data, resolve, reject })
			this.pump()
		})
	}

	private pump(): void {
		while (this.queue.length && this.idleWorkers.length) {
			const worker = this.idleWorkers.pop()!
			const task = this.queue.shift()!

			this.inFlightRejections.set(worker, task.reject)

			const onMessage = (message: WorkerResponse<TResult>) => {
				if (message.id !== task.id) {
					return // stray reply for a task this worker no longer owns - ignore it
				}

				worker.off("message", onMessage)
				this.inFlightRejections.delete(worker)

				if (message.ok) {
					task.resolve(message.result)
				} else {
					task.reject(toError(message.error))
				}

				if (!this.destroyed) {
					this.idleWorkers.push(worker)
					this.pump()
				}
			}

			worker.on("message", onMessage)

			const request: WorkerRequest<TData> = { id: task.id, data: task.data }
			worker.postMessage(request)
		}
	}

	/** Terminates every worker in the pool. Any tasks still queued (there shouldn't be any if callers await all their `run()` promises first) are dropped without resolving or rejecting. */
	async destroy(): Promise<void> {
		this.destroyed = true
		this.queue.length = 0

		for (const reject of this.inFlightRejections.values()) {
			reject(new Error("WorkerPool was destroyed while this task was still running"))
		}
		this.inFlightRejections.clear()

		await Promise.all(this.workers.map((worker) => worker.terminate()))
	}
}
