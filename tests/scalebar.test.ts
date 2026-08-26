import { describe, it, expect } from 'vitest';
import { SCALE_BAR_MAX_PX, SCALE_BAR_MIN_PX, niceScaleLength } from '../src/scalebar';

/**
 * The ruler's whole job is to be believed, so the two things worth checking are
 * that its length is always a number a person would have chosen, and that it is
 * always long enough on screen to read and short enough to fit.
 */

/** The lengths a hand-drawn ruler would use: 1, 2, 5 and their decades. */
const isRound = (value: number): boolean => {
  const decade = Math.pow(10, Math.floor(Math.log10(value)));
  const multiple = value / decade;
  return [1, 2, 5].some((step) => Math.abs(multiple - step) < 1e-9);
};

describe('picking a length', () => {
  it('stays inside the readable band at every zoom the camera allows', () => {
    // The camera clamps zoom to [0.1, 5]; the sweep goes well past both ends.
    for (let zoom = 0.01; zoom <= 20; zoom *= 1.07) {
      const { length } = niceScaleLength(zoom);
      const pixels = length * zoom;

      expect(pixels, `zoom ${zoom.toFixed(3)}`).toBeGreaterThanOrEqual(SCALE_BAR_MIN_PX);
      expect(pixels, `zoom ${zoom.toFixed(3)}`).toBeLessThanOrEqual(SCALE_BAR_MAX_PX);
    }
  });

  it('only ever picks a round number', () => {
    for (let zoom = 0.01; zoom <= 20; zoom *= 1.07) {
      const { length } = niceScaleLength(zoom);
      expect(isRound(length), `zoom ${zoom.toFixed(3)} gave ${length}`).toBe(true);
    }
  });

  it('shortens the ruler as the view zooms in', () => {
    // Zooming in means fewer world units across the same pixels, so the bar
    // must measure less, never more.
    let previous = Infinity;

    for (const zoom of [0.1, 0.25, 0.5, 1, 2, 4]) {
      const { length } = niceScaleLength(zoom);
      expect(length).toBeLessThanOrEqual(previous);
      previous = length;
    }
  });

  it('writes the length the way a person would', () => {
    expect(niceScaleLength(1).label).toBe('100 units');
    expect(niceScaleLength(0.1).label).toBe('1,000 units');
    expect(niceScaleLength(5).label).toBe('20 units');
  });

  it('gives a usable answer for a zoom that makes no sense', () => {
    // The renderer calls this every frame; a NaN here would be a NaN on screen.
    for (const zoom of [0, -1, NaN, Infinity]) {
      const { length, label } = niceScaleLength(zoom);
      expect(Number.isFinite(length)).toBe(true);
      expect(length).toBeGreaterThan(0);
      expect(label).toMatch(/units$/);
    }
  });
});
