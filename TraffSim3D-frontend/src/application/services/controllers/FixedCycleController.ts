// src/application/services/controllers/FixedCycleController.ts
//
// The junction's plain cycle: 30 s green, 3 s yellow, 3 s all-red, then
// the other axis — a 72 s cycle with a 6 s clearance before **every**
// green.
//
// The plan belongs to the junction, so the two axes cannot drift apart:
// the clearance is 6 s by construction, not by two independent
// countdowns happening to line up.
//
// The shape matches the Python training sim's timeline
// (`app/apps/rl/sim_core.py`: a 30 s phase separated by a
// `CLEARANCE_SECS = 6.0` clearance), so a policy trained there behaves
// the same here. The frame-rate gate stays valid when
// controllerKind='fixed-cycle'.

import { JunctionControllerBase } from './junctionPlan'

/**
 * The fixed cycle.
 *
 * Everything it does — the clock, the clearance, the phase transitions
 * and the preemption hold — is the junction's shared machinery, so the
 * class carries no rules of its own.
 */
export class FixedCycleController extends JunctionControllerBase {}
