<script lang="ts">
	import { onMount } from "svelte"

	import { FrameworkVersion, getConfig, mergeConfig } from "$lib/utils"
	import type { Config } from "../../../../src/types"

	import { Button, Checkbox } from "carbon-components-svelte"
	import { fade } from "svelte/transition"
	import { v4 } from "uuid"

	let config: Config | null = null

	onMount(async () => {
		config = await getConfig()
	})

	async function toggleDeveloperMode() {
		if (!config) return
		if (config.developerMode) {
			config = await mergeConfig({ developerMode: false, knownMods: [] })
		} else {
			config = await mergeConfig({ developerMode: true, knownMods: [] })
		}
	}

	async function toggleErrorReporting() {
		if (!config) return
		if (config.reportErrors) {
			config = await mergeConfig({ reportErrors: false, errorReportingID: undefined })
		} else {
			config = await mergeConfig({ reportErrors: true, errorReportingID: v4() })
		}
	}
</script>

<div class="w-full h-full flex items-center justify-center">
	<div>
		<h1 in:fade>Information</h1>
		<p in:fade={{ delay: 400 }}>
			This GUI is powered by Svelte and Tauri. You're on framework version {FrameworkVersion}.
		</p>
		<br />
		<p in:fade={{ delay: 800 }}>Thanks to the Hitman modding community for making this possible, and thanks to IO Interactive for making the game this is for.</p>
		<br />
		{#if config}
			<div in:fade={{ delay: 1200 }}>
				<Checkbox
					checked={config.skipIntro}
					on:check={async ({ detail }) => { config = await mergeConfig({ skipIntro: detail }) }}
					labelText="Skip intro"
				/>
			</div>
			<br />
			<div in:fade={{ delay: 1600 }}>
				<div class="flex gap-4 items-center">
					<Button kind="primary" on:click={toggleDeveloperMode}>
						{config.developerMode ? "Disable" : "Enable"} developer mode
					</Button>
				</div>
			</div>
			<br />
			<div in:fade={{ delay: 2000 }}>
				<div class="flex gap-4 items-center">
					<Button kind="primary" on:click={toggleErrorReporting}>
						{config.reportErrors ? "Disable" : "Enable"} error reporting
					</Button>
					{#if config.reportErrors}
						<span class="text-gray-300">Your reporting ID is {config.errorReportingID}</span>
					{/if}
				</div>
			</div>
		{/if}
	</div>
</div>
