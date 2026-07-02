---
title: "Your agent's memory should compute confidence, not store it"
datePublished: 2026-06-19T00:28:21.365Z
cuid: cmqk6x7fo00000cko39ire4jd
slug: your-agent-s-memory-should-compute-confidence-not-store-it
canonical: https://dev.to/hendrixxcnc/your-agents-memory-should-compute-confidence-not-store-it-c2a
cover: https://cdn.hashnode.com/uploads/covers/6a338dc87bf3ea1f3591dbb9/10c6711e-3934-412d-a6d3-0d7acb56b977.png
ogImage: https://cdn.hashnode.com/uploads/og-images/6a338dc87bf3ea1f3591dbb9/fcd71313-4546-40c1-a467-ae80f629a332.png
tags: memory-management, llm, agentic-ai

---

Most agent memory stores a confidence score the way it stores everything else. You  
write it once and it sits there. The agent decides a fact is worth 0.9, the store  
keeps 0.9, and three weeks later, after something has contradicted that fact, the  
store still hands back 0.9. Confidence was a number written at one moment and  
never looked at again. It is stale, and nothing in the system knows it.

That is the quiet failure of pull memory. You query, it returns the closest  
matches with whatever score they were saved at, and noticing that a fact has gone  
soft is on you.

Recall takes the other path. Effective confidence is not a stored field. It is  
recomputed from the graph every time you read, so a contradiction landing anywhere  
drops the claim's confidence on the next query, with no model rerun and no human  
in the loop.

The formula

It is plain arithmetic, on purpose. For a cell, the effective confidence is:

effective = clamp01( stated × calibration + support − challenge )

*   stated is what the author claimed when they wrote it.
    
*   calibration discounts the author by their track record.
    
*   support is corroboration from incoming supports edges.
    
*   challenge is the weight of incoming contradicts and concerns edges.
    

Support and challenge are not raw sums. Each is squashed through a saturation  
curve with a different ceiling:

support = 0.15 × tanh(supportMass)  
challenge = 0.60 × tanh(challengeMass)

The asymmetry is the whole point. Corroboration is cheap to manufacture, so  
support saturates fast under a low ceiling: stack ten agreeing cells and you add  
at most 0.15. Real contradiction is rare and informative, so challenge runs to a  
0.6 ceiling. One honest contradiction can move a claim further than a pile of  
agreement.

A worked example you can check

A fresh claim, stated 0.9, author with no track record yet, no support, no  
challenge:

effective = clamp01(0.9 × 1 + 0 − 0) = 0.90

One contradiction lands from a source stated at 1.0, a challengeMass of 1.0:

challenge = 0.60 × tanh(1.0) = 0.457  
effective = clamp01(0.90 − 0.457) = 0.44

The same claim now reads 0.44. Nobody edited it. A second contradiction pushes the  
mass to 2.0:

challenge = 0.60 × tanh(2.0) = 0.578  
effective = clamp01(0.90 − 0.578) = 0.32

Down to 0.32, and the original 0.9 is still on record, just demoted. Ten  
supporting cells would have added at most 0.15. Cheap agreement barely moves it; a  
real challenge moves it a lot.

Calibration, and one honest choice in it

Before support and challenge apply, the author's stated number is multiplied by a  
calibration factor. An author contradicted before gets discounted, by how often  
they were wrong times how confident they were when wrong, floored at 0.5 so it  
never zeroes anyone out.

The honest detail is what it is not. It is not raw Brier scoring. Raw Brier also  
punishes a humble author who hedges low on claims that turn out fine, and  
punishing humility is the opposite of the incentive a memory system should create.  
So the discount keys on overconfidence specifically, being wrong while sure.  
Hedge honestly and you are not penalized. Claim 0.95 and get contradicted and you  
are.

Why this beats a stored score

A vector store returns the score a chunk was embedded with. A flat notes file  
returns whatever it says. Neither knows the fact was contradicted last Tuesday,  
because the contradiction is not part of how the score is computed. The score and  
the conflict live in different places.

In Recall they live in the same place. The contradiction is an edge on the graph,  
and the score is computed from the graph, so the moment the edge exists the score  
reflects it, on the next read, deterministically. The reader is the same agent  
that wrote the memory, working from fresh context, and the substrate reprices what  
it knows underneath it.

What it is not

This is a ranking signal, not a verdict on truth. A low effective confidence means  
a claim is contested or comes from an author who has been wrong while sure, not  
that it is false. The ceilings and curves are tunable defaults. And it is  
deliberately deterministic arithmetic over the graph, not a model second-guessing  
itself, which is what makes it inspectable: open any cell and see why its number  
is what it is, term by term.

That is the trade. You give up a number that looks stable and never moves. You get  
one you can recompute, that demotes a stale claim the instant the evidence turns,  
and that you can read the reasons for. For an agent that has to act on what it  
remembers, the second is worth more.

Recall is local-first, runs on SQLite, and sets up with one command. The code and  
the formula above are open: github.com/H-XX-D/recall-memory-substrate