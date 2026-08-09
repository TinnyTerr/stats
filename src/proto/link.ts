/**
 * A PeerLink turns a raw byte pipe (a WebSocket, in practice) into the four
 * things this protocol actually needs:
 *
 *   - one-shot messages     — Telemetry, Hello, Welcome
 *   - request/response      — ControlReq → ControlResp | Error, correlated
 *   - bidirectional streams — StreamData/StreamEnd on a request's correlation id
 *   - liveness              — Ping/Pong with a measured round trip
 *
 * Both ends of both links (node⇄hub, browser⇄hub) run one of these, so the
 * relay in the middle is only ever copying frames between two of them.
 */

import {
	type Bytes,
	decodeFrame,
	type EncodeOptions,
	encodeFrame,
	encodeJson,
	Flags,
	type Frame,
	frameJson,
	MessageType,
	messageTypeName,
	PROTOCOL_VERSION,
} from "./frame.ts";
import type {
	ControlRequest,
	ControlResponse,
	ErrorPayload,
} from "./messages.ts";

export interface Transport {
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
}

export class RemoteError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "RemoteError";
	}
}

export interface StreamSink {
	/**
	 * Declares that this correlation id stays open after the response.
	 *
	 * A handler that only *might* produce data later — a terminal waiting on a
	 * shell, a log tail waiting on a line — must say so before it returns.
	 * Otherwise the link closes the correlation as soon as the response goes out,
	 * on the reasonable assumption that a handler which never touched its stream
	 * doesn't have one.
	 */
	open(): void;
	/** raw bytes — terminal output and anything else opaque */
	bytes(data: Bytes): void;
	/** a JSON value — log lines, progress updates */
	json(value: unknown): void;
	/**
	 * An already-encoded payload, passed through as-is. The hub's relay uses this
	 * to copy a node's frames to a browser without parsing and re-serialising
	 * every line of a log tail.
	 */
	raw(payload: Bytes, binary: boolean): void;
	/** no more data on this correlation id */
	end(error?: ErrorPayload): void;
	readonly closed: boolean;
}

export interface InboundRequest<P = unknown> {
	action: string;
	params: P;
	correlationId: number;
	/** aborts when the peer ends the stream, or the link closes */
	signal: AbortSignal;
	/** register interest in frames the peer sends on this correlation id */
	onData(handler: (payload: Bytes, binary: boolean) => void): void;
	/** the reply channel; using it keeps the correlation id open past the response */
	stream: StreamSink;
}

export type RequestHandler = (
	req: InboundRequest<never>,
) => unknown | Promise<unknown>;

export interface RequestOptions {
	/** null disables the timeout — right for anything that opens a stream */
	timeoutMs?: number | null;
	onData?: (payload: Bytes, binary: boolean) => void;
	onEnd?: (error?: ErrorPayload) => void;
	requiresAck?: boolean;
	signal?: AbortSignal;
}

export interface OutboundStream<T> {
	correlationId: number;
	/** resolves with the ControlResp result; rejects on Error */
	ready: Promise<T>;
	bytes(data: Bytes): void;
	json(value: unknown): void;
	/** pass an already-encoded payload through untouched (see StreamSink.raw) */
	raw(payload: Bytes, binary: boolean): void;
	end(): void;
}

export interface LinkOptions {
	/**
	 * Which half of the correlation-id space this side allocates from. The two
	 * ends of a link must differ, so a request in flight in one direction can
	 * never be confused with one in the other.
	 */
	parity: "odd" | "even";
	/** default deadline for request(); streams opt out with null */
	requestTimeoutMs?: number;
	/** label used in error messages and debug logs */
	name?: string;
	/**
	 * Whether frames may be gzipped above {@link COMPRESS_THRESHOLD}. Set false
	 * for a peer that can't inflate — a browser has no sync gunzip, so the hub
	 * turns this off on every browser link and the dashboard turns it off on its
	 * own. Compression is per-frame and flagged, so the two ends need not agree.
	 */
	compress?: boolean;
	onError?: (err: Error) => void;
}

interface Pending {
	resolve(value: unknown): void;
	reject(err: Error): void;
	timer: ReturnType<typeof setTimeout> | null;
	onData?: (payload: Bytes, binary: boolean) => void;
	onEnd?: (error?: ErrorPayload) => void;
	/** true once ControlResp landed but the stream is still open */
	settled: boolean;
}

interface Inbound {
	controller: AbortController;
	onData?: (payload: Bytes, binary: boolean) => void;
	/** true once the handler wrote to the stream, so we must send StreamEnd */
	streaming: boolean;
	ended: boolean;
	/**
	 * Frames the handler produced before it returned. They can't go out yet: the
	 * peer must see the ControlResp — which carries the session id the stream
	 * belongs to — before any data on that correlation id.
	 */
	queued: Uint8Array[];
	responded: boolean;
}

const DEFAULT_TIMEOUT = 30_000;

export class PeerLink {
	private pending = new Map<number, Pending>();
	private inbound = new Map<number, Inbound>();
	private acks = new Map<number, (value: void) => void>();
	private handlers = new Map<number, (frame: Frame) => void>();
	private requestHandler: RequestHandler | null = null;
	private nextId: number;
	private heartbeat: ReturnType<typeof setInterval> | null = null;
	private closeListeners = new Set<(reason: string) => void>();
	/** false forbids gzip on this link; undefined leaves it to the frame size. */
	private readonly compress: false | undefined;

	/** Round trip of the most recent Ping, in ms. */
	latencyMs: number | null = null;
	closed = false;

	constructor(
		private transport: Transport,
		private options: LinkOptions,
	) {
		this.nextId = options.parity === "odd" ? 1 : 2;
		this.compress = options.compress === false ? false : undefined;
	}

	private get label(): string {
		return this.options.name ?? "peer";
	}

	/** {@link encodeFrame} with this link's compression policy applied. */
	private frame(
		type: number,
		payload?: Bytes,
		opts: EncodeOptions = {},
	): Bytes {
		return encodeFrame(type, payload, { compress: this.compress, ...opts });
	}

	/** {@link encodeJson} with this link's compression policy applied. */
	private jsonFrame(
		type: number,
		value: unknown,
		opts: EncodeOptions = {},
	): Bytes {
		return encodeJson(type, value, { compress: this.compress, ...opts });
	}

	private allocate(): number {
		const id = this.nextId;
		// 32-bit space, stepping by two to stay in this side's parity, skipping 0.
		this.nextId += 2;
		if (this.nextId > 0xffff_fffe)
			this.nextId = this.options.parity === "odd" ? 1 : 2;
		return id;
	}

	private raise(err: Error) {
		if (this.options.onError) this.options.onError(err);
		else console.error(`${this.label}: ${err.message}`);
	}

	private write(data: Uint8Array) {
		if (this.closed) return;
		try {
			this.transport.send(data);
		} catch (err) {
			this.raise(err instanceof Error ? err : new Error(String(err)));
		}
	}

	/* ---------- sending ---------- */

	/** Fire-and-forget JSON message: Telemetry, Hello, Welcome. */
	send(type: number, value: unknown, correlationId = 0) {
		this.write(this.jsonFrame(type, value, { correlationId }));
	}

	/** Like {@link send}, but resolves once the peer acknowledges the frame. */
	sendWithAck(
		type: number,
		value: unknown,
		timeoutMs = DEFAULT_TIMEOUT,
	): Promise<void> {
		const correlationId = this.allocate();
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.acks.delete(correlationId);
				reject(
					new Error(
						`${this.label}: no ack for ${messageTypeName(type)} within ${timeoutMs}ms`,
					),
				);
			}, timeoutMs);
			this.acks.set(correlationId, () => {
				clearTimeout(timer);
				this.acks.delete(correlationId);
				resolve();
			});
			this.write(
				this.jsonFrame(type, value, {
					correlationId,
					flags: Flags.REQUIRES_ACK,
				}),
			);
		});
	}

	error(code: string, message: string, correlationId = 0) {
		this.send(
			MessageType.Error,
			{ code, message } satisfies ErrorPayload,
			correlationId,
		);
	}

	/** Sends a control request and resolves with the peer's result. */
	request<T = unknown>(
		action: string,
		params?: unknown,
		opts: RequestOptions = {},
	): Promise<T> {
		const correlationId = this.allocate();
		return this.dispatch<T>(correlationId, action, params, opts);
	}

	/**
	 * A request whose correlation id stays open in both directions — the caller
	 * can push bytes at the peer (terminal keystrokes) while the peer pushes
	 * back (terminal output).
	 */
	openStream<T = unknown>(
		action: string,
		params: unknown,
		opts: Omit<RequestOptions, "timeoutMs"> & {
			timeoutMs?: number | null;
		} = {},
	): OutboundStream<T> {
		const correlationId = this.allocate();
		const ready = this.dispatch<T>(correlationId, action, params, {
			timeoutMs: null,
			...opts,
		});
		// An unhandled rejection here would be noise: `ready` is handed to the
		// caller, who is expected to await it.
		ready.catch(() => {});

		let ended = false;
		const end = () => {
			if (ended) return;
			ended = true;
			this.write(
				this.frame(MessageType.StreamEnd, undefined, { correlationId }),
			);
		};

		return {
			correlationId,
			ready,
			bytes: (data) => {
				if (!ended) {
					this.write(
						this.frame(MessageType.StreamData, data, {
							correlationId,
							flags: Flags.BINARY,
						}),
					);
				}
			},
			json: (value) => {
				if (!ended)
					this.write(
						this.jsonFrame(MessageType.StreamData, value, { correlationId }),
					);
			},
			raw: (payload, binary) => {
				if (!ended) {
					this.write(
						this.frame(MessageType.StreamData, payload, {
							correlationId,
							flags: binary ? Flags.BINARY : Flags.NONE,
						}),
					);
				}
			},
			end,
		};
	}

	private dispatch<T>(
		correlationId: number,
		action: string,
		params: unknown,
		opts: RequestOptions,
	): Promise<T> {
		if (this.closed) {
			return Promise.reject(
				new RemoteError("link_closed", `${this.label}: link is closed`),
			);
		}

		const timeoutMs =
			opts.timeoutMs === undefined ? DEFAULT_TIMEOUT : opts.timeoutMs;

		return new Promise<T>((resolve, reject) => {
			const entry: Pending = {
				resolve: resolve as (value: unknown) => void,
				reject,
				timer: null,
				onData: opts.onData,
				onEnd: opts.onEnd,
				settled: false,
			};

			if (timeoutMs !== null) {
				entry.timer = setTimeout(() => {
					this.pending.delete(correlationId);
					reject(
						new RemoteError(
							"timeout",
							`${this.label}: '${action}' timed out after ${timeoutMs}ms`,
						),
					);
				}, timeoutMs);
			}

			opts.signal?.addEventListener(
				"abort",
				() => {
					const p = this.pending.get(correlationId);
					if (!p) return;
					this.pending.delete(correlationId);
					if (p.timer) clearTimeout(p.timer);
					this.write(
						this.frame(MessageType.StreamEnd, undefined, { correlationId }),
					);
					if (!p.settled)
						reject(
							new RemoteError("aborted", `${this.label}: '${action}' aborted`),
						);
					p.onEnd?.();
				},
				{ once: true },
			);

			this.pending.set(correlationId, entry);
			this.write(
				this.jsonFrame(
					MessageType.ControlReq,
					{ action, params } satisfies ControlRequest,
					{
						correlationId,
						flags: opts.requiresAck ? Flags.REQUIRES_ACK : Flags.NONE,
					},
				),
			);
		});
	}

	/* ---------- receiving ---------- */

	/** Handles inbound ControlReq frames. One handler per link. */
	onRequest(handler: RequestHandler) {
		this.requestHandler = handler;
	}

	/** Handles a message type the link doesn't process itself (Telemetry, Hello, …). */
	on(type: number, handler: (frame: Frame) => void) {
		this.handlers.set(type, handler);
	}

	onClose(listener: (reason: string) => void) {
		this.closeListeners.add(listener);
	}

	/** Feed every inbound WebSocket message here. */
	receive(data: Uint8Array | ArrayBuffer) {
		const bytes = (
			data instanceof Uint8Array ? data : new Uint8Array(data)
		) as Bytes;
		let frame: Frame;
		try {
			frame = decodeFrame(bytes).frame;
		} catch (err) {
			this.raise(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		if (frame.version !== PROTOCOL_VERSION) {
			// Frames are self-describing and additive, so a version skew is worth a
			// warning rather than a disconnect.
			this.raise(
				new Error(
					`${this.label}: frame version ${frame.version}, expected ${PROTOCOL_VERSION}`,
				),
			);
		}

		if (frame.flags & Flags.REQUIRES_ACK && frame.correlationId !== 0) {
			this.write(
				this.frame(MessageType.Ack, undefined, {
					correlationId: frame.correlationId,
				}),
			);
		}

		switch (frame.type) {
			case MessageType.ControlReq:
				void this.handleRequest(frame);
				return;
			case MessageType.ControlResp:
				this.handleResponse(frame);
				return;
			case MessageType.StreamData:
				this.handleStreamData(frame);
				return;
			case MessageType.StreamEnd:
				this.handleStreamEnd(frame);
				return;
			case MessageType.Error:
				this.handleError(frame);
				return;
			case MessageType.Ack:
				this.acks.get(frame.correlationId)?.();
				return;
			case MessageType.Ping:
				this.write(
					this.frame(MessageType.Pong, frame.payload, {
						correlationId: frame.correlationId,
					}),
				);
				return;
			case MessageType.Pong:
				this.handleResponse(frame);
				return;
			default: {
				const handler = this.handlers.get(frame.type);
				if (handler) handler(frame);
				else
					this.raise(
						new Error(
							`${this.label}: unhandled frame ${messageTypeName(frame.type)}`,
						),
					);
			}
		}
	}

	private async handleRequest(frame: Frame) {
		const { correlationId } = frame;
		if (!this.requestHandler) {
			this.error(
				"unsupported",
				"this peer does not accept control requests",
				correlationId,
			);
			return;
		}

		let request: ControlRequest;
		try {
			request = frameJson<ControlRequest>(frame);
		} catch (err) {
			this.error(
				"bad_request",
				err instanceof Error ? err.message : String(err),
				correlationId,
			);
			return;
		}

		const state: Inbound = {
			controller: new AbortController(),
			streaming: false,
			ended: false,
			queued: [],
			responded: false,
		};
		this.inbound.set(correlationId, state);

		const emit = (data: Uint8Array) => {
			if (state.responded) this.write(data);
			else state.queued.push(data);
		};

		const sink: StreamSink = {
			open: () => {
				if (!state.ended) state.streaming = true;
			},
			bytes: (data) => {
				if (state.ended) return;
				state.streaming = true;
				emit(
					this.frame(MessageType.StreamData, data, {
						correlationId,
						flags: Flags.BINARY,
					}),
				);
			},
			json: (value) => {
				if (state.ended) return;
				state.streaming = true;
				emit(this.jsonFrame(MessageType.StreamData, value, { correlationId }));
			},
			raw: (payload, binary) => {
				if (state.ended) return;
				state.streaming = true;
				emit(
					this.frame(MessageType.StreamData, payload, {
						correlationId,
						flags: binary ? Flags.BINARY : Flags.NONE,
					}),
				);
			},
			end: (error) => {
				if (state.ended) return;
				state.ended = true;
				state.streaming = true;
				if (error) {
					emit(this.jsonFrame(MessageType.Error, error, { correlationId }));
				}
				emit(this.frame(MessageType.StreamEnd, undefined, { correlationId }));
				state.controller.abort();
				if (state.responded) this.inbound.delete(correlationId);
			},
			get closed() {
				return state.ended;
			},
		};

		const inboundRequest: InboundRequest<never> = {
			action: request.action,
			params: (request.params ?? {}) as never,
			correlationId,
			signal: state.controller.signal,
			onData: (handler) => {
				state.onData = handler;
				// Wanting the peer's data is itself a reason to keep the id open.
				state.streaming = true;
			},
			stream: sink,
		};

		try {
			const result = await this.requestHandler(inboundRequest);
			this.send(
				MessageType.ControlResp,
				{ result } satisfies ControlResponse,
				correlationId,
			);
			state.responded = true;
			for (const queued of state.queued.splice(0)) this.write(queued);

			// A handler that never touched the stream has nothing more to say.
			if (!state.streaming || state.ended) {
				state.ended = true;
				this.inbound.delete(correlationId);
				state.controller.abort();
			}
		} catch (err) {
			const code = err instanceof RemoteError ? err.code : "error";
			state.responded = true;
			state.queued.length = 0;
			this.error(
				code,
				err instanceof Error ? err.message : String(err),
				correlationId,
			);
			state.ended = true;
			this.inbound.delete(correlationId);
			state.controller.abort();
		}
	}

	private handleResponse(frame: Frame) {
		const pending = this.pending.get(frame.correlationId);
		if (!pending) return; // late response to something we already gave up on
		if (pending.timer) clearTimeout(pending.timer);
		pending.timer = null;
		pending.settled = true;

		let value: unknown = null;
		try {
			value =
				frame.type === MessageType.Pong
					? frameJson<unknown>(frame)
					: frameJson<ControlResponse>(frame)?.result;
		} catch (err) {
			this.pending.delete(frame.correlationId);
			pending.reject(err instanceof Error ? err : new Error(String(err)));
			return;
		}

		// Streaming requests keep their entry so StreamData still has somewhere to
		// go; one-shots are done the moment they resolve.
		if (!pending.onData && !pending.onEnd)
			this.pending.delete(frame.correlationId);
		pending.resolve(value);
	}

	private handleStreamData(frame: Frame) {
		const binary = (frame.flags & Flags.BINARY) !== 0;
		const pending = this.pending.get(frame.correlationId);
		if (pending?.onData) {
			pending.onData(frame.payload, binary);
			return;
		}
		// Data flowing the other way: the peer is writing into a request we are
		// still handling (terminal input, for instance).
		this.inbound.get(frame.correlationId)?.onData?.(frame.payload, binary);
	}

	private handleStreamEnd(frame: Frame) {
		const pending = this.pending.get(frame.correlationId);
		if (pending) {
			this.pending.delete(frame.correlationId);
			if (pending.timer) clearTimeout(pending.timer);
			if (!pending.settled) {
				pending.reject(
					new RemoteError(
						"stream_closed",
						`${this.label}: stream closed before it answered`,
					),
				);
			}
			pending.onEnd?.();
			return;
		}
		const state = this.inbound.get(frame.correlationId);
		if (state) {
			this.inbound.delete(frame.correlationId);
			state.ended = true;
			state.controller.abort();
		}
	}

	private handleError(frame: Frame) {
		let payload: ErrorPayload;
		try {
			payload = frameJson<ErrorPayload>(frame) ?? {
				code: "error",
				message: "unspecified error",
			};
		} catch {
			payload = { code: "error", message: "malformed error frame" };
		}

		if (frame.correlationId === 0) {
			this.raise(new RemoteError(payload.code, payload.message));
			return;
		}

		const pending = this.pending.get(frame.correlationId);
		if (!pending) return;
		this.pending.delete(frame.correlationId);
		if (pending.timer) clearTimeout(pending.timer);
		if (!pending.settled)
			pending.reject(new RemoteError(payload.code, payload.message));
		pending.onEnd?.(payload);
	}

	/* ---------- liveness ---------- */

	/** Round trip, in ms. Rejects if the peer doesn't answer in time. */
	async ping(timeoutMs = 10_000): Promise<number> {
		const correlationId = this.allocate();
		const started = Date.now();
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(correlationId);
				reject(new RemoteError("timeout", `${this.label}: ping timed out`));
			}, timeoutMs);
			this.pending.set(correlationId, {
				resolve: () => {
					clearTimeout(timer);
					resolve();
				},
				reject,
				timer: null,
				settled: false,
			});
			this.write(this.jsonFrame(MessageType.Ping, started, { correlationId }));
		});
		this.latencyMs = Date.now() - started;
		return this.latencyMs;
	}

	/** Pings on an interval; a failure closes the link so the caller reconnects. */
	startHeartbeat(intervalMs: number, onFailure?: (err: Error) => void) {
		this.stopHeartbeat();
		this.heartbeat = setInterval(() => {
			this.ping(Math.max(5000, intervalMs)).catch((err: Error) => {
				if (onFailure) onFailure(err);
				else this.close("heartbeat timeout");
			});
		}, intervalMs);
		// Don't keep a CLI process alive purely to ping.
		this.heartbeat.unref?.();
	}

	stopHeartbeat() {
		if (this.heartbeat) clearInterval(this.heartbeat);
		this.heartbeat = null;
	}

	/* ---------- teardown ---------- */

	/** Local teardown: reject everything outstanding and notify listeners. */
	dispose(reason = "link closed") {
		if (this.closed) return;
		this.closed = true;
		this.stopHeartbeat();

		for (const [, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			if (!pending.settled)
				pending.reject(
					new RemoteError("link_closed", `${this.label}: ${reason}`),
				);
			pending.onEnd?.({ code: "link_closed", message: reason });
		}
		this.pending.clear();

		for (const [, state] of this.inbound) {
			state.ended = true;
			state.controller.abort();
		}
		this.inbound.clear();
		this.acks.clear();

		for (const listener of this.closeListeners) {
			try {
				listener(reason);
			} catch (err) {
				this.raise(err instanceof Error ? err : new Error(String(err)));
			}
		}
		this.closeListeners.clear();
	}

	/** Closes the underlying transport as well. */
	close(reason = "closing", code = 1000) {
		const alreadyClosed = this.closed;
		this.dispose(reason);
		if (!alreadyClosed) {
			try {
				this.transport.close(code, reason.slice(0, 120));
			} catch {
				// transport already gone
			}
		}
	}
}
