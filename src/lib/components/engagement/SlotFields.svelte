<script lang="ts">
	import type { MotionTemplate, SlotValues } from '$lib/motion/templates';

	/** The fields of a motion template, each with its length limit; lists as one line per item. */
	let { template, values = $bindable() }: { template: MotionTemplate; values: SlotValues } = $props();

	function listItem(key: string, i: number): string {
		const v = values[key];
		return Array.isArray(v) ? (v[i] ?? '') : '';
	}
	function setItem(key: string, i: number, text: string, n: number) {
		const cur = Array.isArray(values[key]) ? [...(values[key] as string[])] : [];
		while (cur.length < n) cur.push('');
		cur[i] = text;
		values = { ...values, [key]: cur };
	}
	const textOf = (key: string) => (typeof values[key] === 'string' ? (values[key] as string) : '');
</script>

<div class="slots">
	{#each Object.entries(template.slots) as [key, spec] (key)}
		{#if spec.kind === 'list'}
			<fieldset class="ess-field">
				<legend class="ess-label">{spec.label}</legend>
				{#each Array.from({ length: spec.items ?? 3 }, (_, i) => i) as i (i)}
					<input class="ess-input" maxlength={spec.maxLength} value={listItem(key, i)} oninput={(e) => setItem(key, i, e.currentTarget.value, spec.items ?? 3)} aria-label="{spec.label} {i + 1}" />
				{/each}
			</fieldset>
		{:else}
			<label class="ess-field">
				<span class="ess-label">{spec.label} <small class="count">{textOf(key).length}/{spec.maxLength}</small></span>
				{#if spec.maxLength > 60}
					<textarea class="ess-input" rows="2" maxlength={spec.maxLength + 40} value={textOf(key)} oninput={(e) => (values = { ...values, [key]: e.currentTarget.value })}></textarea>
				{:else}
					<input class="ess-input" maxlength={spec.maxLength + 40} value={textOf(key)} oninput={(e) => (values = { ...values, [key]: e.currentTarget.value })} />
				{/if}
				{#if spec.hint}<small class="hint">{spec.hint}</small>{/if}
			</label>
		{/if}
	{/each}
</div>

<style>
	.slots {
		display: grid;
		gap: 10px;
	}
	fieldset {
		border: none;
		margin: 0;
		padding: 0;
		display: grid;
		gap: 6px;
	}
	.count {
		float: right;
		font-weight: 400;
		color: var(--ess-text-muted);
	}
	.hint {
		font-size: 11.5px;
		color: var(--ess-text-muted);
	}
</style>
