import child_process from 'node:child_process'
import path from 'node:path'

import { wineArgv } from '../wineExec'

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
    this.name = 'RPKGProcessError'
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

  /**
   * @param toolsRoot The app's Third-Party tools root (usually `paths.toolsRoot`) - resolves to
   * `{toolsRoot}/Third-Party/rpkg-cli.exe` internally (explicit `.exe`, not left to Windows'
   * implicit spawn-extension resolution - see wineExec.ts's doc comment for why that matters on
   * Linux) and routed through {@link wineArgv} so it runs under Wine there.
   */
  constructor(toolsRoot: string) {
    const rpkgCliPath = path.join(toolsRoot, 'Third-Party', 'rpkg-cli.exe')
    const { command, args, env } = wineArgv(rpkgCliPath, ['-i'], toolsRoot)
    this.rpkgProcess = child_process.spawn(command, args, { windowsHide: true, env })
    this.output = ''
    this.previousOutput = ''
    this.initialised = false
    this.ready = false
    this.shouldExit = false

    this.rpkgProcess.stdout.on('data', (data) => {
      this.output += String(data)

      if (this.output.endsWith('RPKG> ')) {
        if (!this.initialised) {
          this.initialised = true
          this.ready = false
          this.output = ''
          this.previousOutput = ''

          const waiters = this.initialisedWaiters.splice(0)
          for (const { resolve } of waiters) {
            resolve(this.previousOutput)
          }

          return
        }

        this.previousOutput = this.output
        this.output = ''
        this.ready = true

        if (this.readyWaiter) {
          const { resolve } = this.readyWaiter
          this.readyWaiter = undefined
          resolve(this.previousOutput.slice(0, -8).replace(/Running command: .*\r\n\r\n/g, ''))
        }
      }
    })

    // Node fires both "error" (if the process couldn't even be spawned - e.g. a missing exe or
    // missing `wine`) and "close" for the same failure, in unspecified relative order - failWith()
    // is idempotent (guarded by `this.fatalError`) so whichever fires first wins and the other is
    // a no-op. Without the "error" listener, a spawn failure was an unhandled EventEmitter "error"
    // (Node throws synchronously when "error" has zero listeners) that never rejected any pending
    // waiter - callers just hung until whatever external timeout gave up on them.
    this.rpkgProcess.on('error', (err) => {
      this.failWith(new RPKGProcessError(`Failed to start rpkg-cli: ${err.message}`))
    })

    this.rpkgProcess.on('close', () => {
      if (this.shouldExit) {
        return
      }

      this.failWith(
        new RPKGProcessError(`RPKG process exited unexpectedly with output:\n${this.output}`)
      )
    })
  }

  private failWith(error: RPKGProcessError): void {
    if (this.fatalError) {
      return
    }

    console.error('Fatal error!')
    console.error(error.message)

    this.fatalError = error

    const initialisedWaiters = this.initialisedWaiters.splice(0)
    for (const { reject } of initialisedWaiters) {
      reject(this.fatalError)
    }

    if (this.readyWaiter) {
      const { reject } = this.readyWaiter
      this.readyWaiter = undefined
      reject(this.fatalError)
    }
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
    this.rpkgProcess.stdin.write('\n')

    return new Promise((resolve, reject) => {
      this.readyWaiter = { resolve, reject }
    })
  }

  async getRPKGOfHash(runtimePath: string, hash: string): Promise<string> {
    // runtimePath is expected to already be an absolute path by the time it gets here (see
    // core.ts's createCore(), which resolves config.runtimePath against paths.dataRoot) -
    // path.resolve() with no base is a no-op for an absolute path and otherwise falls back to
    // process.cwd(), same as it always implicitly did.
    const result = [
      ...(
        await this.callFunction(`-hash_probe "${path.resolve(runtimePath)}" -filter "${hash}"`)
      ).matchAll(/is in RPKG file: (chunk[0-9]*(?:patch[1-9])?)\.rpkg/g),
    ]

    return result
      .map((a) => a[1])
      .filter((a): a is string => a !== undefined)
      .sort((a, b) => {
        const aChunk = /(chunk[0-9]*)(?:patch[0-9]*)?/gi.exec(a)?.[1] ?? ''
        const bChunk = /(chunk[0-9]*)(?:patch[0-9]*)?/gi.exec(b)?.[1] ?? ''

        if (aChunk.localeCompare(bChunk) !== 0) {
          return aChunk.localeCompare(bChunk, undefined, {
            numeric: true,
            sensitivity: 'base',
          })
        } else {
          return b.localeCompare(a, undefined, {
            numeric: true,
            sensitivity: 'base',
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
