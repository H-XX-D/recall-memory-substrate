import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import {
  AGENTS_BEGIN,
  AGENTS_END,
  codexIntegrationStatus,
  mergeAgentsMd,
  recallAgentsBlock,
  syncCodexIntegration,
  upsertCodexMcpServer,
} from "../src/core/codex-integration.js";

describe("mergeAgentsMd", () => {
  it("injects the Recall directive into an empty AGENTS.md", () => {
    const { next, changed } = mergeAgentsMd("");
    assert.equal(changed, true);
    assert.match(next, /recall:begin/);
    assert.match(next, /Corrections supersede/);
  });

  it("is idempotent — a second merge reports no changes", () => {
    const first = mergeAgentsMd("");
    const second = mergeAgentsMd(first.next);
    assert.equal(second.changed, false);
    assert.equal(second.next, first.next);
  });

  it("replaces a stale Recall block instead of appending a duplicate", () => {
    const stale = `# My agents\n\n${AGENTS_BEGIN}\nold recall directive\n<!-- recall:end -->\n`;
    const { next } = mergeAgentsMd(stale);
    const occurrences = next.split(AGENTS_BEGIN).length - 1;
    assert.equal(occurrences, 1, "exactly one Recall block");
    assert.doesNotMatch(next, /old recall directive/);
    assert.match(next, /# My agents/);
  });

  it("preserves unrelated AGENTS.md content", () => {
    const existing = "# Project rules\n\n- Always run tests.\n";
    const { next } = mergeAgentsMd(existing);
    assert.match(next, /# Project rules/);
    assert.match(next, /Always run tests\./);
    assert.match(next, /recall:begin/);
  });

  it("heals TWO duplicate Recall marker blocks down to one (and is then idempotent)", () => {
    const two = `# T\n\n${AGENTS_BEGIN}\nold a\n${AGENTS_END}\n\nmid\n\n${AGENTS_BEGIN}\nold b\n${AGENTS_END}\n`;
    const { next } = mergeAgentsMd(two);
    assert.equal(next.split(AGENTS_BEGIN).length - 1, 1, "exactly one block after heal");
    assert.doesNotMatch(next, /old a|old b/);
    assert.match(next, /# T/);
    assert.match(next, /mid/);
    assert.equal(mergeAgentsMd(next).changed, false, "idempotent after heal");
  });

  it("removes a dangling begin marker with no end", () => {
    const dangling = `# T\n\n${AGENTS_BEGIN}\nhalf written, no end marker`;
    const { next } = mergeAgentsMd(dangling);
    assert.equal(next.split(AGENTS_BEGIN).length - 1, 1);
    assert.doesNotMatch(next, /half written/);
    assert.equal(mergeAgentsMd(next).changed, false);
  });
});

describe("recallAgentsBlock", () => {
  it("is delimited by both markers and teaches read-first + supersede", () => {
    const b = recallAgentsBlock();
    assert.match(b, /recall:begin/);
    assert.match(b, /recall:end/);
    assert.match(b, /Read first/);
    assert.match(b, /evidence\.contradicts/);
  });
});

describe("upsertCodexMcpServer", () => {
  it("adds the recall server to empty config and is idempotent", () => {
    const first = upsertCodexMcpServer("", { mcpCommand: "recall-mcp" });
    assert.equal(first.changed, true);
    assert.match(first.next, /\[mcp_servers\.recall\]/);
    assert.match(first.next, /command = "recall-mcp"/);
    const second = upsertCodexMcpServer(first.next, { mcpCommand: "recall-mcp" });
    assert.equal(second.changed, false);
    assert.equal(second.next.match(/\[mcp_servers\.recall\]/g)?.length, 1);
  });

  it("preserves other config and other mcp servers", () => {
    const existing = `model = "gpt-5.5"\n\n[mcp_servers.other]\ncommand = "x"\n`;
    const { next } = upsertCodexMcpServer(existing, { mcpCommand: "recall-mcp" });
    assert.match(next, /model = "gpt-5.5"/);
    assert.match(next, /\[mcp_servers\.other\]/);
    assert.match(next, /\[mcp_servers\.recall\]/);
  });

  it("replaces a stale recall block (incl. its env table) without duplicating", () => {
    const stale = `[mcp_servers.recall]\ncommand = "old"\n\n[mcp_servers.recall.env]\nRECALL_DB = "/old"\n\n[mcp_servers.keep]\ncommand = "k"\n`;
    const { next } = upsertCodexMcpServer(stale, { mcpCommand: "recall-mcp" });
    assert.equal(next.match(/\[mcp_servers\.recall\]/g)?.length, 1);
    assert.doesNotMatch(next, /command = "old"/);
    assert.doesNotMatch(next, /RECALL_DB = "\/old"/);
    assert.match(next, /\[mcp_servers\.keep\]/);
  });

  it("includes a RECALL_DB env table when recallDb is provided", () => {
    const { next } = upsertCodexMcpServer("", { mcpCommand: "recall-mcp", recallDb: "/tmp/x.sqlite3" });
    assert.match(next, /\[mcp_servers\.recall\.env\]/);
    assert.match(next, /RECALL_DB = "\/tmp\/x\.sqlite3"/);
  });

  it("strips NON-CANONICAL spellings of the recall server (no duplicate definition, idempotent)", () => {
    // each is a legal TOML spelling of the SAME server that the line-based stripper must catch,
    // or it would emit a second mcp_servers.recall and corrupt config.toml (TOML parse error).
    const cases = [
      'mcp_servers.recall = { command = "old" }\n',                                   // inline table
      'mcp_servers.recall.command = "old"\nmcp_servers.recall.env.RECALL_DB = "/old"\n', // dotted keys
      '[mcp_servers."recall"]\ncommand = "old"\n',                                     // quoted header segment
      '[mcp_servers.recall] # legacy comment\ncommand = "old"\n',                      // header w/ trailing comment
    ];
    for (const input of cases) {
      const { next } = upsertCodexMcpServer(`model = "x"\n\n${input}`, { mcpCommand: "recall-mcp" });
      assert.equal(next.match(/\[mcp_servers\.recall\]/g)?.length, 1, `exactly one recall table for: ${input}`);
      assert.doesNotMatch(next, /"old"|"\/old"/, `old recall value removed for: ${input}`);
      assert.match(next, /model = "x"/, `unrelated config preserved for: ${input}`);
      assert.equal(upsertCodexMcpServer(next, { mcpCommand: "recall-mcp" }).changed, false, `idempotent for: ${input}`);
    }
  });
});

describe("syncCodexIntegration (filesystem round-trip)", () => {
  const assetsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "integrations", "codex");
  const sharedSkillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "integrations", "claude", "skill");

  it("installs skill + mcp + AGENTS.md directive, then re-runs idempotently", () => {
    if (!existsSync(join(assetsRoot, "skill", "SKILL.md"))) return; // bundled assets only in a built checkout
    const codexHome = mkdtempSync(join(tmpdir(), "recall-codex-"));
    try {
      const configPath = join(codexHome, "config.toml");
      const agentsPath = join(codexHome, "AGENTS.md");
      const opts = { codexHome, configPath, agentsPath, assetsRoot, sharedSkillRoot };

      const r1 = syncCodexIntegration(opts);
      assert.ok(existsSync(join(r1.skillDir, "SKILL.md")));
      assert.ok(existsSync(configPath));
      assert.ok(existsSync(agentsPath));

      const status = codexIntegrationStatus(opts);
      assert.deepEqual(
        { skill: status.skillInstalled, mcp: status.mcpRegistered, agents: status.agentsDirectiveInstalled },
        { skill: true, mcp: true, agents: true },
      );
      assert.match(readFileSync(configPath, "utf8"), /\[mcp_servers\.recall\]/);
      assert.match(readFileSync(agentsPath, "utf8"), /recall:begin/);

      // second run: already canonical -> no backups created
      const r2 = syncCodexIntegration(opts);
      assert.equal(r2.configBackup, null, "idempotent re-run leaves config unchanged");
      assert.equal(r2.agentsBackup, null, "idempotent re-run leaves AGENTS.md unchanged");
    } finally {
      rmSync(codexHome, { recursive: true, force: true });
    }
  });
});
