# Push vs Pull Memory

**Pull memory is a store you query. Push memory is a loop your agent runs: it reads what it knows before acting, does the work, and writes back what changed.** Most agent memory today is pull. Recall is push.

## The short version

- **Pull memory.** You write facts to a store. Later, at read time, the agent queries it and gets back the closest matches. Reconciling stale or conflicting facts is the reader's job, if it happens at all.
- **Push memory.** The agent and the memory run a loop together. Before it acts, the agent consults what it already knows. After it acts, it writes back what it learned, and the substrate reconciles that write against everything already stored: it supersedes the old value when something changed, and surfaces the contradiction instead of silently keeping both.

The difference is *when reconciliation happens* and *who is responsible for it*. Pull defers reconciliation to read time and puts it on the reader. Push does it at write time, in the substrate, automatically.

## Pull memory

This is the default: a vector store, a document store, or a managed memory service. You, or a background job, extract facts and write them. At query time the agent gets semantic matches ranked by similarity.

Pull is simple, and it works well when facts rarely change, when the agent is short-lived, or when approximate recall is good enough.

Where pull breaks down: nothing notices when a fact goes stale. You stored "the pool cap is 20." Later it became 50. Both are in the store now. A similarity search can return either one, and the agent has no signal that one supersedes the other. The burden of noticing the conflict falls on the reader, on every read, forever.

## Push memory

Push closes the loop. The contract is read, then work, then write:

```
read current memory  →  do the work  →  write a correction
        ▲                                        │
        └──────  substrate supersedes + flags  ──┘
```

The write is not an append. When the new fact corrects an old one, the agent admits it as a correction, and the substrate demotes the superseded value and records the link between them. Every future read sees the current value first, with the stale one flagged, without anyone asking. Reconciliation is a property of the store, not a chore for the reader.

Push costs one thing pull does not: it needs a reliable author. Something has to consult before acting and write a principled correction after. For years that author did not exist at scale, which is why memory was built pull-first. A capable LLM agent is that author now, and that is what makes push memory buildable today.

## The axis

| | Pull memory | Push memory |
|---|---|---|
| Shape | A store you query | A loop you run |
| Reconciliation | At read time, by the reader | At write time, by the substrate |
| Stale facts | Linger until a reader notices | Superseded and flagged automatically |
| The write | An append | A correction, with provenance |
| Best when | Facts are stable, sessions short | Facts change, agents long-lived, correctness matters |

## Which one do you need

If your agent answers one-off questions over a mostly static corpus, pull is fine. If your agent runs over days or weeks, accumulates decisions, and has to stay correct as the world changes underneath it, you want push. The moment a fact can be *wrong later*, read-time similarity is no longer enough, and you need write-time reconciliation.

Many systems can be read either way. The useful question is not "which store has the best search," it is "where does reconciliation live: in every reader, or in the substrate once."

## Where Recall sits

Recall is push memory, local-first. The agent consults a compiled context packet before acting and writes structured corrections back through an admission firewall. Supersession is built in: a correction demotes the old value and surfaces the contradiction at read time. It runs on local SQLite, with provenance and a one-command undo on every fact. No server, no account, no cloud.

See the [README](../README.md) for a 60-second tour, or [`docs/01_ARCHITECTURE.md`](01_ARCHITECTURE.md) for how the loop is built.
