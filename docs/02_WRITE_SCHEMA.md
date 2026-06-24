# Strict Write Schema

All LLM writes enter Recall as `WriteProposal` records.

## WriteProposal

```json
{
  "schema_version": "recall.write.v1",
  "actor": {
    "kind": "llm|human|daemon|connector|program",
    "id": "codex",
    "display": "Codex"
  },
  "intent": {
    "kind": "observation|witness|belief_update|task|decision|risk|constraint|program|relation",
    "operation": "create|update|supersede|link|archive"
  },
  "content": {
    "title": "Short stable title",
    "body": "Precise claim or instruction",
    "summary": "Optional compact summary"
  },
  "scope": {
    "project": "Recall",
    "path": "/path/to/recall",
    "tenant": "local"
  },
  "tags": {
    "topics": ["memory", "graph"],
    "entities": ["Recall"],
    "rings": ["runtime"],
    "lifecycle": ["active"],
    "quality": ["source-grounded"]
  },
  "evidence": {
    "source_refs": [],
    "depends_on": [],
    "supports": [],
    "contradicts": [],
    "concerns": []
  },
  "confidence": {
    "value": 0.7,
    "uncertainty": 0.3,
    "concern": 0.5,
    "source_quality": "unknown|low|medium|high",
    "stability": "ephemeral|volatile|stable"
  },
  "provenance": {
    "created_at": "ISO-8601",
    "origin": "human|llm|daemon|connector|program|external",
    "produced_by": "agent-or-tool-id",
    "verification": "unverified|checked|tested|external",
    "signature_status": "unsigned|signed|verified"
  },
  "policy": {
    "sensitivity": "public|private|secret",
    "allow_background_use": true,
    "requires_review": false,
    "expires_at": null,
    "reverify_after": null
  }
}
```

## Admission Rules

- Reject missing schema version.
- Reject writes with no actor, intent, scope, provenance, or confidence block.
- Reject secret-looking content.
- Downshift unsupported high-confidence claims.
- Require evidence refs for tested or verified claims.
- Require review for program writes and high-concern belief updates.
- Create rollback journal entries for all durable writes.
- Preserve old records through supersession instead of silent overwrite.

## Belief Update Rule

Beliefs are not simple memories. A belief update must cite supporting,
contradicting, or concerning evidence. The belief calculator owns final belief
state.
