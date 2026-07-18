/**
 * WSL interop e2e test: cross-compiled mod-manager-tauri.exe runs as a real
 * Windows process via WSL binfmt interop; tests drive it through the WebView2
 * CDP remote-debugging endpoint (not tauri-driver / WebKit).
 *
 * Flow:
 *   1. Fixture builds the standard game layout in e2e/.runtime/game/
 *      The Deploy.exe in this layout is a cross-compiled Windows PE stub
 *      (the Windows process cannot exec a shell script).
 *   2. mod-manager-tauri.exe is launched with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
 *      enabling CDP on E2E_CDP_PORT (default 9222).
 *   3. puppeteer-core connects to the CDP endpoint and drives the WebView2 page.
 *
 * Self-skips (exit 0, single skip record) when:
 *   - WSL2 binfmt PE interop is not active
 *   - x86_64-w64-mingw32-gcc is not on PATH  (run inside `nix develop`)
 *   - The Windows .exe has not been built yet  (run: npm run test:e2e:wsl:build)
 */
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import puppeteer from "puppeteer-core"

import { TEST_MOD_ID, TEST_MOD_NAME, TEST_RPKG_MOD_NAME, createFixture, readFixtureConfig } from "./helpers/fixture.js"
import { buildStubDeployExe, findMingwGcc, wslInteropAvailable } from "./helpers/wsl-deploy-stub.js"

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)))
const CDP_PORT = Number(process.env.E2E_CDP_PORT ?? 9222)

// The Windows cross-compiled binary.  Build it with: npm run test:e2e:wsl:build
const appExe =
	process.env.E2E_WIN_APP_BINARY ??
	join(projectDir, "src-tauri", "target", "x86_64-pc-windows-gnu", "release", "mod-manager-tauri.exe")

const skipReason = !wslInteropAvailable()
	? "WSL2 with binfmt PE interop not available"
	: !findMingwGcc()
		? "x86_64-w64-mingw32-gcc not found — run inside nix develop"
		: !existsSync(appExe)
			? `Windows .exe not built — run: npm run test:e2e:wsl:build  (looked for ${appExe})`
			: null

/** Poll until port accepts a TCP connection or the deadline is reached. */
function waitForPort(port, timeoutMs = 30_000) {
	const deadline = Date.now() + timeoutMs
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const sock = net.connect({ port, host: "127.0.0.1" })
			sock.once("connect", () => {
				sock.end()
				resolve()
			})
			sock.once("error", () => {
				sock.destroy()
				if (Date.now() > deadline) reject(new Error(`CDP port ${port} not ready within ${timeoutMs}ms`))
				else setTimeout(attempt, 500)
			})
		}
		attempt()
	})
}

if (skipReason) {
	test(`wsl-interop suite (skipped: ${skipReason})`, { skip: skipReason }, () => {})
} else {
	describe("wsl-interop: Windows .exe via WSL binfmt + WebView2 CDP", () => {
		// Windows PE stub for Deploy.exe — written once per test session
		const stubDeployExe = join(tmpdir(), "smf-wsl-stub-deploy.exe")

		let fixture
		let appProc
		let browser
		let page

		before(async () => {
			// Build the Windows PE Deploy.exe stub (fast: tiny C file).
			// The Windows process cannot exec a shebang shell script, so a real
			// PE is required even for this stub role.
			buildStubDeployExe(stubDeployExe)

			// Place the .exe and stub Deploy into the fixture game layout.
			fixture = createFixture(appExe, {
				appFilename: "mod-manager-tauri.exe",
				deployBinary: stubDeployExe
			})

			// Launch via WSL interop.  The binfmt handler routes the PE to Windows.
			// WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS tells the Edge WebView2 runtime
			// to open a CDP endpoint.  WSL interop does not propagate arbitrary
			// Linux env vars to Windows processes by default; WSLENV opts in the
			// specific variable we need.
			const wslenvBase = process.env.WSLENV ? `${process.env.WSLENV}:` : ""
			appProc = spawn(
				fixture.app,
				[],
				{
					env: {
						...process.env,
						WSLENV: `${wslenvBase}WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`,
						WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT} --remote-allow-origins=*`
					},
					stdio: "ignore",
					detached: false
				}
			)
			appProc.on("error", (err) => {
				throw new Error(`failed to launch ${fixture.app}: ${err.message}`)
			})

			// Wait for WebView2 CDP to be ready, then connect.
			await waitForPort(CDP_PORT, 30_000)
			browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null })

			// Get the Tauri webview page (the first non-devtools page target).
			const targets = browser.targets()
			const pageTarget = targets.find((t) => t.type() === "page") ?? targets[0]
			page = await pageTarget.page()
			await page.setDefaultTimeout(20_000)
		})

		after(async () => {
			try {
				await browser?.disconnect()
			} catch {
				// ignore — app may already have exited
			}
			if (appProc && !appProc.killed) {
				appProc.kill("SIGTERM")
				// give the Windows process a moment to clean up via interop
				await new Promise((r) => setTimeout(r, 1_000))
				if (!appProc.killed) appProc.kill("SIGKILL")
			}
		})

		test("renders the navigation bar", async () => {
			await page.waitForSelector('a[href="/modList"]')
		})

		test("mod list shows the mods found on disk", async () => {
			await page.goto(new URL("/modList", await page.url()).href, { waitUntil: "networkidle0" })
			await page.waitForSelector("h1=Available Mods", { timeout: 20_000 }).catch(() =>
				page.waitForFunction(() => document.querySelector("h1")?.textContent?.includes("Available Mods"), { timeout: 20_000 })
			)
			await page.waitForFunction(
				(name) => [...document.querySelectorAll("h4")].some((el) => el.textContent.trim() === name),
				{ timeout: 10_000 },
				TEST_MOD_NAME
			)
			await page.waitForFunction(
				(name) => [...document.querySelectorAll("h4")].some((el) => el.textContent.trim() === name),
				{ timeout: 5_000 },
				TEST_RPKG_MOD_NAME
			)
		})

		test("enabling a mod persists its id to config.json loadOrder", async () => {
			// Find the Enable button inside the mod tile and click it.
			const enabled = await page.evaluate((modName) => {
				const tiles = [...document.querySelectorAll(".bx--tile")]
				const tile = tiles.find((t) => t.querySelector("h4")?.textContent?.trim() === modName)
				const btn = tile?.querySelector("button")
				if (btn && btn.textContent?.trim() === "Enable") {
					btn.click()
					return true
				}
				return false
			}, TEST_MOD_NAME)
			assert.ok(enabled, `Enable button not found for ${TEST_MOD_NAME}`)

			// Wait for config.json to be updated on disk.
			await page.waitForFunction(
				() => document.querySelector("h1")?.textContent?.includes("To Be Applied"),
				{ timeout: 10_000 }
			)
			const deadline = Date.now() + 10_000
			while (Date.now() < deadline) {
				const cfg = readFixtureConfig(fixture)
				if (cfg.loadOrder.includes(TEST_MOD_ID)) break
				await new Promise((r) => setTimeout(r, 300))
			}
			assert.ok(
				readFixtureConfig(fixture).loadOrder.includes(TEST_MOD_ID),
				`config.json loadOrder never gained ${TEST_MOD_ID}`
			)
		})

		test("deploy spawns Windows PE Deploy.exe via interop and streams output", async () => {
			// Click the Apply button.
			await page.evaluate(() => {
				const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Apply")
				btn?.click()
			})

			// Wait for the deploy modal header.
			await page.waitForFunction(() => document.querySelector("h3")?.textContent?.includes("Applying your mods"), {
				timeout: 10_000
			})

			// WSL interop cold-start is slower than a native Linux exec; allow 60 s.
			await page.waitForFunction(() => document.querySelector("span")?.textContent?.includes("Deploy successful"), {
				timeout: 60_000,
				polling: 500
			})

			const output = await page.$eval("#deployOutputElement", (el) => el.textContent ?? "")
			assert.match(output, /Loading mods/, "deploy output missing 'Loading mods'")
			assert.match(output, /Done in 0\.71s/, "deploy output missing 'Done in 0.71s'")

			await page.evaluate(() => {
				const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Close")
				btn?.click()
			})
		})
	})
}
