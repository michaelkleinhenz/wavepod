// Linear prediction helpers for the repair filters: fill short gaps (clicks, clipped peaks) with
// what the surrounding audio predicts.

/**
 * Prediction coefficients c[1..p] fitted by least squares on the segments (covariance method):
 * more exact than the autocorrelation method on the short stretches around a gap.
 */
export function predictor(segments: ArrayLike<number>[], p: number): Float64Array {
  const A = new Float64Array(p * p);
  const y = new Float64Array(p);
  for (const s of segments) {
    for (let n = p; n < s.length; n++) {
      for (let j = 0; j < p; j++) {
        const xj = s[n - 1 - j];
        y[j] += s[n] * xj;
        for (let k = 0; k <= j; k++) A[j * p + k] += xj * s[n - 1 - k];
      }
    }
  }
  let tr = 0;
  for (let j = 0; j < p; j++) tr += A[j * p + j];
  const lambda = (tr / p) * 1e-5 + 1e-12;
  for (let j = 0; j < p; j++) A[j * p + j] += lambda;
  // Cholesky (lower triangle), then solve
  for (let j = 0; j < p; j++) {
    for (let k = 0; k <= j; k++) {
      let sum = A[j * p + k];
      for (let m = 0; m < k; m++) sum -= A[j * p + m] * A[k * p + m];
      A[j * p + k] = j === k ? Math.sqrt(Math.max(sum, 1e-18)) : sum / A[k * p + k];
    }
  }
  const z = new Float64Array(p);
  for (let j = 0; j < p; j++) {
    let sum = y[j];
    for (let m = 0; m < j; m++) sum -= A[j * p + m] * z[m];
    z[j] = sum / A[j * p + j];
  }
  const c = new Float64Array(p + 1);
  for (let j = p - 1; j >= 0; j--) {
    let sum = z[j];
    for (let m = j + 1; m < p; m++) sum -= A[m * p + j] * c[m + 1];
    c[j + 1] = sum / A[j * p + j];
  }
  return c;
}

/**
 * Replaces x[a..b) with an interpolation from the `ctx` samples on each side: one AR model of the
 * surroundings predicts forward from the left and backward from the right, cross-faded.
 */
export function interpolateGap(x: Float32Array, a: number, b: number, ctx: number, order = 32): void {
  const m = b - a;
  if (m <= 0) return;
  const left = x.subarray(Math.max(0, a - ctx), a);
  const right = x.subarray(b, Math.min(x.length, b + ctx));
  const p = Math.min(order, Math.floor(Math.min(left.length, right.length) / 2));
  const l0 = left.length ? left[left.length - 1] : 0;
  const r0 = right.length ? right[0] : 0;
  if (p < 2) {
    for (let j = 0; j < m; j++) x[a + j] = l0 + ((r0 - l0) * (j + 1)) / (m + 1);
    return;
  }
  const c = predictor([left, right], p);
  const fwd = new Float64Array(m);
  for (let j = 0; j < m; j++) {
    let acc = 0;
    for (let k = 1; k <= p; k++) {
      const i = j - k;
      acc += c[k] * (i >= 0 ? fwd[i] : a + i >= 0 ? x[a + i] : 0);
    }
    fwd[j] = acc;
  }
  const bwd = new Float64Array(m);
  for (let j = m - 1; j >= 0; j--) {
    let acc = 0;
    for (let k = 1; k <= p; k++) {
      const i = j + k;
      acc += c[k] * (i < m ? bwd[i] : a + i < x.length ? x[a + i] : 0);
    }
    bwd[j] = acc;
  }
  for (let j = 0; j < m; j++) {
    const w = 0.5 - 0.5 * Math.cos((Math.PI * (j + 1)) / (m + 1));
    x[a + j] = (1 - w) * fwd[j] + w * bwd[j];
  }
}
