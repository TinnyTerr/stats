import {
	type Bytes,
	decodeFrame,
	Flags,
	messageTypeName,
} from "../proto/frame.ts";
import type { PacketDirection, PacketRecord } from "../proto/messages.ts";

/**
 * A ring buffer of every frame the hub has sent or received, for the packets
 * tab. It only ever sees bytes already on the wire — see the two capture
 * points in src/hub/server.ts — so it has no opinion on the protocol beyond
 * what {@link decodeFrame} can tell it, and a frame that fails to decode is
 * still recorded rather than dropped.
 */

const MAX_RECORDS = 1000;
/** Frames past this are still recorded, but the raw copy is cut short. */
const MAX_RAW_BYTES = 8192;

export class PacketLog {
	private records: PacketRecord[] = [];
	private nextId = 1;
	private subscribers = new Set<(record: PacketRecord) => void>();

	capture(
		direction: PacketDirection,
		peer: string,
		data: Uint8Array,
	): PacketRecord {
		const originalFlags =
			data.byteLength >= 4
				? new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(
						2,
						false,
					)
				: 0;

		let decoded: ReturnType<typeof decodeFrame> | null = null;
		try {
			decoded = decodeFrame(data as Bytes);
		} catch {
			decoded = null;
		}

		const binary = decoded ? (decoded.frame.flags & Flags.BINARY) !== 0 : false;
		let json: unknown = null;
		let jsonError: string | null = null;
		if (decoded && !binary && decoded.frame.payload.length) {
			try {
				json = JSON.parse(new TextDecoder().decode(decoded.frame.payload));
			} catch (err) {
				jsonError = err instanceof Error ? err.message : String(err);
			}
		}

		const record: PacketRecord = {
			id: this.nextId++,
			ts: Date.now(),
			direction,
			peer,
			type: decoded
				? messageTypeName(decoded.frame.type)
				: `malformed(0x${(data[1] ?? 0).toString(16)})`,
			correlationId: decoded?.frame.correlationId ?? 0,
			flags: originalFlags,
			compressed: (originalFlags & Flags.COMPRESSED) !== 0,
			binary,
			bytes: data.byteLength,
			json,
			jsonError,
			rawBase64: Buffer.from(
				data.buffer,
				data.byteOffset,
				Math.min(data.byteLength, MAX_RAW_BYTES),
			).toString("base64"),
			truncated: data.byteLength > MAX_RAW_BYTES,
		};

		this.records.push(record);
		if (this.records.length > MAX_RECORDS) this.records.shift();
		for (const notify of this.subscribers) notify(record);
		return record;
	}

	/** Most recent frames first-capped, oldest first — the order a tail replays them in. */
	recent(limit = MAX_RECORDS): PacketRecord[] {
		if (limit >= this.records.length) return this.records.slice();
		return this.records.slice(-limit);
	}

	subscribe(notify: (record: PacketRecord) => void): () => void {
		this.subscribers.add(notify);
		return () => this.subscribers.delete(notify);
	}
}
