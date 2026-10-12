import { expect, test } from "bun:test";
import { addKey, normalizeKey, removeKey } from "./sshkeys.ts";

const KEY =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOHqXzlEC6bWc1bgkNHVW5sALhY9siCcgb8Jn6X2CUyk lm@thad";
const OTHER =
	"ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHklXKE4/A4FMluIZpI2yha4FQD8NNVDuTY7eRyivN7r lm@sdn";

test("only a bare key is accepted", () => {
	expect(normalizeKey(KEY)).toBe(KEY);
	expect(normalizeKey(`command="rm -rf /" ${KEY}`)).toBeNull();
	expect(normalizeKey(`${KEY}\n${OTHER}`)).toBeNull();
	expect(normalizeKey("ssh-dss AAAA")).toBeNull();
	expect(normalizeKey(42)).toBeNull();
});

test("adds inside a managed block and leaves hand-written keys alone", () => {
	const { content, changed } = addKey(`${OTHER}\n`, KEY);
	expect(changed).toBe(true);
	expect(content.startsWith(`${OTHER}\n`)).toBe(true);
	expect(content).toContain(KEY);
});

test("adding twice is a no-op, whatever the comment says", () => {
	const once = addKey("", KEY).content;
	const again = addKey(once, KEY.replace("lm@thad", "renamed"));
	expect(again.changed).toBe(false);
	expect(again.content).toBe(once);
});

test("revoke removes only the managed key", () => {
	const withBoth = addKey(`${KEY}\n`, KEY).content; // hand-written copy stays
	const added = addKey(withBoth, OTHER).content;
	const removed = removeKey(added, OTHER);
	expect(removed.changed).toBe(true);
	expect(removed.content).not.toContain("lm@sdn");
	expect(removed.content).toContain(KEY);
	expect(removeKey(`${OTHER}\n`, OTHER).changed).toBe(false);
});
