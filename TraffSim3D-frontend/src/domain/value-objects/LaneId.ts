/** Stable lane identifier: road id + lane index. */
export type LaneId = `${string}#${number}`;

export const LaneId = {
  make: (roadId: string, laneIndex: number): LaneId => `${roadId}#${laneIndex}`,
  roadOf: (id: LaneId): string => id.split('#')[0] ?? '',
  indexOf: (id: LaneId): number => Number(id.split('#')[1] ?? 0),
};
