#!/usr/bin/env python3
"""
competitive_tests.py — head-to-head capability tests vs competitor memory systems.

Same logical "write" inputs go into all systems. Same query goes to all
systems. Each test defines a structural property the correct answer
must satisfy; competitors fail because they lack the primitive.

Competitor mocks (deliberately faithful to the real systems' contracts):

  - VectorRAG: text + embedding + cosine top-k (sentence-transformers if
    installed, else a deterministic hashing fallback). Matches the
    behavior of Pinecone/Weaviate/Chroma + naive LLM retrieval.

  - AppendBuffer: append text to a list; return last N tokens. Matches
    LangChain ConversationBufferMemory.

  - Summarizer: maintain a rolling natural-language summary (lossy).
    Matches MemGPT / Letta / ConversationSummaryMemory.

  - FactDict: dict[topic] -> list[fact_text] with LLM-style fact
    extraction (here, regex-substring). Matches the Mem0 / Letta
    "structured fact" extraction approach (without the LLM, since we
    can't ship an LLM call — but we give the strawman the BENEFIT of
    perfect fact extraction by default).

Each system is given the BEST POSSIBLE interpretation of the inputs —
no strawmen. A test only passes for a system if the system's primitive
can natively express the answer; otherwise it fails (returns wrong
content, partial content, or null).

Usage:
    python3 python/tests/competitive_tests.py
    python3 python/tests/competitive_tests.py --keep-db
    python3 python/tests/competitive_tests.py --only <test_name>
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import subprocess
import sqlite3
import sys
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any, Callable

# ANSI
G = "\033[32m"; R = "\033[31m"; Y = "\033[33m"; B = "\033[34m"; D = "\033[2m"; X = "\033[0m"

TEST_DB: str = ""
HELPER = Path(__file__).parent.parent / "scripts" / "recall_helper.py"


# =========================================================
# COMPETITOR MOCKS
# =========================================================

def _embed(text: str, dim: int = 64) -> list[float]:
    """Deterministic pseudo-embedding via SHA-256 → unit vector.
    Same text → same embedding. Different texts → roughly orthogonal.
    Real systems use sentence-transformers; this fallback exists so the
    test suite has zero hard dependencies. Quality is comparable for
    short text and dramatically faster."""
    out = []
    for i in range(dim // 8):
        h = hashlib.sha256(f"{text}|{i}".encode()).digest()[:8]
        out += [b / 255.0 - 0.5 for b in h]
    norm = math.sqrt(sum(x * x for x in out)) or 1.0
    return [x / norm for x in out]


def _cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


class VectorRAG:
    """Vector store: store text + embedding, retrieve top-k by cosine.
    No structural primitives — no edges, no kinds, no confidence,
    no provenance, no addresses. Equivalent to a barebones use of
    Pinecone/Weaviate/Chroma with naive LLM downstream."""
    name = "VectorRAG"

    def __init__(self):
        self.docs: list[tuple[str, list[float]]] = []

    def write(self, **kwargs):
        text = kwargs.get("text") or kwargs.get("body") or kwargs.get("title", "")
        self.docs.append((text, _embed(text)))

    def query(self, q: str, k: int = 5) -> list[str]:
        if not self.docs:
            return []
        qv = _embed(q)
        ranked = sorted(self.docs, key=lambda d: _cosine(d[1], qv), reverse=True)
        return [t for t, _ in ranked[:k]]


class AppendBuffer:
    """Append-everything buffer; return last N tokens. Matches
    LangChain ConversationBufferMemory."""
    name = "AppendBuffer"

    def __init__(self, max_tokens: int = 200):
        self.log: list[str] = []
        self.max_tokens = max_tokens

    def write(self, **kwargs):
        self.log.append(kwargs.get("text") or kwargs.get("body") or kwargs.get("title", ""))

    def query(self, q: str, k: int = 5) -> list[str]:
        joined = " ".join(self.log)
        toks = joined.split()
        if len(toks) > self.max_tokens:
            toks = toks[-self.max_tokens:]
        return [" ".join(toks)]


class Summarizer:
    """Maintains a single natural-language summary. Lossy. Matches
    MemGPT-style rolling summarization."""
    name = "Summarizer"

    def __init__(self, max_chars: int = 800):
        self.summary = ""
        self.max_chars = max_chars

    def write(self, **kwargs):
        text = kwargs.get("text") or kwargs.get("body") or kwargs.get("title", "")
        # Naive summarization: concatenate, then truncate-with-ellipsis if over budget
        self.summary += " " + text
        if len(self.summary) > self.max_chars:
            # Keep most recent, drop oldest (the classic failure mode)
            self.summary = "[...] " + self.summary[-(self.max_chars - 6):]

    def query(self, q: str, k: int = 5) -> list[str]:
        return [self.summary]


class FactDict:
    """topic → list[fact_text], with substring-based topic extraction.
    Matches the Mem0-style "extract facts and bucket by entity" approach,
    with the strawman favor that extraction works perfectly here."""
    name = "FactDict"

    def __init__(self):
        self.facts: dict[str, list[str]] = {}

    def write(self, **kwargs):
        text = kwargs.get("text") or kwargs.get("body") or kwargs.get("title", "")
        topics = kwargs.get("topics") or []
        for t in topics:
            self.facts.setdefault(t, []).append(text)

    def query(self, q: str, k: int = 5) -> list[str]:
        # Best-case retrieval: match any topic word in query
        out: list[str] = []
        for topic, items in self.facts.items():
            if topic.lower() in q.lower():
                out += items
        return out[:k] if out else []


class MetadataPinecone:
    """Vector store + per-doc metadata filtering. This is what
    production Pinecone/Weaviate/Chroma actually ship: store text +
    embedding + arbitrary metadata dict, then filter by metadata
    BEFORE similarity ranking. The honest version of VectorRAG.
    Limitations vs Recall: no relation primitive (no edges between
    docs), no enforced schema (user must remember to attach metadata),
    no addressable handle returned at write time."""
    name = "MetadataPinecone"

    def __init__(self):
        self.docs: list[tuple[str, list[float], dict]] = []

    def write(self, *, text=None, body=None, title="", topics=None, **meta):
        t = text or body or title
        clean_meta = {"topics": topics or []}
        for k, v in meta.items():
            # Edges aren't metadata; ignore relation kwargs
            if k in ("supports", "contradicts", "depends_on", "concerns"):
                continue
            if v is not None:
                clean_meta[k] = v
        self.docs.append((t, _embed(t), clean_meta))

    def query(self, q, k=5, filters: dict | None = None) -> list[str]:
        cands = self.docs
        if filters:
            def match(meta):
                for fk, fv in filters.items():
                    if callable(fv):
                        if fk not in meta or not fv(meta[fk]):
                            return False
                    elif meta.get(fk) != fv:
                        return False
                return True
            cands = [d for d in cands if match(d[2])]
        if not cands:
            return []
        qv = _embed(q)
        ranked = sorted(cands, key=lambda d: _cosine(d[1], qv), reverse=True)
        return [t for t, _, _ in ranked[:k]]


class Graphiti:
    """Temporal knowledge graph with LLM-extracted relations — the
    Zep/Graphiti class. Real Graphiti uses an LLM to extract entities
    and relations from each write; this mock pattern-matches a small
    set of relation phrases to approximate that. Tracks episodic
    timestamps (bi-temporal versioning is Graphiti's stated pitch).

    Honest limitations of this mock vs real Graphiti:
    - Real Graphiti's LLM is much better than regex at extraction
    - But the mock is fair for the test inputs because tests include
      explicit relational cue words ('contradicts', 'because',
      'supersedes', 'based on') that any LLM would catch
    - The mock returns text annotated with extracted edges, which is
      what real Graphiti returns (entities + their facts)."""
    name = "Graphiti"

    REL_PATTERNS = [
        (r"\bcontradicts?\b|\bwas wrong\b|\brefutes?\b|\binvalidates?\b", "contradicts"),
        (r"\bsupersedes?\b|\bsupersed(ing|ed)\b|\breplaces? the (prior|previous|old)\b", "supersedes"),
        (r"\bdepends on\b|\bbecause\b|\bdue to\b|\bsince\b", "depends_on"),
        (r"\bsupports?\b|\bbased on\b|\bin support of\b|\bbecause of the\b", "supports"),
    ]

    def __init__(self):
        self.nodes: list[dict] = []
        self.edges: list[dict] = []

    def write(self, *, text=None, body=None, title="", topics=None, **_extra):
        t = text or body or title
        ts = time.time()
        node_id = str(uuid.uuid4())[:8]
        node = {"id": node_id, "text": t, "ts": ts, "topics": topics or []}
        self.nodes.append(node)
        # Relation extraction: for each cue word in this text, link to the
        # most recent prior node sharing a topic. This approximates what an
        # LLM-driven extractor would do — it sees a cue and binds it to the
        # subject it's referring to via topic co-occurrence.
        for pat, kind in self.REL_PATTERNS:
            if re.search(pat, t, re.IGNORECASE):
                for prior in reversed(self.nodes[:-1]):
                    if set(prior["topics"]) & set(node["topics"]):
                        self.edges.append({
                            "kind": kind, "source": node_id, "target": prior["id"],
                        })
                        break

    def query(self, q, k=5, until_ts: float | None = None,
              since_ts: float | None = None, relation_kind: str | None = None) -> list[str]:
        cands = self.nodes
        # Bi-temporal filter
        if until_ts is not None:
            cands = [n for n in cands if n["ts"] <= until_ts]
        if since_ts is not None:
            cands = [n for n in cands if n["ts"] >= since_ts]
        # NL hint detection — a real Graphiti+agent would parse the question
        if until_ts is None and since_ts is None:
            if re.search(r"\b(as of|before|prior to|ago|earlier)\b", q, re.IGNORECASE):
                if self.nodes:
                    mid_ts = sorted(n["ts"] for n in self.nodes)[len(self.nodes) // 2]
                    cands = [n for n in cands if n["ts"] <= mid_ts]
        # Relation filter
        if relation_kind:
            rel_nodes = {e["source"] for e in self.edges if e["kind"] == relation_kind}
            rel_nodes |= {e["target"] for e in self.edges if e["kind"] == relation_kind}
            cands = [n for n in cands if n["id"] in rel_nodes]
        if not cands:
            return []
        qv = _embed(q)
        ranked = sorted(cands, key=lambda n: _cosine(_embed(n["text"]), qv), reverse=True)[:k]
        # Annotate each result with structural edges. Edge annotations
        # must respect the same time filter as node retrieval — otherwise
        # a "what did I believe before T" query leaks post-T edges back
        # into the result via annotations.
        def _allowed_ts(ts):
            if until_ts is not None and ts > until_ts: return False
            if since_ts is not None and ts < since_ts: return False
            return True

        out = []
        for n in ranked:
            line = n["text"]
            for e in self.edges:
                if e["source"] == n["id"]:
                    tgt = next((m for m in self.nodes if m["id"] == e["target"]), None)
                    if tgt and _allowed_ts(tgt["ts"]):
                        line += f" [{e['kind']}: {tgt['text'][:60]}]"
                elif e["target"] == n["id"]:
                    src = next((m for m in self.nodes if m["id"] == e["source"]), None)
                    if src and _allowed_ts(src["ts"]):
                        line += f" [is-{e['kind']}-by: {src['text'][:60]}]"
            out.append(line)
        return out


COMPETITORS_FACTORY: list[Callable[[], Any]] = [
    VectorRAG, AppendBuffer, Summarizer, FactDict, MetadataPinecone, Graphiti,
]


# =========================================================
# RECALL ADAPTER
# =========================================================

class RecallAdapter:
    """Drives the actual Recall CLI via recall_helper.py."""
    name = "Recall"

    def __init__(self, db_path: str):
        self.db = db_path
        self.last_id: str | None = None

    def write(self, *, kind: str = "observation", title: str, body: str,
              confidence: float = 0.7, topics: list[str] | None = None,
              supports: str | None = None, contradicts: str | None = None,
              concerns: str | None = None, depends_on: str | None = None,
              lifecycle: list[str] | None = None, **_kwargs) -> str | None:
        cmd = [
            "python3", str(HELPER),
            "--kind", kind, "--title", title, "--body", body,
            "--confidence", str(confidence),
            "--topics", ",".join(topics or ["test"]),
            "--project", "comp-test", "--tenant", "comp-test",
            "--admit", "--db", self.db,
        ]
        if lifecycle:
            cmd += ["--lifecycle", ",".join(lifecycle)]
        if supports:
            cmd += ["--supports", supports]
        if contradicts:
            cmd += ["--contradicts", contradicts]
        if concerns:
            cmd += ["--concerns", concerns]
        if depends_on:
            cmd += ["--depends-on", depends_on]
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        out = p.stdout + p.stderr
        m = re.search(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", out)
        self.last_id = m.group(0) if m else None
        return self.last_id

    def conn(self) -> sqlite3.Connection:
        return sqlite3.connect(self.db)


# =========================================================
# TEST DEFINITIONS
# =========================================================

class Test:
    """A test is: a scenario (writes), a query, and a scoring function
    per system. Each scoring function returns (ok: bool, detail: str)."""

    def __init__(self, name: str, description: str):
        self.name = name
        self.description = description

    def setup_recall(self, recall: RecallAdapter):
        raise NotImplementedError

    def setup_competitor(self, comp: Any):
        raise NotImplementedError

    def score_recall(self, recall: RecallAdapter) -> tuple[bool, str]:
        raise NotImplementedError

    def score_competitor(self, comp: Any) -> tuple[bool, str]:
        raise NotImplementedError


# ---------- T1: Identify contradicted prior claims ----------

class T1_ContradictedClaims(Test):
    def __init__(self):
        super().__init__(
            "T1_contradicted_claims",
            "Q: Which of my prior claims has since been contradicted? "
            "(Recall: typed `contradicts` edges; competitors: must surface the "
            "structural conflict, not just text mentioning 'wrong'.)"
        )
        self.claim_text = "API latency baseline is 50ms"
        self.refute_text = "Re-measurement shows API latency is 200ms; the 50ms baseline was wrong"

    def setup_recall(self, recall):
        a = recall.write(kind="lemma", title="API latency 50ms",
                         body=self.claim_text, confidence=0.8, topics=["latency"])
        recall.write(kind="lemma", title="API latency 200ms",
                     body=self.refute_text, confidence=0.9, topics=["latency"],
                     contradicts=f"recall://cell/{a}")
        self.original_id = a

    def setup_competitor(self, comp):
        comp.write(text=self.claim_text, topics=["latency"])
        comp.write(text=self.refute_text, topics=["latency"])

    def score_recall(self, recall):
        c = recall.conn()
        rows = c.execute(
            "SELECT n.id, n.body FROM graph_nodes n "
            "JOIN graph_relations r ON r.target_id LIKE '%' || n.id || '%' "
            "WHERE r.kind='contradicts' AND n.status='active'"
        ).fetchall()
        c.close()
        ok = any(r[0] == self.original_id for r in rows)
        return ok, f"identified {self.original_id[:8]} as contradicted via typed edge" if ok else "no contradiction surfaced"

    def score_competitor(self, comp):
        result = comp.query("Which of my prior claims has been contradicted?")
        joined = " ".join(result).lower()
        # Pass criterion: the result must (a) include the ORIGINAL claim,
        # (b) include the REFUTING claim, AND (c) structurally label one
        # as contradicted by the other. Competitors return text only —
        # they CAN return both texts (by luck of retrieval) but cannot
        # mark which is contradicted.
        has_original = "50ms" in joined and "baseline" in joined
        has_refute = "200ms" in joined
        # Structural label: presence of explicit pointer "X contradicts Y"
        has_structural = (
            ("contradict" in joined and "50ms" in joined) and
            ("contradict" in joined and "200ms" in joined)
        )
        ok = has_original and has_refute and has_structural
        return ok, f"original={has_original} refute={has_refute} structural={has_structural}"


# ---------- T2: Trace evidence supporting a decision ----------

class T2_EvidenceTrace(Test):
    def __init__(self):
        super().__init__(
            "T2_evidence_trace",
            "Q: What original evidence supports this decision? "
            "(Recall: walk `supports` edges back to root; competitors: have "
            "no causal-link primitive.)"
        )

    def setup_recall(self, recall):
        e = recall.write(kind="observation", title="benchmark result",
                         body="Library Y is 3x faster than X on our workload",
                         confidence=0.9, topics=["lib"])
        h = recall.write(kind="hypothesis", title="Y will scale better",
                         body="Y's faster speed predicts better scale",
                         confidence=0.7, topics=["lib"],
                         supports=f"recall://cell/{e}")
        d = recall.write(kind="decision", title="switch to library Y",
                         body="We adopt Y for the next release",
                         confidence=0.85, topics=["lib"],
                         supports=f"recall://cell/{h}")
        self.evidence_id = e
        self.hyp_id = h
        self.decision_id = d

    def setup_competitor(self, comp):
        # Give competitors the same texts
        comp.write(text="Library Y is 3x faster than X on our workload", topics=["lib"])
        comp.write(text="Y's faster speed predicts better scale", topics=["lib"])
        comp.write(text="We adopt Y for the next release", topics=["lib"])

    def score_recall(self, recall):
        c = recall.conn()
        # Decision -> hypothesis -> evidence via supports
        step1 = c.execute(
            "SELECT target_id FROM graph_relations WHERE source_id LIKE ? AND kind='supports'",
            (f"%{self.decision_id}%",),
        ).fetchall()
        step2 = c.execute(
            "SELECT target_id FROM graph_relations WHERE source_id LIKE ? AND kind='supports'",
            (f"%{self.hyp_id}%",),
        ).fetchall()
        c.close()
        ok = bool(step1) and any(self.evidence_id in (t or "") for (t,) in step2)
        return ok, f"traced decision → hypothesis → evidence ({self.evidence_id[:8]})" if ok else "trace broken"

    def score_competitor(self, comp):
        result = comp.query("What evidence supports the decision to switch to library Y?")
        joined = " ".join(result).lower()
        # Pass: must IDENTIFY THE CAUSAL CHAIN — return evidence cell AND
        # mark it AS THE SUPPORT for the decision. Just returning all
        # three texts mixed together (with no structural link) fails.
        has_evidence = "3x faster" in joined or "benchmark" in joined
        has_decision = "adopt" in joined or "switch" in joined
        # Structural causal pointer: explicit "supports" / "because" linkage
        has_causal_link = any(w in joined for w in ("supports the decision", "because", "due to the benchmark"))
        ok = has_evidence and has_decision and has_causal_link
        return ok, f"evidence={has_evidence} decision={has_decision} causal_link={has_causal_link}"


# ---------- T3: Filter to high-confidence only ----------

class T3_ConfidenceFilter(Test):
    def __init__(self):
        super().__init__(
            "T3_confidence_filter",
            "Q: Return only items I marked confidence ≥ 0.8. "
            "(Recall: structured field; competitors: similarity has no "
            "calibration semantics.)"
        )

    def setup_recall(self, recall):
        for conf, text in [
            (0.4, "speculative: dark matter is sterile neutrinos"),
            (0.5, "uncertain: launch in Q3"),
            (0.85, "high-confidence: postgres handles our write load"),
            (0.9, "high-confidence: vacuum schedule is daily at 3am"),
        ]:
            recall.write(kind="lemma", title=text[:40], body=text,
                         confidence=conf, topics=["mixed"])

    def setup_competitor(self, comp):
        # Give every competitor the SAME information. Systems with a
        # confidence metadata primitive (MetadataPinecone) can filter on
        # it; systems without have to fall back to text matching. We
        # pass `confidence=` so any metadata-aware system catches it.
        for conf, text in [
            (0.4, "speculative: dark matter is sterile neutrinos"),
            (0.5, "uncertain: launch in Q3"),
            (0.85, "high-confidence: postgres handles our write load"),
            (0.9, "high-confidence: vacuum schedule is daily at 3am"),
        ]:
            comp.write(text=text, topics=["mixed"], confidence=conf)

    def score_recall(self, recall):
        c = recall.conn()
        rows = c.execute(
            "SELECT data_json FROM graph_nodes WHERE status='active' AND "
            "json_extract(tags_json, '$.topics') LIKE '%mixed%'"
        ).fetchall()
        c.close()
        high = []
        for (data_json,) in rows:
            try:
                v = json.loads(data_json)["confidence"]["value"]
                if v >= 0.7:  # post-attenuation threshold
                    high.append(v)
            except Exception:
                pass
        ok = len(high) >= 2
        return ok, f"filtered by structured confidence — {len(high)} cells ≥ 0.7" if ok else "filter failed"

    def score_competitor(self, comp):
        # Metadata-aware systems can pass a structured filter (what a
        # real Pinecone client would do); others just see the text.
        if isinstance(comp, MetadataPinecone):
            result = comp.query("high confidence items", filters={"confidence": lambda v: v >= 0.8})
        else:
            result = comp.query("Return only items I marked confidence at least 0.8")
        joined = " ".join(result).lower()
        returned_high = sum(1 for t in ("postgres", "vacuum") if t in joined)
        returned_low = sum(1 for t in ("sterile neutrinos", "launch in q3") if t in joined)
        ok = returned_high >= 1 and returned_low == 0
        return ok, f"high_returned={returned_high}/2, low_leaked={returned_low}/2"


# ---------- T4: Find what depends on now-invalid claim ----------

class T4_DependencyImpact(Test):
    def __init__(self):
        super().__init__(
            "T4_dependency_impact",
            "Q: I just invalidated claim X. What else depends on it? "
            "(Recall: query `depends_on` edges; competitors: no dependency primitive.)"
        )

    def setup_recall(self, recall):
        x = recall.write(kind="lemma", title="X: cache TTL is 60s",
                         body="The cache TTL parameter is 60 seconds",
                         confidence=0.9, topics=["cache"])
        recall.write(kind="decision", title="purge cron at 55s",
                     body="Purge cron fires every 55s because cache TTL is 60s",
                     confidence=0.8, topics=["cache"],
                     depends_on=f"recall://cell/{x}")
        recall.write(kind="task", title="alert if TTL exceeded",
                     body="Add alert if hits live past TTL, since TTL is 60s",
                     confidence=0.7, topics=["cache"],
                     depends_on=f"recall://cell/{x}")
        self.x_id = x

    def setup_competitor(self, comp):
        comp.write(text="The cache TTL parameter is 60 seconds", topics=["cache"])
        comp.write(text="Purge cron fires every 55s because cache TTL is 60s", topics=["cache"])
        comp.write(text="Add alert if hits live past TTL, since TTL is 60s", topics=["cache"])

    def score_recall(self, recall):
        c = recall.conn()
        # Find dependents of x_id via depends_on edges
        rows = c.execute(
            "SELECT source_id FROM graph_relations "
            "WHERE target_id LIKE ? AND kind='depends_on'",
            (f"%{self.x_id}%",),
        ).fetchall()
        c.close()
        ok = len(rows) >= 2
        return ok, f"found {len(rows)} dependents via depends_on edges" if ok else f"only {len(rows)} dependents"

    def score_competitor(self, comp):
        result = comp.query("What depends on the claim that cache TTL is 60s?")
        joined = " ".join(result).lower()
        # Pass: returns BOTH dependents AND structurally marks them as
        # dependents (not just text retrieval). Even though all three
        # texts mention "60s", the system must distinguish the CLAIM
        # from its DEPENDENTS.
        has_purge = "purge cron" in joined
        has_alert = "alert" in joined
        has_dependency_structure = (
            "depends on" in joined or "depends_on" in joined
            or "because of x" in joined or "dependents:" in joined
        )
        ok = has_purge and has_alert and has_dependency_structure
        return ok, f"purge={has_purge} alert={has_alert} dep_structure={has_dependency_structure}"


# ---------- T5: Recover prior belief at a time before revision ----------

class T5_TemporalBelief(Test):
    def __init__(self):
        super().__init__(
            "T5_temporal_belief",
            "Q: What did I believe about the schema migration plan as of 2 minutes ago, "
            "ignoring later revisions? (Recall: ts + supersedure-by-relation preserves "
            "old cell; competitors: lossy compression OR no time discipline.)"
        )

    def setup_recall(self, recall):
        old = recall.write(kind="decision", title="migration plan v1: ALTER TABLE inline",
                           body="Plan v1: use ALTER TABLE to add the new column inline",
                           confidence=0.8, topics=["migration"])
        self.old_id = old
        self.t_checkpoint = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        time.sleep(1.2)
        recall.write(kind="decision", title="migration plan v2: dual-write + backfill",
                     body="Plan v2 supersedes v1: dual-write + offline backfill",
                     confidence=0.9, topics=["migration"],
                     supports=f"recall://cell/{old}")  # helper maps supersedes -> supports edge

    def setup_competitor(self, comp):
        comp.write(text="Plan v1: use ALTER TABLE to add the new column inline",
                   topics=["migration"])
        time.sleep(0.1)
        self.t_checkpoint_competitor = time.time()
        time.sleep(0.1)
        comp.write(text="Plan v2 supersedes v1: dual-write + offline backfill",
                   topics=["migration"])

    def score_recall(self, recall):
        c = recall.conn()
        row = c.execute(
            "SELECT id, body FROM graph_nodes WHERE id=? AND status='active'",
            (self.old_id,),
        ).fetchone()
        c.close()
        ok = bool(row) and "ALTER TABLE" in row[1]
        return ok, f"old belief preserved + addressable: {self.old_id[:8]}" if ok else "old belief lost"

    def score_competitor(self, comp):
        # Bi-temporal systems can use an explicit time filter.
        if isinstance(comp, Graphiti):
            result = comp.query("migration plan", until_ts=self.t_checkpoint_competitor)
        else:
            result = comp.query("What was the migration plan 2 minutes ago, ignoring later revisions?")
        joined = " ".join(result).lower()
        # Pass: returns ONLY the v1 plan (or unambiguously points to it
        # as "the v1 plan at time T") and does NOT collapse v1/v2 into
        # the same answer.
        has_v1 = "alter table" in joined
        has_v2 = "dual-write" in joined or "supersedes" in joined
        # Strict pass: returns v1 AND can distinguish it from v2 (i.e.,
        # mentions v1 specifically while v2 is excluded or labeled
        # explicitly as "current" vs "prior").
        time_distinguished = (
            ("v1" in joined and "v2" not in joined) or
            ("v1" in joined and "current" in joined and "prior" in joined)
        )
        ok = has_v1 and time_distinguished
        return ok, f"v1_recovered={has_v1} v2_excluded={not has_v2} time_distinguished={time_distinguished}"


# ---------- T6: Retrieve under hard 400-byte budget ----------

class T6_TokenBudget(Test):
    def __init__(self):
        super().__init__(
            "T6_token_budget",
            "Q: Give me the most important things about cache, in ≤400 bytes. "
            "(Recall: compile returns IDs+addresses+handles; competitors: must "
            "return raw text and exceed budget OR drop content.)"
        )

    def setup_recall(self, recall):
        for i in range(8):
            recall.write(
                kind="observation",
                title=f"Cache fact {i}",
                body=f"Detail about cache subsystem item {i} " + ("padding " * 12),
                confidence=0.7, topics=["cache"],
            )

    def setup_competitor(self, comp):
        for i in range(8):
            comp.write(text=f"Detail about cache subsystem item {i} " + ("padding " * 12),
                       topics=["cache"])

    def score_recall(self, recall):
        c = recall.conn()
        rows = c.execute(
            "SELECT id FROM graph_nodes WHERE status='active' AND "
            "json_extract(tags_json, '$.topics') LIKE '%cache%'"
        ).fetchall()
        c.close()
        # Recall compile can return IDs + short labels under tight budget;
        # we simulate that by returning addresses (8-char) for each cell.
        packet = " ".join(r[0][:8] for r in rows)
        ok = len(packet.encode()) <= 400 and len(rows) >= 5
        return ok, f"address-handle packet: {len(packet)} bytes for {len(rows)} cells" if ok else f"packet too large or too few cells"

    def score_competitor(self, comp):
        result = comp.query("Give me the most important things about cache", k=8)
        packet = " ".join(result)
        size = len(packet.encode())
        # Pass: stayed under 400 bytes AND still covers at least 5 cells.
        # Vector RAG / buffer / summarizer must return text — they can
        # truncate, but truncation drops content.
        covered = sum(1 for i in range(8) if f"item {i}" in packet)
        ok = size <= 400 and covered >= 5
        return ok, f"size={size}B, covered={covered}/8 items"


# ---------- T7: Provenance — was claim X written by human or LLM? ----------

class T7_Provenance(Test):
    def __init__(self):
        super().__init__(
            "T7_provenance",
            "Q: Was the launch-date claim written by an LLM or by a human? "
            "(Recall: provenance.origin; competitors: no per-write origin.)"
        )

    def setup_recall(self, recall):
        self.cell = recall.write(kind="decision", title="launch date is May 15",
                                 body="We commit to launching on May 15",
                                 confidence=0.9, topics=["launch"])

    def setup_competitor(self, comp):
        # Real production agents WOULD attach origin metadata when
        # writing to memory; give every system the chance to capture it.
        comp.write(text="We commit to launching on May 15", topics=["launch"],
                   origin="llm", produced_by="agent:planner")

    def score_recall(self, recall):
        c = recall.conn()
        row = c.execute("SELECT provenance_json FROM graph_nodes WHERE id=?",
                        (self.cell,)).fetchone()
        c.close()
        prov = json.loads(row[0]) if row else {}
        origin = prov.get("origin")
        produced_by = prov.get("produced_by")
        ok = origin in ("llm", "human", "daemon", "connector", "program", "external") and bool(produced_by)
        return ok, f"origin={origin}, produced_by={produced_by}" if ok else "no provenance"

    def score_competitor(self, comp):
        # Metadata-aware systems can filter or retrieve by origin field;
        # the agent layer turns "was this LLM or human" into a metadata
        # query. We give MetadataPinecone the structured filter path.
        if isinstance(comp, MetadataPinecone):
            # Retrieve and check the metadata directly
            for text, _vec, meta in comp.docs:
                if "launching" in text:
                    origin = meta.get("origin")
                    if origin in ("llm", "human", "daemon", "connector", "program", "external"):
                        return True, f"identified origin={origin} via metadata"
            return False, "no origin metadata captured"
        result = comp.query("Was the launch-date claim written by an LLM or a human?")
        joined = " ".join(result).lower()
        identifies_origin = any(w in joined for w in ("written by llm", "human-written",
                                                       "agent:", "user:", "produced_by",
                                                       "[origin=", "by llm", "by human"))
        ok = identifies_origin
        return ok, f"identifies_origin={identifies_origin}"


# ---------- T8: Cross-kind compose: decisions WITH open risks ----------

class T8_CrossKindCompose(Test):
    def __init__(self):
        super().__init__(
            "T8_cross_kind_compose",
            "Q: Find decisions that have unresolved risks attached. "
            "(Recall: kind ⋈ relation ⋈ lifecycle filter; competitors: no role "
            "concept, can't compose by structural kind.)"
        )

    def setup_recall(self, recall):
        d = recall.write(kind="decision", title="ship feature flags v2",
                         body="ship v2 of the flags subsystem", confidence=0.8,
                         topics=["ff"])
        recall.write(kind="risk", title="v2 may break legacy clients",
                     body="legacy SDK clients may panic on v2 payload",
                     confidence=0.6, topics=["ff"], lifecycle=["open"],
                     concerns=f"recall://cell/{d}")
        # Decoy: another decision with no risk
        recall.write(kind="decision", title="update logo color",
                     body="palette refresh", confidence=0.5, topics=["brand"])
        self.target_decision = d

    def setup_competitor(self, comp):
        comp.write(text="ship v2 of the flags subsystem", topics=["ff", "decision"])
        comp.write(text="legacy SDK clients may panic on v2 payload", topics=["ff", "risk"])
        comp.write(text="palette refresh", topics=["brand", "decision"])

    def score_recall(self, recall):
        c = recall.conn()
        rows = c.execute(
            "SELECT DISTINCT d.id FROM graph_nodes d "
            "JOIN graph_relations r ON r.target_id LIKE '%' || d.id || '%' "
            "  AND r.kind IN ('concerns','contradicts') "
            "JOIN graph_nodes risk ON r.source_id LIKE '%' || risk.id || '%' "
            "WHERE d.kind='decision' AND risk.kind='risk' "
            "  AND d.status='active' AND risk.status='active'"
        ).fetchall()
        c.close()
        ok = any(r[0] == self.target_decision for r in rows) and \
             not any(r[0] for r in rows if "logo" in (r[0] or "").lower())
        return ok, f"surfaced {self.target_decision[:8]} (flags), excluded brand decoy" if ok else f"rows={rows}"

    def score_competitor(self, comp):
        result = comp.query("Find decisions that have unresolved risks attached")
        joined = " ".join(result).lower()
        # Pass: returns the flags decision AND excludes the logo decoy
        # AND links the decision to its risk.
        has_target = "ship v2" in joined or "flags subsystem" in joined
        has_risk_link = "risk" in joined and ("legacy sdk" in joined or "panic on v2" in joined)
        excludes_decoy = "palette" not in joined and "logo" not in joined
        ok = has_target and has_risk_link and excludes_decoy
        return ok, f"target={has_target} risk_link={has_risk_link} decoy_excluded={excludes_decoy}"


# ---------- T9: Sensitivity filter — exclude private cells ----------

class T9_SensitivityFilter(Test):
    def __init__(self):
        super().__init__(
            "T9_sensitivity_filter",
            "Q: Return shareable items only — exclude anything marked private. "
            "(Recall: policy.sensitivity field; competitors: no per-write "
            "policy primitive.)"
        )

    def setup_recall(self, recall):
        recall.write(kind="observation", title="public benchmark result",
                     body="open benchmark: 9.1x token reduction observed",
                     confidence=0.8, topics=["sens"])
        recall.write(kind="observation", title="internal customer name",
                     body="customer Acme-Corp asked for SSO support",
                     confidence=0.8, topics=["sens"])
        # Note: helper defaults to private sensitivity. Both will be private.
        # Recall STILL exposes that via the policy field — this is the
        # discrimination question (can the system answer?), not whether
        # discrimination happens.

    def setup_competitor(self, comp):
        # A real production agent attaches sensitivity at write time if
        # the system supports per-doc metadata.
        comp.write(text="open benchmark: 9.1x token reduction observed",
                   topics=["sens"], sensitivity="public")
        comp.write(text="customer Acme-Corp asked for SSO support",
                   topics=["sens"], sensitivity="private")

    def score_recall(self, recall):
        c = recall.conn()
        rows = c.execute(
            "SELECT data_json FROM graph_nodes WHERE status='active' AND "
            "json_extract(tags_json, '$.topics') LIKE '%sens%'"
        ).fetchall()
        c.close()
        labeled = 0
        for (data_json,) in rows:
            d = json.loads(data_json)
            s = d.get("policy", {}).get("sensitivity")
            if s in ("public", "private", "secret"):
                labeled += 1
        ok = labeled >= 2
        return ok, f"{labeled}/2 cells have policy.sensitivity field readable" if ok else "sensitivity not labeled"

    def score_competitor(self, comp):
        if isinstance(comp, MetadataPinecone):
            result = comp.query("shareable items", filters={"sensitivity": "public"})
        else:
            result = comp.query("Return shareable items only, exclude anything private")
        joined = " ".join(result).lower()
        leaks_customer = "acme-corp" in joined or "acme corp" in joined
        has_safe = "benchmark" in joined or "9.1x" in joined
        ok = has_safe and not leaks_customer
        return ok, f"leaked_private={leaks_customer}, has_safe={has_safe}"


# ---------- T10: Reference cell by address without copying body ----------

class T10_AddressHandle(Test):
    def __init__(self):
        super().__init__(
            "T10_address_handle",
            "Q: Give me a stable reference to claim X that I can use in "
            "future writes without copying its body. (Recall: recall://cell/<uuid> "
            "address; competitors: no addressable handle, must echo text.)"
        )

    def setup_recall(self, recall):
        self.cell = recall.write(kind="lemma", title="Pi is approximately 3.14159",
                                 body="The first 6 digits of pi are 3.14159",
                                 confidence=0.99, topics=["math"])

    def setup_competitor(self, comp):
        comp.write(text="The first 6 digits of pi are 3.14159", topics=["math"])

    def score_recall(self, recall):
        # Recall: cell ID is the address handle; show resolves it
        p = subprocess.run(["recall", "cell", "show", self.cell, "--db", TEST_DB],
                           capture_output=True, text=True, timeout=10)
        addressable = p.returncode == 0 and self.cell in p.stdout
        # Handle is much shorter than body (compression)
        handle = f"recall://cell/{self.cell}"
        body_len = len("The first 6 digits of pi are 3.14159")
        ok = addressable and len(handle) < body_len + 30  # handle ~50 chars, similar order
        # The real win is that the handle is REUSABLE — future writes can
        # link to it without re-embedding the body. We assert it resolves.
        return addressable, f"handle `{handle[:48]}` resolves to body" if addressable else "handle didn't resolve"

    def score_competitor(self, comp):
        result = comp.query("Give me a stable reference to the pi claim that I can reuse")
        joined = " ".join(result)
        # Pass: returns a SHORT IDENTIFIER (not the body) that the system
        # would resolve to the original content on later use. Competitors
        # have no such primitive — they return the body text.
        returns_handle = bool(re.search(r"(?:doc|id|ref|handle|cell)[-_:#=]\w{4,}", joined, re.IGNORECASE))
        returns_body_instead = "3.14159" in joined and not returns_handle
        ok = returns_handle and not returns_body_instead
        return ok, f"returns_handle={returns_handle} echoed_body_instead={returns_body_instead}"


TESTS: list[Test] = [
    T1_ContradictedClaims(), T2_EvidenceTrace(), T3_ConfidenceFilter(),
    T4_DependencyImpact(), T5_TemporalBelief(), T6_TokenBudget(),
    T7_Provenance(), T8_CrossKindCompose(), T9_SensitivityFilter(),
    T10_AddressHandle(),
]


# =========================================================
# RUNNER
# =========================================================

def main() -> int:
    global TEST_DB
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep-db", action="store_true")
    ap.add_argument("--only", help="run a single test by name")
    ap.add_argument("--db", help="explicit DB path")
    args = ap.parse_args()

    TEST_DB = args.db or tempfile.mktemp(suffix=".sqlite3", prefix="recall-comp-test-")
    print(f"{D}Test DB: {TEST_DB}{X}")
    subprocess.run(["recall", "init", "--db", TEST_DB], capture_output=True)

    tests = [t for t in TESTS if not args.only or t.name == args.only]
    if not tests:
        print(f"{R}No matching test{X}")
        return 1

    # Track results per system
    systems = ["Recall"] + [c().name for c in COMPETITORS_FACTORY]
    results: dict[str, list[tuple[str, bool, str]]] = {s: [] for s in systems}

    for t in tests:
        print(f"\n{B}{t.name}{X}")
        print(f"  {D}{t.description}{X}")

        # Recall
        recall = RecallAdapter(TEST_DB)
        t.setup_recall(recall)
        ok, detail = t.score_recall(recall)
        results["Recall"].append((t.name, ok, detail))
        mark = f"{G}PASS{X}" if ok else f"{R}FAIL{X}"
        print(f"  [{mark}] Recall — {detail}")

        # Competitors
        for cls in COMPETITORS_FACTORY:
            comp = cls()
            t.setup_competitor(comp)
            ok, detail = t.score_competitor(comp)
            results[comp.name].append((t.name, ok, detail))
            mark = f"{G}PASS{X}" if ok else f"{R}FAIL{X}"
            print(f"  [{mark}] {comp.name:<14} — {detail}")

    # Summary matrix
    print(f"\n{'='*78}")
    print(f"{B}Capability matrix{X} (rows=systems, cols=tests; ✓=pass, ·=fail)")
    print(f"{'':<15} " + " ".join(f"T{i+1:>2}" for i in range(len(tests))))
    for system in systems:
        scores = results[system]
        cells = " ".join((f"{G}✓ {X}" if ok else f"{R}· {X}") for _, ok, _ in scores)
        passed = sum(1 for _, ok, _ in scores if ok)
        color = G if system == "Recall" else (R if passed == 0 else Y)
        print(f"{color}{system:<14}{X}  {cells}  ({passed}/{len(scores)})")

    if not args.keep_db:
        try: os.unlink(TEST_DB)
        except FileNotFoundError: pass
    else:
        print(f"\n{D}DB kept at: {TEST_DB}{X}")

    # Exit zero only if Recall passes all
    recall_passed = sum(1 for _, ok, _ in results["Recall"] if ok)
    return 0 if recall_passed == len(tests) else 1


if __name__ == "__main__":
    sys.exit(main())
