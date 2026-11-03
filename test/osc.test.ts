import * as dgram from 'node:dgram';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeOscMessage, normalizeOscSettings, oscCommand, parseOscPacket } from '../src/core/osc';
import { OscServer } from '../src/main/oscServer';
import type { RemoteCommand } from '../src/shared/types';

function bundle(...messages: Buffer[]): Buffer {
  const head = Buffer.concat([Buffer.from('#bundle\0', 'latin1'), Buffer.alloc(8)]);
  return Buffer.concat([head, ...messages.flatMap((m) => {
    const size = Buffer.alloc(4);
    size.writeInt32BE(m.length);
    return [size, m];
  })]);
}

describe('OSC', () => {
  it('decodes messages with int, float and string arguments, and bundles', () => {
    expect(parseOscPacket(encodeOscMessage('/wavepod/cough/2', [1]))).toEqual([{ address: '/wavepod/cough/2', args: [1] }]);
    const [m] = parseOscPacket(encodeOscMessage('/x', [0.5, 'hi', 7]));
    expect(m.args).toEqual([0.5, 'hi', 7]);
    expect(parseOscPacket(bundle(encodeOscMessage('/a'), encodeOscMessage('/b', [2]))).map((x) => x.address)).toEqual(['/a', '/b']);
    expect(() => parseOscPacket(Buffer.from('nonsense'))).toThrow();
  });

  it('maps addresses to actions; 0 is a release', () => {
    const cmd = (a: string, args: Array<number | string> = []) => oscCommand(parseOscPacket(encodeOscMessage(a, args))[0]);
    expect(cmd('/wavepod/record')).toEqual({ action: 'record-toggle', pressed: true });
    expect(cmd('/wavepod/marker/chapter', [1])).toEqual({ action: 'chapter-marker', pressed: true });
    expect(cmd('/wavepod/marker/chapter', [0])).toBeNull();
    expect(cmd('/WavePod/Sound/3/')).toEqual({ action: 'sound-3', pressed: true });
    expect(cmd('/wavepod/cough/1', [1])).toEqual({ action: 'cough-1', pressed: true });
    expect(cmd('/wavepod/cough/1', [0])).toEqual({ action: 'cough-1', pressed: false });
    expect(cmd('/wavepod/cough/9')).toBeNull();
    expect(cmd('/other/thing')).toBeNull();
  });

  it('validates settings', () => {
    expect(normalizeOscSettings(null)).toEqual({ enabled: false, port: 9000, allowNetwork: false });
    expect(normalizeOscSettings({ enabled: true, port: 80, allowNetwork: 'yes' })).toEqual({ enabled: true, port: 9000, allowNetwork: false });
  });

  describe('server', () => {
    let server: OscServer | null = null;
    afterEach(async () => {
      await server?.close();
      server = null;
    });

    it('receives commands over UDP on localhost and stops when switched off', async () => {
      const got: RemoteCommand[] = [];
      server = new OscServer((c) => got.push(c));
      const port = 39000 + Math.floor(Math.random() * 1000);
      const s = await server.apply({ enabled: true, port, allowNetwork: false });
      expect(s.running).toBe(true);
      const client = dgram.createSocket('udp4');
      await new Promise<void>((r) => client.send(encodeOscMessage('/wavepod/marker/edit', [1]), port, '127.0.0.1', () => r()));
      for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
      client.close();
      expect(got).toEqual([{ action: 'edit-marker', pressed: true }]);
      expect(server.status().received).toBe(1);
      expect((await server.apply({ enabled: false, port, allowNetwork: false })).running).toBe(false);
    });

    it('reports a port that is taken', async () => {
      const blocker = dgram.createSocket('udp4');
      const port = 40000 + Math.floor(Math.random() * 1000);
      await new Promise<void>((r) => blocker.bind(port, '127.0.0.1', () => r()));
      server = new OscServer(() => {});
      const s = await server.apply({ enabled: true, port, allowNetwork: false });
      blocker.close();
      expect(s.running).toBe(false);
      expect(s.error).toContain('already in use');
    });
  });
});
