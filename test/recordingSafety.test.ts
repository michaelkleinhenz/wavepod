import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { WavReader, WavWriter, parseWavHeader, repairWav } from '../src/core/wav';
import { TakeFiles } from '../src/core/takeFiles';
import { RecordingMonitor } from '../src/core/recordingMonitor';
import { JOURNAL_FILE, journalOwnerRunning, readJournal, recoverRecording, writeJournal, type OwnerCheck, type RecordingJournal } from '../src/core/recordingJournal';
import { addTrack, createProject } from '../src/core/project';
import { RecordWorker } from '../src/main/audio/takeSink';
import { tmpDir } from './helpers';

const SR = 48000;

/** Interleaves planar channels into one device buffer. */
function interleave(chans: Float32Array[]): Float32Array {
  const n = chans[0].length;
  const out = new Float32Array(n * chans.length);
  for (let i = 0; i < n; i++) for (let c = 0; c < chans.length; c++) out[i * chans.length + c] = chans[c][i];
  return out;
}

/** Something speech-like: a gliding harmonic voice, noisy fricatives and pauses with gate-like onsets. */
function speechLike(seconds: number, seed = 1): Float32Array {
  let r = seed;
  const rnd = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const n = Math.round(seconds * SR);
  const out = new Float32Array(n);
  let phase = 0;
  let lp = 0;
  let env = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const seg = Math.floor(t * 3) % 6; // ~330 ms segments
    const f0 = 110 + 40 * Math.sin(t * 2.1);
    phase += (2 * Math.PI * f0) / SR;
    let v = 0;
    if (seg < 3) for (let h = 1; h <= 20; h++) v += Math.sin(phase * h) / h;
    else if (seg === 3) {
      lp += (rnd() - lp) * 0.6; // fricative: bright noise
      v = rnd() * 0.5 + lp * 0.3;
    } else if (seg === 4) v = rnd() * 0.002; // room tone
    // voices and noises fade in and out over a few milliseconds, like real ones
    env += ((seg === 5 ? 0 : 0.25) - env) * 0.01;
    out[i] = v * env;
  }
  return out;
}

describe('crash-safe WAV files', () => {
  it('reserves room for RF64 and reads RF64 headers', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'a.wav');
    const w = new WavWriter(file, 2, SR, 24, 1024, 0, { rf64: true });
    w.write([new Float32Array(1000).fill(0.5), new Float32Array(1000).fill(-0.5)]);
    w.close();
    const buf = fs.readFileSync(file);
    expect(buf.toString('ascii', 12, 16)).toBe('JUNK');
    const r = new WavReader(file);
    expect(r.frames).toBe(1000);
    expect(r.read(0, 1)[1][0]).toBeCloseTo(-0.5, 4);
    r.close();
    // the same header turned into RF64 with a ds64 chunk
    const rf = Buffer.from(buf);
    rf.write('RF64', 0);
    rf.writeUInt32LE(0xffffffff, 4);
    rf.write('ds64', 12);
    rf.writeBigUInt64LE(BigInt(buf.length - 8), 20);
    rf.writeBigUInt64LE(BigInt(6000), 28);
    const dataSizeAt = buf.indexOf('data') + 4;
    rf.writeUInt32LE(0xffffffff, dataSizeAt);
    const info = parseWavHeader(rf, rf.length);
    expect(info.frames).toBe(1000);
  });

  it('repairs a file a crash left behind and can continue it', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'crash.wav');
    const w = new WavWriter(file, 2, SR, 24, 0, 1e12, { rf64: true });
    w.write([new Float32Array(4800).fill(0.25), new Float32Array(4800).fill(0.25)]);
    // crash: header never patched, and half a frame at the end
    fs.appendFileSync(file, Buffer.alloc(4));
    expect(fs.readFileSync(file).readUInt32LE(fs.readFileSync(file).indexOf('data') + 4)).toBe(0);
    const info = repairWav(file);
    expect(info.frames).toBe(4800);
    expect(fs.statSync(file).size).toBe(info.dataOffset + 4800 * 6);
    const r = new WavReader(file);
    expect(r.frames).toBe(4800);
    r.close();
    const more = new WavWriter(file, 2, SR, 24, 0, 0, { rf64: true, append: true });
    expect(more.framesWritten).toBe(4800);
    more.write([new Float32Array(100).fill(-0.25), new Float32Array(100).fill(-0.25)]);
    more.close();
    const r2 = new WavReader(file);
    expect(r2.frames).toBe(4900);
    expect(r2.read(4899, 1)[0][0]).toBeCloseTo(-0.25, 4);
    r2.close();
  });
});

describe('TakeFiles', () => {
  it('writes each track its channels, and keeps audio while the disk is full', () => {
    const dir = tmpDir();
    let full = false;
    let now = 0;
    const writeSync = (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      if (full) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      return fs.writeSync(fd, buf, off, len, pos);
    };
    const files = new TakeFiles(
      [
        { path: path.join(dir, 'host.wav'), channels: [2] },
        { path: path.join(dir, 'guest.wav'), channels: [0, 1] },
      ],
      { sampleRate: SR, bitDepth: 24, deviceChannels: 4, writeSync, now: () => now },
    );
    const block = (v: number) => interleave([0, 1, 2, 3].map((c) => new Float32Array(480).fill(v * (c + 1) / 10)));
    files.write(block(1));
    full = true;
    for (let i = 0; i < 10; i++) {
      now += 10;
      files.write(block(1));
    }
    expect(files.status().error).toBe('The disk is full');
    expect(files.status().queuedBytes).toBeGreaterThan(0);
    full = false;
    now += 2000;
    files.tick();
    expect(files.status().error).toBeNull();
    expect(files.status().queuedBytes).toBe(0);
    const res = files.close();
    expect(res.error).toBeNull();
    expect(res.framesOnDisk).toEqual([5280, 5280]);
    const host = new WavReader(path.join(dir, 'host.wav'));
    expect(host.info.channels).toBe(1);
    expect(host.frames).toBe(5280);
    expect(host.read(5279, 1)[0][0]).toBeCloseTo(0.3, 4);
    host.close();
    const guest = new WavReader(path.join(dir, 'guest.wav'));
    expect(guest.info.channels).toBe(2);
    expect(guest.read(0, 1)[1][0]).toBeCloseTo(0.2, 4);
    guest.close();
  });

  it('closes with what reached the disk if it never comes back', () => {
    const dir = tmpDir();
    let full = false;
    const writeSync = (fd: number, buf: Buffer, off: number, len: number, pos: number) => {
      if (full) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      return fs.writeSync(fd, buf, off, len, pos);
    };
    const files = new TakeFiles([{ path: path.join(dir, 'a.wav'), channels: [0] }], { sampleRate: SR, bitDepth: 16, deviceChannels: 1, writeSync, maxQueuedBytes: 2000 });
    files.write(new Float32Array(480).fill(0.1));
    full = true;
    for (let i = 0; i < 5; i++) files.write(new Float32Array(480).fill(0.1));
    expect(files.status().droppedFrames).toBeGreaterThan(0);
    const res = files.close();
    expect(res.error).toBe('The disk is full');
    expect(res.framesOnDisk).toEqual([480]);
    expect(new WavReader(path.join(dir, 'a.wav')).frames).toBe(480);
  });
});

describe('RecordingMonitor', () => {
  const tracks = [{ trackId: 't1', name: 'Host', channels: [0] }];
  const feed = (m: RecordingMonitor, signal: Float32Array, block = 512, t0 = 0) => {
    let t = t0;
    for (let i = 0; i + block <= signal.length; i += block) {
      m.input(signal.subarray(i, i + block), 1, t);
      t += (block / SR) * 1000;
    }
    return t;
  };

  it('finds no problems in clean speech', () => {
    const m = new RecordingMonitor({ sampleRate: SR, bufferSize: 512, tracks, bytesPerSecond: SR * 3 });
    feed(m, speechLike(20));
    expect(m.events).toEqual([]);
  });

  it('finds no problems in hiss or bright tones', () => {
    const m = new RecordingMonitor({ sampleRate: SR, bufferSize: 512, tracks, bytesPerSecond: SR * 3 });
    let r = 3;
    const n = SR * 10;
    const sig = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      // Gaussian-ish hiss, then a sweep up to 16 kHz
      if (i < n / 2) {
        let g = 0;
        for (let k = 0; k < 6; k++) g += ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) - 0.5;
        sig[i] = g * 0.05;
      } else {
        ph += (2 * Math.PI * (100 + (16000 * (i - n / 2)) / (n / 2))) / SR;
        sig[i] = 0.3 * Math.sin(ph) * Math.min(1, (i - n / 2) / 480);
      }
    }
    feed(m, sig);
    expect(m.events).toEqual([]);
  });

  it('reports crackle from discontinuities', () => {
    const m = new RecordingMonitor({ sampleRate: SR, bufferSize: 512, tracks, bytesPerSecond: SR * 3 });
    const s = speechLike(6, 7);
    // what an overrun does: buffers of audio missing, so the waveform jumps
    const cut = new Float32Array(s.length);
    let o = 0;
    for (let i = 0; i < s.length && o < cut.length; i++) {
      if (i > SR && i < 3 * SR && i % 4800 === 0) i += 37;
      cut[o++] = s[i];
    }
    feed(m, cut);
    const crackle = m.events.filter((e) => e.kind === 'crackle');
    expect(crackle.length).toBeGreaterThan(0);
    expect(crackle[0].frame).toBeGreaterThan(SR * 0.9);
    expect(m.health(0).warnings.some((w) => w.key === 'crackle-t1')).toBe(true);
  });

  it('reports clipping, but not inputs without signal', () => {
    const m = new RecordingMonitor({
      sampleRate: SR,
      bufferSize: 512,
      tracks: [...tracks, { trackId: 't2', name: 'Guest', channels: [1] }],
      bytesPerSecond: SR * 6,
    });
    const loud = speechLike(6).map((v) => Math.max(-1, Math.min(1, v * 8)));
    const silent = new Float32Array(loud.length);
    let t = 0;
    for (let i = 0; i + 512 <= loud.length; i += 512) {
      m.input(interleave([loud.subarray(i, i + 512), silent.subarray(i, i + 512)]), 2, t);
      t += (512 / SR) * 1000;
    }
    expect(m.events.some((e) => e.kind === 'clipping' && e.trackId === 't1')).toBe(true);
    // a muted mic is normal: nothing about the silent guest
    const w = m.health(t).warnings;
    expect(w.some((x) => x.trackId === 't2')).toBe(false);
    expect(m.events.some((e) => e.trackId === 't2')).toBe(false);
  });

  it('stays quiet in normal operation: silence, gated voices, mute buttons', () => {
    const m = new RecordingMonitor({
      sampleRate: SR,
      bufferSize: 512,
      tracks: [...tracks, { trackId: 't2', name: 'Guest', channels: [1] }, { trackId: 't3', name: 'Cohost', channels: [2] }],
      bytesPerSecond: SR * 9,
    });
    const n = SR * 90;
    const silent = new Float32Array(n);
    // a noise gate: words that snap on out of digital silence and off again, several per second
    const gated = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      ph += (2 * Math.PI * 180) / SR;
      const on = Math.floor(i / (SR * 0.15)) % 3 !== 2;
      gated[i] = on ? 0.3 * Math.sin(ph + 1) + 0.1 * Math.sin(3 * ph) : 0;
    }
    // a mute button: room tone and voice, cut hard to zero and back every few seconds
    const muted = speechLike(90, 5).map((v, i) => (Math.floor(i / (SR * 2.5)) % 2 ? 0 : v));
    let t = 0;
    for (let i = 0; i + 512 <= n; i += 512) {
      m.input(interleave([gated.subarray(i, i + 512), silent.subarray(i, i + 512), muted.subarray(i, i + 512)]), 3, t);
      t += (512 / SR) * 1000;
      if (i % (512 * 8) === 0) m.tick(t, { queuedBytes: 0, error: null, droppedFrames: 0, freeBytes: 1e12 });
    }
    expect(m.events).toEqual([]);
    expect(m.health(t).warnings).toEqual([]);
  });

  it('is not fooled by a busy thread that catches up', () => {
    const m = new RecordingMonitor({ sampleRate: SR, bufferSize: 512, tracks, bytesPerSecond: SR * 3 });
    const s = speechLike(10);
    const ok = { queuedBytes: 0, error: null, droppedFrames: 0, freeBytes: 1e12 };
    const dt = (512 / SR) * 1000;
    let busyUntil = 0;
    for (let i = 0, k = 0; i + 512 <= s.length; i += 512, k++) {
      const due = k * dt;
      // at 4 s the thread is blocked for 1.5 s; the queued buffers then arrive in a burst
      if (k === 375) {
        busyUntil = due + 1500;
        m.tick(busyUntil, ok); // the first tick after the pause runs before the queued buffers
      }
      m.input(s.subarray(i, i + 512), 1, Math.max(due, busyUntil) + (k % 5));
      if (k % 8 === 0) m.tick(Math.max(due, busyUntil), ok);
    }
    expect(m.events).toEqual([]);
  });

  it('notices audio the device never delivered', () => {
    const m = new RecordingMonitor({ sampleRate: SR, bufferSize: 512, tracks, bytesPerSecond: SR * 3 });
    const s = speechLike(8);
    let t = 0;
    for (let i = 0, k = 0; i + 512 <= s.length; i += 512, k++) {
      // jitter in delivery is fine…
      m.input(s.subarray(i, i + 512), 1, t + (k % 7) * 3);
      t += (512 / SR) * 1000;
      // …but after 4 s, 30 ms of buffers go missing
      if (k === 375) t += 30;
    }
    const d = m.events.filter((e) => e.kind === 'dropout');
    expect(d).toHaveLength(1);
    expect(d[0].text).toMatch(/about (2[5-9]|3[0-5]) ms/);
  });

  it('warns about a full disk, a slow disk, write errors and a stalled input', () => {
    const m = new RecordingMonitor({ sampleRate: SR, bufferSize: 512, tracks, bytesPerSecond: 1000 });
    const t = feed(m, speechLike(1));
    m.tick(t, { queuedBytes: 5000, error: null, droppedFrames: 0, freeBytes: 240_000 });
    let w = m.health(t).warnings;
    expect(w.find((x) => x.key === 'disk-space')?.level).toBe('critical');
    expect(w.some((x) => x.key === 'disk-slow')).toBe(true);
    expect(m.health(t).diskSecondsLeft).toBe(240);
    // the ticks keep coming, the input buffers don't
    for (let k = 1; k <= 10; k++) m.tick(t + k * 300, { queuedBytes: 5000, error: 'The disk is full', droppedFrames: 0, freeBytes: 0 });
    w = m.health(t + 3000).warnings;
    expect(w.find((x) => x.key === 'disk-error')?.text).toContain('held in memory');
    expect(w.find((x) => x.key === 'stall')?.level).toBe('critical');
    expect(m.events.map((e) => e.kind)).toEqual(expect.arrayContaining(['stall', 'disk']));
  });
});

describe('recording journal and recovery', () => {
  it('puts the takes of an interrupted recording back on their tracks', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    let p = createProject('Crash', SR);
    p = addTrack(p, { name: 'Host', inputChannels: [0] });
    const host = p.tracks[0];
    const files = new TakeFiles(
      [
        { path: path.join(dir, 'media/host.wav'), channels: [0] },
        { path: path.join(dir, 'media/gone.wav'), channels: [1] },
      ],
      { sampleRate: SR, bitDepth: 24, deviceChannels: 2 },
    );
    files.write(interleave([new Float32Array(SR).fill(0.1), new Float32Array(SR).fill(0.2)]));
    // no close(): the app died here
    const journal: RecordingJournal = {
      version: 1,
      startedAt: new Date().toISOString(),
      sampleRate: SR,
      bitDepth: 24,
      recordStart: 4800,
      takes: [
        { trackId: host.id, trackName: 'Host', file: 'media/host.wav', channels: [0] },
        { trackId: 'trk_deleted', trackName: 'Guest', file: 'media/gone.wav', channels: [1] },
      ],
      jingles: [],
      events: [{ frame: 100, kind: 'crackle', trackId: host.id, text: 'Crackle on Host', count: 4 }],
    };
    writeJournal(dir, journal);
    expect(readJournal(dir)?.takes).toHaveLength(2);
    const rec = recoverRecording(dir, p)!;
    expect(rec.takes).toBe(2);
    expect(rec.seconds).toBe(1);
    const h = rec.project.tracks.find((t) => t.id === host.id)!;
    expect(h.clips).toEqual([expect.objectContaining({ file: 'media/host.wav', start: 4800, length: SR })]);
    const guest = rec.project.tracks.find((t) => t.name === 'Guest (recovered)')!;
    expect(guest.clips[0].file).toBe('media/gone.wav');
    expect(rec.project.markers).toEqual([expect.objectContaining({ kind: 'edit', position: 4900, title: '⚠ Crackle on Host (4×)' })]);
    // the files are valid WAVs again
    expect(new WavReader(path.join(dir, 'media/host.wav')).frames).toBe(SR);
    // running it again on the recovered project adds nothing
    const again = recoverRecording(dir, rec.project)!;
    expect(again.takes).toBe(0);
    expect(again.project.markers).toHaveLength(1);
    expect(fs.existsSync(path.join(dir, JOURNAL_FILE))).toBe(true);
  });
});

describe('a take another WavePod is still recording', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const journal = (owner?: RecordingJournal['owner'], startedAt = new Date(now - 60_000).toISOString()): RecordingJournal => ({
    version: 1,
    startedAt,
    sampleRate: SR,
    bitDepth: 24,
    recordStart: 0,
    takes: [],
    jingles: [],
    events: [],
    ...(owner ? { owner } : {}),
  });
  // this process is 100 on "studio", up for an hour; 200 is running, everything else is gone
  const check: OwnerCheck = { pid: 100, host: 'studio', now, uptime: 3600, alive: (pid) => pid === 200 };

  it('counts as running only while its process is alive on this computer since the last restart', () => {
    expect(journalOwnerRunning(journal({ pid: 200, host: 'studio' }), check)).toBe(true);
    // the process is gone: the app crashed
    expect(journalOwnerRunning(journal({ pid: 300, host: 'studio' }), check)).toBe(false);
    // this very process: nobody else is recording it
    expect(journalOwnerRunning(journal({ pid: 100, host: 'studio' }), check)).toBe(false);
    // written before the computer restarted: the number may belong to another program now
    expect(journalOwnerRunning(journal({ pid: 200, host: 'studio' }, new Date(now - 2 * 3600_000).toISOString()), check)).toBe(false);
    // another computer (a shared folder) or a journal from before owners were stored
    expect(journalOwnerRunning(journal({ pid: 200, host: 'laptop' }), check)).toBe(false);
    expect(journalOwnerRunning(journal(), check)).toBe(false);
  });

  it('is left alone by recovery, journal and files included', () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, 'media'));
    let p = createProject('Live', SR);
    p = addTrack(p, { name: 'Host', inputChannels: [0] });
    const files = new TakeFiles([{ path: path.join(dir, 'media/host.wav'), channels: [0] }], { sampleRate: SR, bitDepth: 24, deviceChannels: 1 });
    files.write(new Float32Array(SR).fill(0.1));
    const j: RecordingJournal = { ...journal({ pid: process.pid + 1, host: 'studio' }, new Date().toISOString()), takes: [{ trackId: p.tracks[0].id, trackName: 'Host', file: 'media/host.wav', channels: [0] }] };
    writeJournal(dir, j);
    const before = fs.readFileSync(path.join(dir, 'media/host.wav'));
    const live: OwnerCheck = { pid: process.pid, host: 'studio', now: Date.now(), uptime: 3600, alive: () => true };
    expect(recoverRecording(dir, p, live)).toBeNull();
    expect(fs.readFileSync(path.join(dir, 'media/host.wav'))).toEqual(before);
    expect(readJournal(dir)?.owner).toEqual({ pid: process.pid + 1, host: 'studio' });
    // once that process is gone, the take is recovered as usual
    const rec = recoverRecording(dir, p, { ...live, alive: () => false })!;
    expect(rec.takes).toBe(1);
    files.close();
  });
});

describe('recording worker', () => {
  it('writes takes on its own thread and answers start and stop synchronously', () => {
    const out = path.join(tmpDir(), 'recordWorker.js');
    buildSync({ entryPoints: ['src/main/recordWorker.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'silent' });
    const rw = new RecordWorker(out);
    try {
      const dir = tmpDir();
      const sink = rw.sink([{ path: path.join(dir, 'a.wav'), channels: [1] }], { sampleRate: SR, bitDepth: 24, deviceChannels: 2 });
      const buf = interleave([new Float32Array(480).fill(0.1), new Float32Array(480).fill(0.4)]);
      for (let i = 0; i < 100; i++) sink.write(buf, 480);
      const res = sink.finish();
      expect(res).toEqual({ error: null, framesOnDisk: [48000] });
      const r = new WavReader(path.join(dir, 'a.wav'));
      expect(r.frames).toBe(48000);
      expect(r.read(47999, 1)[0][0]).toBeCloseTo(0.4, 4);
      r.close();
      // a file that can't be created fails the start, not the worker
      expect(() => rw.sink([{ path: path.join(dir, 'nope/a.wav'), channels: [0] }], { sampleRate: SR, bitDepth: 24, deviceChannels: 2 })).toThrow(/ENOENT/);
      const again = rw.sink([{ path: path.join(dir, 'b.wav'), channels: [0] }], { sampleRate: SR, bitDepth: 16, deviceChannels: 2 });
      again.write(buf, 480);
      expect(again.finish().framesOnDisk).toEqual([480]);
    } finally {
      rw.dispose();
    }
  });
});

describe('AudioEngine recording safety', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('keeps a journal while recording, reports health, and survives losing its writer', async () => {
    const { AudioEngine, VIRTUAL_API } = await import('../src/main/audio/engine');
    const engine = new AudioEngine(null);
    try {
      engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480 });
      const dir = tmpDir();
      const p = addTrack(createProject('Safe', 48000), { name: 'Host', inputChannels: [2], armed: true });
      engine.setProject(p, dir);
      const health: unknown[] = [];
      engine.on('transport', (u) => u.health && health.push(u.health));
      let report: { events: unknown[]; writeError: string | null } | null = null;
      engine.on('recordingFinished', (_t, r) => (report = r));
      const [file] = engine.record();
      expect(readJournal(dir)?.takes[0]).toEqual(expect.objectContaining({ file, trackName: 'Host' }));
      await wait(200);
      engine.writerFailed('The recording writer stopped (test)');
      await wait(200);
      const takes = engine.stop();
      expect(health.length).toBeGreaterThan(0);
      expect(report!.writeError).toBeNull();
      expect(report!.events).toEqual([expect.objectContaining({ kind: 'disk', text: expect.stringContaining('recording continues') })]);
      // one file across the writer change, as long as the take
      const r = new WavReader(path.join(dir, file));
      expect(r.frames).toBe(takes[0].clip.length);
      expect(r.frames).toBeGreaterThan(48000 * 0.3);
      r.close();
      // the listener (main) saves the project and clears the journal; here nobody did
      expect(fs.existsSync(path.join(dir, JOURNAL_FILE))).toBe(true);
    } finally {
      engine.dispose();
    }
  });

  it('refuses to record onto a full disk', async () => {
    const { AudioEngine, VIRTUAL_API } = await import('../src/main/audio/engine');
    const engine = new AudioEngine(null);
    try {
      engine.applyConfig({ api: VIRTUAL_API, inputDeviceId: 1, outputDeviceId: 2, sampleRate: 48000, bufferSize: 480 });
      const dir = tmpDir();
      engine.setProject(addTrack(createProject('Full', 48000), { name: 'Host', inputChannels: [2], armed: true }), dir);
      engine.freeSpace = () => 40_000;
      expect(() => engine.record()).toThrow(/disk is full/);
      expect(fs.existsSync(path.join(dir, JOURNAL_FILE))).toBe(false);
    } finally {
      engine.dispose();
    }
  });
});
