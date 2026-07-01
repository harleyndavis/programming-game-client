import { describe, it, expect } from 'vitest';
import { isFiniteNumber, isFinitePosition, distanceBetween } from '../utils';

describe('isFiniteNumber', () => {
  it('returns true for finite numbers', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1)).toBe(true);
    expect(isFiniteNumber(3.14)).toBe(true);
    expect(isFiniteNumber(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('returns false for non-numbers', () => {
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
    expect(isFiniteNumber('42')).toBe(false);
    expect(isFiniteNumber({})).toBe(false);
    expect(isFiniteNumber([])).toBe(false);
  });

  it('returns false for non-finite numbers', () => {
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
    expect(isFiniteNumber(NaN)).toBe(false);
  });
});

describe('isFinitePosition', () => {
  it('returns true for valid positions', () => {
    expect(isFinitePosition({ x: 0, y: 0 })).toBe(true);
    expect(isFinitePosition({ x: -10, y: 3.5 })).toBe(true);
  });

  it('returns false for non-objects', () => {
    expect(isFinitePosition(null)).toBe(false);
    expect(isFinitePosition(undefined)).toBe(false);
    expect(isFinitePosition('string')).toBe(false);
  });

  it('returns false when x or y is missing or non-finite', () => {
    expect(isFinitePosition({})).toBe(false);
    expect(isFinitePosition({ x: 1 })).toBe(false);
    expect(isFinitePosition({ y: 1 })).toBe(false);
    expect(isFinitePosition({ x: NaN, y: 0 })).toBe(false);
    expect(isFinitePosition({ x: 0, y: Infinity })).toBe(false);
  });
});

describe('distanceBetween', () => {
  it('returns 0 for identical points', () => {
    expect(distanceBetween({ x: 0, y: 0 }, { x: 0, y: 0 })).toBe(0);
  });

  it('computes Euclidean distance', () => {
    const result = distanceBetween({ x: 0, y: 0 }, { x: 3, y: 4 });
    expect(result).toBe(5);
  });

  it('handles negative coordinates', () => {
    const result = distanceBetween({ x: -1, y: -1 }, { x: 2, y: 3 });
    expect(result).toBe(5);
  });

  it('is commutative', () => {
    const a = { x: 1, y: 2 };
    const b = { x: 10, y: 20 };
    expect(distanceBetween(a, b)).toBe(distanceBetween(b, a));
  });
});
