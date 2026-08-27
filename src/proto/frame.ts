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

export const PROTOCOL_VERSION = 5;

/** Header size in bytes: version + type + flags + correlation + length. */
export const HEADER_SIZE = 12;

/**
 * Payload cap, enforced on decode. Telemetry from a busy host with hundreds of
 * containers is tens of kilobytes; 16 MiB is far past anything legitimate and
 * keeps a malformed length field from allocating the process to death.
 */
export const MAX_PAYLOAD = 16 * 1024 * 1024;

export const MessageType = {
	/** node → hub, correlation 0, unsolicited: a snapshot of the whole host. */
	Telemetry: 0x01,
	/** either direction: `{ action, params }`, expects a response. */
	ControlReq: 0x02,
	/** the matching `{ ok, result }` or terminal failure for a ControlReq. */
	ControlResp: 0x03,
	/** receipt for a frame that set REQUIRES_ACK. */
	Ack: 0x04,
	/** `{ code, message }`; fatal for the correlation id, or the link if 0. */
	Error: 0x05,
	/** a chunk of an open stream: log lines, terminal bytes, project output. */
	StreamData: 0x06,
	/** the stream on this correlation id has finished; no more StreamData. */
	StreamEnd: 0x07,
	/** node → hub, first frame after connect: who I am, what I can do. */
	Hello: 0x08,
	/** hub → node, the answer to Hello: accepted, plus the hub's settings. */
	Welcome: 0x09,
	/** keepalive; the peer answers with Pong carrying the same payload. */
	Ping: 0x0a,
	Pong: 0x0b,
} as const;

export type MessageType = (typeof MessageType)[keyof typeof MessageType];

const TYPE_NAMES = new Map<number, string>(
	Object.entries(MessageType).map(([name, value]) => [value, name]),
);

export function messageTypeName(type: number): string {
	return TYPE_NAMES.get(type) ?? `0x${type.toString(16).padStart(2, "0")}`;
}

export const Flags = {
	NONE: 0x0000,
	/** payload is gzipped. Set automatically above COMPRESS_THRESHOLD. */
	COMPRESSED: 0x0001,
	/** sender wants an Ack frame echoing this correlation id. */
	REQUIRES_ACK: 0x0002,
	/** payload is raw bytes rather than JSON. */
	BINARY: 0x0004,
} as const;

/** Below this, gzip costs more than it saves. */
export const COMPRESS_THRESHOLD = 1024;

/**
 * Sync gzip, where the runtime has it. Bun does; a browser does not — its only
 * gzip is the async `DecompressionStream`, which can't be used from a decoder
 * that has to return a frame. So a peer running in a browser neither compresses
 * nor can be sent compressed frames: `PeerLink`'s `compress: false` is what
 * keeps the hub honest about that, and the guards below are the backstop.
 */
const zlib: {
	gzipSync(data: Bytes): Bytes;
	gunzipSync(data: Bytes): Bytes;
} | null = typeof Bun === "undefined" ? null : Bun;

/** Whether this runtime can gzip at all — false in the browser. */
export const canCompress = zlib !== null;

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

export class FrameError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface EncodeOptions {
	correlationId?: number;
	flags?: number;
	version?: number;
	/** Overrides the size-based decision. */
	compress?: boolean;
}

/** Serialises a frame. `payload` is taken as-is; use {@link encodeJson} for objects. */
export function encodeFrame(
	type: number,
	payload: Bytes = new Uint8Array(0),
	opts: EncodeOptions = {},
): Bytes {
	const version = opts.version ?? PROTOCOL_VERSION;
	const correlationId = opts.correlationId ?? 0;
	let flags = opts.flags ?? Flags.NONE;

	let body = payload;
	const wantsCompression =
		opts.compress ?? payload.length >= COMPRESS_THRESHOLD;
	if (zlib && wantsCompression && !(flags & Flags.COMPRESSED)) {
		body = zlib.gzipSync(payload);
		// Compressing tiny or already-compressed payloads can grow them; only keep
		// the result when it actually helped.
		if (body.length < payload.length) flags |= Flags.COMPRESSED;
		else body = payload;
	}

	if (body.length > MAX_PAYLOAD) {
		throw new FrameError(
			`payload of ${body.length} bytes exceeds the ${MAX_PAYLOAD} byte limit`,
		);
	}

	const out = new Uint8Array(HEADER_SIZE + body.length) as Bytes;
	const view = new DataView(out.buffer);
	view.setUint8(0, version);
	view.setUint8(1, type);
	view.setUint16(2, flags, false);
	view.setUint32(4, correlationId, false);
	view.setUint32(8, body.length, false);
	out.set(body, HEADER_SIZE);
	return out;
}

export function encodeJson(
	type: number,
	value: unknown,
	opts: EncodeOptions = {},
): Bytes {
	return encodeFrame(type, encoder.encode(JSON.stringify(value ?? null)), opts);
}

/**
 * Parses one frame from the front of `data`. `consumed` is how many bytes the
 * frame occupied, so a stream transport can decode back-to-back frames; over
 * WebSocket, where one message is one frame, it should equal `data.length`.
 */
export function decodeFrame(data: Bytes): { frame: Frame; consumed: number } {
	if (data.length < HEADER_SIZE) {
		throw new FrameError(
			`truncated header: ${data.length} of ${HEADER_SIZE} bytes`,
		);
	}
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const length = view.getUint32(8, false);
	if (length > MAX_PAYLOAD) {
		throw new FrameError(
			`declared payload of ${length} bytes exceeds the ${MAX_PAYLOAD} limit`,
		);
	}
	if (data.length < HEADER_SIZE + length) {
		throw new FrameError(
			`truncated payload: ${data.length - HEADER_SIZE} of ${length} bytes`,
		);
	}

	const flags = view.getUint16(2, false);
	let payload = data.subarray(HEADER_SIZE, HEADER_SIZE + length);
	if (flags & Flags.COMPRESSED) {
		if (!zlib) {
			throw new FrameError(
				`frame ${messageTypeName(view.getUint8(1))} is gzipped, but this runtime has no sync inflate; the peer should not compress frames sent here`,
			);
		}
		try {
			payload = zlib.gunzipSync(payload);
		} catch (err) {
			throw new FrameError(
				`payload is flagged compressed but did not inflate: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	return {
		frame: {
			version: view.getUint8(0),
			type: view.getUint8(1),
			// The decoded payload is plain again, so the flag would be a lie downstream.
			flags: flags & ~Flags.COMPRESSED,
			correlationId: view.getUint32(4, false),
			payload,
		},
		consumed: HEADER_SIZE + length,
	};
}

/** Decodes every whole frame in a buffer, returning any trailing partial bytes. */
export function decodeFrames(data: Bytes): { frames: Frame[]; rest: Bytes } {
	const frames: Frame[] = [];
	let offset = 0;
	while (offset < data.length) {
		let decoded;
		try {
			decoded = decodeFrame(data.subarray(offset));
		} catch (err) {
			// A truncated tail is normal mid-stream; a malformed header is not.
			if (err instanceof FrameError && err.message.startsWith("truncated"))
				break;
			throw err;
		}
		frames.push(decoded.frame);
		offset += decoded.consumed;
	}
	return { frames, rest: data.subarray(offset) };
}

export function frameJson<T>(frame: Frame): T {
	if (frame.flags & Flags.BINARY) {
		throw new FrameError(
			`frame ${messageTypeName(frame.type)} carries binary, not JSON`,
		);
	}
	if (frame.payload.length === 0) return null as T;
	try {
		return JSON.parse(decoder.decode(frame.payload)) as T;
	} catch (err) {
		throw new FrameError(
			`frame ${messageTypeName(frame.type)} payload is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
}
