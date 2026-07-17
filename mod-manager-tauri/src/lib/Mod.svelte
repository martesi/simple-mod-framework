<script lang="ts">
	import { Tile } from "carbon-components-svelte"
	import WarningAlt from "carbon-icons-svelte/lib/WarningAlt.svelte"
	import Error from "carbon-icons-svelte/lib/Error.svelte"

	import type { Manifest } from "../../../src/types"
	import { FrameworkVersion, getModFolder, validateModFolder } from "./utils"
	import * as native from "$lib/native"

	import semver from "semver"
	import { goto } from "$app/navigation"

	export let isFrameworkMod: boolean
	export let manifest: Manifest = {} as Manifest
	export let rpkgModName: string = ""
	export let darken: boolean = false
	export let config: import("../../../src/types").Config | null = null

	// validation is resolved asynchronously; start as "valid" to avoid flash
	let modValidation: [boolean, string] = [true, ""]
	let validationDone = false

	if (isFrameworkMod && manifest?.id) {
		;(async () => {
			try {
				const folder = await getModFolder(manifest.id)
				modValidation = await validateModFolder(folder)
			} catch {
				modValidation = [false, "Couldn't locate mod folder"]
			}
			validationDone = true
		})()
	}
</script>

<Tile style={darken ? "filter: brightness(0.75); transition: 250ms filter" : "transition: 250ms filter"}>
	<div class="flex flex-row items-center gap-8">
		<div class="flex-grow">
			{#if isFrameworkMod}
				<span class="text-xs">{manifest.authors?.length === 1 ? manifest.authors.join(", ") : (manifest.authors ?? []).slice(0, -1).join(", ") + " and " + (manifest.authors ?? []).at(-1)}</span>
				<h4 class="mb-1 overflow-x-auto w-full">{manifest.name}</h4>
				{manifest.description}
			{:else}
				<h4 class="mb-1 overflow-x-auto w-full">{rpkgModName}</h4>
				RPKG-only mod
			{/if}
		</div>
		<div class="flex-shrink-0">
			{#if isFrameworkMod && manifest.frameworkVersion && semver.lt(manifest.frameworkVersion, FrameworkVersion) && semver.diff(manifest.frameworkVersion, FrameworkVersion) === "major"}
				<div
					tabindex="0"
					aria-pressed="false"
					class="bx--btn bx--btn--ghost red-button bx--btn--icon-only bx--tooltip__trigger bx--tooltip--a11y bx--btn--icon-only--bottom bx--tooltip--align-center"
					on:click={async () => {
						const m = JSON.parse(JSON.stringify(manifest))
						if (m.contentFolder) { m.contentFolders = [m.contentFolder]; delete m.contentFolder }
						if (m.blobsFolder)   { m.blobsFolders  = [m.blobsFolder];  delete m.blobsFolder  }
						if (m.dependencies) {
							for (const dep of m.dependencies) {
								if (typeof dep !== "string") dep.toChunk = Number(dep.toChunk.replace("chunk", ""))
							}
						}
						if (m.options) {
							for (const opt of m.options) {
								if (opt.contentFolder) { opt.contentFolders = [opt.contentFolder]; delete opt.contentFolder }
								if (opt.blobsFolder)   { opt.blobsFolders  = [opt.blobsFolder];  delete opt.blobsFolder  }
								if (opt.dependencies) {
									for (const dep of opt.dependencies) {
										if (typeof dep !== "string") dep.toChunk = Number(dep.toChunk.replace("chunk", ""))
									}
								}
								if (opt.type === "requirement") {
									opt.type = "conditional"
									opt.condition = opt.mods.map(mod => `"${mod}" in config.loadOrder`).join(" and ")
									delete opt.mods
								}
							}
						}
						m.frameworkVersion = "2.0.0"
						const folder = await getModFolder(manifest.id)
						await native.fs.writeFileSync(native.path.join(folder, "manifest.json"), JSON.stringify(m, null, "\t"))
						window.location.reload()
					}}
					role="button"
				>
					<span class="bx--assistive-text">This mod is designed for an earlier version of the framework; click to update it.</span>
					<Error color="black" />
				</div>
			{:else if isFrameworkMod && validationDone && !modValidation[0]}
				<div
					on:click={() => { if (config?.developerMode) goto(`/authoring/${manifest.id}`) }}
					tabindex="0"
					aria-pressed="false"
					class="bx--btn bx--btn--ghost red-button bx--btn--icon-only bx--tooltip__trigger bx--tooltip--a11y bx--btn--icon-only--bottom bx--tooltip--align-center"
					role="button"
				>
					<span class="bx--assistive-text">This mod will likely cause issues; {config?.developerMode ? "click to see more information" : "contact the mod developer"}</span>
					<Error color="black" />
				</div>
			{/if}
			<slot />
		</div>
	</div>
</Tile>

<style>
	.red-button { background-color: rgb(255, 60, 0); }
</style>
