---
title: "I asked the Fable 5 which memory it would rather run on"
seoTitle: "I asked the model which memory it would rather run on"
seoDescription: "A frontier model's self-report on the difference between graph memory and flat-file auto-memory, plus the deterministic numbers so you don't have to take its word for it."
datePublished: 2026-07-02T18:45:23.772Z
cuid: cmr3uu2zg00000aj4g2zjfvpg
slug: i-asked-the-fable-5-which-memory-it-would-rather-run-on
cover: https://cdn.hashnode.com/uploads/covers/6a338dc87bf3ea1f3591dbb9/fde26db7-88ff-420d-89a5-2e695200c08d.png
tags: ai, memory, llm, agents

---

I switched my terminal over to Fable 5, Anthropic's new frontier model, and put a blunt question to it: you have run on Claude Code's built-in auto-memory, and you are running on my memory substrate right now. Can you actually tell a difference?

It said yes, and it brought a receipt from twenty minutes earlier in the same session.

I had asked it a mundane question: what is my next scheduled blog post. My content calendar lives in the memory graph, and the graph held two versions of it: an older cell with the original ordering and a newer cell that resequenced it, linked by a contradicts edge. The compile packet the model reads at the start of a turn includes a conflicts section, and that section flagged the old ordering as challenged before the model ever quoted from it. Its own summary: with auto-memory, the stale calendar comes back as flat text with nothing marking it superseded, and I would have confidently given you the wrong post.

That is the difference in one sentence. One system hands the model facts with epistemic state attached: confidence, challenged, stale, who wrote it and when. The other hands it text it has to take at face value.

## Discount the self-report first

Before quoting a model's opinion about anything, name the confound: models tend to agree with the framing of whoever is asking, and I built the thing I was asking about. So treat the interview as color, not evidence.

The evidence is a store-level battery with no LLM in the scoring loop. Seven deterministic scenarios, run against two stores: a faithful flat-file model of Claude Code's auto-memory (a real MEMORY.md index plus per-fact .md files with metadata frontmatter, overwrite-in-place on correction) and the real recall CLI on an isolated database.

Audited score: Recall 6.5 of 7, auto-memory 3.5 of 7. The audit is the part I trust most. The first run scored 7 against 2.5. Three independent agents then reviewed the harness adversarially, called it mildly biased toward Recall, found a genuine false positive, and the corrected run is the number I keep. A benchmark that got less flattering after an audit is worth more than one that never had one.

And the honest reading of the split: auto-memory ties on basics. In a separate agent-level A/B, both stores went 3 for 3 on simple current-value questions. Flat prose can simulate simple supersession fine. The gap opens at scale and on corrections. My graph currently holds about 1,180 cells with 86 tracked contradictions. A flat file at that size is a pile of sentences, and no sentence in it can answer "what changed since Tuesday" or "which of these beliefs is contested," because those are questions about the store's state over time, not about any fact inside it.

## The four mechanisms that do the work

**Supersession instead of overwrite.** When a fact is corrected, auto-memory overwrites the old file in place. The history is gone, and a corrected fact is indistinguishable from a never-wrong one. In the graph, the new cell carries a contradicts edge to the old one; the old cell's effective confidence drops and it stays visible as superseded. The correction is recorded as a resolution, not a deletion.

**Per-prompt push instead of load-at-start.** A hook compiles a small index of relevant cells, ids and staleness flags included, into every prompt. The model does not have to remember to look; the current state of the graph re-enters its context each turn. Auto-memory loads once at session start and then drifts.

**Ids-first reads instead of whole-file loads.** The compile packet returns handles. The model expands the two cells it needs instead of ingesting the whole store and hoping the relevant paragraph survives.

**Questions about the store itself.** What changed in the last day. What is stale. What is contested. These are answered by diff and health tools reading timestamps and edges. There is no flat-file equivalent, not because nobody wrote one, but because the file does not contain the information.

## The long-run answer

Then the follow-up I actually cared about: for a long-running task, which would you rather have underneath you?

Its answer, compressed: what kills a long session is context compaction. The window gets summarized, the summary is lossy prose, and nothing marks what got dropped or corrected along the way. A memory that loads at session start does not help mid-task. The per-prompt push re-anchors the model after every compaction, from the graph rather than from whatever survived the summary. And long tasks accumulate corrections: something believed in hour one gets falsified in hour three, and the specific way long autonomous runs die is an agent confidently resuming from a belief nobody told it was stale.

It conceded the cost without being asked, which I appreciated. The write discipline burns tokens every turn, and on a ten-minute task it may never pay back. On a long run it amortizes, and the writes double as an audit trail of what the agent did and why.

One operational footnote if you want to reproduce any of this: Claude Code's native auto-memory shadows an external store while it is on. We tested arming the agent every way we could think of; it kept writing flat .md files regardless. CLAUDE\_CODE\_DISABLE\_AUTO\_MEMORY=1 is the switch. The two do not coexist.

## The two questions, again

Strip the interview away and you are left with the two questions I keep coming back to. Is your agent actually using your memory, or a shadow store sitting next to it? And if a fact in that memory were wrong, would anything in the system know?

A self-report from a frontier model is a data point, not a verdict, and this is a field report from one stack, half of which I built. Run the two questions against your own setup and tell me where I have it wrong: github.com/H-XX-D/recall-memory-substrate