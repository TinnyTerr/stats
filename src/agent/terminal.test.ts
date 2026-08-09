import { afterEach, expect, test } from "bun:test";
import { TerminalManager } from "./terminal.ts";

/**
 * The cwd, mostly. Bun reports a missing working directory as an ENOENT naming
 * the *shell* — so a node whose $HOME was never created looks exactly like a
 * host with no /bin/bash, on every terminal, forever.
 */

const terminals = new TerminalManager(true);
const home = process.env.HOME;

afterEach(() => {
	terminals.closeAll();
	process.env.HOME = home;
});

const open = (cwd?: string) =>
	terminals.open({
		cols: 80,
		rows: 24,
		cwd,
		onData: () => {},
		onExit: () => {},
	});

test("a $HOME that does not exist still gets you a shell", async () => {
	process.env.HOME = "/home/nobody-made-this";
	const session = await open();
	expect(session.pid).toBeGreaterThan(0);
	expect(session.shell).toMatch(/^\/bin\//);
});

test("a requested directory that is missing says so, and doesn't blame the shell", async () => {
	expect(open("/no/such/project")).rejects.toThrow(
		"no such directory: /no/such/project",
	);
});

test("a requested directory that exists is honoured", async () => {
	const session = await open("/tmp");
	expect(session.pid).toBeGreaterThan(0);
});
