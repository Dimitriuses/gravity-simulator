/**
 * Choosing the length of the ruler drawn along the bottom of the canvas.
 *
 * Separate from the renderer, and free of p5, for the usual reason: it is
 * arithmetic with a right answer, so it belongs somewhere a test can reach it
 * without a canvas.
 */

/** The range of on-screen lengths the ruler is allowed to take. */
export const SCALE_BAR_MIN_PX = 70;
export const SCALE_BAR_MAX_PX = 180;

/** A ruler nobody would choose, for the cases where no sensible one exists. */
const FALLBACK = { length: 100, label: '100 units' };

/**
 * A round world length whose on-screen size lands in the readable band.
 *
 * Steps through 1, 2, 5, 10, 20, 50… so the number under the bar is always one
 * a person would pick. A ruler reading "137 units" is a ruler nobody trusts,
 * and the whole reason for drawing one is to be trusted: everything else on the
 * canvas is relative — arrow length is normalized against the frame, body
 * radius follows mass, zoom is a percentage of an arbitrary starting point — so
 * this is the only thing that answers "how far apart are those two?".
 */
export function niceScaleLength(zoom: number): { length: number; label: string } {
  if (!(zoom > 0) || !Number.isFinite(zoom)) return FALLBACK;

  // Start a decade below the smallest length that could qualify and climb: the
  // 1-2-5 ladder rises by at most 2.5x a step, and the band is 2.6x wide, so
  // some rung always lands inside it.
  let decade = Math.pow(10, Math.floor(Math.log10(SCALE_BAR_MIN_PX / zoom)) - 1);

  for (let step = 0; step < 24; step++) {
    for (const multiple of [1, 2, 5]) {
      const length = decade * multiple;
      const pixels = length * zoom;

      if (pixels >= SCALE_BAR_MIN_PX && pixels <= SCALE_BAR_MAX_PX) {
        return { length, label: `${formatLength(length)} units` };
      }
    }
    decade *= 10;
  }

  return FALLBACK;
}

/** Thousands separators, and no exponent for the sizes a ruler reaches. */
function formatLength(value: number): string {
  return value >= 1 ? value.toLocaleString('en-US') : String(value);
}
