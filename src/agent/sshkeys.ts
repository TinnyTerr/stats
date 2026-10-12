/**
 * The hub handing a node a public key to put in authorized_keys.
 *
 * Everything the hub controls lives between two marker lines, so a hand-written
 * key is never touched and revoking can't take one away by accident. The hub
 * sends a key and nothing else: no options, no path, no user. A key with
 * `command=` or `from=` in front of it is how an authorized_keys entry stops
 * being "can log in" and becomes "can run this" — so those are refused rather
 * than passed through.
 */

const BEGIN = "# >>> stats-managed keys — do not edit this block";
const END = "# <<< stats-managed keys";

const KEY_TYPES = new Set([
	"ssh-ed25519",
	"sk-ssh-ed25519@openssh.com",
	"ecdsa-sha2-nistp256",
	"ecdsa-sha2-nistp384",
	"ecdsa-sha2-nistp521",
	"sk-ecdsa-sha2-nistp256@openssh.com",
	"ssh-rsa",
]);

/** `type base64 [comment]` on one line, or null if it is anything else. */
export function normalizeKey(input: unknown): string | null {
	if (typeof input !== "string") return null;
	const line = input.trim();
	if (!line || /[\r\n]/.test(line) || line.length > 4096) return null;
	const [type, body, ...rest] = line.split(/\s+/);
	if (!type || !body || !KEY_TYPES.has(type)) return null;
	if (!/^[A-Za-z0-9+/]+={0,3}$/.test(body)) return null;
	return [type, body, ...rest].join(" ");
}

/** The `type body` pair, which is what identifies a key whatever its comment. */
function identity(line: string): string {
	return line.split(/\s+/).slice(0, 2).join(" ");
}

function managed(content: string): {
	before: string;
	keys: string[];
	after: string;
} {
	const lines = content.split("\n");
	const start = lines.indexOf(BEGIN);
	const end = start === -1 ? -1 : lines.indexOf(END, start);
	if (start === -1 || end === -1) {
		return { before: content.replace(/\n+$/, ""), keys: [], after: "" };
	}
	return {
		before: lines.slice(0, start).join("\n").replace(/\n+$/, ""),
		keys: lines.slice(start + 1, end).filter((l) => l.trim()),
		after: lines
			.slice(end + 1)
			.join("\n")
			.replace(/^\n+/, ""),
	};
}

function render(before: string, keys: string[], after: string): string {
	const parts: string[] = [];
	if (before) parts.push(before);
	if (keys.length) parts.push([BEGIN, ...keys, END].join("\n"));
	if (after) parts.push(after.replace(/\n+$/, ""));
	return parts.length ? `${parts.join("\n\n")}\n` : "";
}

/** `changed` is false when the key was already there. */
export function addKey(
	content: string,
	key: string,
): { content: string; changed: boolean } {
	const { before, keys, after } = managed(content);
	if (keys.some((k) => identity(k) === identity(key))) {
		return { content, changed: false };
	}
	return { content: render(before, [...keys, key], after), changed: true };
}

/** Only ever removes from the managed block. */
export function removeKey(
	content: string,
	key: string,
): { content: string; changed: boolean } {
	const { before, keys, after } = managed(content);
	const kept = keys.filter((k) => identity(k) !== identity(key));
	if (kept.length === keys.length) return { content, changed: false };
	return { content: render(before, kept, after), changed: true };
}
