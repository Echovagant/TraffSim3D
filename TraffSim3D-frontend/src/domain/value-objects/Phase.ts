// M2-B (plan 010): extend with 7 new phase values.
// Backward-compat: M1 values (Red/Yellow/Green) keep their string
// values; sceneSerializer's KNOWN_PHASES already accepts all 10.

export const LightPhase = {
  // 基础三态 (M1 已有 — keep)
  Green: 'green',
  Yellow: 'yellow',
  Red: 'red',
  // 高级相位 (M2-B 新增 — 007 §1)
  GreenLeft: 'greenLeft',
  YellowLeft: 'yellowLeft',
  RedLeft: 'redLeft',
  FlashingYellow: 'flashingYellow',
  FlashingRed: 'flashingRed',
  AllRed: 'allRed',
  Dark: 'dark',
} as const
export type LightPhase = (typeof LightPhase)[keyof typeof LightPhase]
