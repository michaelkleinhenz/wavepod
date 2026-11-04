// Runs exports and loudness analysis off the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import type { CleanupOptions, ExportOptions, Project, TimelineWord } from '../shared/types';
import { scanCleanup } from '../core/cleanupScan';
import { exportProject } from '../core/exporter';
import { analyseClips, analyseProject } from '../core/analysis';
import { alignClip } from '../core/align';
import { setVstHost } from '../core/fx/vst';
import { VstHostProcess } from './vst/host';

interface Job {
  kind: 'export' | 'loudness' | 'clips' | 'align' | 'cleanup';
  words?: TimelineWord[];
  cleanup?: CleanupOptions;
  refTrackId?: string;
  project: Project;
  dir: string;
  opts?: ExportOptions;
  clipIds?: string[];
  mixOnly?: boolean;
  vstExe?: string | null;
  vstBridge?: string;
}

const job = workerData as Job;
// VST3 filters render through a host process of this worker's own
const usesVst = job.kind !== 'clips' && job.kind !== 'align' && [...(job.project.masterFx ?? []), ...job.project.tracks.flatMap((t) => [...(t.fx ?? []), ...t.clips.flatMap((c) => c.fx ?? [])])].some((f) => f.type === 'vst3' && f.enabled);
const vstHost = usesVst && job.vstExe && job.vstBridge ? new VstHostProcess(job.vstExe, job.vstBridge) : null;
if (vstHost) setVstHost(vstHost);
try {
  if (job.kind === 'export') {
    const result = exportProject(job.project, job.dir, job.opts!, (p) => parentPort!.postMessage({ type: 'progress', progress: p }));
    parentPort!.postMessage({ type: 'done', result });
  } else if (job.kind === 'cleanup') {
    parentPort!.postMessage({ type: 'done', result: scanCleanup(job.project, job.dir, job.words ?? [], job.cleanup!) });
  } else if (job.kind === 'align') {
    parentPort!.postMessage({ type: 'done', result: alignClip(job.project, job.dir, job.clipIds![0], job.refTrackId!) });
  } else if (job.kind === 'clips') {
    parentPort!.postMessage({ type: 'done', result: analyseClips(job.project, job.dir, job.clipIds ?? []) });
  } else {
    parentPort!.postMessage({ type: 'done', result: analyseProject(job.project, job.dir, job.mixOnly) });
  }
} catch (e) {
  parentPort!.postMessage({ type: 'error', message: (e as Error).message });
} finally {
  vstHost?.dispose();
}
