// The OSC server: a UDP socket that turns OSC messages into WavePod actions. Off by default;
// only this computer can send unless "allow other computers" is switched on.
import * as dgram from 'node:dgram';
import { DEFAULT_OSC_PORT, oscCommand, parseOscPacket } from '../core/osc';
import type { OscSettings, OscStatus, RemoteCommand } from '../shared/types';

export class OscServer {
  private socket: dgram.Socket | null = null;
  private bound: { port: number; allowNetwork: boolean } | null = null;
  private error: string | null = null;
  private received = 0;
  private settings: OscSettings = { enabled: false, port: DEFAULT_OSC_PORT, allowNetwork: false };

  constructor(private onCommand: (cmd: RemoteCommand) => void) {}

  async apply(settings: OscSettings): Promise<OscStatus> {
    this.settings = settings;
    const changed = this.bound && (this.bound.port !== settings.port || this.bound.allowNetwork !== settings.allowNetwork);
    if (this.socket && (!settings.enabled || changed)) await this.close();
    this.error = null;
    if (settings.enabled && !this.socket) {
      try {
        await this.open(settings);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        this.error = err.code === 'EADDRINUSE' ? `Port ${settings.port} is already in use. Pick another port.` : err.message;
        await this.close();
      }
    }
    return this.status();
  }

  private open(settings: OscSettings): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = dgram.createSocket('udp4');
      socket.once('error', reject);
      socket.on('message', (buf) => {
        let messages;
        try {
          messages = parseOscPacket(buf);
        } catch {
          return; // not OSC
        }
        for (const m of messages) {
          const cmd = oscCommand(m);
          if (!cmd) continue;
          this.received++;
          this.onCommand(cmd);
        }
      });
      socket.bind(settings.port, settings.allowNetwork ? '0.0.0.0' : '127.0.0.1', () => {
        socket.off('error', reject);
        socket.on('error', (e) => (this.error = e.message));
        this.socket = socket;
        this.bound = { port: settings.port, allowNetwork: settings.allowNetwork };
        resolve();
      });
    });
  }

  status(): OscStatus {
    return { ...this.settings, running: !!this.socket, error: this.error, received: this.received };
  }

  async close(): Promise<void> {
    const s = this.socket;
    this.socket = null;
    this.bound = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }
}
