<script lang="ts">
	import { onMount } from "svelte"
	import { page } from "$app/stores"

	import ExpandableTile from "$lib/ExpandableTile.svelte"
	import { getConfig, getManifestFromModID, getModFolder, mergeConfig, modIsFramework } from "$lib/utils"
	import type { Config, Manifest } from "../../../../src/types"
	import { Checkbox, RadioButtonGroup, RadioButton, Truncate } from "carbon-components-svelte"
	import { scale } from "svelte/transition"
	import { OptionType } from "../../../../src/types"

	import tippy from "svelte-tippy"
	import "tippy.js/dist/tippy.css"

	import { convertFileSrc } from "@tauri-apps/api/core"
	import { path as nativePath } from "$lib/native"

	let config: Config | null = null
	let mods: Manifest[] = []
	let modFolderMap: Record<string, string> = {}

	const columns: [Manifest[], Manifest[], Manifest[]] = [[], [], []]
	let groupOptions: Record<string, Record<string, any[]>> = {}
	let selectedMod: string | null = null

	onMount(async () => {
		config = await getConfig()
		selectedMod = $page.url.searchParams.get("mod")

		const frameworkMods = config.loadOrder.filter(a => config!.modOptions[a])
		const manifests: Manifest[] = []
		for (const id of frameworkMods) {
			if (await modIsFramework(id)) {
				try {
					const m = await getManifestFromModID(id)
					if (m && m.options && m.options.filter(a => a.type !== OptionType.conditional).length) {
						manifests.push(m)
						modFolderMap[id] = await getModFolder(id)
					}
				} catch {}
			}
		}
		mods = manifests

		// assign to 3 columns
		columns[0] = []; columns[1] = []; columns[2] = []
		let col = 0
		for (const mod of mods) {
			columns[col as 0 | 1 | 2].push(mod)
			col = (col + 1) % 3
		}

		// build group options map
		groupOptions = {}
		for (const mod of mods) {
			groupOptions[mod.id] = {}
			mod.options?.forEach(opt => {
				if (opt.type === "select") {
					groupOptions[mod.id][opt.group] ??= []
					groupOptions[mod.id][opt.group].push(opt)
				}
			})
		}
	})

	async function setSelectOption(mod: string, group: string, option: string) {
		const cfg = await getConfig()
		const items = cfg.modOptions[mod].filter(a => (a.split(":").length > 1 ? a.split(":")[0] !== group : true))
		items.push(group + ":" + option)
		config = await mergeConfig({ modOptions: { [mod]: items } })
	}

	async function setCheckboxOption(mod: string, option: string, value: boolean) {
		const cfg = await getConfig()
		const items = cfg.modOptions[mod].filter(a => (a.split(":").length > 1 ? true : a !== option))
		if (value) items.push(option)
		config = await mergeConfig({ modOptions: { [mod]: items } })
	}
</script>

<h1 class="text-center" transition:scale>Mod Settings</h1>
<br />
{#if config}
	<div class="grid grid-cols-3 gap-4 w-full h-[90vh] mb-16 overflow-y-auto">
		{#each columns as column, index (column)}
			<div class="w-full">
				{#each columns[index] as mod (mod.id)}
					<ExpandableTile initiallyOpen={mod.id === selectedMod}>
						<h3 slot="heading">{mod.name}</h3>
						<span slot="closedContent">
							<Truncate>
								{!config.modOptions[mod.id]?.length ? "No options enabled" : config.modOptions[mod.id].map(a => (a.split(":").length > 1 ? a.split(":").join(": ") : a)).join(", ")}
							</Truncate>
						</span>
						<div slot="content">
							{#each (mod.options ?? []).filter(a => a.type === "checkbox") as option}
								<div
									use:tippy={option?.tooltip || option?.image
										? {
												content: () => {
													if (!option.image) return option.tooltip
													const elem = document.createElement("div")
													const text = document.createElement("span")
													text.innerText = option.tooltip ?? ""
													const img = document.createElement("img")
													img.src = convertFileSrc(nativePath.join(modFolderMap[mod.id] ?? "", option.image))
													elem.appendChild(img)
													elem.appendChild(document.createElement("br"))
													elem.appendChild(text)
													return elem
												},
												placement: "left"
										  }
										: { content: undefined, delay: 9999999999 }}
								>
									<Checkbox
										labelText={option.name}
										checked={config.modOptions[mod.id]?.includes(option.name)}
										on:check={({ detail }) => setCheckboxOption(mod.id, option.name, detail)}
									/>
								</div>
							{/each}
							{#each Object.entries(groupOptions[mod.id] ?? {}) as [group, options]}
								<span class="text-lg font-semibold">{group}</span>
								<br />
								<RadioButtonGroup
									selected={options.find(a => config?.modOptions[mod.id]?.includes(group + ":" + a.name))?.name}
									on:change={({ detail }) => setSelectOption(mod.id, group, detail)}
								>
									{#each options as option}
										<div
											class="bx--radio-button-wrapper"
											use:tippy={option?.tooltip || option?.image
												? {
														content: () => {
															if (!option.image) return option.tooltip
															const elem = document.createElement("div")
															const text = document.createElement("span")
															text.innerText = option.tooltip ?? ""
															const img = document.createElement("img")
															img.src = convertFileSrc(nativePath.join(modFolderMap[mod.id] ?? "", option.image))
															elem.appendChild(img)
															if (option.tooltip) elem.appendChild(document.createElement("br"))
															if (option.tooltip) elem.appendChild(text)
															return elem
														}
												  }
												: { content: undefined, delay: 9999999999 }}
										>
											<RadioButton value={option.name} labelText={option.name} />
										</div>
									{/each}
								</RadioButtonGroup>
								<br />
							{/each}
						</div>
					</ExpandableTile>
					<br />
				{/each}
			</div>
		{/each}
	</div>
{/if}

<style global>
	.bx--radio-button-group {
		flex-wrap: wrap;
		row-gap: 0.2rem;
	}
</style>
