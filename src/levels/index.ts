import type { LevelData } from '../level';
import provingGround from './proving-ground.json';
import deepCaverns from './deep-caverns.json';

/** Levels in play order. */
export const LEVELS: LevelData[] = [provingGround as LevelData, deepCaverns as LevelData];
