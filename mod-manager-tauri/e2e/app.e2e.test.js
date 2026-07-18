/**
 * End-to-end test: real app binary, real WebKit webview, real Rust IO bridge.
 *
 * Drives the app through tauri-driver (WebDriver). Covers:
 *   - app launch against a realistic on-disk framework layout
 *   - mod list rendering (framework + RPKG mods discovered on disk)
 *   - enabling a mod → load order persisted to config.json on disk
 *   - deploy → stub Deploy.exe spawned, output streamed into the UI
 *
 * Prerequisites (see e2e/README.md): a debug app binary, tauri-driver, and
 * WebKitWebDriver; headless runs need xvfb-run.
 */
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { TEST_MOD_ID, TEST_MOD_NAME, TEST_RPKG_MOD_NAME, createFixture, readFixtureConfig } from "./helpers/fixture.js"
import { startDriver, startSession } from "./helpers/session.js"

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)))
const appBinary = process.env.E2E_APP_BINARY ?? join(projectDir, "src-tauri", "target", "debug", "mod-manager-tauri")

let fixture
let driver
let browser

/**
 * WebKitWebDriver (webkitgtk 2.52) miscomputes element rects under Xvfb and
 * rejects native clicks with "element not interactable" even for perfectly
 * visible elements — fall back to a DOM-level click inside the page.
 */
async function click(selectorOrElement) {
	const el = typeof selectorOrElement === "string" ? browser.$(selectorOrElement) : selectorOrElement
	await el.waitForExist({ timeout: 10_000 })
	try {
		await el.click()
	} catch {
		await browser.execute((node) => node.click(), await el.getElement())
	}
}

before(async () => {
	assert.ok(existsSync(appBinary), `App binary not found at ${appBinary} — build it first: npm run tauri build -- --debug --no-bundle (inside nix develop)`)
	fixture = createFixture(appBinary)
	driver = await startDriver()
	browser = await startSession(fixture.app)
})

after(async () => {
	try {
		await browser?.deleteSession()
	} catch {
		// session may already be gone if a test crashed the app
	}
	driver?.kill()
})

test("launches and renders the navigation bar", async () => {
	await browser.$('a[href="/modList"]').waitForExist({ timeout: 20_000 })
})

test("mod list shows the mods found on disk", async () => {
	// navigate directly rather than clicking, so a startup modal (e.g. an
	// update-available prompt when GitHub is reachable) can't block the test
	const base = await browser.getUrl()
	await browser.url(new URL("/modList", base).href)

	await browser.$("h1=Available Mods").waitForExist({ timeout: 20_000 })
	await browser.$(`h4=${TEST_MOD_NAME}`).waitForExist({ timeout: 10_000 })
	await browser.$(`h4=${TEST_RPKG_MOD_NAME}`).waitForExist({ timeout: 5_000 })
})

test("enabling a mod updates the load order in config.json", async () => {
	const tile = browser.$(`//div[contains(@class, "bx--tile")][.//h4[normalize-space()="${TEST_MOD_NAME}"]]`)
	await click(tile.$("button=Enable"))

	// the enabled column's heading switches once there are pending changes
	await browser.$("h1=To Be Applied").waitForExist({ timeout: 10_000 })

	await browser.waitUntil(async () => readFixtureConfig(fixture).loadOrder.includes(TEST_MOD_ID), {
		timeout: 10_000,
		timeoutMsg: `config.json loadOrder never gained ${TEST_MOD_ID}`
	})
})

test("deploy spawns Deploy.exe and streams its output into the modal", async () => {
	await click("button=Apply")

	await browser.$("h3=Applying your mods").waitForExist({ timeout: 10_000 })
	await browser.$("span=Deploy successful").waitForExist({ timeout: 30_000 })

	const output = await browser.$("#deployOutputElement").getText()
	assert.match(output, /Loading mods/)
	assert.match(output, /Done in 0\.71s/)

	await click("button=Close")
})
