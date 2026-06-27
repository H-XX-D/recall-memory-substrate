---
title: "Claude, Codex, Gemini, Grok: A Field Report on Agentic Memory Write Reliability"
seoTitle: "Claude, Codex, Gemini, Grok: Field Report on Agentic Memory"
seoDescription: "A benchmark only means something if there’s a baseline and a calibrated anchor. A bench that only your system can run is not a benchmark ts a demo "
datePublished: 2026-06-27T05:50:38.140Z
cuid: cmqvxyh4k00010ahz190f2es4
slug: claude-codex-gemini-grok-a-field-report-on-agentic-memory-write-reliability
cover: https://cdn.hashnode.com/uploads/covers/6a338dc87bf3ea1f3591dbb9/4d9b182f-4c22-40b0-a193-355a3b464e6f.png

---

I received a comment that felt like a good way to end a series and start another. They asked me if I could notice a difference in the hyperscale frontier models. This post is a breakdown of where I am at, the carve-outs, and the direction this work is headed I will attempt to convey and start formalizing. a shared mental model and a consistent vernacular.

There are differences, but they are not really about the model. They are about how much of the turn each family lets you control. If adherence is a systems problem, then the thing that actually decides write reliability is which family hands you enough control surface to build the system.

Treat this as a field report, not a benchmark, and an early one. I have not pushed every family equally hard, and that matters for how much weight the comparison can carry.

## Claude is where I have gone the deepest

This is the family I have cut my teeth on the most, invested the most time with, so weigh the claim with that in mind. What I can say is that Claude gives you a full ladder, from shallow to deep, and you can stop at whatever rung the job needs.

The shallow rung is nudges: the settings page and system instructions. This is the weakest form, and it is the one that decays, the same “tell it harder” failure I wrote about last time. It helps a little, and it does not hold.

Above that are skills and hooks. This is where the concept of a Push vs. Pull agentic memory scaffolding and instrumentation Hooks are the first rung, where adherence stops being a request and becomes an event: something fires at the start of the turn, at write time, refusing to end the turn return the required data shaped. They can also be difficult to structure correctly. I had good results with loose pseudo code. it was generic enough it return wel

The deep rung is the SDK. With it, you get targeted control of the model’s turn, the whole prompt-to-response lifecycle, beginning to end. This is where the read reason response write wiring carries weight. Say that 5 times fast.

The point is not that any single rung is magic. It is that Claude lets you go as deep as the reliability you need, and the deeper you go, the more deterministic the write becomes.

## ChatGPT and Codex are close, through AGENTS.md

Codex was a lot easier than I expected, because its instruction set is the AGENTS.md file. That one anchor did most of the work, and the net result was only slightly less consistent than Claude.

Honest caveat: I have not dug into the Codex SDK yet. So the ceiling there is probably higher than what I have measured, and the real gap to Claude may be smaller than it looks right now.

## Gemini and Grok lean on their own memory

The Gemini and Grok CLIs are a different story. They seem to want to do the least amount of work possible, and they lean on their own KV and incoming user prompts more than they reach for an outside store. You end up working against a default that would rather not call your database at all.

The exception is WebSearch, and it comes back noisy and minimal, and it gets actively counterproductive when it does surface strongly correlated evidence that’s divergent from your store, because then the model over-trusts the search and skips the store it should have read. Getting real adherence out of those two means digging into their architectures to optimize for it, and that is still on my horizon,## Why this is a field report and not a benchmark yet

Building SENTINEL, a real benchmarking suite for this, is one of my highest priorities right now. The honest problem is that most memory systems do not expose the turn the way you would need to in order to measure whether a write happened at the right moment, so you cannot make them play the same game. The way I keep it fair is to grade what each system’s outputs actually demonstrate, on a capability ladder, rather than the levers it was never built to expose. A system that does not surface something scores lower on that axis without being punished for it, and I say plainly which axis is push and which is pull, so a gap reads as a different shape, not a worse one. The full design is its own post.

A benchmark value only means something if there’s an aggregate baseline and a calibrated anchor. A bench that only your system can run is not a benchmark; it is a demo attributing the result to the wrong layer, blaming the store when the model just queried it badly, or crediting the system. So devising ways to avoid bias, cold start cutoffs, normalizations for balancing the different ways correlated axis report their values, scale parity, outlier skew, and correct attribution comes first, and then the leaderboard means something.

*Veni, vidi, vici.*

“I came, I saw, I conquered.”

—Attributed to Julius Caesar after the Battle of Zela, 47 BC

Sources: Plutarch, Life of Caesar 50.3; Suetonius, Divus Julius 37.2.

Quotng Julious Ceaser without projecting hubris is hard to earn. The rendering from the Latin to English carries little of the same weight, effort involved, or consequence of failure in the attempt. I am not claiming victories yet because it’s apples to orange homeboy, I need like a handicapping algorithm

It feels like it is more difficult to create an honest comparison between separate but similar function systems than the engineering of the thing being compared.

The model is not the variable that matters most for write reliability. The control surface is. The deterministic parts of a good memory system, the validation gate, and the demotion math, hold the same on any of these. What changes across families is how much of the turn you are allowed to act on and instrument the input-output mechanics. So far, Claude exposed the whole lifecycle, Codex gave a strong instruction anchor through AGENTS.md, and Gemini and Grok leaned hardest on their own context. I went testicle deep on Claude’s hooks and SDK, scratching the surface on Codex, its SDK next, and I have barely pushed Gemini or Grok past their defaults. Subjective verdict on which family is most controllable. Making that comparison fair, with equal effort and correct attribution, is exactly what SENTINEL is for.

So “which model writes more reliably” turns out to be the wrong question. The real one is which model lets you build the most system around the userprompt\_init read write, and turn\_end mechanics. That was his comment, followed by the floor.

github.com/H-XX-D/recall-memory-substrate