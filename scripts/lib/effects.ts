import { type Either, isLeft, right } from 'fp-ts/Either'
import { pipe } from 'fp-ts/function'
import * as TE from 'fp-ts/TaskEither'

export interface ScriptError {
  readonly _tag: 'ScriptError'
  readonly operation: string
  readonly message: string
  readonly path?: string
  readonly url?: string
  readonly process?: {
    readonly command: string
    readonly args: readonly string[]
    readonly exitCode?: number
  }
  readonly cause?: unknown
}

export const scriptError = (
  operation: string,
  message: string,
  details: Omit<ScriptError, '_tag' | 'operation' | 'message'> = {}
): ScriptError => ({
  _tag: 'ScriptError',
  operation,
  message,
  ...details,
})

export const toScriptError = (
  operation: string,
  cause: unknown,
  details: Omit<ScriptError, '_tag' | 'operation' | 'message' | 'cause'> = {}
): ScriptError => scriptError(operation, errorMessage(cause), { ...details, cause })

export function errorMessage(error: unknown): string {
  return error && typeof error === 'object' && 'message' in error
    ? String(error.message)
    : String(error)
}

export function errorStack(error: unknown): string | undefined {
  if (error instanceof Error) return error.stack
  if (error && typeof error === 'object' && 'cause' in error) return errorStack(error.cause)
  return undefined
}

export function formatScriptError(error: ScriptError): string {
  const context = error.path ? ` (${error.path})` : error.url ? ` (${error.url})` : ''
  return `${error.operation}${context}: ${error.message}`
}

export const tryScript = <A>(
  operation: string,
  thunk: () => Promise<A>,
  details: Omit<ScriptError, '_tag' | 'operation' | 'message' | 'cause'> = {}
): TE.TaskEither<ScriptError, A> =>
  TE.tryCatch(thunk, (cause) => toScriptError(operation, cause, details))

export const runTask = <A>(task: TE.TaskEither<ScriptError, A>): Promise<Either<ScriptError, A>> =>
  task()

export async function requireTask<A>(task: TE.TaskEither<ScriptError, A>): Promise<A> {
  const result = await task()
  if (isLeft(result)) throw result.left
  return result.right
}

export interface BestEffortTask {
  readonly label: string
  readonly operation: TE.TaskEither<ScriptError, unknown>
  readonly warning: string
}

/** Run independent setup tasks concurrently. Every failure is reported and the task is non-fatal. */
export const runBestEffort = (
  tasks: readonly BestEffortTask[],
  report: (message: string) => void = console.warn
): TE.TaskEither<never, void> =>
  pipe(
    TE.rightIO(() => undefined),
    TE.chainW(() => async () => {
      const results = await Promise.all(
        tasks.map(async ({ label, operation, warning }) => ({
          label,
          warning,
          result: await operation().catch((cause) => ({
            _tag: 'Left' as const,
            left: toScriptError(label, cause),
          })),
        }))
      )
      for (const task of results)
        if (isLeft(task.result))
          report(
            `Couldn't fetch ${task.label} automatically (${formatScriptError(task.result.left)}). ${task.warning}`
          )
      return right(undefined)
    })
  )
