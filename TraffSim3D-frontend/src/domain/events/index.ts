import type { Vehicle } from '../entities/Vehicle'
import type { TrafficLight } from '../entities/TrafficLight'

export type DomainEvent =
  | { kind: 'vehicle-moved'; vehicle: Vehicle; timestampMs: number }
  | { kind: 'light-phase-changed'; light: TrafficLight; previousPhase: TrafficLight['phase'] }
  | { kind: 'collision-detected'; vehicleAId: string; vehicleBId: string }
