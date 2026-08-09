import { MessageType } from "../src/proto/frame.ts";
import {
	type OutboundStream,
	PeerLink,
	RemoteError,
} from "../src/proto/link.ts";
import type { HubPush, TelemetryPush } from "../src/proto/messages.ts";
import type { NodeSummary, Telemetry } from "../src/types.ts";

/**
 * The browser's end of the protocol. Exactly the same framing the nodes use —
 * the dashboard is just another peer — so a log tail or a terminal is the same
 * kind of stream here as it is on the wire between hub and node.
 */

export type Push =
	| HubPush
	| (TelemetryPush & { nodeId: string })
	| { event: "nodes"; nodes: NodeSummary[] };

export interface HubConnection {
	/** one-shot control request; hub-local actions and relayed node actions alike */
	request<T = unknown>(action: string, params?: unknown): Promise<T>;
	/** a request whose reply is a stream: log tails, terminals */
	stream<T = unknown>(
		action: string,
		params: unknown,
		handlers: {
			onData?: (payload: Uint8Array, binary: boolean) => void;
			onEnd?: (error?: { code: string; message: string }) => void;
		},
	): OutboundStream<T>;
	close(): void;
	readonly connected: boolean;
}

/** Token, kept out of the URL bar so a bookmark can't leak it. */
export function token(): string | null {
	return localStorage.getItem("stats.token");
}

export function setToken(value: string | null) {
	if (value) localStorage.setItem("stats.token", value);
	else localStorage.removeItem("stats.token");
}

const decoder = new TextDecoder();

export interface ConnectOptions {
	onPush: (push: Push) => void;
	onStatus: (connected: boolean) => void;
	onError?: (message: string) => void;
}

/**
 * Connects, and keeps reconnecting. Everything the UI does goes through the
 * returned handle; while the socket is down, requests reject immediately rather
 * than queueing, and the components show the disconnected state instead.
 */
export function connectHub(opts: ConnectOptions): HubConnection {
	let link: PeerLink | null = null;
	let socket: WebSocket | null = null;
	let retry: ReturnType<typeof setTimeout> | null = null;
	let closed = false;
	let backoff = 1000;

	const connect = () => {
		if (closed) return;
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const qs = token() ? `?token=${encodeURIComponent(token()!)}` : "";
		const ws = new WebSocket(`${proto}//${location.host}/ws${qs}`);
		ws.binaryType = "arraybuffer";
		socket = ws;

		const peer = new PeerLink(
			{
				send: (data) => {
					if (ws.readyState === WebSocket.OPEN) ws.send(data);
				},
				close: (code, reason) => ws.close(code, reason),
			},
			{
				// The hub allocates odd correlation ids; every peer it talks to uses even.
				parity: "even",
				name: "dashboard",
				// No sync gzip in a browser. The socket's permessage-deflate does the
				// compressing for us, in both directions.
				compress: false,
				onError: (err) => opts.onError?.(err.message),
			},
		);

		peer.on(MessageType.Telemetry, (frame) => {
			try {
				opts.onPush(JSON.parse(decoder.decode(frame.payload)) as Push);
			} catch {
				opts.onError?.("the hub sent a frame this dashboard could not read");
			}
		});

		ws.onopen = () => {
			backoff = 1000;
			link = peer;
			opts.onStatus(true);
			peer.startHeartbeat(20_000);
		};

		ws.onmessage = (event) => {
			if (event.data instanceof ArrayBuffer) peer.receive(event.data);
		};

		ws.onclose = () => {
			peer.dispose("socket closed");
			if (link === peer) link = null;
			opts.onStatus(false);
			if (closed) return;
			retry = setTimeout(connect, backoff);
			backoff = Math.min(backoff * 2, 15_000);
		};

		ws.onerror = () => ws.close();
	};

	connect();

	const requireLink = (): PeerLink => {
		if (!link || link.closed)
			throw new RemoteError("offline", "not connected to the hub");
		return link;
	};

	return {
		get connected() {
			return Boolean(link && !link.closed);
		},
		request: (action, params) => {
			try {
				return requireLink().request(action, params);
			} catch (err) {
				return Promise.reject(err);
			}
		},
		stream: (action, params, handlers) =>
			requireLink().openStream(action, params, {
				onData: handlers.onData,
				onEnd: handlers.onEnd,
			}),
		close: () => {
			closed = true;
			if (retry) clearTimeout(retry);
			link?.close("dashboard closing");
			socket?.close();
		},
	};
}

/** Decodes a JSON stream frame — log batches, terminal exit notices. */
export function streamJson<T>(payload: Uint8Array): T {
	return JSON.parse(decoder.decode(payload)) as T;
}

export type { NodeSummary, Telemetry };
