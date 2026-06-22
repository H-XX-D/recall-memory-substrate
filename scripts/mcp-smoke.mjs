import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "recall-mcp-smoke-"));
const db = join(tempDir, "recall.sqlite3");
const child = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "dist/src/mcp/cli.js"], {
  env: {
    ...process.env,
    RECALL_DB: db,
    RECALL_MCP_IDLE_EXIT_MS: "0"
  },
  stdio: ["pipe", "pipe", "pipe"]
});

const responses = [];
let stdout = "";
let stderr = "";
let settled = false;

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  let newline = stdout.indexOf("\n");
  while (newline >= 0) {
    const line = stdout.slice(0, newline).trim();
    stdout = stdout.slice(newline + 1);
    if (line) {
      responses.push(JSON.parse(line));
    }
    newline = stdout.indexOf("\n");
  }
  maybeFinish();
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

child.on("error", fail);
child.on("exit", (code) => {
  if (!settled && code !== 0) {
    fail(new Error(`recall-mcp exited with ${code}: ${stderr}`));
  }
});

child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);

setTimeout(() => fail(new Error(`Timed out waiting for recall-mcp responses. stderr=${stderr}`)), 5000).unref();

function maybeFinish() {
  if (responses.length < 2 || settled) {
    return;
  }
  const init = responses.find((response) => response.id === 1);
  const list = responses.find((response) => response.id === 2);
  if (!init?.result?.serverInfo?.version) {
    fail(new Error(`initialize did not include server version: ${JSON.stringify(init)}`));
  }
  const tools = list?.result?.tools;
  if (!Array.isArray(tools) || tools.length !== 45) {
    fail(new Error(`tools/list returned ${Array.isArray(tools) ? tools.length : "no"} tools`));
  }
  settled = true;
  child.stdin.end();
  child.kill();
  rmSync(tempDir, { recursive: true, force: true });
  console.log(`Recall MCP smoke passed (${tools.length} tools, version ${init.result.serverInfo.version}).`);
}

function fail(error) {
  if (settled) {
    return;
  }
  settled = true;
  child.kill();
  rmSync(tempDir, { recursive: true, force: true });
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
