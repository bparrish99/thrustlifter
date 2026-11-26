import type { LevelData } from '../level';
import order from './order.json';

// Every level file in this folder; order.json says which are played, and in what order.
// Files not listed there are "on the shelf": kept, editable, but not played.
// The level editor writes files here and rewrites order.json (dev server only).
const files = import.meta.glob<{ default: LevelData }>(['./*.json', '!./order.json'], { eager: true });

/** Every level file in the folder, played or shelved. */
export const ALL_LEVEL_FILES: string[] = Object.keys(files)
  .map((k) => k.slice(2))
  .sort();

/** File names of the levels, in play order (parallel to LEVELS). */
export const LEVEL_FILES: string[] = (order as string[]).filter((f) => files[`./${f}`]);

/** Level files that exist but aren't in the play order. */
export const SHELVED_LEVEL_FILES: string[] = ALL_LEVEL_FILES.filter((f) => !LEVEL_FILES.includes(f));

/** Levels in play order. */
export const LEVELS: LevelData[] = LEVEL_FILES.map((f) => files[`./${f}`].default);

/** The saved data of any level file (played or shelved). */
export function levelFile(file: string): LevelData | undefined {
  return files[`./${file}`]?.default;
}
