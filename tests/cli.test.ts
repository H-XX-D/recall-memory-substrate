import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { makeProposal, tempDbPath, writeJsonFixture } from "./helpers.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = ["--disable-warning=ExperimentalWarning", "dist/src/cli.js"];

describe("cli", () => {
  it("initializes, admits, reports status, and compiles context", () => {
    const temp = tempDbPath();
    const json = writeJsonFixture(makeProposal());
    const archiveHolder: { cleanup?: () => void } = {};
    try {
      const init = execFileSync(process.execPath, [...CLI, "init", "--db", temp.path], {
        encoding: "utf8"
      });
      assert.match(init, /initialized/);

      const admit = execFileSync(
        process.execPath,
        [...CLI, "admit", "--json", json.path, "--db", temp.path],
        { encoding: "utf8" }
      );
      assert.match(admit, /"accepted": true/);

      const status = execFileSync(process.execPath, [...CLI, "status", "--db", temp.path], {
        encoding: "utf8"
      });
      assert.match(status, /"nodes": 1/);

      const compiled = execFileSync(
        process.execPath,
        [...CLI, "compile", "Recall schema memory", "--db", temp.path, "--words", "120"],
        { encoding: "utf8" }
      );
      assert.match(compiled, /expansion_handles:/);
    } finally {
      json.cleanup();
      temp.cleanup();
    }
  });

  it("admit fails with a clean non-zero exit on a missing, empty, or invalid --json file", () => {
    const temp = tempDbPath();
    const dir = mkdtempSync(join(tmpdir(), "recall-badjson-"));
    const emptyFile = join(dir, "empty.json");
    const invalidFile = join(dir, "invalid.json");
    writeFileSync(emptyFile, "");
    writeFileSync(invalidFile, "{ not valid json ");
    try {
      for (const bad of ["/no/such/recall-proposal.json", emptyFile, invalidFile]) {
        let threw = false;
        try {
          execFileSync(process.execPath, [...CLI, "admit", "--json", bad, "--db", temp.path], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"]
          });
        } catch (err) {
          threw = true;
          const e = err as { status?: number; stderr?: string };
          assert.notEqual(e.status, 0, `admit --json ${bad} should exit non-zero`);
          // a clean one-line error, never a raw Node stacktrace
          assert.doesNotMatch(
            String(e.stderr ?? ""),
            /at Object\.|at Module\.|node:internal/,
            `admit --json ${bad} leaked a stacktrace`
          );
        }
        assert.ok(threw, `admit --json ${bad} should fail`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      temp.cleanup();
    }
  });

  it("exports and imports a portable graph archive", () => {
    const source = tempDbPath();
    const target = tempDbPath();
    const json = writeJsonFixture(
      makeProposal({
        content: {
          title: "Portable archive witness",
          body: "Export/import preserves the user-facing graph archive.",
          summary: "Archive round trip."
        }
      })
    );
    const archiveHolder: { cleanup?: () => void } = {};
    try {
      execFileSync(process.execPath, [...CLI, "admit", "--json", json.path, "--db", source.path], {
        encoding: "utf8"
      });

      const exported = execFileSync(process.execPath, [...CLI, "export", "--db", source.path], {
        encoding: "utf8"
      });
      assert.match(exported, /"schemaVersion": "recall.export.v1"/);
      const archive = writeJsonFixture(JSON.parse(exported));
      archiveHolder.cleanup = archive.cleanup;

      const imported = execFileSync(process.execPath, [...CLI, "import", "--json", archive.path, "--db", target.path], {
        encoding: "utf8"
      });
      assert.match(imported, /"graph_nodes": 1/);

      const search = execFileSync(process.execPath, [...CLI, "search", "Portable archive", "--db", target.path], {
        encoding: "utf8"
      });
      assert.match(search, /Portable archive witness/);

      let refused = false;
      try {
        execFileSync(process.execPath, [...CLI, "import", "--json", archive.path, "--db", target.path], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        refused = true;
        assert.match(String((error as { stderr?: Buffer }).stderr), /Refusing to import into a non-empty Recall database/);
      }
      assert.equal(refused, true);
    } finally {
      archiveHolder.cleanup?.();
      json.cleanup();
      source.cleanup();
      target.cleanup();
    }
  });

  it("saves and reads secrets only through explicit secrets commands", () => {
    const temp = tempDbPath();
    try {
      const saved = execFileSync(
        process.execPath,
        [
          ...CLI,
          "secrets",
          "save",
          "--title",
          "Local token placeholder",
          "--tags",
          "local,test",
          "--scope",
          "cli-test",
          "--confirm-secret-save",
          "--password-stdin",
          "--value-stdin",
          "--secrets-db",
          temp.path
        ],
        { encoding: "utf8", input: "test-password\nnot-a-real-secret-value" }
      );
      assert.match(saved, /"saved": true/);
      const parsed = JSON.parse(saved) as { secret: { id: string } };

      const listed = execFileSync(process.execPath, [...CLI, "secrets", "list", "--secrets-db", temp.path], {
        encoding: "utf8"
      });
      assert.match(listed, /Local token placeholder/);
      assert.doesNotMatch(listed, /not-a-real-secret-value/);

      const got = execFileSync(
        process.execPath,
        [...CLI, "secrets", "get", parsed.secret.id, "--password-stdin", "--secrets-db", temp.path],
        { encoding: "utf8", input: "test-password\n" }
      );
      assert.match(got, /not-a-real-secret-value/);
    } finally {
      temp.cleanup();
    }
  });

  it("runs semantic, subgraph, and daemon commands", () => {
    const temp = tempDbPath();
    const json = writeJsonFixture(
      makeProposal({
        tags: {
          category: ["memory"],
          type: ["witness"],
          subject: ["compiler"],
          project: ["Recall"],
          idea: ["context-packet"],
          timestamp: ["2026-05-21"],
          topics: ["compiler", "memory"],
          entities: ["Recall"],
          identities: ["agent:codex", "project:recall"],
          rings: ["runtime"],
          lifecycle: ["active"],
          quality: ["source-grounded"]
        }
      })
    );
    try {
      execFileSync(process.execPath, [...CLI, "admit", "--json", json.path, "--db", temp.path], {
        encoding: "utf8"
      });

      const semantic = execFileSync(process.execPath, [...CLI, "semantic", "structured memory", "--db", temp.path], {
        encoding: "utf8"
      });
      assert.match(semantic, /Recall schema initialized/);

      const subgraph = execFileSync(
        process.execPath,
        [
          ...CLI,
          "subgraph",
          "--category",
          "memory",
          "--type",
          "witness",
          "--subject",
          "compiler",
          "--project",
          "Recall",
          "--idea",
          "context-packet",
          "--timestamp",
          "2026-05-21",
          "--topic",
          "compiler",
          "--identity",
          "agent:codex",
          "--ring",
          "runtime",
          "--db",
          temp.path
        ],
        { encoding: "utf8" }
      );
      assert.match(subgraph, /context-packet/);

      const daemon = execFileSync(process.execPath, [...CLI, "daemon", "run-once", "--db", temp.path], {
        encoding: "utf8"
      });
      assert.match(daemon, /Daemon maintenance pass/);

      const daemonDerived = execFileSync(process.execPath, [...CLI, "daemon", "run-once", "--derive", "--db", temp.path], {
        encoding: "utf8"
      });
      assert.match(daemonDerived, /"evalClosure"/);
      assert.match(daemonDerived, /"accepted": true/);

      const evalDerived = execFileSync(process.execPath, [...CLI, "eval", "run", "--derive", "--db", temp.path], {
        encoding: "utf8"
      });
      assert.match(evalDerived, /"derived"/);
      assert.match(evalDerived, /Eval run: recall-default/);

      const evalList = execFileSync(process.execPath, [...CLI, "eval", "list", "--db", temp.path], {
        encoding: "utf8"
      });
      assert.match(evalList, /recall-default/);
    } finally {
      json.cleanup();
      temp.cleanup();
    }
  });
});
