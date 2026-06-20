---
title: "How an agent memory learns who to trust, without retraining anything"
published: false
description: "Confidence is self-reported, so a memory full of agents needs to learn whose claims to trust. Here is how a graph does it with a scorecard you cannot game by hedging, and why the penalty deliberately is not raw Brier."
tags: ai, llm, agents, machinelearning
---

Every confidence number in an agent's memory is self-reported. The agent decides a fact is worth 0.9 and writes 0.9. That is fine until you have more than one writer, a few subagents, a teammate, a background job, each stamping its own numbers. Now some sources are well calibrated and some are chronically sure and chronically wrong, and a store that takes every 0.9 at face value trusts them equally.

You want the memory to learn whose claims to lean on. The catch is you do not want to fine-tune a model to do it. Recall does it with arithmetic over the graph, and the interesting part is a design choice in how the penalty works.

## A scorecard you cannot game by hedging

For each actor, the graph keeps a record. Take all of that actor's cells, mark the ones still standing as successes and the ones that got contradicted as failures, and score their stated confidence against those outcomes with a Brier score.

Brier is a proper scoring rule, and that property is the whole point. With a proper rule, the only way to get a good score is to state your true probability. You cannot improve it by always hedging low, because then you score badly on the many claims that turn out fine. You cannot improve it by always claiming high, because then you score badly on the ones that get contradicted. Honesty is the optimal strategy by the math, not by a policy someone wrote. So an actor's calibration record is something they earn by being accurate, and cannot fake by being strategically vague.

That gives you an honest scorecard. `recall calibration` will show it to you per actor: how many cells, how often contradicted, mean confidence, and the Brier score.

## The penalty is deliberately not the Brier score

Here is the part most systems get wrong. The scorecard is a measure, not the penalty. If you take raw Brier and use it to discount an actor's future claims, you punish the wrong people.

Raw Brier dings a humble author too. Someone who hedges at 0.6 on claims that turn out fine still takes a Brier hit for not having said 0.95, because the outcome was a success and they were "underconfident." Penalizing an author for being modest and right is exactly the behavior a memory system should not create. You want people to hedge honestly, not to learn that hedging costs them standing.

So the discount Recall actually applies keys on overconfidence specifically. For each actor it computes:

```
overconfidence = contradicted_rate × mean_confidence_when_contradicted
factor         = max(0.5, 1 − overconfidence)
```

In words: how often you were wrong, times how sure you were when you were wrong. An author contradicted ten percent of the time, at an average stated confidence of 0.9 on those wrong cells, has an overconfidence of 0.09 and a factor of 0.91, so their future claims enter at ninety-one percent of stated. An author wrong thirty percent of the time at 0.9 when wrong lands at a factor of 0.73. Hedge honestly and you are not touched, because being modest does not raise your contradicted-while-confident number. Claim 0.95 and get contradicted and you are.

Two guards keep it sane. The factor is floored at 0.5, so the system never zeroes anyone out entirely, a bad streak demotes you, it does not erase you. And it stays neutral until an actor has at least three cells, because three contradictions out of three is noise, not a track record.

## Without retraining anything

There is no model in this. No fine-tune, no gradient, no second network learning who to trust. It is a deterministic count over the contradiction outcomes already sitting in the graph. The graph is the training data, and the scorecard is recomputed when you read, so it adapts as the record grows, continuously, with nothing retrained and nothing to redeploy.

That matters most when the memory has many writers. You can point several agents and subagents at one store. The calibration factor is what keeps a noisy or overconfident one from quietly poisoning the shared trust: its claims come in discounted, automatically, with no per-actor rule written anywhere. A chronically wrong approver's vote stops counting on its own. The same mechanism, no special case.

## What it is and is not

It is a discount on trust, not a verdict on truth. A low factor means an author has been wrong while sure, so weight their claims less, not that any given claim is false.

It also depends on the contradictions being real edges to real cells. The score only counts a contradiction that resolves to an actual prior cell, so if your corrections are free text that never links back to what they correct, the loop starves and the scorecard stays flat. That is the same supersession discipline the rest of the system runs on: a correction has to point at what it corrects, by id, or it does not count.

And it needs a little history. Under three cells, everyone is neutral, because there is nothing yet to judge.

That is the trade. You give up treating every self-reported number as equally true. You get a memory that keeps an honest, ungameable record of its own sources and quietly leans away from the ones that have been confidently wrong, without anyone training a thing.

Recall is local-first, runs on SQLite, and the calibration math above is open: github.com/H-XX-D/recall-memory-substrate
