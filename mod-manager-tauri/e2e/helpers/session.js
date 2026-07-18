/**
 * Starts tauri-driver (which proxies WebDriver commands to WebKitWebDriver on
 * Linux) and opens a WebdriverIO session against the app binary under test.
 */
import { execSync, spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import net from "node:net"

import { remote } from "webdriverio"

const DRIVER_PORT = Number(process.env.E2E_DRIVER_PORT ?? 4444)

function which(bin) {
	try {
		return (
			execSync(`which ${bin}`, { stdio: ["ignore", "pipe", "ignore"] })
				.toString()
				.trim() || null
		)
	} catch {
		return null
	}
}

function findTauriDriver() {
	const fromEnv = process.env.TAURI_DRIVER
	if (fromEnv) return fromEnv
	const onPath = which("tauri-driver")
	if (onPath) return onPath
	const cargoBin = join(homedir(), ".cargo", "bin", "tauri-driver")
	if (existsSync(cargoBin)) return cargoBin
	throw new Error("tauri-driver not found — install it with: cargo install tauri-driver --locked")
}

function waitForPort(port, timeoutMs = 15_000) {
	const deadline = Date.now() + timeoutMs
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const socket = net.connect({ port, host: "127.0.0.1" })
			socket.once("connect", () => {
				socket.end()
				resolve()
			})
			socket.once("error", () => {
				socket.destroy()
				if (Date.now() > deadline) reject(new Error(`tauri-driver did not listen on port ${port}`))
				else setTimeout(attempt, 250)
			})
		}
		attempt()
	})
}

export async function startDriver() {
	const args = ["--port", String(DRIVER_PORT)]
	// WebKitWebDriver comes with webkitgtk (present in the nix devShell)
	const nativeDriver = process.env.WEBKIT_WEBDRIVER ?? which("WebKitWebDriver")
	if (nativeDriver) args.push("--native-driver", nativeDriver)

	const proc = spawn(findTauriDriver(), args, { stdio: ["ignore", "inherit", "inherit"] })
	proc.on("error", (e) => {
		throw new Error(`failed to start tauri-driver: ${e}`)
	})
	await waitForPort(DRIVER_PORT)
	return proc
}

export async function startSession(appPath) {
	return await remote({
		hostname: "127.0.0.1",
		port: DRIVER_PORT,
		capabilities: {
			browserName: "wry",
			"tauri:options": { application: appPath },
			// WebKitWebDriver doesn't speak WebDriver BiDi; without this wdio v9
			// requests webSocketUrl and capability matching fails
			"wdio:enforceWebDriverClassic": true
		},
		logLevel: "warn",
		connectionRetryCount: 2
	})
}
