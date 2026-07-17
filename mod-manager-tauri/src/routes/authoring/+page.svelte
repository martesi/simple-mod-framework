<script lang="ts">
	import { onMount } from "svelte"
	import { scale } from "svelte/transition"

	import { Button, Tile, Truncate } from "carbon-components-svelte"
	import { getAllMods, getManifestFromModID, modIsFramework } from "$lib/utils"
	import type { Manifest } from "../../../../src/types"
	import Edit from "carbon-icons-svelte/lib/Edit.svelte"
	import { goto } from "$app/navigation"

	let manifests: Manifest[] = []

	onMount(async () => {
		const mods = await getAllMods()
		const result: Manifest[] = []
		for (const mod of mods) {
			if (await modIsFramework(mod)) {
				try {
					result.push(await getManifestFromModID(mod))
				} catch {}
			}
		}
		manifests = result.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }))
	})
</script>

<div class="flex items-center justify-center">
	<h1 transition:scale>Mod Authoring</h1>
</div>

<div class="mt-2 flex items-center justify-center">
	<a href="/docs/Index.md" transition:scale>View the documentation</a>
</div>

<br />

<div class="mt-4 {window.screen.height <= 1080 ? 'h-[82vh]' : 'h-[85vh]'} pr-4 overflow-y-auto">
	<div class="flex flex-wrap gap-4">
		{#each manifests as manifest (manifest.id)}
			<Tile>
				<div class="flex flex-row items-center gap-8">
					<div class="flex-grow" style="max-width: 28rem">
						<span class="text-xs">
							{manifest.authors?.length === 1 ? manifest.authors.join(", ") : (manifest.authors ?? []).slice(0, -1).join(", ") + " and " + (manifest.authors ?? []).at(-1)}
						</span>
						<h4 class="mb-1 overflow-x-auto w-full">{manifest.name}</h4>
						<Truncate>{manifest.description}</Truncate>
					</div>
					<div class="flex-shrink-0">
						<Button kind="ghost" icon={Edit} iconDescription="Edit this mod" on:click={() => goto(`/authoring/${manifest.id}`)} />
					</div>
				</div>
			</Tile>
		{/each}
	</div>
</div>

<div class="mb-[100vh]" />

<style>
	:global(.bx--btn--ghost) {
		color: inherit;
		@apply bg-neutral-900;
	}

	:global(.bx--btn--ghost:hover, .bx--btn--ghost:active) {
		color: inherit;
	}
</style>
