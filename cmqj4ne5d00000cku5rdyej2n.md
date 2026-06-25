---
title: "Push vs Pull AI"
seoDescription: "Push vs Pull Memory for AI Agents"
datePublished: 2026-06-18T06:36:58.095Z
cuid: cmqj4ne5d00000cku5rdyej2n
slug: push-vs-pull-ai
canonical: https://dev.to/hendrixxcnc/push-vs-pull-memory-a-better-way-to-think-about-ai-agent-memory-3lnp
cover: https://cdn.hashnode.com/uploads/covers/6a338dc87bf3ea1f3591dbb9/e7114bd8-7532-40e9-95e2-5de0290011ec.png
ogImage: https://cdn.hashnode.com/uploads/og-images/6a338dc87bf3ea1f3591dbb9/acbb6259-2545-4186-88c9-9f9589c783ba.png
tags: ai, memory-management, ai-agents, memory-systems

---

# Push vs Pull Memory: A Better Way to Think About AI Agent Memory

Pull memory is a store you query. Push memory is a loop your agent runs: it reads what it knows before acting, does the work, and writes back what changed, and the substrate reconciles that write so a stale fact gets superseded instead of lingering. Most agent memory today is pull. This post is about the other half of the design space, and when it is the one you actually want.

## How agents remember today

Almost everything sold as "agent memory" right now is pull. You write facts into a store: a vector database, a document store, or a managed memory service. Later, at read time, the agent sends a query and gets back the closest matches by similarity. That is it. The store is passive. It answers when asked and does nothing in between.

Pull is simple, and it is the right tool in plenty of cases. If your agent answers one-off questions over a corpus that does not change much, or the session is short, or approximate recall is good enough, a vector store is fine and you should not overthink it.

The trouble starts when a fact can be wrong later.

Say your agent stored "the connection pool cap is 20." Weeks pass and the cap is raised to 50, so the agent stores that too. Now both facts live in the store. A similarity search can return either one, and nothing in the system knows that the second supersedes the first. The agent has no signal that one of these is stale. The job of noticing the conflict falls on the reader, on every single read, forever. In practice nobody does that reliably, so the agent quietly acts on outdated facts and you find out when something breaks.

This is not a bug in any particular vector database. It is a property of the pull shape itself: reconciliation happens at read time, if it happens at all, and the responsibility for it sits with whoever is reading.

## Push memory: reconcile at write time instead

Push closes the loop. The contract is read, then work, then write:

```plaintext
read current memory  ->  do the work  ->  write a correction
        ^                                        |
        +------  substrate supersedes + flags  --+
```

Before the agent acts, it consults what it already knows. After it acts, it writes back what it learned. The key difference is what happens on that write. It is not an append. When the new fact corrects an old one, the agent writes it as a correction, and the substrate demotes the superseded value and records the link between the two. From then on, every read sees the current value first, with the old one flagged as contradicted, and no one had to ask.

Reconciliation moves from read time to write time, and from the reader to the substrate. You pay the cost once, when you write, instead of every time you read. Stale facts do not pile up silently, because the moment a contradiction is written, it is resolved and recorded.

## The axis

|  | Pull memory | Push memory |
| --- | --- | --- |
| Shape | A store you query | A loop you run |
| Reconciliation | At read time, by the reader | At write time, by the substrate |
| Stale facts | Linger until a reader notices | Superseded and flagged automatically |
| The write | An append | A correction, with provenance |
| Best when | Facts are stable, sessions short | Facts change, agents long-lived, correctness matters |

## Why push memory is only buildable now

The push shape is not a new idea. Truth-maintenance systems and belief revision were studying write-time reconciliation decades ago. The reason memory got built pull-first is that push needs something pull does not: a reliable author. Something has to consult memory before acting and write a principled correction afterward, every time, without being told. For most of computing history that author did not exist at scale. You were not going to get a human to do it on every write.

A capable LLM agent is that author. It can read before it acts and write a structured correction after, as a normal part of its loop. That is what makes push memory practical today and not five years ago, and it is why the idea is worth a fresh look now even though the underlying theory is old.

## Which one do you need

Be honest about it. If your agent answers questions over a mostly static corpus and does not live very long, pull is fine and simpler. Reach for push when your agent runs over days or weeks, accumulates decisions, and has to stay correct as the world changes underneath it. The deciding question is whether a fact can be wrong later. If it can, read-time similarity is not enough on its own, and you want write-time reconciliation.

A quick test for what you already have: does your memory flag a contradiction without being asked? Store two facts that conflict, then query the topic. If you get back whichever is more similar with no signal that they disagree, you have pull. If the system surfaces the conflict and tells you which one is current, you have push.

## Where this lands

The honest framing is a spectrum, not a binary. Plenty of systems can be read either way, and some sit closer to the push end than others. The useful question is not "which store has the best search," it is "where does reconciliation live: in every reader, or in the substrate, once."

I am building [Recall](https://github.com/H-XX-D/recall-memory-substrate), an open-source, local-first push memory substrate, to take the push end seriously. The agent consults a compiled context packet before acting and writes structured corrections back through an admission layer. Supersession is built in. It runs on local SQLite, every fact carries provenance, and there is a one-command undo. No server, no account, no cloud. There is a short screencast of a live supersession in the README, and a benchmark called SENTINEL that measures whether a memory system catches its own contradictions.

If you think the push vs pull split is wrong, or that your system is push and I have it filed under pull, I want to hear it.

## FAQ

**What is pull memory?** A passive store you query at read time, where reconciling stale or conflicting facts is the reader's job.

**What is push memory?** A loop where the agent reads before acting and writes corrections back, and the substrate reconciles at write time, superseding stale facts automatically.

**Is RAG push or pull?** Pull. Retrieval-augmented generation fetches similar chunks at read time and does not reconcile across writes.

**Are Mem0, Zep, or Letta push or pull?** Mostly pull in the sense above, though they differ. Zep's bi-temporal graph does some write-time reconciliation and sits closer to the push end than a plain vector store. The cleanest way to tell is the contradiction test: does it flag a conflict without being asked.

**When should I not bother with push memory?** Short-lived agents over a static corpus, where approximate recall is enough. Pull is simpler and fine there.