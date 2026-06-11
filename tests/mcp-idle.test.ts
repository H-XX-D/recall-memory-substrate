import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createIdleExit } from "../src/mcp/idle.js";
import { tempDbPath } from "./helpers.js";

describe("mcp idle exit", () => {
  it("fires onIdle exactly once after the timeout elapses without activity", () => {
    let t = 1000;
    let fired = 0;
    const idle = createIdleExit({ timeoutMs: 500, onIdle: () => { fired += 1; }, now: () => t });
    idle.touch();

    t += 499;
    idle.tick();
    assert.equal(fired, 0);

    t += 2;
    idle.tick();
    assert.equal(fired, 1);

    t += 1000;
    idle.tick();
    assert.equal(fired, 1, "onIdle must not fire again after shutdown");
  });

  it("activity resets the idle clock", () => {
    let t = 0;
    let fired = 0;
    const idle = createIdleExit({ timeoutMs: 500, onIdle: () => { fired += 1; }, now: () => t });
    idle.touch();

    t += 400;
    idle.touch();
    t += 400;
    idle.tick();
    assert.equal(fired, 0, "recent activity must hold off the idle exit");

    t += 101;
    idle.tick();
    assert.equal(fired, 1);
  });

  it("timeoutMs of zero disables idle exit entirely", () => {
    let t = 0;
    let fired = 0;
    const idle = createIdleExit({ timeoutMs: 0, onIdle: () => { fired += 1; }, now: () => t });
    assert.equal(idle.enabled, false);
    idle.touch();
    t += 1_000_000_000;
    idle.tick();
    assert.equal(fired, 0);
  });

  it("stdio server exits on its own when abandoned with stdin held open", async () => {
    // The leak scenario: a client spawns the server, never closes stdin, never
    // sends another request. The server must reap itself.
    const temp = tempDbPath();
    const cliPath = join(process.cwd(), "dist", "src", "mcp", "cli.js");
    const child = spawn(process.execPath, [cliPath], {
      env: {
        ...process.env,
        RECALL_DB: temp.path,
        RECALL_MCP_IDLE_EXIT_MS: "200",
        RECALL_MCP_IDLE_CHECK_MS: "50"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`);

    const code = await new Promise<number | null>((resolvePromise, rejectPromise) => {
      const guard = setTimeout(() => rejectPromise(new Error("server did not idle-exit within 5s")), 5000);
      child.on("exit", (exitCode) => { clearTimeout(guard); resolvePromise(exitCode); });
      child.on("error", (error) => { clearTimeout(guard); rejectPromise(error); });
    });

    try {
      assert.equal(code, 0, "idle exit must be a clean shutdown");
      assert.ok(stdout.includes('"serverInfo"'), "server must have answered initialize before idling out");
    } finally {
      temp.cleanup();
    }
  });
});
