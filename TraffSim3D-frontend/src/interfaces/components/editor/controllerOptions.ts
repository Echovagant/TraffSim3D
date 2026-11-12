/**
 * The signal-controller options, in ONE place.
 *
 * Two components draw this list — the editor toolbar and the readout
 * drawer — and they used to carry their own copy of it. That is how the
 * RL entry came to claim "未实装·回退固定周期" in both of them while the
 * policy was in fact installed and driving the signals (the AI
 * Proving Ground installs the shipped grid policy; the grid scene then
 * runs on it).
 *
 * A label that lies about the state of the system is worse than no
 * label at all: the reader cannot tell which of the two situations they
 * are looking at. So the RL entry says what is true — and it is
 * computed from the store's own signal policy, not from a guess.
 */
export interface ControllerOption {
  value: 'fixed-cycle' | 'actuated' | 'coordinated' | 'rl'
  label: string
}

/**
 * The options, with the RL entry reflecting the real state.
 *
 * @param installed whether a signal policy is loaded in the store
 * @param origin where it came from ('shipped' = the bundled one,
 *                 'checkpoint' = one the user picked)
 */
export const controllerOptions = (
  installed: boolean,
  origin: 'shipped' | 'checkpoint' | null,
): ControllerOption[] => [
  { value: 'fixed-cycle', label: '固定' },
  { value: 'actuated', label: '感应' },
  { value: 'coordinated', label: '协调 (绿波带)' },
  {
    value: 'rl',
    label: installed
      ? `RL (已实装·${origin === 'checkpoint' ? '所选 checkpoint' : '产品附带策略'}指挥)`
      : 'RL (未实装·回退固定周期)',
  },
]
