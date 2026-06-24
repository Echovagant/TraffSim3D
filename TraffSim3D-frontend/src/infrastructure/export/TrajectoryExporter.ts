// src/infrastructure/export/TrajectoryExporter.ts
//
// M2-C trajectory export. Buffers per-vehicle state at sample
// interval (default 10Hz). Triggered manually via UI or auto-flush
// at maxBufferRows. Output: CSV or JSON Blob for download.

import type { RoadNetwork } from '@domain/entities/RoadNetwork';

export const TRAJECTORY_EXPORT_SCHEMA_VERSION = 1;

export interface TrajectoryRow {
  t: number;        // simTime (s)
  vehicleId: string;
  roadId: string;
  laneIndex: number;
  type: 'car' | 'truck' | 'bus';
  x: number;
  z: number;
  heading: number;  // radians
  speed: number;    // m/s
  status: 'driving' | 'waiting' | 'crashed';
}

export interface ExportFormat {
  kind: 'csv' | 'json';
  includeCrashed: boolean;
  sampleInterval: number;  // s
}

export class TrajectoryExporter {
  private buffer: TrajectoryRow[] = [];
  private lastSampleSimTime = -Infinity;
  private cap: number;

  constructor(cap: number) {
    this.cap = cap;
  }

  record(network: RoadNetwork, simTime: number, sampleInterval: number): void {
    if (simTime - this.lastSampleSimTime < sampleInterval) return;
    this.lastSampleSimTime = simTime;
    for (const v of Object.values(network.vehicles)) {
      this.buffer.push({
        t: simTime,
        vehicleId: v.id,
        roadId: v.roadId,
        laneIndex: v.laneIndex,
        type: v.type,
        x: v.position.x,
        z: v.position.z,
        heading: v.heading,
        speed: v.speed,
        status: v.status,
      });
    }
    if (this.buffer.length >= this.cap) {
      // Auto-flush: download as CSV.
      const blob = this.exportAsBlob({ kind: 'csv', includeCrashed: true, sampleInterval });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `trajectory-autoflush-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      this.buffer = [];
    }
  }

  exportAsBlob(format: ExportFormat): Blob {
    const filtered = format.includeCrashed
      ? this.buffer
      : this.buffer.filter((r) => r.status !== 'crashed');
    if (format.kind === 'csv') {
      const header = 't,vehicleId,roadId,laneIndex,type,x,z,heading,speed,status\n';
      const rows = filtered.map((r) =>
        [r.t, r.vehicleId, r.roadId, r.laneIndex, r.type, r.x.toFixed(3), r.z.toFixed(3), r.heading.toFixed(3), r.speed.toFixed(3), r.status].join(',')
      ).join('\n');
      return new Blob([header + rows + '\n'], { type: 'text/csv' });
    } else {
      const body = {
        schemaVersion: TRAJECTORY_EXPORT_SCHEMA_VERSION,
        savedAtMs: Date.now(),
        format: format.kind,
        includeCrashed: format.includeCrashed,
        sampleInterval: format.sampleInterval,
        rows: filtered,
      };
      return new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' });
    }
  }

  clear(): void {
    this.buffer = [];
    this.lastSampleSimTime = -Infinity;
  }

  get rowCount(): number { return this.buffer.length; }
  get maxBufferRows(): number { return this.cap; }
}
