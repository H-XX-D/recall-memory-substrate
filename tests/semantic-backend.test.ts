import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { after, before, describe, it } from "node:test";
import { admitWriteProposal } from "../src/core/admission.js";
import { embedTextRecord, parseEmbeddingHttpResponse } from "../src/core/semantic.js";
import { SQLiteRecallStore } from "../src/core/store.js";
import { makeProposal, tempDbPath } from "./helpers.js";

// The embedding HTTP call is synchronous (it must run inside synchronous
// store writes), so a same-process mock server would deadlock. Run the mock
// endpoint in a child process instead.
const SERVER_SOURCE = `
const http = require("node:http");
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/openai") {
      res.end(JSON.stringify({ data: [{ embedding: [3, 4] }] }));
    } else if (req.url === "/ollama") {
      res.end(JSON.stringify({ embeddings: [[1, 0, 0]] }));
    } else {
      res.statusCode = 500;
      res.end("{}");
    }
  });
});
server.listen(0, "127.0.0.1", () => {
  process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n");
});
`;

let serverProcess: ChildProcess | null = null;
let serverPort = 0;

function clearEmbeddingEnv(): void {
  delete process.env.RECALL_EMBEDDING_URL;
  delete process.env.RECALL_EMBEDDING_MODEL;
  delete process.env.RECALL_EMBEDDING_API_KEY;
  delete process.env.RECALL_EMBEDDING_COMMAND;
}

describe("semantic embedding backends", () => {
  before(async () => {
    serverProcess = spawn(process.execPath, ["-e", SERVER_SOURCE], { stdio: ["ignore", "pipe", "ignore"] });
    serverPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("mock embedding server did not start")), 5000);
      serverProcess?.stdout?.once("data", (data: Buffer) => {
        clearTimeout(timer);
        resolve((JSON.parse(data.toString()) as { port: number }).port);
      });
    });
  });

  after(() => {
    serverProcess?.kill();
    clearEmbeddingEnv();
  });

  it("uses an OpenAI-compatible HTTP endpoint when configured", () => {
    try {
      process.env.RECALL_EMBEDDING_URL = `http://127.0.0.1:${serverPort}/openai`;
      process.env.RECALL_EMBEDDING_MODEL = "test-embed";

      const record = embedTextRecord("hello agent memory");

      assert.match(record.backend, /^http:/);
      assert.equal(record.dims, 2);
      // [3,4] normalized.
      assert.ok(Math.abs(record.vector[0] - 0.6) < 1e-9);
      assert.ok(Math.abs(record.vector[1] - 0.8) < 1e-9);
    } finally {
      clearEmbeddingEnv();
    }
  });

  it("parses Ollama-native embedding responses", () => {
    try {
      process.env.RECALL_EMBEDDING_URL = `http://127.0.0.1:${serverPort}/ollama`;

      const record = embedTextRecord("hello agent memory");

      assert.match(record.backend, /^http:/);
      assert.deepEqual(record.vector, [1, 0, 0]);
    } finally {
      clearEmbeddingEnv();
    }
  });

  it("falls back to hash embeddings when the endpoint is unreachable", () => {
    try {
      process.env.RECALL_EMBEDDING_URL = "http://127.0.0.1:9/unreachable";

      const record = embedTextRecord("hello agent memory");

      assert.equal(record.backend, "hash:v1");
      assert.equal(record.dims, 256);

      // Second call hits the per-process latch instead of retrying the dead endpoint.
      const second = embedTextRecord("another text");
      assert.equal(second.backend, "hash:v1");
    } finally {
      clearEmbeddingEnv();
    }
  });

  it("falls back to hash embeddings when the embedding command fails", () => {
    try {
      process.env.RECALL_EMBEDDING_COMMAND = "exit 7";

      const record = embedTextRecord("hello agent memory");

      assert.equal(record.backend, "hash:v1");
    } finally {
      clearEmbeddingEnv();
    }
  });

  it("never blocks admission on embedding backend failure", () => {
    const temp = tempDbPath();
    let store: SQLiteRecallStore | null = null;
    try {
      process.env.RECALL_EMBEDDING_URL = "http://127.0.0.1:9/also-unreachable";
      store = new SQLiteRecallStore(temp.path);

      const result = admitWriteProposal(makeProposal(), store);

      assert.equal(result.accepted, true);
    } finally {
      clearEmbeddingEnv();
      store?.close();
      temp.cleanup();
    }
  });

  it("semantic search falls back to hash-indexed rows when the configured backend has no index", () => {
    const temp = tempDbPath();
    let store: SQLiteRecallStore | null = null;
    try {
      // Index under the default hash backend.
      store = new SQLiteRecallStore(temp.path);
      admitWriteProposal(
        makeProposal({
          content: {
            title: "Semantic fallback target",
            body: "Persistent memory across sessions for agents.",
            summary: "Semantic fallback target."
          }
        }),
        store
      );

      // Query under an HTTP backend that has indexed nothing yet.
      process.env.RECALL_EMBEDDING_URL = `http://127.0.0.1:${serverPort}/openai`;
      const hits = store.semanticSearch("persistent memory sessions agents", 5);

      assert.ok(hits.length > 0, "expected hash-backend fallback hits");
      assert.equal(hits[0]?.item.title, "Semantic fallback target");
    } finally {
      clearEmbeddingEnv();
      store?.close();
      temp.cleanup();
    }
  });

  it("rejects malformed embedding payloads", () => {
    assert.equal(parseEmbeddingHttpResponse("not json"), null);
    assert.equal(parseEmbeddingHttpResponse(JSON.stringify({ data: [] })), null);
    assert.equal(parseEmbeddingHttpResponse(JSON.stringify({ data: [{ embedding: ["x"] }] })), null);
    assert.equal(parseEmbeddingHttpResponse(JSON.stringify({ embeddings: [[]] })), null);
    assert.deepEqual(parseEmbeddingHttpResponse(JSON.stringify([1, 2])), [1, 2]);
    assert.deepEqual(parseEmbeddingHttpResponse(JSON.stringify({ embedding: [5] })), [5]);
  });
});
