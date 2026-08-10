import { dirname } from 'node:path'
import { pipe } from 'fp-ts/function'
import * as TE from 'fp-ts/TaskEither'
import { errorMessage, type ScriptError, scriptError } from './effects'
import {
  cleanupTemporaryPath,
  createTemporaryPath,
  ensureDirectory,
  moveFileAtomically,
} from './files'

export interface FetchOptions {
  headers?: Record<string, string>
  debug?: (message: string) => void
  onHttpError?: (response: Response, body: string) => string | undefined
  fetchImpl?: typeof fetch
}

const request = (url: string, options: FetchOptions): TE.TaskEither<ScriptError, Response> =>
  TE.tryCatch(
    () => (options.fetchImpl ?? fetch)(url, { headers: options.headers }),
    (cause) => {
      options.debug?.(`GET ${url} -> network error: ${errorMessage(cause)}`)
      return scriptError('HTTP request', errorMessage(cause), { url, cause })
    }
  )

export function downloadFile(
  url: string,
  destination: string,
  options: FetchOptions = {}
): TE.TaskEither<ScriptError, void> {
  return pipe(
    ensureDirectory(dirname(destination)),
    TE.chain(() => createTemporaryPath(dirname(destination), 'download')),
    TE.chain((temporaryPath) =>
      TE.bracket(
        TE.right(temporaryPath),
        (temporaryPath) =>
          pipe(
            request(url, options),
            TE.chainFirstIOK((response) => () => {
              options.debug?.(`GET ${url} -> ${response.status}`)
            }),
            TE.filterOrElseW(
              (response) => response.status === 200,
              (response) =>
                scriptError('download file', `HTTP ${response.status} fetching ${url}`, { url })
            ),
            TE.chain((response) =>
              TE.tryCatch(
                () => Bun.write(temporaryPath, response).then(() => undefined),
                (cause) =>
                  scriptError('write download', errorMessage(cause), { path: temporaryPath, url })
              )
            ),
            TE.chain(() => moveFileAtomically(temporaryPath, destination))
          ),
        (temporaryPath) => cleanupTemporaryPath(temporaryPath)
      )
    )
  )
}

export function fetchJson<T>(
  url: string,
  options: FetchOptions = {}
): TE.TaskEither<ScriptError, T> {
  return pipe(
    request(url, options),
    TE.chainFirstIOK((response) => () => {
      options.debug?.(`GET ${url} -> ${response.status}`)
      options.debug?.(
        `  x-ratelimit-remaining: ${response.headers.get('x-ratelimit-remaining') ?? undefined}`
      )
      options.debug?.(
        `  x-ratelimit-reset: ${response.headers.get('x-ratelimit-reset') ?? undefined}`
      )
    }),
    TE.chain((response) =>
      TE.tryCatch(
        async () => ({ response, body: await response.text() }),
        (cause) => scriptError('read HTTP response', errorMessage(cause), { url, cause })
      )
    ),
    TE.chain(({ response, body }) => {
      options.debug?.(`  body: ${body.slice(0, 500)}`)
      if (response.status !== 200) {
        let message = ''
        try {
          message = (JSON.parse(body) as { message?: string }).message ?? ''
        } catch {
          /* non-JSON proxy response */
        }
        const extra = options.onHttpError?.(response, body) ?? ''
        return TE.left(
          scriptError(
            'HTTP request',
            `HTTP ${response.status} fetching ${url}${message ? ` - ${message}` : ''}${extra}`,
            { url }
          )
        )
      }
      return TE.tryCatch(
        () => Promise.resolve(JSON.parse(body) as T),
        (cause) =>
          scriptError(
            'parse JSON',
            `Couldn't parse JSON from ${url}: ${errorMessage(cause)} - body started with: ${body.slice(0, 200)}`,
            { url, cause }
          )
      )
    })
  )
}
