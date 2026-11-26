import type { LevelData } from '../level';
import order from './order.json';

// Every level file in this folder; order.json says which are played, and in what order.
// The level editor's "Save to project" writes files here and appends new ones to order.json.
const files = import.meta.glob<{ default: LevelData }>(['./*.json', '!./order.json'], { eager: true });

/** File names of the levels, in play order (parallel to LEVELS). */
export const LEVEL_FILES: string[] = (order as string[]).filter((f) => files[`./${f}`]);

/** Levels in play order. */
export const LEVELS: LevelData[] = LEVEL_FILES.map((f) => files[`./${f}`].default);
