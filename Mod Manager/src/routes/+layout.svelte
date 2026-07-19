<script lang="ts">
	import "../app.css"
	import "carbon-components-svelte/css/g90.css"
	import { onMount } from "svelte"

	import Icon from "svelte-fa"
	import { faBook, faCog, faEdit, faHome, faInfoCircle, faList } from "@fortawesome/free-solid-svg-icons"
	import { getConfig } from "$lib/utils"
	import { page } from "$app/stores"

	let developerMode: boolean = false

	onMount(() => {
		try {
			developerMode = !!getConfig().developerMode
		} catch {
			// config missing
		}

		window.ipc.receive("urlScheme", async (path: string) => {
			if (path.startsWith("install/")) {
				window.location.href = "/modList?urlScheme=" + encodeURIComponent(path.replace("install/", ""))
			} else if (path.startsWith("open-docs-page/")) {
				window.location.href = "/docs/" + path.replace("open-docs-page/", "")
			}
		})
	})
</script>

<div class="flex flex-row h-screen w-screen">
	<div class="bg-neutral-900 w-16 h-full flex flex-col gap-16 items-center justify-center">
		<a href="/" class="text-white">
			<Icon icon={faHome} />
		</a>
		<a href="/modList" class="text-white">
			<Icon icon={faList} />
		</a>
		<a href="/settings" class="text-white">
			<Icon icon={faCog} />
		</a>
		{#if developerMode}
			<a href="/authoring" class="text-white">
				<Icon icon={faEdit} />
			</a>
			<a href="/docs/Index.md" class="text-white">
				<Icon icon={faBook} />
			</a>
		{/if}
		<a href="/info" class="text-white">
			<Icon icon={faInfoCircle} />
		</a>
	</div>
	<div class="col-span-11 px-16 py-8 w-full">
		<slot />
	</div>
</div>

<style>
	:global(.bx--content) {
		background-color: initial;
	}
</style>
