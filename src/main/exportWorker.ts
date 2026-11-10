// Runs exports and loudness analysis off the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import type { CleanupOptions, ExportOptions, Project, TimelineWord } from '../shared/types';
import { scanCleanup } from '../core/cleanupScan';
import { exportProject } from '../core/exporter';
import { analyseClips, analyseProject } from '../core/analysis';
import { alignClips, stretchWav } from '../core/align';
import { importWav } from '../core/importAudio';
import { renderFused } from '../core/fuseRender';
import { setVstHost } from '../core/fx/vst';
import { VstHostProcess } from './vst/host';
import { setImpulseDir } from '../core/fx/convolution';

interface Job {
  kind: 'export' | 'loudness' | 'clips' | 'align' | 'stretch' | 'cleanup' | 'importWav' | 'fuse';
  /** stretch / importWav: absolute source and destination WAV (and the stretch factor); fuse: the destination. */
  src?: string;
  dest?: string;
  stretch?: number;
  words?: TimelineWord[];
  cleanup?: CleanupOptions;
  refTrackId?: string;
  project: Project;
  dir: string;
  opts?: ExportOptions;
  clipIds?: string[];
  mixOnly?: boolean;
  /** loudness: measure the mix folded to mono. */
  mono?: boolean;
  vstExe?: string | null;
  vstBridge?: string;
  /** Where convolution filters find their impulse responses. */
  impulseDir?: string;
  /** importWav: the episode's sample rate. */
  sampleRate?: number;
}

const job = workerData as Job;
if (job.impulseDir) setImpulseDir(job.impulseDir);
// VST3 filters render through a host process of this worker's own
const usesVst = job.kind !== 'clips' && job.kind !== 'align' && job.kind !== 'stretch' && job.kind !== 'importWav' && [...(job.project.masterFx ?? []), ...job.project.tracks.flatMap((t) => [...(t.fx ?? []), ...t.clips.flatMap((c) => c.fx ?? [])])].some((f) => f.type === 'vst3' && f.enabled);
const vstHost = usesVst && job.vstExe && job.vstBridge ? new VstHostProcess(job.vstExe, job.vstBridge) : null;
if (vstHost) setVstHost(vstHost);
try {
  if (job.kind === 'export') {
    const result = exportProject(job.project, job.dir, job.opts!, (p) => parentPort!.postMessage({ type: 'progress', progress: p }));
    parentPort!.postMessage({ type: 'done', result });
  } else if (job.kind === 'cleanup') {
    parentPort!.postMessage({ type: 'done', result: scanCleanup(job.project, job.dir, job.words ?? [], job.cleanup!) });
  } else if (job.kind === 'align') {
    parentPort!.postMessage({ type: 'done', result: alignClips(job.project, job.dir, job.clipIds ?? [], job.refTrackId!) });
  } else if (job.kind === 'stretch') {
    stretchWav(job.src!, job.dest!, job.stretch!, (f) => parentPort!.postMessage({ type: 'progress', progress: f }));
    parentPort!.postMessage({ type: 'done', result: null });
  } else if (job.kind === 'importWav') {
    const frames = importWav(job.src!, job.dest!, job.sampleRate!, (f) => parentPort!.postMessage({ type: 'progress', progress: f }));
    parentPort!.postMessage({ type: 'done', result: frames });
  } else if (job.kind === 'fuse') {
    const r = renderFused(job.project, job.dir, job.clipIds ?? [], job.dest!, (f) => parentPort!.postMessage({ type: 'progress', progress: f }));
    parentPort!.postMessage({ type: 'done', result: r });
  } else if (job.kind === 'clips') {
    parentPort!.postMessage({ type: 'done', result: analyseClips(job.project, job.dir, job.clipIds ?? []) });
  } else {
    parentPort!.postMessage({ type: 'done', result: analyseProject(job.project, job.dir, job.mixOnly, job.mono) });
  }
} catch (e) {
  parentPort!.postMessage({ type: 'error', message: (e as Error).message });
} finally {
  vstHost?.dispose();
}
