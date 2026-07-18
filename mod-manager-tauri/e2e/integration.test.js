/**
 * Integration test: real game directory, real Deploy.exe, real mod archives.
 *
 * Opt-in — runs only when e2e/integration.json exists (see INTEGRATION.md).
 * When it is absent, this file registers a single skipped test and exits 0 so
 * it never fails CI or a local `npm run test:e2e`.
 *
 * The fixture (helpers/integration-fixture.js) installs the configured mods into
 * the real <frameworkRoot>/Mods before launch and flips outputToSeparateDirectory
 * so Deploy.exe writes to Output/ instead of patching Runtime/ in place.  This
 * suite then drives the UI to: list the installed mods, enable them (persisted
 * to config.json), and deploy through the real binary, asserting Output/ is
 * populated and Runtime/ is left untouched.
 */
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { after, before, describe, test } from "node:test"
import { fileURLToPath } from "node:url"

import { createIntegrationFixture, hasPatchRpkg, loadIntegrationConfig, mtimeMs, readConfig } from "./helpers/integration-fixture.js"
import { startDriver, startSession } from "./helpers/session.js"

const projectDir = dirname(dirname(fileURLToPath(import.meta.url)))
const appBinary = process.env.E2E_APP_BINARY ?? join(projectDir, "src-tauri", "target", "debug", "mod-manager-tauri")

const integrationConfig = loadIntegrationConfig()

if (!integrationConfig) {
	test("integration suite (skipped: e2e/integration.json absent)", { skip: "create e2e/integration.json to run — see INTEGRATION.md" }, () => {})
} else {
	describe("integration: real game + real Deploy.exe", () => {
		let fixture
		let driver
		let browser
		let runtimeMtimeBefore

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
			assert.ok(existsSync(appBinary), `App binary not found at ${appBinary} — build it first: npm run test:e2e:build (inside nix develop)`)
			fixture = createIntegrationFixture(appBinary, integrationConfig)
			runtimeMtimeBefore = mtimeMs(fixture.runtimeChunk)
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
			fixture?.teardown()
		})

		test("startup resolves the framework root without a config error", async () => {
			await browser.$('a[href="/modList"]').waitForExist({ timeout: 20_000 })
			// a broken framework-root resolution surfaces a "can't find config" modal
			const modals = await browser.$$(".bx--modal.is-visible")
			for (const modal of modals) {
				const text = await modal.getText()
				assert.doesNotMatch(text, /config/i, `unexpected startup modal mentioning config:\n${text}`)
			}
		})

		test("installed mods appear in the Available Mods list", async () => {
			const base = await browser.getUrl()
			await browser.url(new URL("/modList", base).href)
			await browser.$("h1=Available Mods").waitForExist({ timeout: 20_000 })

			for (const mod of fixture.mods) {
				await browser.$(`h4=${mod.name}`).waitForExist({
					timeout: 10_000
				})
			}
		})

		test("enabling the mods persists their ids to config.json loadOrder", async () => {
			for (const mod of fixture.mods) {
				const tile = browser.$(`//div[contains(@class, "bx--tile")][.//h4[normalize-space()="${mod.name}"]]`)
				await click(tile.$("button=Enable"))
			}

			await browser.waitUntil(
				async () => {
					const loadOrder = readConfig(fixture.configPath).loadOrder
					return fixture.mods.every((m) => loadOrder.includes(m.id))
				},
				{ timeout: 10_000, timeoutMsg: "config.json loadOrder never gained every installed mod id" }
			)
		})

		test("deploy runs the real Deploy.exe and writes only to Output/", async () => {
			await click("button=Apply")
			await browser.$("h3=Applying your mods").waitForExist({ timeout: 10_000 })

			// real deploys are slow — wait up to 2 min for success or failure
			await browser.waitUntil(
				async () => {
					if (await browser.$("span=Deploy successful").isExisting()) return true
					if (await browser.$("span=Deploy unsuccessful").isExisting()) {
						const output = await browser
							.$("#deployOutputElement")
							.getText()
							.catch(() => "")
						assert.fail(`Deploy.exe reported failure:\n${output}`)
					}
					return false
				},
				{ timeout: 120_000, interval: 1_000, timeoutMsg: "Deploy.exe did not finish within 120s" }
			)

			// Output/ populated
			assert.ok(existsSync(fixture.outputDir), `Output/ was not created at ${fixture.outputDir}`)
			assert.ok(readdirSync(fixture.outputDir).length > 0, "Output/ is empty")
			assert.ok(existsSync(join(fixture.outputDir, "packagedefinition.txt")), "Output/packagedefinition.txt missing")
			assert.ok(hasPatchRpkg(fixture.outputDir), "no chunk*patch<N>.rpkg found in Output/")

			// Runtime/ untouched — mtime of chunk0.rpkg unchanged
			if (runtimeMtimeBefore !== null) {
				assert.equal(mtimeMs(fixture.runtimeChunk), runtimeMtimeBefore, "Runtime/chunk0.rpkg was modified — game files were mutated")
			}

			await click("button=Close")
		})
	})
}
