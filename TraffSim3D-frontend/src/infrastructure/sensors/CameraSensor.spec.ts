import { describe, it, expect } from 'vitest';
import { CameraSensor, defaultCameraConfig } from './CameraSensor';

describe('CameraSensor', () => {
  it('defaultCameraConfig returns a 256x192 sensor with 60 FOV', () => {
    const cfg = defaultCameraConfig('v-1');
    expect(cfg.width).toBe(256);
    expect(cfg.height).toBe(192);
    expect(cfg.fov).toBe(60);
  });

  it('configure({width, height}) updates config + target size', () => {
    const cfg = defaultCameraConfig('v-1');
    const sensor = new CameraSensor(cfg);
    sensor.configure({ width: 128, height: 96 });
    expect(sensor.config.width).toBe(128);
    expect(sensor.config.height).toBe(96);
  });

  it('configure({fov}) updates camera fov', () => {
    const cfg = defaultCameraConfig('v-1');
    const sensor = new CameraSensor(cfg);
    sensor.configure({ fov: 90 });
    expect(sensor.config.fov).toBe(90);
  });

  it('renderToCanvas writes to a canvas (no-throw smoke test)', () => {
    const cfg = defaultCameraConfig('v-1');
    const sensor = new CameraSensor(cfg);
    const canvas = document.createElement('canvas');
    canvas.width = cfg.width;
    canvas.height = cfg.height;
    const fakeFrame = {
      vehicleId: 'v-1',
      simTime: 0,
      width: cfg.width,
      height: cfg.height,
      rgba: new Uint8Array(cfg.width * cfg.height * 4),
    };
    expect(() => sensor.renderToCanvas(fakeFrame, canvas)).not.toThrow();
  });
});