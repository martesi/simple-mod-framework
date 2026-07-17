<script lang="ts">
	import { onMount } from "svelte"

	let ready = false
	onMount(() => (ready = true))
</script>

{#if ready}
	<div class="flex items-center justify-center h-screen bg-neutral-900 text-white">
		<div class="text-center">
			<h1 class="text-2xl font-bold mb-2">Simple Mod Framework</h1>
			<p class="text-neutral-400">Phase 0: Tauri scaffold working ✓</p>
		</div>
	</div>
{/if}
