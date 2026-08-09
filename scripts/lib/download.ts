import { dirname } from "node:path"
import { createTemporaryPath, ensureDirectory, cleanupTemporaryPath, moveFileAtomically } from "./files"
import { errorMessage } from "./errors"

export interface FetchOptions {
	headers?: Record<string, string>
	debug?: (message: string) => void
	onHttpError?: (response: Response, body: string) => string | undefined
}

export async function downloadFile(url: string, destination: string, options: FetchOptions = {}): Promise<void> {
	await ensureDirectory(dirname(destination))
	const temporaryPath = await createTemporaryPath(dirname(destination), "download")
	try {
		let response: Response
		try {
			response = await fetch(url, { headers: options.headers })
		} catch (error) {
			options.debug?.(`GET ${url} -> network error: ${errorMessage(error)}`)
			throw error
		}
		options.debug?.(`GET ${url} -> ${response.status}`)
		if (response.status !== 200) {
			throw new Error(`HTTP ${response.status} fetching ${url}`)
		}

		// Bun.write consumes the response body as a stream; the completed temporary file is
		// moved into place atomically below.
		await Bun.write(temporaryPath, response)
		await moveFileAtomically(temporaryPath, destination)
	} finally {
		await cleanupTemporaryPath(temporaryPath)
	}
}

export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
	let response: Response
	try {
		response = await fetch(url, { headers: options.headers })
	} catch (error) {
		options.debug?.(`GET ${url} -> network error: ${errorMessage(error)}`)
		throw error
	}
	options.debug?.(`GET ${url} -> ${response.status}`)
	options.debug?.(`  x-ratelimit-remaining: ${response.headers.get("x-ratelimit-remaining") ?? undefined}`)
	options.debug?.(`  x-ratelimit-reset: ${response.headers.get("x-ratelimit-reset") ?? undefined}`)

	const body = await response.text()
	options.debug?.(`  body: ${body.slice(0, 500)}`)
	if (response.status !== 200) {
		let message = ""
		try {
			message = (JSON.parse(body) as { message?: string }).message ?? ""
		} catch {
			// The body was not JSON, such as an HTML error page from a proxy.
		}
		const extra = options.onHttpError?.(response, body)
		throw new Error(`HTTP ${response.status} fetching ${url}${message ? ` - ${message}` : ""}${extra ?? ""}`)
	}

	try {
		return JSON.parse(body) as T
	} catch (error) {
		throw new Error(`Couldn't parse JSON from ${url}: ${errorMessage(error)} - body started with: ${body.slice(0, 200)}`, { cause: error })
	}
}
