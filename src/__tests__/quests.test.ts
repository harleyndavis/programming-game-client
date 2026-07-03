import { describe, it, expect } from 'vitest';
import {
  findCompletableQuest,
  findTurnInNpc,
  evaluateQuest,
  findBestQuestToAccept,
  findBestAvailableQuest,
  findQuestGivers,
  findQuestTurnInRequiredItemIds,
  findPendingQuestTurnInItems,
  findStalledQuests,
  findQuestToAbandon,
  findQuestToDismiss,
  questRewardsNeededItem,
} from '../quests';
import type { ClientSideNPC, ActiveQuests, ActiveQuest } from 'programming-game/types';

describe('findQuestTurnInRequiredItemIds', () => {
  it('returns empty set for no active quests', () => {
    expect(findQuestTurnInRequiredItemIds({}).size).toBe(0);
  });

  it('collects required item ids from a turn_in current step', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { ratPelt: 3, stone: 1 }, position: {} }] },
    };
    const result = findQuestTurnInRequiredItemIds(quests);
    expect(result.has('ratPelt')).toBe(true);
    expect(result.has('stone')).toBe(true);
    expect(result.size).toBe(2);
  });

  it('ignores quests whose current step is not a turn_in', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'kill', targets: { rat: { required: 3, killed: 1 } } } as any] },
    };
    expect(findQuestTurnInRequiredItemIds(quests).size).toBe(0);
  });

  it('skips a turn_in step behind an incomplete goto step', () => {
    const quests: ActiveQuests = {
      q1: {
        id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1',
        steps: [
          { type: 'goto', position: { x: 1, y: 1 }, completed: false },
          { type: 'turn_in', target: 'npc1', requiredItems: { ratPelt: 3 }, position: {} },
        ],
      },
    };
    expect(findQuestTurnInRequiredItemIds(quests).size).toBe(0);
  });

  it('finds the turn_in step once a preceding goto step completes', () => {
    const quests: ActiveQuests = {
      q1: {
        id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1',
        steps: [
          { type: 'goto', position: { x: 1, y: 1 }, completed: true },
          { type: 'turn_in', target: 'npc1', requiredItems: { ratPelt: 3 }, position: {} },
        ],
      },
    };
    expect(findQuestTurnInRequiredItemIds(quests).has('ratPelt')).toBe(true);
  });

  it('treats a turn_in step with no requiredItems as needing nothing', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', position: {} }] },
    };
    expect(findQuestTurnInRequiredItemIds(quests).size).toBe(0);
  });
});

describe('findPendingQuestTurnInItems', () => {
  it('returns empty for no active quests', () => {
    expect(findPendingQuestTurnInItems({}, {})).toEqual({});
  });

  it('returns the shortfall against current inventory', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { ratPelt: 5 }, position: {} }] },
    };
    expect(findPendingQuestTurnInItems(quests, { ratPelt: 2 })).toEqual({ ratPelt: 3 });
  });

  it('omits items already fully satisfied', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { ratPelt: 5 }, position: {} }] },
    };
    expect(findPendingQuestTurnInItems(quests, { ratPelt: 5 })).toEqual({});
  });

  it('sums per-quest shortfalls, each computed against the same current inventory', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { ratPelt: 3 }, position: {} }] },
      q2: { id: 'q2', start_npc: 'npc2', end_npc: 'npc2', name: 'Q2', steps: [{ type: 'turn_in', target: 'npc2', requiredItems: { ratPelt: 4 }, position: {} }] },
    };
    // q1 shortfall = 3-1 = 2, q2 shortfall = 4-1 = 3 (each vs. the same pocket qty, not decremented)
    expect(findPendingQuestTurnInItems(quests, { ratPelt: 1 })).toEqual({ ratPelt: 5 });
  });
});

describe('findStalledQuests', () => {
  it('returns empty when no quests are active', () => {
    expect(findStalledQuests({}, {}, new Set())).toEqual([]);
  });

  it('flags a quest whose turn-in item is short and unobtainable', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { feather: 3 }, position: {} }] },
    };
    const result = findStalledQuests(quests, {}, new Set(['feather']));
    expect(result.map(q => q.id)).toEqual(['q1']);
  });

  it('does not flag a quest whose item is short but obtainable', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { stone: 3 }, position: {} }] },
    };
    expect(findStalledQuests(quests, {}, new Set(['feather']))).toEqual([]);
  });

  it('does not flag a quest whose item is already satisfied, even if marked unobtainable', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { feather: 3 }, position: {} }] },
    };
    expect(findStalledQuests(quests, { feather: 3 }, new Set(['feather']))).toEqual([]);
  });

  it('ignores quests whose current step is not a turn_in', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'kill', targets: { rat: { required: 3, killed: 1 } } } as any] },
    };
    expect(findStalledQuests(quests, {}, new Set(['feather']))).toEqual([]);
  });

  it('returns every stalled quest, not just the first', () => {
    const quests: ActiveQuests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in', target: 'npc1', requiredItems: { feather: 1 }, position: {} }] },
      q2: { id: 'q2', start_npc: 'npc2', end_npc: 'npc2', name: 'Q2', steps: [{ type: 'turn_in', target: 'npc2', requiredItems: { chickenMeat: 1 }, position: {} }] },
    };
    const result = findStalledQuests(quests, {}, new Set(['feather', 'chickenMeat']));
    expect(result.map(q => q.id).sort()).toEqual(['q1', 'q2']);
  });
});

describe('findCompletableQuest', () => {
  it('returns null for empty active quests', () => {
    expect(findCompletableQuest({}, {})).toBeNull();
  });

  it('returns null when no quest has required items satisfied', () => {
    const quests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in' as const, target: 'npc1', requiredItems: { ratPelt: 3 }, position: {} }] },
    };
    expect(findCompletableQuest(quests, { ratPelt: 2 })).toBeNull();
  });

  it('returns quest when turn_in required items are satisfied', () => {
    const quests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in' as const, target: 'npc1', requiredItems: { ratPelt: 3 }, position: {} }] },
    };
    const result = findCompletableQuest(quests, { ratPelt: 5 });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('q1');
  });

  it('skips quests without turn_in steps', () => {
    const quests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'kill' as const, targets: { rat: { required: 3, killed: 2 } } }] },
    };
    expect(findCompletableQuest(quests, {})).toBeNull();
  });

  it('returns first completable quest when multiple exist', () => {
    const quests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [{ type: 'turn_in' as const, target: 'npc1', requiredItems: { ratPelt: 3 }, position: {} }] },
      q2: { id: 'q2', start_npc: 'npc2', end_npc: 'npc2', name: 'Q2', steps: [{ type: 'turn_in' as const, target: 'npc2', requiredItems: { copperOre: 5 }, position: {} }] },
    };
    const result = findCompletableQuest(quests, { ratPelt: 5, copperOre: 1 });
    expect(result).not.toBeNull();
    expect(result!.id).toBe('q1');
  });
});

describe('findTurnInNpc', () => {
  const npcs = [
    { id: 'npc1', type: 'npc' as const, name: 'Alice', availableQuests: {} },
    { id: 'npc2', type: 'npc' as const, name: 'Bob', availableQuests: {} },
  ] as unknown as ClientSideNPC[];

  it('returns the NPC matching quest.end_npc', () => {
    const quest = { id: 'q1', start_npc: 'npc1', end_npc: 'npc2', name: 'Q1', steps: [] };
    const result = findTurnInNpc(quest, npcs);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('npc2');
  });

  it('returns null when no NPC matches end_npc', () => {
    const quest = { id: 'q1', start_npc: 'npc1', end_npc: 'npc3', name: 'Q1', steps: [] };
    expect(findTurnInNpc(quest, npcs)).toBeNull();
  });

  it('returns null for empty units', () => {
    const quest = { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [] };
    expect(findTurnInNpc(quest, [])).toBeNull();
  });
});

describe('evaluateQuest', () => {
  it('returns 0 for no reward items', () => {
    const quest = { id: 'q1', name: 'Q1', repeatable: false, steps: [], rewards: { items: {} } };
    expect(evaluateQuest(quest)).toBe(0);
  });

  it('sums reward item quantities', () => {
    const quest = { id: 'q1', name: 'Q1', repeatable: false, steps: [], rewards: { items: { copperCoin: 100, ratPelt: 3 } } };
    expect(evaluateQuest(quest)).toBe(103);
  });

  it('returns 1 when rewards is undefined', () => {
    const quest = { id: 'q1', name: 'Q1', repeatable: false, steps: [], rewards: undefined as any };
    expect(evaluateQuest(quest)).toBe(1);
  });
});

describe('findBestQuestToAccept', () => {
  const npcWithQuests = {
    id: 'npc1', type: 'npc' as const, name: 'QuestGiver',
    availableQuests: {
      q1: { id: 'q1', name: 'Quest 1', repeatable: false, steps: [], rewards: { items: { copperCoin: 50 } } },
      q2: { id: 'q2', name: 'Quest 2', repeatable: true, steps: [], rewards: { items: { copperCoin: 100 } } },
    },
  } as unknown as ClientSideNPC;

  it('returns the highest-reward quest', () => {
    const result = findBestQuestToAccept([npcWithQuests], {}, 5);
    expect(result).not.toBeNull();
    expect(result!.quest.id).toBe('q2');
  });

  it('skips already-active quests', () => {
    const active = { q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [] } };
    const result = findBestQuestToAccept([npcWithQuests], active, 5);
    expect(result).not.toBeNull();
    expect(result!.quest.id).toBe('q2');
  });

  it('returns null at max active quests', () => {
    const active = { a: {} as any, b: {} as any, c: {} as any, d: {} as any, e: {} as any };
    expect(findBestQuestToAccept([npcWithQuests], active, 5)).toBeNull();
  });

  it('returns null when no quest givers', () => {
    expect(findBestQuestToAccept([], {}, 5)).toBeNull();
  });
});

describe('findQuestGivers', () => {
  it('returns NPCs with available quests', () => {
    const npcs = [
      { id: 'npc1', availableQuests: { q1: {} } },
      { id: 'npc2', availableQuests: {} },
      { id: 'npc3', availableQuests: { q2: {} } },
    ] as unknown as ClientSideNPC[];
    const result = findQuestGivers(npcs);
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.id)).toEqual(['npc1', 'npc3']);
  });

  it('returns empty array when no NPC has quests', () => {
    const npcs = [
      { id: 'npc1', availableQuests: {} },
      { id: 'npc2', availableQuests: {} },
    ] as unknown as ClientSideNPC[];
    expect(findQuestGivers(npcs)).toHaveLength(0);
  });

  it('returns empty array for empty input', () => {
    expect(findQuestGivers([])).toHaveLength(0);
  });
});

describe('evaluateQuest with scoring opts', () => {
  it('boosts quests rewarding a needed item above any reward count', () => {
    const filler = { id: 'filler', name: 'Filler', repeatable: false, steps: [], rewards: { items: { copperCoin: 500 } } };
    const needed = { id: 'needed', name: 'Needed', repeatable: true, steps: [], rewards: { items: { stone: 1 } } };
    const opts = { neededItems: new Set(['stone']) };
    expect(evaluateQuest(needed, opts)).toBeGreaterThan(evaluateQuest(filler, opts));
  });

  it('uses reward patches when the server omits rewards', () => {
    const quest = { id: 'wood_for_stone', name: 'Wood for Stone', repeatable: true, steps: [], rewards: undefined as any };
    const opts = {
      neededItems: new Set(['stone']),
      rewardPatches: { wood_for_stone: { stone: 1 } },
    };
    expect(evaluateQuest(quest, opts)).toBeGreaterThan(1000);
  });

  it('does not boost when no reward item is needed', () => {
    const quest = { id: 'q1', name: 'Q1', repeatable: false, steps: [], rewards: { items: { ratPelt: 3 } } };
    expect(evaluateQuest(quest, { neededItems: new Set(['stone']) })).toBe(3);
  });

  it('zeroes a fully-stocked reward below the unknown-reward fallback', () => {
    const quest = { id: 'q1', name: 'Q1', repeatable: true, steps: [], rewards: { items: { stoneCutterTools: 1 } } };
    const score = evaluateQuest(quest, { stockedItems: new Set(['stoneCutterTools']) });
    expect(score).toBeLessThan(1); // below the fallback score for a totally unknown reward
    expect(score).toBe(0);
  });

  it('only zeroes the stocked portion of a mixed reward', () => {
    const quest = { id: 'q1', name: 'Q1', repeatable: true, steps: [], rewards: { items: { stoneCutterTools: 1, copperCoin: 50 } } };
    expect(evaluateQuest(quest, { stockedItems: new Set(['stoneCutterTools']) })).toBe(50);
  });

  it('stocked and needed are checked independently — needed bonus still applies to other reward items', () => {
    const quest = { id: 'q1', name: 'Q1', repeatable: true, steps: [], rewards: { items: { stoneCutterTools: 1, stone: 1 } } };
    const score = evaluateQuest(quest, { stockedItems: new Set(['stoneCutterTools']), neededItems: new Set(['stone']) });
    // stoneCutterTools contributes 0, stone contributes 1 + the needed bonus
    expect(score).toBeGreaterThan(1000);
  });
});

describe('findBestQuestToAccept with scoring opts', () => {
  it('prefers a patched needed-reward quest over a higher-count filler quest', () => {
    const npc = {
      id: 'guard', type: 'npc' as const, name: 'Guard',
      availableQuests: {
        wood_for_stone: { id: 'wood_for_stone', name: 'Wood for Stone', repeatable: true, steps: [], rewards: undefined as any },
        feather_cap: { id: 'feather_cap', name: 'A Feather in Your Cap', repeatable: false, steps: [], rewards: { items: { copperCoin: 200 } } },
      },
    } as unknown as ClientSideNPC;
    const result = findBestQuestToAccept([npc], {}, 5, {
      neededItems: new Set(['stone']),
      rewardPatches: { wood_for_stone: { stone: 1 } },
    });
    expect(result).not.toBeNull();
    expect(result!.quest.id).toBe('wood_for_stone');
  });

  it('a fully-stocked-reward quest loses to an unknown-reward quest at the same NPC', () => {
    const npc = {
      id: 'blacksmith', type: 'npc' as const, name: 'Blacksmith',
      availableQuests: {
        tool_quest: { id: 'tool_quest', name: 'Tool Quest', repeatable: true, steps: [], rewards: { items: { stoneCutterTools: 1 } } },
        mystery_quest: { id: 'mystery_quest', name: 'Mystery Quest', repeatable: false, steps: [], rewards: undefined as any },
      },
    } as unknown as ClientSideNPC;
    const result = findBestQuestToAccept([npc], {}, 5, { stockedItems: new Set(['stoneCutterTools']) });
    expect(result).not.toBeNull();
    expect(result!.quest.id).toBe('mystery_quest');
  });
});

describe('questRewardsNeededItem', () => {
  const quest = { id: 'q1', name: 'Q1', repeatable: false, steps: [], rewards: { items: { stone: 1 } } };

  it('returns false when neededItems is undefined', () => {
    expect(questRewardsNeededItem(quest, undefined)).toBe(false);
  });

  it('returns false when neededItems is empty', () => {
    expect(questRewardsNeededItem(quest, new Set())).toBe(false);
  });

  it('returns true when a reward item is needed', () => {
    expect(questRewardsNeededItem(quest, new Set(['stone']))).toBe(true);
  });

  it('returns false when no reward item is needed', () => {
    expect(questRewardsNeededItem(quest, new Set(['feather']))).toBe(false);
  });

  it('checks the reward patch instead of quest.rewards when a patch is provided', () => {
    const patched = { id: 'wood_for_stone', name: 'Wood for Stone', repeatable: true, steps: [], rewards: undefined as any };
    expect(questRewardsNeededItem(patched, new Set(['stone']), { wood_for_stone: { stone: 1 } })).toBe(true);
    expect(questRewardsNeededItem(patched, new Set(['stone']))).toBe(false);
  });
});

describe('findBestAvailableQuest', () => {
  const npc = {
    id: 'guard', type: 'npc' as const, name: 'Guard',
    availableQuests: {
      wood_for_stone: { id: 'wood_for_stone', name: 'Wood for Stone', repeatable: true, steps: [], rewards: { items: { copperCoin: 10 } } },
    },
  } as unknown as ClientSideNPC;

  it('returns a candidate even when quest capacity is full', () => {
    const active = { a: {} as any, b: {} as any, c: {} as any, d: {} as any, e: {} as any };
    expect(findBestAvailableQuest([npc], active)).not.toBeNull();
    // The capacity-respecting variant returns null in the identical scenario.
    expect(findBestQuestToAccept([npc], active, 5)).toBeNull();
  });

  it('still skips already-active quests', () => {
    const active = { wood_for_stone: {} as any };
    expect(findBestAvailableQuest([npc], active)).toBeNull();
  });

  it('returns null when there are no quest givers', () => {
    expect(findBestAvailableQuest([], {})).toBeNull();
  });
});

describe('findQuestToAbandon', () => {
  const stalledQuest: ActiveQuest = {
    id: 'stalled1', start_npc: 'healer_name', end_npc: 'healer_name', name: 'Stalled',
    steps: [{ type: 'turn_in', target: 'healer_name', requiredItems: { feather: 1 }, position: {} }],
  };
  const neededQuestCandidate = {
    npc: { id: 'guard' } as unknown as ClientSideNPC,
    quest: { id: 'wood_for_stone', name: 'Wood for Stone', repeatable: true, steps: [], rewards: { items: { stone: 1 } } },
  };
  const neededItems = new Set(['stone']);

  it('returns null when not at capacity', () => {
    expect(findQuestToAbandon([stalledQuest], false, neededQuestCandidate, neededItems)).toBeNull();
  });

  it('returns null when there are no stalled quests', () => {
    expect(findQuestToAbandon([], true, neededQuestCandidate, neededItems)).toBeNull();
  });

  it('returns null when nothing is waiting to be accepted', () => {
    expect(findQuestToAbandon([stalledQuest], true, null, neededItems)).toBeNull();
  });

  it('returns null when the waiting quest does not reward a needed item', () => {
    const fillerCandidate = {
      npc: { id: 'guard' } as unknown as ClientSideNPC,
      quest: { id: 'filler', name: 'Filler', repeatable: false, steps: [], rewards: { items: { copperCoin: 500 } } },
    };
    expect(findQuestToAbandon([stalledQuest], true, fillerCandidate, neededItems)).toBeNull();
  });

  it('returns the stalled quest when capacity is full and a needed quest is waiting', () => {
    const result = findQuestToAbandon([stalledQuest], true, neededQuestCandidate, neededItems);
    expect(result?.id).toBe('stalled1');
  });

  it('respects reward patches when judging the waiting quest', () => {
    const patchedCandidate = {
      npc: { id: 'guard' } as unknown as ClientSideNPC,
      quest: { id: 'wood_for_stone', name: 'Wood for Stone', repeatable: true, steps: [], rewards: undefined as any },
    };
    expect(findQuestToAbandon([stalledQuest], true, patchedCandidate, neededItems)).toBeNull();
    const result = findQuestToAbandon([stalledQuest], true, patchedCandidate, neededItems, { wood_for_stone: { stone: 1 } });
    expect(result?.id).toBe('stalled1');
  });
});

describe('findQuestToDismiss', () => {
  it('returns null for empty active quests', () => {
    expect(findQuestToDismiss({})).toBeNull();
  });

  it('returns an active quest when one exists', () => {
    const quests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [] },
    };
    const result = findQuestToDismiss(quests);
    expect(result).not.toBeNull();
    expect(result!.id).toBe('q1');
  });

  it('returns one quest at a time when multiple are active', () => {
    const quests = {
      q1: { id: 'q1', start_npc: 'npc1', end_npc: 'npc1', name: 'Q1', steps: [] },
      q2: { id: 'q2', start_npc: 'npc2', end_npc: 'npc2', name: 'Q2', steps: [] },
    };
    const result = findQuestToDismiss(quests);
    expect(result).not.toBeNull();
    expect(['q1', 'q2']).toContain(result!.id);
  });
});
