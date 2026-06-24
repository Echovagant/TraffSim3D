import { describe, it, expect, beforeEach } from 'vitest';
import { TrajectoryExporter, TRAJECTORY_EXPORT_SCHEMA_VERSION } from './TrajectoryExporter';
import { buildTestNetwork } from '@__fixtures__/testNetwork';

describe('TrajectoryExporter', () => {
  let exp: TrajectoryExporter;
  beforeEach(() => {
    exp = new TrajectoryExporter(1000);
  });

  it('record respects sampleInterval (10Hz throttle)', () => {
    const net = buildTestNetwork(1);
    exp.record(net, 0, 0.1);
    exp.record(net, 0.05, 0.1);  // too soon, skip
    expect(exp.rowCount).toBe(1);
    exp.record(net, 0.1, 0.1);  // 0.1s later, OK
    expect(exp.rowCount).toBe(2);
  });

  it('record captures one row per vehicle per sample', () => {
    const net = buildTestNetwork(3);
    exp.record(net, 0, 0.1);
    expect(exp.rowCount).toBe(3);
  });

  it('CSV header has 10 columns', async () => {
    const net = buildTestNetwork(0);
    exp.record(net, 0, 0.1);
    const blob = exp.exportAsBlob({ kind: 'csv', includeCrashed: true, sampleInterval: 0.1 });
    const text = await blob.text();
    expect(text.split('\n')[0]).toBe('t,vehicleId,roadId,laneIndex,type,x,z,heading,speed,status');
  });

  it('CSV includes crashed vehicles when includeCrashed=true', async () => {
    const net = buildTestNetwork(1);
    net.vehicles['v-1']!.status = 'crashed';
    exp.record(net, 0, 0.1);
    const blob = exp.exportAsBlob({ kind: 'csv', includeCrashed: true, sampleInterval: 0.1 });
    const text = await blob.text();
    expect(text).toMatch(/crashed/);
  });

  it('CSV excludes crashed when includeCrashed=false', async () => {
    const net = buildTestNetwork(1);
    net.vehicles['v-1']!.status = 'crashed';
    exp.record(net, 0, 0.1);
    const blob = exp.exportAsBlob({ kind: 'csv', includeCrashed: false, sampleInterval: 0.1 });
    const text = await blob.text();
    expect(text).not.toMatch(/crashed/);
  });

  it('JSON export has schemaVersion = TRAJECTORY_EXPORT_SCHEMA_VERSION', async () => {
    const net = buildTestNetwork(0);
    exp.record(net, 0, 0.1);
    const blob = exp.exportAsBlob({ kind: 'json', includeCrashed: true, sampleInterval: 0.1 });
    const body = JSON.parse(await blob.text());
    expect(body.schemaVersion).toBe(TRAJECTORY_EXPORT_SCHEMA_VERSION);
    expect(body.format).toBe('json');
    expect(Array.isArray(body.rows)).toBe(true);
  });

  it('clear() resets buffer and lastSampleSimTime', () => {
    const net = buildTestNetwork(1);
    exp.record(net, 0, 0.1);
    exp.clear();
    expect(exp.rowCount).toBe(0);
  });
});