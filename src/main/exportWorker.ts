// Runs exports and loudness analysis off the main thread.
import { parentPort, workerData } from 'node:worker_threads';
import type { ExportOptions, LoudnessReport, Project } from '../shared/types';
import { exportProject, measureLoudness } from '../core/exporter';

interface Job {
  kind: 'export' | 'loudness';
  project: Project;
  dir: string;
  opts?: ExportOptions;
}

const job = workerData as Job;
try {
  if (job.kind === 'export') {
    const result = exportProject(job.project, job.dir, job.opts!, (p) => parentPort!.postMessage({ type: 'progress', progress: p }));
    parentPort!.postMessage({ type: 'done', result });
  } else {
    const reports: LoudnessReport[] = [];
    const master = measureLoudness(job.project, job.dir);
    reports.push({ trackId: 'master', integrated: master.integrated, peakDb: master.peakDb });
    for (const t of job.project.tracks) {
      if (!t.clips.length) continue;
      const r = measureLoudness(job.project, job.dir, [t]);
      reports.push({ trackId: t.id, integrated: r.integrated, peakDb: r.peakDb });
    }
    parentPort!.postMessage({ type: 'done', result: reports });
  }
} catch (e) {
  parentPort!.postMessage({ type: 'error', message: (e as Error).message });
}
