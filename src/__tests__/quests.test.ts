import { describe, it, expect } from 'vitest';
import {
  findCompletableQuest,
  findTurnInNpc,
  evaluateQuest,
  findBestQuestToAccept,
  findQuestGivers,
} from '../quests';
import type { ClientSideNPC } from 'programming-game/types';

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
