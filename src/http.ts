/**
 * The little HTTP that's left. Almost everything now travels over the binary
 * protocol on a WebSocket; this covers the health check, the JSON mirror of the
 * node list, and the bearer check both share.
 */

export function json(
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
): Response {
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
	// Query fallback exists because a browser WebSocket cannot set headers.
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
