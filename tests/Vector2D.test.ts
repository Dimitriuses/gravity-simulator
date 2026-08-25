import { describe, it, expect } from 'vitest';
import { Vector2D } from '../src/Vector2D';

describe('Vector2D', () => {
  it('is immutable — operations return new vectors', () => {
    const a = new Vector2D(3, 4);
    const b = new Vector2D(1, 1);

    a.add(b);
    a.sub(b);
    a.mult(10);

    expect(a.x).toBe(3);
    expect(a.y).toBe(4);
  });

  it('adds, subtracts, scales and divides componentwise', () => {
    const a = new Vector2D(3, 4);
    const b = new Vector2D(1, 2);

    expect(a.add(b)).toMatchObject({ x: 4, y: 6 });
    expect(a.sub(b)).toMatchObject({ x: 2, y: 2 });
    expect(a.mult(2)).toMatchObject({ x: 6, y: 8 });
    expect(a.div(2)).toMatchObject({ x: 1.5, y: 2 });
  });

  it('measures magnitude', () => {
    expect(new Vector2D(3, 4).magnitude()).toBe(5);
    expect(new Vector2D(3, 4).magnitudeSquared()).toBe(25);
    expect(new Vector2D(0, 0).magnitude()).toBe(0);
  });

  it('normalizes to unit length', () => {
    const n = new Vector2D(3, 4).normalize();
    expect(n.magnitude()).toBeCloseTo(1, 12);
    expect(n.x).toBeCloseTo(0.6, 12);
    expect(n.y).toBeCloseTo(0.8, 12);
  });

  // Both guards matter: the field sampler divides by distance at points that
  // can coincide exactly with a particle.
  it('degrades safely instead of producing NaN', () => {
    expect(new Vector2D(0, 0).normalize()).toMatchObject({ x: 0, y: 0 });
    expect(new Vector2D(5, 5).div(0)).toMatchObject({ x: 0, y: 0 });
  });

  it('limits magnitude without changing direction', () => {
    const limited = new Vector2D(30, 40).limit(5);
    expect(limited.magnitude()).toBeCloseTo(5, 12);
    expect(limited.x).toBeCloseTo(3, 12);

    // Already under the limit: returned unchanged.
    expect(new Vector2D(1, 1).limit(5)).toMatchObject({ x: 1, y: 1 });
  });

  it('measures distance between points', () => {
    expect(new Vector2D(0, 0).dist(new Vector2D(3, 4))).toBe(5);
  });

  it('builds a vector from an angle', () => {
    const v = Vector2D.fromAngle(Math.PI / 2, 10);
    expect(v.x).toBeCloseTo(0, 12);
    expect(v.y).toBeCloseTo(10, 12);
  });

  it('copies without aliasing', () => {
    const original = new Vector2D(1, 2);
    const copy = original.copy();
    copy.x = 99;
    expect(original.x).toBe(1);
  });
});

describe('dot', () => {
  it('multiplies parallel components and cancels perpendicular ones', () => {
    expect(new Vector2D(3, 4).dot(new Vector2D(2, 1))).toBeCloseTo(10, 12);
    expect(new Vector2D(1, 0).dot(new Vector2D(0, 1))).toBeCloseTo(0, 12);
  });

  it('gives the signed component of one vector along a unit vector', () => {
    // What the collision solver uses it for: is this pair approaching or
    // separating along the contact normal?
    const normal = new Vector2D(1, 0);
    expect(new Vector2D(-4, 7).dot(normal)).toBeCloseTo(-4, 12);
  });

  it('is the squared magnitude against itself', () => {
    const v = new Vector2D(-5, 12);
    expect(v.dot(v)).toBeCloseTo(v.magnitudeSquared(), 12);
  });
});
