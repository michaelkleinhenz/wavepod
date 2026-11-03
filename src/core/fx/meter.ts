// Meter helpers shared by the filters.

/** Keeps the most extreme gain change (dB) between two meter reads. */
export class GainMeter {
  private v = 0;
  note(db: number): void {
    if (Math.abs(db) > Math.abs(this.v)) this.v = db;
  }
  take(): number {
    const v = this.v;
    this.v = 0;
    return Math.max(-60, v);
  }
}
