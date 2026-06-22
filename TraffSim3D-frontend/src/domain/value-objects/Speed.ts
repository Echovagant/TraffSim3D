/** Scalar speed in meters/second. Direction is implied by the vehicle's heading. */
export type Speed = number;

export const Speed = {
  zero: (): Speed => 0,
  /** Convert km/h to m/s. */
  fromKmh: (kmh: number): Speed => (kmh * 1000) / 3600,
  toKmh: (ms: Speed): number => (ms * 3600) / 1000,
  clamp: (s: Speed, min: Speed, max: Speed): Speed => Math.min(max, Math.max(min, s)),
};
