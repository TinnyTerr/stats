import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	COMPRESS_THRESHOLD,
	decodeFrame,
	decodeFrames,
	encodeFrame,
	encodeJson,
	Flags,
	FrameError,
	frameJson,
	HEADER_SIZE,
	MessageType,
	messageTypeName,
	PROTOCOL_VERSION,
} from "./frame.ts";
import { PeerLink, RemoteError, type Transport } from "./link.ts";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("frame codec", () => {
	test("round-trips a header exactly as specified", () => {
		const encoded = encodeFrame(MessageType.ControlReq, bytes(1, 2, 3), {
			correlationId: 0xdeadbeef,
			flags: Flags.REQUIRES_ACK,
		});

		// 1 version, 1 type, 2 flags, 4 correlation, 4 length, then the payload.
		expect(encoded.length).toBe(HEADER_SIZE + 3);
		expect(encoded[0]).toBe(PROTOCOL_VERSION);
		expect(encoded[1]).toBe(MessageType.ControlReq);
		const view = new DataView(encoded.buffer);
		expect(view.getUint16(2, false)).toBe(Flags.REQUIRES_ACK);
		expect(view.getUint32(4, false)).toBe(0xdeadbeef);
		expect(view.getUint32(8, false)).toBe(3);

		const { frame, consumed } = decodeFrame(encoded);
		expect(consumed).toBe(encoded.length);
		expect(frame.correlationId).toBe(0xdeadbeef);
		expect(frame.flags & Flags.REQUIRES_ACK).toBeTruthy();
		expect([...frame.payload]).toEqual([1, 2, 3]);
	});

	test("telemetry uses correlation id 0", () => {
		const { frame } = decodeFrame(
			encodeJson(MessageType.Telemetry, { cpu: 0.5 }),
		);
		expect(frame.correlationId).toBe(0);
		expect(frameJson<{ cpu: number }>(frame).cpu).toBe(0.5);
	});

	test("compresses big payloads and inflates them transparently", () => {
		const value = {
			lines: Array.from({ length: 500 }, (_, i) => `log line ${i}`),
		};
		const encoded = encodeJson(MessageType.Telemetry, value);
		const view = new DataView(encoded.buffer);

		expect(view.getUint16(2, false) & Flags.COMPRESSED).toBeTruthy();
		expect(encoded.length).toBeLessThan(JSON.stringify(value).length);

		const { frame } = decodeFrame(encoded);
		// The flag is cleared once inflated, so downstream sees plain bytes.
		expect(frame.flags & Flags.COMPRESSED).toBe(0);
		expect(frameJson<typeof value>(frame)).toEqual(value);
	});

	test("a link told not to compress never sets the flag", async () => {
		// A browser has no sync gunzip, so a compressed frame is one it silently
		// drops — which is how every push to the dashboard once went missing.
		const sent: Uint8Array[] = [];
		const link = new PeerLink(
			{ send: (data) => sent.push(data), close: () => {} },
			{ parity: "odd", compress: false, onError: () => {} },
		);

		const big = { lines: Array.from({ length: 500 }, (_, i) => `line ${i}`) };
		link.send(MessageType.Telemetry, big);
		void link.request("something.big", big).catch(() => {});
		link.openStream("stream.big", big).json(big);

		// send, request, the stream's ControlReq, and the frame written into it.
		expect(sent.length).toBe(4);
		for (const frame of sent) {
			const view = new DataView(
				frame.buffer,
				frame.byteOffset,
				frame.byteLength,
			);
			expect(view.getUint16(2, false) & Flags.COMPRESSED).toBe(0);
			// Uncompressed, so the payload is the JSON itself.
			expect(frame.length).toBeGreaterThan(COMPRESS_THRESHOLD);
		}
	});

	test("leaves small payloads alone", () => {
		const encoded = encodeJson(MessageType.Ping, 1);
		expect(
			new DataView(encoded.buffer).getUint16(2, false) & Flags.COMPRESSED,
		).toBe(0);
		expect(encoded.length).toBeLessThan(COMPRESS_THRESHOLD);
	});

	test("rejects a truncated frame", () => {
		const encoded = encodeFrame(MessageType.Telemetry, bytes(1, 2, 3, 4));
		expect(() => decodeFrame(encoded.subarray(0, 6))).toThrow(FrameError);
		expect(() => decodeFrame(encoded.subarray(0, HEADER_SIZE + 2))).toThrow(
			/truncated payload/,
		);
	});

	test("rejects an absurd declared length before allocating", () => {
		const encoded = encodeFrame(MessageType.Telemetry, bytes(1));
		new DataView(encoded.buffer).setUint32(8, 0x7fff_ffff, false);
		expect(() => decodeFrame(encoded)).toThrow(/exceeds/);
	});

	test("decodeFrames splits a concatenated buffer and keeps the tail", () => {
		const a = encodeJson(MessageType.Ping, "a");
		const b = encodeJson(MessageType.Pong, "b");
		const joined = new Uint8Array(a.length + b.length + 3);
		joined.set(a);
		joined.set(b, a.length);
		joined.set(bytes(2, 1, 0), a.length + b.length); // a partial header

		const { frames, rest } = decodeFrames(joined);
		expect(frames.map((f) => f.type)).toEqual([
			MessageType.Ping,
			MessageType.Pong,
		]);
		expect(rest.length).toBe(3);
	});

	test("binary payloads are not parsed as JSON", () => {
		const { frame } = decodeFrame(
			encodeFrame(MessageType.StreamData, bytes(0x1b, 0x5b, 0x41), {
				flags: Flags.BINARY,
			}),
		);
		expect(() => frameJson(frame)).toThrow(/binary/);
	});

	test("names types for logs", () => {
		expect(messageTypeName(MessageType.Telemetry)).toBe("Telemetry");
		expect(messageTypeName(0x7f)).toBe("0x7f");
	});

	test("the dashboard bundle never reaches for the Bun global", async () => {
		// The browser runs this same wire code, where `Bun` does not exist. One
		// `Bun.gunzipSync` in the decoder was enough to make every push to the
		// dashboard vanish into a caught exception, silently, for weeks.
		const built = await Bun.build({
			entrypoints: [join(import.meta.dir, "../../web/frontend.tsx")],
			target: "browser",
		});
		expect(built.success).toBe(true);

		const js = await built.outputs[0]!.text();
		expect(js.match(/[^\w$]Bun\./g) ?? []).toEqual([]);
	});
});

/** Wires two links straight into each other, the way the WebSocket does. */
function pair(options?: { onError?: (err: Error) => void }) {
	const queues: Array<Uint8Array[]> = [[], []];
	let a!: PeerLink;
	let b!: PeerLink;

	const transport = (index: number): Transport => ({
		send(data) {
			// Copy: the receiver may hold on to the payload past this tick.
			queues[index]!.push(new Uint8Array(data));
			queueMicrotask(() => {
				const next = queues[index]!.shift();
				if (!next) return;
				(index === 0 ? b : a).receive(next);
			});
		},
		close() {
			(index === 0 ? b : a).dispose("peer closed");
		},
	});

	a = new PeerLink(transport(0), {
		parity: "odd",
		name: "a",
		onError: options?.onError,
	});
	b = new PeerLink(transport(1), {
		parity: "even",
		name: "b",
		onError: options?.onError,
	});
	return { a, b };
}

describe("PeerLink", () => {
	test("request/response round trip", async () => {
		const { a, b } = pair();
		b.onRequest((req) => ({ echoed: req.action, params: req.params }));

		await expect(a.request("snapshot", { full: true })).resolves.toEqual({
			echoed: "snapshot",
			params: { full: true },
		});
	});

	test("the two ends never allocate the same correlation id", async () => {
		const { a, b } = pair();
		const seen: number[] = [];
		a.onRequest((req) => {
			seen.push(req.correlationId);
			return null;
		});
		b.onRequest((req) => {
			seen.push(req.correlationId);
			return null;
		});

		await Promise.all([
			a.request("x"),
			b.request("y"),
			a.request("z"),
			b.request("w"),
		]);
		expect(new Set(seen).size).toBe(seen.length);
		// odd side allocates odd ids, even side even ones
		expect(seen.filter((id) => id % 2 === 1)).toHaveLength(2);
	});

	test("a throwing handler becomes a typed remote error", async () => {
		const { a, b } = pair();
		b.onRequest(() => {
			throw new RemoteError(
				"unauthorized",
				"terminals are disabled on this node",
			);
		});

		const err = (await a
			.request("terminal.open")
			.catch((e: unknown) => e)) as RemoteError;
		expect(err).toBeInstanceOf(RemoteError);
		expect(err.code).toBe("unauthorized");
		expect(err.message).toMatch(/disabled/);
	});

	test("requests time out without stranding the caller", async () => {
		const { a, b } = pair();
		b.onRequest(() => new Promise(() => {}));
		await expect(a.request("hang", null, { timeoutMs: 20 })).rejects.toThrow(
			/timed out/,
		);
	});

	test("streams data both ways on one correlation id", async () => {
		const { a, b } = pair();
		const received: string[] = [];
		const decoder = new TextDecoder();

		b.onRequest((req) => {
			req.onData((payload) => {
				// Echo whatever the caller types, uppercased, like a tiny shell.
				req.stream.bytes(
					new TextEncoder().encode(decoder.decode(payload).toUpperCase()),
				);
			});
			req.stream.json({ hello: true });
			return { sessionId: "s1" };
		});

		const out: unknown[] = [];
		const stream = a.openStream<{ sessionId: string }>(
			"terminal.open",
			{ cols: 80, rows: 24 },
			{
				onData: (payload, binary) => {
					if (binary) received.push(decoder.decode(payload));
					else out.push(JSON.parse(decoder.decode(payload)));
				},
			},
		);

		expect(await stream.ready).toEqual({ sessionId: "s1" });
		stream.bytes(new TextEncoder().encode("ls\n"));
		await Bun.sleep(10);

		expect(out).toEqual([{ hello: true }]);
		expect(received).toEqual(["LS\n"]);

		stream.end();
	});

	test("the handler ending a stream resolves the caller's onEnd", async () => {
		const { a, b } = pair();
		b.onRequest((req) => {
			queueMicrotask(() => {
				req.stream.json({ line: "one" });
				req.stream.end();
			});
			return { started: true };
		});

		const lines: unknown[] = [];
		let ended = false;
		const stream = a.openStream(
			"logs.tail",
			{ tail: 10 },
			{
				onData: (payload) =>
					lines.push(JSON.parse(new TextDecoder().decode(payload))),
				onEnd: () => {
					ended = true;
				},
			},
		);

		await stream.ready;
		await Bun.sleep(10);
		expect(lines).toEqual([{ line: "one" }]);
		expect(ended).toBe(true);
	});

	/**
	 * A terminal produces nothing until the shell says something, which is
	 * always after the handler returned. Declaring the stream keeps the
	 * correlation id alive; without it the link would tidy it away.
	 */
	test("a handler that declares a stream can send long after it responded", async () => {
		const { a, b } = pair();
		let aborted = false;

		b.onRequest((req) => {
			req.stream.open();
			req.signal.addEventListener("abort", () => {
				aborted = true;
			});
			setTimeout(
				() => req.stream.bytes(new TextEncoder().encode("late output")),
				30,
			);
			return { sessionId: "s1" };
		});

		const chunks: string[] = [];
		const stream = a.openStream(
			"terminal.open",
			{},
			{
				onData: (payload) => chunks.push(new TextDecoder().decode(payload)),
			},
		);

		await stream.ready;
		expect(aborted).toBe(false);
		await Bun.sleep(60);
		expect(chunks).toEqual(["late output"]);
	});

	test("aborting the peer's stream aborts the handler's signal", async () => {
		const { a, b } = pair();
		let aborted = false;
		b.onRequest((req) => {
			req.stream.json({ tick: 1 });
			req.signal.addEventListener("abort", () => {
				aborted = true;
			});
			return null;
		});

		const stream = a.openStream("logs.tail", {}, { onData: () => {} });
		await stream.ready;
		stream.end();
		await Bun.sleep(10);
		expect(aborted).toBe(true);
	});

	test("ack frames resolve sendWithAck", async () => {
		const { a, b } = pair();
		const seen: unknown[] = [];
		b.on(MessageType.Hello, (frame) => seen.push(frameJson(frame)));

		await expect(
			a.sendWithAck(MessageType.Hello, { node: "x" }, 500),
		).resolves.toBeUndefined();
		expect(seen).toEqual([{ node: "x" }]);
	});

	test("ping measures a round trip", async () => {
		const { a } = pair();
		const latency = await a.ping(500);
		expect(latency).toBeGreaterThanOrEqual(0);
		expect(a.latencyMs).toBe(latency);
	});

	test("closing rejects everything in flight", async () => {
		const { a, b } = pair();
		b.onRequest(() => new Promise(() => {}));
		const inflight = a.request("hang", null, { timeoutMs: null });
		a.dispose("node went away");
		await expect(inflight).rejects.toThrow(/node went away/);
	});

	test("unhandled message types surface as an error, not a crash", () => {
		const errors: Error[] = [];
		const { a, b } = pair({ onError: (err) => errors.push(err) });
		b.send(0x7e, { odd: true });
		// Delivery is a microtask behind the send.
		return Bun.sleep(5).then(() => {
			expect(errors.some((e) => /unhandled frame/.test(e.message))).toBe(true);
			expect(a.closed).toBe(false);
		});
	});
});
