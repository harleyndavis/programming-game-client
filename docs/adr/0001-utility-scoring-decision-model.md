# ADR-0001: Utility scoring as the bot decision model

## Status
Accepted

## Context
The initial bot used a hard-coded priority stack: a cascade of `if` statements
where higher-priority conditions (low HP, encumbrance) unconditionally override
lower ones. This causes two failure modes:

1. **Blocking**: tasks run strictly in sequence even when they're compatible
   (e.g., the bot stands idle at the healer waiting for full HP before shopping,
   instead of shopping while healing).
2. **Threshold blindness**: rules apply regardless of context (e.g., fleeing at
   25% HP even when the target has 1 HP left and the bot is encumbered and
   cannot outrun it).

## Decision
Replace the priority stack with a **utility scoring model**: every candidate
action evaluates itself against current game state and produces a continuous
score. The highest-scoring action wins the single action slot each tick.

Action scores incorporate **net value**, not just immediate reward:
- Immediate reward (coins, items, progression)
- Travel cost (distance × speed penalty)
- Route danger cost (heat map threat along the path)
- Opportunity cost (positional penalty relative to next highest-priority goal)

The bot does not do multi-step lookahead — net value considers one step ahead
(current action + positioning for the next), not a full plan.

## Consequences
- Context overrides rules: a near-dead target raises the "finish the fight"
  score above "flee", even at low HP. An encumbered bot raises the "flee"
  cost enough that fighting on may score higher.
- Compatible goals (heal, shop, equip) compete for the action slot each tick
  rather than blocking each other in sequence.
- Adding a new behaviour means writing a scoring function, not finding the right
  place in a cascade.
- Scores must be calibrated against each other. Early implementation will
  require tuning; weights should be treated as observable parameters, not
  constants buried in logic.
- Thrashing (oscillating between similarly-scored actions) is mitigated by two
  complementary mechanisms: **hysteresis** (current action gets a score bonus)
  and **action commitment** (minimum tick duration per action, bypassed only by
  hard interrupts like HP = 0). Persistent thrashing after both signals a
  scoring design gap, not a mechanism failure.
- No global plan: the bot may make locally optimal choices that are globally
  suboptimal. Accepted as a reasonable starting point.
