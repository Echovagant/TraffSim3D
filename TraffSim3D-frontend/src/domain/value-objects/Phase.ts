export const LightPhase = {
  Red: 'red',
  Yellow: 'yellow',
  Green: 'green',
} as const;
export type LightPhase = (typeof LightPhase)[keyof typeof LightPhase];
