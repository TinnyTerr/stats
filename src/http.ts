/** Small HTTP helpers shared by the agent and the hub. */

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export function unauthorized(): Response {
  return json({ error: "unauthorized" }, 401, { "www-authenticate": "Bearer" });
}

/**
 * Constant-time-ish bearer check. When `expected` is null the endpoint is open,
 * which is the default for a single-user setup on a trusted network.
 */
export function requireToken(req: Request, expected: string | null): boolean {
  if (!expected) return true;

  const header = req.headers.get("authorization");
  const url = new URL(req.url);
  // Query fallback exists because EventSource cannot set headers.
  const provided = header?.startsWith("Bearer ")
    ? header.slice(7)
    : (url.searchParams.get("token") ?? "");

  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export interface SseEvent {
  event: string;
  data: unknown;
}

function encodeSse(event: SseEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * Wraps an async generator of events in a text/event-stream Response.
 * A comment heartbeat keeps proxies from closing an idle stream.
 */
export function sseResponse(
  producer: (signal: AbortSignal) => AsyncGenerator<SseEvent>,
  clientSignal?: AbortSignal,
): Response {
  const controller = new AbortController();
  clientSignal?.addEventListener("abort", () => controller.abort(), { once: true });

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(ctrl) {
      const heartbeat = setInterval(() => {
        try {
          ctrl.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15_000);

      try {
        for await (const event of producer(controller.signal)) {
          if (controller.signal.aborted) break;
          ctrl.enqueue(encoder.encode(encodeSse(event)));
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          ctrl.enqueue(
            encoder.encode(
              encodeSse({
                event: "error",
                data: { message: err instanceof Error ? err.message : String(err) },
              }),
            ),
          );
        }
      } finally {
        clearInterval(heartbeat);
        try {
          ctrl.close();
        } catch {
          // already closed by the client disconnecting
        }
      }
    },
    cancel() {
      controller.abort();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
