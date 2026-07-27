import child_process from "child_process"
import path from "path"

import "clarify"

/**
 * Thrown when the underlying rpkg-cli process exits unexpectedly (crashes) instead of on
 * request. Replaces the previous behaviour of calling `process.exit(1)` from inside the
 * process's "close" handler - any pending {@link RPKGInstance.callFunction}/
 * {@link RPKGInstance.waitForInitialised} call is rejected with this instead, so it's up to the
 * caller (ultimately the CLI entry point or an embedder) to decide what a fatal RPKG crash means.
 */
export class RPKGProcessError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RPKGProcessError"
	}
}

interface PendingCall {
	resolve: (result: string) => void
	reject: (error: Error) => void
}

class RPKGInstance {
	rpkgProcess: child_process.ChildProcessWithoutNullStreams

	output: string
	previousOutput: string

	initialised: boolean
	ready: boolean

	shouldExit: boolean

	private fatalError?: Error
	private initialisedWaiters: PendingCall[] = []
	private readyWaiter?: PendingCall

	/** @param rpkgCliPath Path to the rpkg-cli executable. Defaults to `Third-Party/rpkg-cli` under the current working directory, matching the CLI's historical layout. */
	constructor(rpkgCliPath: string = path.join(process.cwd(), "Third-Party", "rpkg-cli")) {
		this.rpkgProcess = child_process.spawn(rpkgCliPath, ["-i"])
		this.output = ""
		this.previousOutput = ""
		this.initialised = false
		this.ready = false
		this.shouldExit = false

		this.rpkgProcess.stdout.on("data", (data) => {
			this.output += String(data)

			if (this.output.endsWith("RPKG> ")) {
				if (!this.initialised) {
					this.initialised = true
					this.ready = false
					this.output = ""
					this.previousOutput = ""

					const waiters = this.initialisedWaiters.splice(0)
					for (const { resolve } of waiters) {
						resolve(this.previousOutput)
					}

					return
				}

				this.previousOutput = this.output
				this.output = ""
				this.ready = true

				if (this.readyWaiter) {
					const { resolve } = this.readyWaiter
					this.readyWaiter = undefined
					resolve(this.previousOutput.slice(0, -8).replace(/Running command: .*\r\n\r\n/g, ""))
				}
			}
		})

		this.rpkgProcess.on("close", () => {
			if (this.shouldExit) {
				return
			}

			console.error("Fatal error!")
			console.error("RPKG process exited unexpectedly with output:")

			for (const line of this.output.split("\n")) {
				console.log(line)
			}

			this.fatalError = new RPKGProcessError(`RPKG process exited unexpectedly with output:\n${this.output}`)

			const initialisedWaiters = this.initialisedWaiters.splice(0)
			for (const { reject } of initialisedWaiters) {
				reject(this.fatalError)
			}

			if (this.readyWaiter) {
				const { reject } = this.readyWaiter
				this.readyWaiter = undefined
				reject(this.fatalError)
			}
		})
	}

	async waitForInitialised(): Promise<string> {
		if (this.fatalError) {
			throw this.fatalError
		}

		if (this.initialised) {
			return this.previousOutput
		}

		return new Promise((resolve, reject) => {
			this.initialisedWaiters.push({ resolve, reject })
		})
	}

	async callFunction(func: string): Promise<string> {
		if (this.fatalError) {
			throw this.fatalError
		}

		this.ready = false

		this.rpkgProcess.stdin.write(func)
		this.rpkgProcess.stdin.write("\n")

		return new Promise((resolve, reject) => {
			this.readyWaiter = { resolve, reject }
		})
	}

	async getRPKGOfHash(runtimePath: string, hash: string): Promise<string> {
		const result = [
			...(await this.callFunction(`-hash_probe "${path.resolve(process.cwd(), runtimePath)}" -filter "${hash}"`)).matchAll(/is in RPKG file: (chunk[0-9]*(?:patch[1-9])?)\.rpkg/g)
		]

		return result
			.map((a) => a[1])
			.sort((a, b) => {
				const aChunk = /(chunk[0-9]*)(?:patch[0-9]*)?/gi.exec(a)![1]
				const bChunk = /(chunk[0-9]*)(?:patch[0-9]*)?/gi.exec(b)![1]

				if (aChunk.localeCompare(bChunk) !== 0) {
					return aChunk.localeCompare(bChunk, undefined, {
						numeric: true,
						sensitivity: "base"
					})
				} else {
					return b.localeCompare(a, undefined, {
						numeric: true,
						sensitivity: "base"
					})
				}
			})[0]
	}

	exit() {
		this.shouldExit = true
		this.rpkgProcess.kill()
	}
}

export default RPKGInstance
