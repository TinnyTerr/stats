/**
 * The stats wire format. Every message — telemetry, control, terminal bytes —
 * is one of these frames, sent as a single binary WebSocket message.
 *
 *   [1 byte]  version
 *   [1 byte]  message type
 *   [2 bytes] flags
 *   [4 bytes] correlation id   (0 for telemetry, non-zero for req/resp pairs)
 *   [4 bytes] payload length
 *   [N bytes] payload
 *
 * Multi-byte fields are big-endian. The payload is UTF-8 JSON unless the BINARY
 * flag is set, in which case it is opaque bytes belonging to the stream named by
 * the correlation id (that's how terminal I/O travels).
 */
export declare const PROTOCOL_VERSION = 2;
/** Header size in bytes: version + type + flags + correlation + length. */
export declare const HEADER_SIZE = 12;
/**
 * Payload cap, enforced on decode. Telemetry from a busy host with hundreds of
 * containers is tens of kilobytes; 16 MiB is far past anything legitimate and
 * keeps a malformed length field from allocating the process to death.
 */
export declare const MAX_PAYLOAD: number;
export declare const MessageType: {
    /** node → hub, correlation 0, unsolicited: a snapshot of the whole host. */
    readonly Telemetry: 1;
    /** either direction: `{ action, params }`, expects a response. */
    readonly ControlReq: 2;
    /** the matching `{ ok, result }` or terminal failure for a ControlReq. */
    readonly ControlResp: 3;
    /** receipt for a frame that set REQUIRES_ACK. */
    readonly Ack: 4;
    /** `{ code, message }`; fatal for the correlation id, or the link if 0. */
    readonly Error: 5;
    /** a chunk of an open stream: log lines, terminal bytes, project output. */
    readonly StreamData: 6;
    /** the stream on this correlation id has finished; no more StreamData. */
    readonly StreamEnd: 7;
    /** node → hub, first frame after connect: who I am, what I can do. */
    readonly Hello: 8;
    /** hub → node, the answer to Hello: accepted, plus the hub's settings. */
    readonly Welcome: 9;
    /** keepalive; the peer answers with Pong carrying the same payload. */
    readonly Ping: 10;
    readonly Pong: 11;
};
export type MessageType = (typeof MessageType)[keyof typeof MessageType];
export declare function messageTypeName(type: number): string;
export declare const Flags: {
    readonly NONE: 0;
    /** payload is gzipped. Set automatically above COMPRESS_THRESHOLD. */
    readonly COMPRESSED: 1;
    /** sender wants an Ack frame echoing this correlation id. */
    readonly REQUIRES_ACK: 2;
    /** payload is raw bytes rather than JSON. */
    readonly BINARY: 4;
};
/** Below this, gzip costs more than it saves. */
export declare const COMPRESS_THRESHOLD = 1024;
/**
 * Payloads are always backed by a plain ArrayBuffer, never a SharedArrayBuffer:
 * Bun's compression and WebSocket APIs both insist on it, and nothing here has
 * a reason to share memory across threads.
 */
export type Bytes = Uint8Array<ArrayBuffer>;
export interface Frame {
    version: number;
    type: number;
    flags: number;
    correlationId: number;
    payload: Bytes;
}
export declare class FrameError extends Error {
}
export interface EncodeOptions {
    correlationId?: number;
    flags?: number;
    version?: number;
    /** Overrides the size-based decision. */
    compress?: boolean;
}
/** Serialises a frame. `payload` is taken as-is; use {@link encodeJson} for objects. */
export declare function encodeFrame(type: number, payload?: Bytes, opts?: EncodeOptions): Bytes;
export declare function encodeJson(type: number, value: unknown, opts?: EncodeOptions): Bytes;
/**
 * Parses one frame from the front of `data`. `consumed` is how many bytes the
 * frame occupied, so a stream transport can decode back-to-back frames; over
 * WebSocket, where one message is one frame, it should equal `data.length`.
 */
export declare function decodeFrame(data: Bytes): {
    frame: Frame;
    consumed: number;
};
/** Decodes every whole frame in a buffer, returning any trailing partial bytes. */
export declare function decodeFrames(data: Bytes): {
    frames: Frame[];
    rest: Bytes;
};
export declare function frameJson<T>(frame: Frame): T;
