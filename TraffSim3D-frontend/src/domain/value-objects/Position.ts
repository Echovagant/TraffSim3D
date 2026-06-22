/** 2D position in world units (meters). z is unused at street level; reserved for grade separation. */
export interface Position {
  readonly x: number;
  readonly y: number;  // y is "up" in Three.js; we map domain y to three.js y unchanged.
  readonly z: number;
}

export const Position = {
  origin: (): Position => ({ x: 0, y: 0, z: 0 }),
  distance: (a: Position, b: Position): number => {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },
};
