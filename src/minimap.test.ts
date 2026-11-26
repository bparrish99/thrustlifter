import { describe, expect, it } from 'vitest';
import { ALL_LEVEL_FILES, levelFile } from './levels';
import { minimapBounds } from './minimap';

describe('minimap', () => {
  it('frames every level: full width, everything you fly near, not the far-off border rock', () => {
    for (const f of ALL_LEVEL_FILES) {
      const d = levelFile(f)!;
      const b = minimapBounds(d);
      expect(b.x1 - b.x0, f).toBe(d.width);
      for (const p of [...d.pads, d.orb, d.bowl, ...(d.fuelTanks ?? []), ...(d.balloons ?? []), ...d.turrets]) {
        expect(p.y, f).toBeGreaterThan(b.y0);
        expect(p.y, f).toBeLessThan(b.y1);
      }
      expect(b.y0, f).toBeGreaterThanOrEqual(-1200); // never above the level's top border (a level may use its full height)
    }
  });
});
