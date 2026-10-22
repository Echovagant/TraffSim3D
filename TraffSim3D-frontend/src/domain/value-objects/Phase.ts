// Extend with 7 new phase values.
// Backward-compat: the original values (Red/Yellow/Green) keep their string
// values; sceneSerializer's KNOWN_PHASES already accepts all 10.

export const LightPhase = {
  // 基础三态 (keep)
  Green: 'green',
  Yellow: 'yellow',
  Red: 'red',
  // 高级相位 (新增 — 007 §1)
  GreenLeft: 'greenLeft',
  YellowLeft: 'yellowLeft',
  RedLeft: 'redLeft',
  FlashingYellow: 'flashingYellow',
  FlashingRed: 'flashingRed',
  AllRed: 'allRed',
  Dark: 'dark',
} as const
export type LightPhase = (typeof LightPhase)[keyof typeof LightPhase]
