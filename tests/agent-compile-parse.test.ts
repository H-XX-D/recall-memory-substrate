import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCompilePacket } from "../src/agent/compile-parse.js";

const GRAPH_PREFIXED = `relevant_memory:
- Cache TTL is sixty seconds [decision:home:1750a919-7592-4791-b144-d0f2280fd7c7]
- Fresh thing here [observation:home:99887766-0000-1111-2222-333344445555]

conflicts:
Cache changed contradicts Cache TTL; severity=0.9 [contradicts:home:abcd0000-1111-2222-3333-444455556666->home:1750a919-7592-4791-b144-d0f2280fd7c7]

stale_or_low_trust:
- none
`;

const BARE_STALE = `relevant_memory:
- Cache TTL is sixty seconds [decision:1750a919-7592-4791-b144-d0f2280fd7c7]

conflicts:
- none

stale_or_low_trust:
- Cache TTL note is stale; severity=0.5 [stale:1750a919-7592-4791-b144-d0f2280fd7c7]
`;

const NO_FLAG = `relevant_memory:
- Fresh thing here [observation:home:99887766-0000-1111-2222-333344445555]

conflicts:
- none

stale_or_low_trust:
- none
`;

describe("compile packet parse", () => {
  it("flags a graph-prefixed superseded id (home/union scope)", () => {
    const r = parseCompilePacket(GRAPH_PREFIXED);
    assert.deepEqual(r.flaggedIds, ["1750a919"]);
    assert.match(r.push, /\[Recall mini-index/);
    assert.match(r.push, /SUPERSEDED\?/);
    assert.match(r.push, /DIG REQUIRED/);
  });

  it("flags a bare stale id (project scope)", () => {
    const r = parseCompilePacket(BARE_STALE);
    assert.deepEqual(r.flaggedIds, ["1750a919"]);
    assert.match(r.push, /STALE/);
    assert.match(r.push, /DIG REQUIRED/);
  });

  it("builds a push with no flags when nothing is challenged or stale", () => {
    const r = parseCompilePacket(NO_FLAG);
    assert.deepEqual(r.flaggedIds, []);
    assert.match(r.push, /\[Recall mini-index/);
    assert.doesNotMatch(r.push, /DIG REQUIRED/);
  });

  it("returns an empty push when there is no relevant memory", () => {
    const r = parseCompilePacket("relevant_memory:\n- none\n");
    assert.deepEqual(r.flaggedIds, []);
    assert.equal(r.push, "");
  });
});
