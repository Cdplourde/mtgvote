<script lang="ts">
	import { onMount } from 'svelte';
	import type { RealtimeChannel } from '@supabase/supabase-js';
	import { MTG_GLOBAL_CHANNEL, STORAGE_KEYS, supabase } from '$lib/supabaseClient';

	type PageProps = {
		data: {
			unlocked: boolean;
		};
		form?: {
			unlockError?: string;
		};
	};

	let { data, form }: PageProps = $props();

	type PresenceMeta = {
		name?: string;
		hasVoted?: boolean;
		vote?: string | null;
		roundId?: number;
		updatedAt?: number;
	};

	type Participant = {
		key: string;
		name: string;
		hasVoted: boolean;
		vote: string | null;
		roundId: number;
		updatedAt: number;
	};

	type SharedStatePayload = {
		senderId: string;
		options: string[];
		revealed: boolean;
		roundId: number;
		reason: string;
	};

	let passphraseUnlocked = $derived(Boolean(data?.unlocked));

	let draftName = $state('');
	let playerName = $state('');
	let nameError = $state('');

	let optionDrafts = $state(['', '']);
	let voteOptions = $state<string[]>([]);
	let selectedVote = $state('');
	let revealed = $state(false);
	let roundId = $state(1);
	let stateError = $state('');

	let presenceUsers = $state<Participant[]>([]);
	let channel: RealtimeChannel | null = null;
	let clientId = '';

	const activeParticipants = $derived.by(() => {
		const mergedByName: Record<string, Participant> = {};

		for (const user of presenceUsers) {
			const trimmedName = user.name.trim();
			if (!trimmedName) {
				continue;
			}

			const identity = trimmedName.toLowerCase();
			const existing = mergedByName[identity];
			if (!existing) {
				mergedByName[identity] = {
					...user,
					key: identity,
					name: trimmedName
				};
				continue;
			}

			if (user.roundId > existing.roundId) {
				mergedByName[identity] = {
					...user,
					key: identity,
					name: trimmedName
				};
				continue;
			}

			if (user.roundId < existing.roundId) {
				continue;
			}

			const existingVoteTime = existing.hasVoted ? existing.updatedAt : -1;
			const incomingVoteTime = user.hasVoted ? user.updatedAt : -1;
			const useIncomingVote = incomingVoteTime > existingVoteTime;

			mergedByName[identity] = {
				...existing,
				hasVoted: existing.hasVoted || user.hasVoted,
				vote: useIncomingVote && user.vote ? user.vote : existing.vote,
				updatedAt: Math.max(existing.updatedAt, user.updatedAt)
			};
		}

		return Object.values(mergedByName).sort((a, b) => a.name.localeCompare(b.name));
	});
	const votedCount = $derived.by(
		() => activeParticipants.filter((user) => user.roundId === roundId && user.hasVoted).length
	);
	const allPresentUsersVoted = $derived.by(
		() =>
			activeParticipants.length > 0 &&
			activeParticipants.every((user) => user.roundId === roundId && user.hasVoted)
	);
	const hasActiveRound = $derived(voteOptions.length >= 2);
	const voteTallies = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const user of activeParticipants) {
			if (user.roundId !== roundId || !user.hasVoted || !user.vote) {
				continue;
			}

			counts[user.vote] = (counts[user.vote] ?? 0) + 1;
		}

		return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	});

	onMount(() => {
		clientId = getOrCreateClientId();
		playerName = localStorage.getItem(STORAGE_KEYS.playerName) ?? '';
		draftName = playerName;
	});

	$effect(() => {
		if (!passphraseUnlocked || !playerName) {
			return;
		}

		void connectRealtime();

		return () => {
			void teardownRealtime();
		};
	});

	$effect(() => {
		if (allPresentUsersVoted && !revealed) {
			revealed = true;
			void broadcastState('auto_reveal');
		}
	});

	function getOrCreateClientId() {
		const existing = sessionStorage.getItem(STORAGE_KEYS.clientId);
		if (existing) {
			return existing;
		}

		const generated =
			typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
				? crypto.randomUUID()
				: `${Date.now()}-${Math.random().toString(16).slice(2)}`;
		sessionStorage.setItem(STORAGE_KEYS.clientId, generated);
		return generated;
	}

	function submitName() {
		nameError = '';
		const trimmed = draftName.trim();
		if (!trimmed) {
			nameError = 'Please enter your name.';
			return;
		}

		playerName = trimmed;
		localStorage.setItem(STORAGE_KEYS.playerName, trimmed);
	}

	async function connectRealtime() {
		await teardownRealtime();

		channel = supabase.channel(MTG_GLOBAL_CHANNEL, {
			config: {
				presence: { key: clientId },
				broadcast: { self: true }
			}
		});

		channel
			.on('presence', { event: 'sync' }, () => {
				syncPresence();
			})
			.on('presence', { event: 'join' }, () => {
				syncPresence();
			})
			.on('presence', { event: 'leave' }, () => {
				syncPresence();
			})
			.on('broadcast', { event: 'state' }, ({ payload }) => {
				applySharedState(payload as SharedStatePayload);
			})
			.on('broadcast', { event: 'request_state' }, ({ payload }) => {
				const senderId = (payload as { senderId?: string }).senderId;
				if (senderId && senderId !== clientId) {
					void broadcastState('sync_response');
				}
			});

		await new Promise<void>((resolve) => {
			channel?.subscribe(async (status) => {
				if (status !== 'SUBSCRIBED') {
					return;
				}

				await updateOwnPresence(false, null, roundId);
				syncPresence();

				await channel?.send({
					type: 'broadcast',
					event: 'request_state',
					payload: { senderId: clientId }
				});

				resolve();
			});
		});
	}

	async function teardownRealtime() {
		if (!channel) {
			return;
		}

		await channel.unsubscribe();
		channel = null;
		presenceUsers = [];
	}

	function syncPresence() {
		if (!channel) {
			presenceUsers = [];
			return;
		}

		const state = channel.presenceState<PresenceMeta>();
		const nextUsers: Participant[] = [];

		for (const [key, metas] of Object.entries(state)) {
			for (const meta of metas) {
				nextUsers.push({
					key,
					name: meta.name ?? 'Unknown',
					hasVoted: Boolean(meta.hasVoted),
					vote: meta.vote ?? null,
					roundId: Number(meta.roundId ?? 1),
					updatedAt: Number(meta.updatedAt ?? 0)
				});
			}
		}

		// Keep the latest meta if a client temporarily has multiple presence entries.
		const latestByKey: Record<string, Participant> = {};
		for (const user of nextUsers) {
			const current = latestByKey[user.key];
			if (!current || user.updatedAt >= current.updatedAt) {
				latestByKey[user.key] = user;
			}
		}

		presenceUsers = Object.values(latestByKey).sort((a, b) => a.name.localeCompare(b.name));
	}

	async function updateOwnPresence(hasVoted: boolean, vote: string | null, forRoundId: number) {
		if (!channel || !playerName) {
			return;
		}

		await channel.track({
			name: playerName,
			hasVoted,
			vote,
			roundId: forRoundId,
			updatedAt: Date.now()
		});
	}

	function normalizeOptions(values: string[]) {
		const cleaned = values.map((value) => value.trim()).filter(Boolean);
		return [...new Set(cleaned)];
	}

	async function updateOptions() {
		stateError = '';
		const cleaned = normalizeOptions(optionDrafts);
		if (cleaned.length < 2) {
			stateError = 'Add at least two options.';
			return;
		}

		voteOptions = cleaned;
		optionDrafts = [...cleaned];
		roundId += 1;
		revealed = false;
		selectedVote = '';
		presenceUsers = presenceUsers.map((user) => ({
			...user,
			hasVoted: false,
			vote: null,
			roundId
		}));
		await updateOwnPresence(false, null, roundId);
		await broadcastState('round_update');
	}

	async function submitVote() {
		if (!selectedVote) {
			return;
		}

		await updateOwnPresence(true, selectedVote, roundId);
		syncPresence();
	}

	async function resetRound() {
		revealed = false;
		roundId += 1;
		selectedVote = '';

		await updateOwnPresence(false, null, roundId);
		await broadcastState('reset_round');
	}

	async function resetAllState() {
		stateError = '';
		revealed = false;
		roundId += 1;
		selectedVote = '';
		voteOptions = [];
		optionDrafts = ['', ''];
		presenceUsers = presenceUsers.map((user) => ({
			...user,
			hasVoted: false,
			vote: null,
			roundId
		}));

		await updateOwnPresence(false, null, roundId);
		await broadcastState('reset_all');
	}

	async function broadcastState(reason: string) {
		if (!channel) {
			return;
		}

		await channel.send({
			type: 'broadcast',
			event: 'state',
			payload: {
				senderId: clientId,
				options: voteOptions,
				revealed,
				roundId,
				reason
			} satisfies SharedStatePayload
		});
	}

	function applySharedState(payload: SharedStatePayload) {
		if (!payload || payload.senderId === clientId) {
			return;
		}

		const nextOptions = normalizeOptions(payload.options ?? []);
		if (payload.reason === 'reset_all') {
			voteOptions = [];
			optionDrafts = ['', ''];
		} else if (nextOptions.length >= 2) {
			voteOptions = nextOptions;
			optionDrafts = [...nextOptions];
		}

		const incomingRound = Number(payload.roundId ?? roundId);
		const roundChanged = incomingRound !== roundId;
		roundId = incomingRound;
		revealed = Boolean(payload.revealed);

		if (roundChanged) {
			selectedVote = '';
			presenceUsers = presenceUsers.map((user) => ({
				...user,
				hasVoted: false,
				vote: null,
				roundId
			}));
			void updateOwnPresence(false, null, roundId);
		}
	}

	function addOptionField() {
		optionDrafts = [...optionDrafts, ''];
	}

	function removeOptionField(index: number) {
		if (optionDrafts.length <= 2) {
			return;
		}

		optionDrafts = optionDrafts.filter((_, fieldIndex) => fieldIndex !== index);
	}
</script>

<main class="app-shell mx-auto flex min-h-screen w-full max-w-4xl flex-col gap-6 p-6">
	<h1 class="text-3xl font-bold">MTG Vote</h1>

	{#if !passphraseUnlocked}
		<section class="rounded border p-4">
			<h2 class="mb-3 text-lg font-semibold">Enter passphrase</h2>
			<form method="POST" action="?/unlock" class="flex flex-col gap-3 sm:flex-row">
				<input
					class="w-full rounded border px-3 py-2"
					type="password"
					name="passphrase"
					placeholder="Passphrase"
					required
				/>
				<button class="cursor-pointer rounded border px-4 py-2 font-medium" type="submit"
					>Unlock</button
				>
			</form>
			{#if form?.unlockError}
				<p class="mt-2 text-sm text-red-400">{form.unlockError}</p>
			{/if}
		</section>
	{:else if !playerName}
		<section class="rounded border p-4">
			<h2 class="mb-3 text-lg font-semibold">Enter your name</h2>
			<form
				class="flex flex-col gap-3 sm:flex-row"
				onsubmit={(event) => {
					event.preventDefault();
					submitName();
				}}
			>
				<input
					class="w-full rounded border px-3 py-2"
					type="text"
					bind:value={draftName}
					placeholder="Your name"
				/>
				<button class="cursor-pointer rounded border px-4 py-2 font-medium" type="submit"
					>Join</button
				>
			</form>
			{#if nameError}
				<p class="mt-2 text-sm text-red-400">{nameError}</p>
			{/if}
		</section>
	{:else}
		<section class="rounded border p-4">
			<h2 class="mb-3 text-lg font-semibold">Round options</h2>
			<div class="flex flex-col gap-2">
				{#each optionDrafts as option, index (index)}
					<div class="flex items-center gap-2">
						<input
							class="w-full rounded border px-3 py-2"
							type="text"
							value={option}
							placeholder={`Option ${index + 1}`}
							oninput={(event) => {
								const target = event.currentTarget as HTMLInputElement;
								optionDrafts[index] = target.value;
							}}
						/>
						<button
							class="cursor-pointer rounded border px-3 py-2"
							type="button"
							disabled={optionDrafts.length <= 2}
							onclick={() => removeOptionField(index)}
						>
							Remove
						</button>
					</div>
				{/each}
			</div>
			<div class="mt-3 flex flex-wrap gap-2">
				<button
					class="cursor-pointer rounded border px-3 py-2"
					type="button"
					onclick={addOptionField}>Add option</button
				>
				<button
					class="cursor-pointer rounded border px-3 py-2 font-medium"
					type="button"
					onclick={updateOptions}
				>
					Start/update round
				</button>
				<button class="cursor-pointer rounded border px-3 py-2" type="button" onclick={resetAllState}
					>Reset all</button
				>
			</div>
			{#if stateError}
				<p class="mt-2 text-sm text-red-400">{stateError}</p>
			{/if}
		</section>

		{#if hasActiveRound}
			<section class="rounded border p-4">
				<h2 class="mb-3 text-lg font-semibold">Your vote</h2>
				<div class="flex flex-col gap-3 sm:flex-row">
					<div class="relative h-fit w-full">
						<select
							class="vote-select h-11 w-full cursor-pointer appearance-none rounded border px-3 py-2 pr-12"
							bind:value={selectedVote}
						>
							<option value="">Select an option</option>
							{#each voteOptions as option (option)}
								<option value={option}>{option}</option>
							{/each}
						</select>
						<span
							class="pointer-events-none absolute top-1/2 right-4 flex h-4 w-4 -translate-y-1/2 items-center justify-center opacity-80"
						>
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 12 12"
								class="h-3 w-3"
								aria-hidden="true"
							>
								<path
									d="M2.25 4.5 6 8.25 9.75 4.5"
									fill="none"
									stroke="currentColor"
									stroke-width="1.75"
									stroke-linecap="round"
									stroke-linejoin="round"
								/>
							</svg>
						</span>
					</div>
					<button
						class="h-11 cursor-pointer rounded border px-4 py-2 font-medium whitespace-nowrap"
						type="button"
						onclick={submitVote}
					>
						Submit
					</button>
					<button
						class="h-11 cursor-pointer rounded border px-4 py-2 whitespace-nowrap"
						type="button"
						onclick={resetRound}
					>
						Reset
					</button>
				</div>
			</section>

			<section class="rounded border p-4">
				<h2 class="mb-3 text-lg font-semibold">Players</h2>
				<p class="mb-3 text-sm opacity-80">Voted: {votedCount} / {activeParticipants.length}</p>
				<ul class="flex flex-col gap-2">
					{#each activeParticipants as user (user.key)}
						<li class="rounded border px-3 py-2">
							<div class="flex items-center justify-between gap-3">
								<span class="font-medium">{user.name}</span>
								<span class="text-sm opacity-80">
									{#if user.roundId === roundId && user.hasVoted}
										<span class="font-semibold text-green-600 dark:text-green-400">Voted</span>
									{:else}
										<span class="font-semibold text-red-600 dark:text-red-400">Waiting</span>
									{/if}
								</span>
							</div>
							{#if revealed}
								<p class="mt-1 text-sm">Vote: {user.vote ?? 'No vote'}</p>
							{/if}
						</li>
					{/each}
				</ul>
			</section>

			<section class="rounded border p-4">
				<h2 class="mb-2 text-lg font-semibold">{revealed ? 'The results are in!' : 'Vote now!'}</h2>
				<p class="text-sm opacity-80">
					{#if revealed}
						Here is the current tally:
					{:else}
						Votes reveal automatically once all users vote.
					{/if}
				</p>
				{#if revealed}
					<ul class="mt-3 flex flex-col gap-2">
						{#each voteTallies as [option, count] (option)}
							<li class="rounded border px-3 py-2">
								<span class="font-medium">{option}</span>: {count}
							</li>
						{/each}
					</ul>
				{/if}
			</section>
		{/if}
	{/if}
</main>

<style>
	:global(:root) {
		color-scheme: light dark;
	}

	:global(body) {
		background-color: #f3f4f6;
		color: #111827;
	}

	.app-shell :where(section, li, input, select, button) {
		border-color: #374151;
		background-color: #ffffff;
		color: #111827;
	}

	.app-shell input::placeholder {
		color: #6b7280;
	}

	.vote-select {
		background-image: none;
	}

	.vote-select::-ms-expand {
		display: none;
	}

	@media (prefers-color-scheme: dark) {
		:global(body) {
			background-color: #030712;
			color: #e5e7eb;
		}

		.app-shell :where(section, li, input, select, button) {
			border-color: #4b5563;
			background-color: #111827;
			color: #e5e7eb;
		}

		.app-shell input::placeholder {
			color: #9ca3af;
		}
	}
</style>
