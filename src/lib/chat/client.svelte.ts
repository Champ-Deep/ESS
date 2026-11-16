/**
 * The browser side of Champ Chat's live connection. One per tab, started by
 * the (app) layout so the sidebar badge and pop-ups work on every page, not
 * just on /chat.
 *
 * It holds the sidebar (channels with unread counts), listens to the
 * /api/chat/stream Server-Sent Events, and lets any component subscribe to
 * the events it cares about. On reconnect it re-reads the sidebar and tells
 * subscribers to refresh, which is how nothing sent while offline is missed.
 */

import { supportTeam, type SupportTeamKey } from '$lib/capabilities';
import { goto } from '$app/navigation';

export type ChatEvent = { type: string; [key: string]: unknown };

export type SidebarChannel = {
	id: string;
	kind: 'channel' | 'dm' | 'group' | 'desk' | 'system' | 'announcements';
	name: string;
	topic: string;
	source: string;
	isPrivate: boolean;
	readOnly: boolean;
	teamId: string | null;
	others: { id: string; fullName: string; isActive: boolean }[];
	pinnedAs: 'manager' | 'hr' | null;
	deskStatus: string | null;
	deskOwnerId: string | null;
	/** Which desk: 'hr' | 'engagement' | 'it'. */
	deskTeam?: SupportTeamKey | null;
	/** A desk nobody has written in yet. */
	deskEmpty?: boolean;
	isAdmin: boolean;
	unread: number;
	mentions: number;
	muted: boolean;
	notify: string;
	lastMessageAt: string;
	lastReadAt: string;
};

/** Wording for a desk thread (Ask HR, Ask IT, Ask Engagement), seen by the person asking. */
export function deskWords(c: Pick<SidebarChannel, 'deskTeam'>) {
	const t = supportTeam(c.deskTeam);
	return {
		placeholder: `${t.deskName} a question`,
		privacy: t.key === 'hr' ? 'Private to you and HR · goes to your concerned HR first' : `Private to you and ${t.name}`,
		empty: `${t.deskName} anything here: ${t.askAbout.toLowerCase()}. Only you and ${t.name} can see it.`
	};
}

/** What a conversation is called in the sidebar and its header. */
export function channelLabel(c: SidebarChannel, meId: string): string {
	if (c.kind === 'announcements') return 'announcements';
	if (c.kind === 'system') return 'ESS notices';
	if (c.kind === 'desk') {
		const desk = supportTeam(c.deskTeam).deskName;
		return c.deskOwnerId === meId ? desk : c.name.replace(new RegExp(`^${desk} · `), '');
	}
	if (c.kind === 'dm') return c.others[0]?.fullName ?? 'Just you';
	if (c.kind === 'group') return c.others.map((o) => o.fullName.split(' ')[0]).join(', ');
	return c.name;
}

type Listener = (e: ChatEvent) => void;

class ChatClient {
	channels = $state<SidebarChannel[]>([]);
	badge = $state(0);
	connected = $state(false);
	/** The conversation open in Champ Hub, so its messages do not count as unread. */
	openChannelId = $state<string | null>(null);

	private source: EventSource | null = null;
	private listeners = new Set<Listener>();
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | null = null;
	private started = false;
	private audio: AudioContext | null = null;

	start(initialBadge = 0) {
		if (this.started || typeof window === 'undefined') return;
		this.started = true;
		this.badge = initialBadge;
		this.connect();
		void this.refresh();
		// "Online" is a heartbeat while the tab is visible.
		const beat = () => {
			if (document.visibilityState === 'visible') void fetch('/api/chat/presence', { method: 'POST' }).catch(() => {});
		};
		this.heartbeat = setInterval(beat, 30_000);
		document.addEventListener('visibilitychange', beat);
		// Any click unlocks sound for the notification chime.
		window.addEventListener('pointerdown', () => this.unlockAudio(), { once: true });
	}

	private connect() {
		this.source?.close();
		const es = new EventSource('/api/chat/stream');
		this.source = es;
		es.onopen = () => {
			const wasDown = !this.connected;
			this.connected = true;
			if (wasDown) {
				void this.refresh();
				this.emit({ type: 'reconnected' });
			}
		};
		es.onerror = () => {
			this.connected = false;
		};
		es.onmessage = (m) => {
			let e: ChatEvent;
			try {
				e = JSON.parse(m.data);
			} catch {
				return;
			}
			this.handle(e);
		};
	}

	private handle(e: ChatEvent) {
		if (e.type === 'message.created' || e.type === 'channels.changed' || e.type === 'read' || e.type === 'card.updated') {
			this.scheduleRefresh();
		}
		if (e.type === 'notify') this.notify(e);
		this.emit(e);
	}

	private emit(e: ChatEvent) {
		for (const l of this.listeners) {
			try {
				l(e);
			} catch (err) {
				console.error('[chat] listener failed', err);
			}
		}
	}

	on(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private scheduleRefresh() {
		if (this.refreshTimer) return;
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = null;
			void this.refresh();
		}, 400);
	}

	async refresh() {
		try {
			const res = await fetch('/api/chat/sidebar');
			if (!res.ok) return;
			const data = (await res.json()) as { channels: SidebarChannel[]; badge: number };
			this.channels = data.channels;
			this.badge = data.badge;
		} catch {
			/* offline: the stream reconnect will try again */
		}
	}

	/** Mark a conversation read now (the server echoes to your other tabs). */
	async markRead(channelId: string) {
		const c = this.channels.find((x) => x.id === channelId);
		if (c && (c.unread || c.mentions)) {
			c.unread = 0;
			c.mentions = 0;
			this.badge = this.channels.reduce((n, x) => n + (x.muted ? 0 : x.kind === 'channel' ? x.mentions : x.unread), 0);
		}
		await fetch('/api/chat/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId }) }).catch(() => {});
	}

	/* ---------- alerts ---------- */

	private unlockAudio() {
		try {
			this.audio ??= new AudioContext();
		} catch {
			/* no audio */
		}
	}

	private chime() {
		const ctx = this.audio;
		if (!ctx) return;
		const o = ctx.createOscillator();
		const g = ctx.createGain();
		o.frequency.value = 880;
		g.gain.setValueAtTime(0.0001, ctx.currentTime);
		g.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.02);
		g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
		o.connect(g).connect(ctx.destination);
		o.start();
		o.stop(ctx.currentTime + 0.4);
	}

	private notify(e: ChatEvent) {
		if (e.quiet) return;
		const url = String(e.url ?? '/chat');
		const here = typeof location !== 'undefined' && (location.pathname === '/chat' || location.pathname.startsWith('/hub/c/')) && this.openChannelId && url.includes(this.openChannelId);
		if (here && document.visibilityState === 'visible') return;
		if (e.sound !== false) this.chime();
		if (document.visibilityState === 'visible' || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
		try {
			const n = new Notification(String(e.title ?? 'Champ Chat'), { body: String(e.body ?? ''), tag: String(e.kind ?? 'chat') });
			n.onclick = () => {
				window.focus();
				void goto(url);
				n.close();
			};
		} catch {
			/* some browsers only allow notifications from a service worker */
		}
	}

	/** Ask to show pop-ups, and subscribe for web push when the portal is closed. */
	async enableAlerts(): Promise<'granted' | 'denied' | 'unsupported'> {
		if (typeof Notification === 'undefined') return 'unsupported';
		const perm = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
		if (perm !== 'granted') return 'denied';
		try {
			if ('serviceWorker' in navigator && 'PushManager' in window) {
				const reg = await navigator.serviceWorker.register('/chat-sw.js');
				const { key } = await (await fetch('/api/chat/push-key')).json();
				const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) }));
				await fetch('/api/chat/push', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription: sub.toJSON() }) });
			}
		} catch (err) {
			console.warn('[chat] push subscription failed', err);
		}
		return 'granted';
	}
}

function urlBase64ToUint8Array(base64: string) {
	const padding = '='.repeat((4 - (base64.length % 4)) % 4);
	const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
	return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export const chat = new ChatClient();
