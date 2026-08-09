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
import { type Bytes, type Frame } from "./frame.ts";
import type { ErrorPayload } from "./messages.ts";
export interface Transport {
    send(data: Uint8Array): void;
    close(code?: number, reason?: string): void;
}
export declare class RemoteError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
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
export type RequestHandler = (req: InboundRequest<never>) => unknown | Promise<unknown>;
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
    onError?: (err: Error) => void;
}
export declare class PeerLink {
    private transport;
    private options;
    private pending;
    private inbound;
    private acks;
    private handlers;
    private requestHandler;
    private nextId;
    private heartbeat;
    private closeListeners;
    /** Round trip of the most recent Ping, in ms. */
    latencyMs: number | null;
    closed: boolean;
    constructor(transport: Transport, options: LinkOptions);
    private get label();
    private allocate;
    private raise;
    private write;
    /** Fire-and-forget JSON message: Telemetry, Hello, Welcome. */
    send(type: number, value: unknown, correlationId?: number): void;
    /** Like {@link send}, but resolves once the peer acknowledges the frame. */
    sendWithAck(type: number, value: unknown, timeoutMs?: number): Promise<void>;
    error(code: string, message: string, correlationId?: number): void;
    /** Sends a control request and resolves with the peer's result. */
    request<T = unknown>(action: string, params?: unknown, opts?: RequestOptions): Promise<T>;
    /**
     * A request whose correlation id stays open in both directions — the caller
     * can push bytes at the peer (terminal keystrokes) while the peer pushes
     * back (terminal output).
     */
    openStream<T = unknown>(action: string, params: unknown, opts?: Omit<RequestOptions, "timeoutMs"> & {
        timeoutMs?: number | null;
    }): OutboundStream<T>;
    private dispatch;
    /** Handles inbound ControlReq frames. One handler per link. */
    onRequest(handler: RequestHandler): void;
    /** Handles a message type the link doesn't process itself (Telemetry, Hello, …). */
    on(type: number, handler: (frame: Frame) => void): void;
    onClose(listener: (reason: string) => void): void;
    /** Feed every inbound WebSocket message here. */
    receive(data: Uint8Array | ArrayBuffer): void;
    private handleRequest;
    private handleResponse;
    private handleStreamData;
    private handleStreamEnd;
    private handleError;
    /** Round trip, in ms. Rejects if the peer doesn't answer in time. */
    ping(timeoutMs?: number): Promise<number>;
    /** Pings on an interval; a failure closes the link so the caller reconnects. */
    startHeartbeat(intervalMs: number, onFailure?: (err: Error) => void): void;
    stopHeartbeat(): void;
    /** Local teardown: reject everything outstanding and notify listeners. */
    dispose(reason?: string): void;
    /** Closes the underlying transport as well. */
    close(reason?: string, code?: number): void;
}
