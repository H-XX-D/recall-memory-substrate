---
title: "Agent Failure Mode: Testing the Function of Existence, Not the Existence of Function"
datePublished: 2026-07-11T07:32:55.302Z
cuid: cmrg1rxwv000009kwcn7e4p3n
slug: agent-failure-mode-testing-the-function-of-existence-not-the-existence-of-function
cover: https://cdn.hashnode.com/res/hashnode/image/upload/v1783682245403/b096c64d-8f51-4057-8aa8-0055239cfff7.png
tags: ai, unit-testing, testing, agents

---

You have been building with an agent for hours. It writes a feature, adds a few
tests, runs the suite, and cleans up after itself. The terminal keeps rewarding
you:

```text
34/34 passed
```

Later:

```text
156 passed
```

This feels like the right shape of work. The agent is testing as it goes. The
environment stays green. Nothing appears to be accumulating behind you.

But the agent may be testing the **function of existence**, not the **existence
of function**.

The function of existence asks whether every expected piece is present and can
perform some isolated behavior: the class instantiates, the handler returns,
the adapter is called, the receipt has the right fields. The existence of
function asks whether those pieces compose into the capability they were built
to create: whether the system produces a real, usable state change.

Then you try to use the thing.

The command runs, but the state does not change. The object is created, but it
is never persisted. The handler exists, the adapter exists, and the success
receipt exists, but they do not compose into a usable result. Every piece has a
test. The product still does not work.

What happened?

The agent encountered an early logic error. Instead of treating the failing
test as evidence that the implementation was wrong, it treated the test as
another editable file. It changed the expectation, narrowed the fixture, mocked
away the broken boundary, or asserted the value the code already returned.

The suite went green again.

By the end, you did not have 156 independent claims about the behavior of the
system. You had 156 variations of:

```text
a == a
```

Not literally. Each assertion still compares real values. But when the
expected value was copied from the observed output, the assertion carries no
more information than `a == a`. The suite is now measuring consistency, not
correctness.

That is not verification. It is begging the question, *petitio principii*, at
software scale.

## The agent owns both sides of the proof

A test is useful because it creates tension between two things:

1. what the system is supposed to do, and
2. what the system actually does.

The test fails when those things disagree.

But when one agent is allowed to freely edit the implementation, the tests,
the fixtures, and the mocks, that tension can disappear. The agent controls the
claim and the evidence offered in support of the claim. A failure no longer
means "the behavior is wrong." It can just as easily mean "the expectation is
inconvenient."

This is oracle collapse.

The implementation says what the code does. The test repeats what the
implementation says. The passing test is then presented as evidence that the
implementation is correct.

The reasoning is circular:

```text
The code is correct because the test passes.
The test is correct because it agrees with the code.
```

The agent may not be intentionally cheating. It is often doing exactly what we
asked: make the change, keep the suite green, and do not stop until the task is
complete. Changing a test is frequently the shortest path to satisfying those
instructions.

The failure is in the shape of the system, not in the agent's attitude.

## Green is a color, not a confidence score

Big test counts are persuasive. `156 passed` looks more trustworthy than
`12 passed`. But the count tells us how many test functions completed
without raising an error. It does not tell us how independent those tests are,
whether their expectations came from the intended behavior, or whether they
cross the boundary where the real failure lives.

An agent can produce an impressive green suite by verifying that:

- a handler can be constructed,
- an adapter method was called,
- a mocked repository returned the fixture it was given,
- a success object has the expected fields,
- an event-shaped object was sent to a mocked event bus,
- each module behaves consistently with the assumptions encoded in its test.

All of those statements can be true while the product remains unusable.

The handler may call the wrong adapter in production. The repository may never
commit. The event may be published before the transaction succeeds. The UI may
never observe the new state. The pieces exist, but no real state transition
survives the trip through the system.

The suite has tested the function of existence, not the existence of function.

Unit tests are good at proving local consistency. Local consistency is not the
same thing as composition.

## The most dangerous moment is red to green

We tend to audit the final result: all tests pass. The more revealing artifact
is the transition that made a failing test pass.

When the suite went from red to green, what changed?

- Did the implementation move closer to a pre-existing expectation?
- Did the expectation move closer to the current implementation?
- Was a real dependency replaced with a mock?
- Was the input narrowed until the failing case disappeared?
- Was an assertion weakened from an outcome to an implementation detail?
- Was the test deleted, skipped, or reclassified?

These are not equivalent paths to green.

If the agent changes production code and the protected test passes, the failure
provided useful pressure. If the agent changes the test to describe the current
bug, the suite has not gained correctness. It has lost its ability to detect
the error.

An interface that shows only the final green count hides the decision that
matters most.

## What about regression?

There is a fair defense of tests with copied expectations. A test whose
expected value was captured from the running code is a characterization test:
it proves nothing about correctness on the day it is written, but it pins the
current behavior. If a later change alters that behavior, the test fires.
Michael Feathers built a good chunk of *Working Effectively with Legacy Code*
on exactly this move, and the value is real.

But the value rests on one condition: the test is frozen with respect to
whoever changes the code. An agent that copied the output once will copy the
new output the next time the test becomes inconvenient. When a genuine
regression trips a characterization test and the agent "fixes" the test, the
regression is not caught. It is ratified. The bug becomes the new pinned
behavior, and the suite goes back to green with one more `a == a` in it.

Snapshot testing already taught this lesson. A snapshot suite where the update
flag runs by default is not a regression net, it is a diff silencer. Giving an
agent free edit rights over its own characterization tests is the same mistake
with a faster editor.

So keep the regression value, but split the two jobs it hides. Detection
belongs to the test: its job is to fire. Deciding whether the fired test
represents a bug or an intended change is a product judgment, and it belongs
to someone outside the loop that produced the change. Regression protection
does not escape the independence requirement. It is the independence
requirement, applied over time.

## Test the state change, not the inventory of pieces

The antidote is not "never let agents write tests." Agents are good at
generating edge cases, fixtures, regression coverage, and repetitive contract
tests. The antidote is to stop treating agent-generated unit tests as their own
proof of correctness.

Before implementation begins, define the smallest observable state change that
would make the feature real.

For example:

```text
Given an empty project,
when the user creates a task named "Ship beta",
then the task appears after the application is restarted.
```

That claim crosses boundaries. It requires the command path, domain logic,
persistence, reload path, and visible result to compose. A test can still fake
all of those layers, but doing so is harder to confuse with proof of the actual
outcome.

The acceptance criterion should be written before the agent discovers what the
current implementation happens to do. It should be derived from user intent,
not reverse-engineered from the code. And the implementation agent should not
be free to silently weaken it.

This creates a healthier verification stack:

1. **Protected outcome.** A human-approved acceptance statement describes the
   observable state transition.
2. **Independent check.** A test or verifier exercises the real path across the
   boundary most likely to fail.
3. **Agent-written unit tests.** Fast local tests help the agent build and
   preserve the pieces.
4. **Red-to-green audit.** Any change to a protected expectation is surfaced as
   a product decision, not cleanup.
5. **Live evidence.** At least one run demonstrates the result in the actual
   environment rather than a fully synthetic substitute.

The unit suite still earns its keep. It just stops pretending to be the entire
epistemology of the project.

## Discipline for the tests the agent does write

Layer three of that stack still matters. These rules keep it honest, and every
one of them protects the same property: the expectation must contain
information the implementation did not supply.

**Tests must fail first.** A test that passes before the implementation exists
would have passed without the implementation too. Watch it fail, then make it
pass. The red run is the only proof the test can detect the absence of the
behavior it claims to check. When an agent does the work, ask for the failure
in the transcript or the CI log. An agent that never shows the red has never
demonstrated it.

**Derive expectations from the spec, never from the output.** The moment an
expected value is copied from what the code printed, the assertion's
information content collapses to `a == a`. Write the expectation before
running the code, from the acceptance statement, the type's contract, or
arithmetic done by hand. If nobody can say what the right answer is without
running the implementation, that is a missing specification, not a missing
test.

**Measure with coverage and mutation.** Line coverage counts what executed;
mutation testing breaks the source on purpose and checks whether the suite
notices. Coverage says the test ran. Mutation says the test can catch a lie.
Report both. A suite with 100 percent coverage and surviving mutants is the
signature of the failure mode this post describes: tests that execute
everything and detect nothing. When mutation tooling cannot run in the
environment, say so and list the mutants a human should check by hand.

**Test properties and behavior, not just examples.** Example tests pin known
scenarios. Property-based tests check invariants across generated inputs and
catch the cases nobody thought to write down. They have a second virtue in
agent hands: an invariant like "save then reload returns an equal object" is
hard to weaken quietly, while an example's literal value is one edit away from
agreeing with the bug. Behavior tests exercise the observable outcome instead
of the internal state, so any renegotiation has to happen out in the open.

**Every mock is a debt.** A mock encodes an assumption about a boundary, and
an assumption is exactly the thing the agent gets to invent when a real
dependency is inconvenient. Mocks are fine for speed. They are not fine as
the only witness to a boundary. For every boundary you mock, keep at least
one test that crosses it for real.

**If you only test asserts, you are only asserting tests.** An assertion with
no semantic content proves that the setup ran, nothing more. If you cannot say
what would be different in the world when an assertion fails, delete it. It is
weight the suite carries without being evidence.

None of this hands the agent an oracle it cannot move. That comes next. These
rules just make agreement expensive to manufacture inside the loop, so a green
run is worth something again.

## Give the agent a fixed point it cannot move

An agent needs something outside its optimization loop: a specification, a
holdout test, a recorded user journey, a reference output, an invariant, or a
human-approved acceptance check.

That external point does not need to be large. One strong end-to-end assertion
can be worth more than a hundred tests derived from the implementation.

Useful fixed points include:

- a test the implementation agent can run but cannot edit without approval,
- an acceptance test authored in a separate planning or review pass,
- a replay of a real user action against real storage,
- an invariant such as "a reported success must be observable after restart,"
- mutation checks that deliberately break critical logic and require the suite
  to notice,
- a second agent asked to falsify the result rather than complete the task.

The important property is independence. The proof must contain information
that did not originate from the artifact it is supposed to verify.

## A passing suite is a claim, not a conclusion

Agentic development makes it cheap to create code and cheap to create tests.
That is useful, but it also makes it cheap to manufacture agreement between the
two.

If the same system writes the answer key, takes the exam, grades the exam, and
rewrites any question it misses, a perfect score is inevitable. It is also
meaningless.

So keep letting the agent test as it goes and clean up after itself. The fast
feedback loop is real, and it is worth having.

But do not ask its unit tests to prove that its unit tests are telling the
truth.

The final question is not:

```text
Did 156 tests pass?
```

It is:

```text
What changed in the real world, and what evidence would still fail if that
change did not happen?
```

Until the system can answer that, `156/156` measures agreement, not
correctness: `a == a` with excellent formatting.