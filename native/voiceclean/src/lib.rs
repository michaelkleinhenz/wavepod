//! WavePod Voice Clean: splits a voice recording into three parts and mixes them back at the
//! levels the user chose:
//!
//! - **voice**: the dry voice,
//! - **ambience**: everything DeepFilterNet 3 says is not voice (noise, hum, traffic, music bleed),
//! - **reverb**: the late reverberation of the room that is still on the voice.
//!
//! DeepFilterNet works on 48 kHz in 10 ms hops. Its enhanced spectrum is the voice with the room,
//! the noisy spectrum minus that is the ambience. The voice spectrum is then split once more with a
//! statistical late-reverb model (Lebart et al. 2001 / Habets): the reverb in a bin is the energy
//! the bin had 50 ms ago, decayed by the room's reverberation time. The reverberation time is
//! estimated blindly from how fast the voice decays when a word ends.
//!
//! With all three levels at 0 dB the output is the input, only delayed.
//!
//! The module has a tiny C interface for WebAssembly (one instance per channel, see `vc_*`).

use df::tract::{DfParams, DfTract, RuntimeParams};
use df::Complex32;
use ndarray::Array2;

const DF_SR: usize = 48000;
/// The I/O buffer every instance shares with JavaScript.
pub const IO_LEN: usize = 8192;

// ---------------------------------------------------------------------------------------------
// Resampling (polyphase windowed sinc) for projects that are not at 48 kHz

fn gcd(a: usize, b: usize) -> usize {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

fn bessel_i0(x: f64) -> f64 {
    let mut sum = 1.0;
    let mut term = 1.0;
    let q = x * x / 4.0;
    for k in 1..60 {
        term *= q / (k as f64 * k as f64);
        sum += term;
        if term < 1e-14 * sum {
            break;
        }
    }
    sum
}

struct Resampler {
    l: usize,
    m: usize,
    taps: usize,
    /// Phase-major polyphase filter: h[p * taps + j].
    h: Vec<f32>,
    /// The last `taps` inputs, newest last, kept twice so a window never wraps.
    hist: Vec<f32>,
    pos: usize,
    phase: usize,
    start_phase: usize,
    /// Group delay in seconds.
    delay: f64,
}

impl Resampler {
    fn new(from: usize, to: usize) -> Self {
        let g = gcd(from, to);
        let (l, m) = (to / g, from / g);
        let taps = 64;
        let n = l * taps;
        let fc = 0.5 / l.max(m) as f64 * 0.92; // of the upsampled rate
        let beta = 8.0;
        let i0b = bessel_i0(beta);
        let mid = (n - 1) as f64 / 2.0;
        let proto: Vec<f64> = (0..n)
            .map(|i| {
                let t = i as f64 - mid;
                let sinc = if t == 0.0 { 2.0 * fc } else { (2.0 * std::f64::consts::PI * fc * t).sin() / (std::f64::consts::PI * t) };
                let r = t / mid;
                let w = bessel_i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0b;
                sinc * w * l as f64
            })
            .collect();
        let mut h = vec![0f32; n];
        for p in 0..l {
            for j in 0..taps {
                h[p * taps + j] = proto[p + j * l] as f32;
            }
        }
        Resampler { l, m, taps, h, hist: vec![0.0; taps * 2], pos: 0, phase: 0, start_phase: 0, delay: mid / (from * l) as f64 }
    }

    fn push(&mut self, x: f32, out: &mut Vec<f32>) {
        // ring kept twice: hist[pos] and hist[pos + taps] hold the same sample
        self.hist[self.pos] = x;
        self.hist[self.pos + self.taps] = x;
        self.pos = (self.pos + 1) % self.taps;
        // the newest sample is at pos - 1 (+ taps); a window of taps ending there is contiguous
        let newest = self.pos + self.taps - 1;
        while self.phase < self.l {
            let h = &self.h[self.phase * self.taps..(self.phase + 1) * self.taps];
            let mut acc = 0f32;
            for (j, c) in h.iter().enumerate() {
                acc += c * self.hist[newest - j];
            }
            out.push(acc);
            self.phase += self.m;
        }
        self.phase -= self.l;
    }

    fn reset(&mut self) {
        self.hist.fill(0.0);
        self.pos = 0;
        self.phase = self.start_phase;
    }
}

// ---------------------------------------------------------------------------------------------
// Late reverberation estimate and blind reverberation time

/// Frames (10 ms each) between the direct sound and the start of the "late" reverb.
const REVERB_GAP: usize = 5;
const RT_MIN: f32 = 0.1;
const RT_MAX: f32 = 2.0;
/// Most the dry voice is turned down where the model hears only reverb (−24 dB).
const DRY_FLOOR: f32 = 0.063;
/// Per-frame factor the noise estimate may rise by (6 dB per second at 100 frames per second).
const NOISE_RISE: f32 = 1.0139;
/// Mean over minimum of a smoothed noise power.
const NOISE_BIAS: f32 = 4.0;

/// Splits DeepFilterNet's two halves once more by the room:
///
/// - DeepFilterNet's voice still carries some of the room (early and part of the late reverb),
/// - what it took away holds the noise *and* most of the late reverb, because it was trained to
///   keep a voice clean of both.
///
/// The late reverb in a bin is predicted from the reverberant voice (voice + reverb, noise left
/// out) 60 ms earlier, decayed by the reverberation time (Lebart et al. 2001, Habets 2007). That
/// energy is first taken from the removed part, the rest from the voice.
struct Dereverb {
    bins: usize,
    /// Reverberant voice power per bin of the last REVERB_GAP + 1 frames (ring).
    psd: Vec<Vec<f32>>,
    at: usize,
    /// Smoothed power of the removed part.
    removed: Vec<f32>,
    /// Steady noise in the removed part: a slowly rising minimum of its power (−1 = not yet known).
    noise: Vec<f32>,
    voice_gain: Vec<f32>,
    removed_gain: Vec<f32>,
    /// Reverberation time in seconds (estimated).
    rt60: f32,
    // decay tracker
    prev_db: f32,
    floor_db: f32,
    peak_db: f32,
    run: Vec<f32>,
    candidates: Vec<f32>,
    next_candidate: usize,
}

impl Dereverb {
    fn new(bins: usize) -> Self {
        Dereverb {
            bins,
            psd: vec![vec![0.0; bins]; REVERB_GAP + 1],
            at: 0,
            removed: vec![0.0; bins],
            noise: vec![-1.0; bins],
            voice_gain: vec![1.0; bins],
            removed_gain: vec![0.0; bins],
            rt60: 0.3,
            prev_db: -120.0,
            floor_db: 0.0,
            peak_db: -120.0,
            run: Vec::with_capacity(128),
            candidates: Vec::with_capacity(48),
            next_candidate: 0,
        }
    }

    fn reset(&mut self) {
        for p in &mut self.psd {
            p.fill(0.0);
        }
        self.removed.fill(0.0);
        self.noise.fill(-1.0);
        self.voice_gain.fill(1.0);
        self.removed_gain.fill(0.0);
        self.prev_db = -120.0;
        self.floor_db = 0.0;
        self.peak_db = -120.0;
        self.run.clear();
    }

    /// Follows the level of the reverberant voice (100 Hz – 5 kHz; the input without its steady
    /// noise) and, whenever it falls steadily after a word while staying clear of the floor, takes the slope of that fall as a reverberation time
    /// candidate. A voice can stop faster than the room, never slower, so the faster decays belong
    /// to the room: the estimate follows a low percentile of the candidates.
    fn track_decay(&mut self, reverberant: &[f32]) {
        let hz_per_bin = DF_SR as f32 / ((self.bins - 1) * 2) as f32;
        let lo = (100.0 / hz_per_bin) as usize;
        let hi = ((5000.0 / hz_per_bin) as usize).min(self.bins);
        let e: f32 = reverberant[lo..hi].iter().sum();
        let db = 10.0 * (e + 1e-12).log10();
        // noise floor: follows drops at once, rises 3 dB per second
        self.floor_db = if db < self.floor_db || self.floor_db == 0.0 { db } else { self.floor_db + 0.03 };
        self.peak_db = if db > self.peak_db { db } else { self.peak_db - 0.02 };
        let clear = db > self.floor_db + 12.0;
        if db < self.prev_db + 0.3 && clear && !self.run.is_empty() {
            // still falling (a little ripple is fine)
            self.run.push(db);
        } else if db < self.prev_db - 0.3 && clear && self.prev_db > self.peak_db - 30.0 {
            self.end_run();
            self.run.push(self.prev_db);
            self.run.push(db);
        } else {
            self.end_run();
        }
        if self.run.len() >= 100 {
            self.end_run();
        }
        self.prev_db = db;
    }

    fn end_run(&mut self) {
        let n = self.run.len();
        // at least 100 ms falling by 10 dB or more
        if n >= 10 && self.run[0] - self.run[n - 1] >= 10.0 {
            // least-squares slope in dB per frame over the first 25 dB of the fall (where noise
            // has not flattened it yet), skipping the first two frames (the word's own end)
            let start = self.run[0];
            let cut = self.run.iter().position(|&d| d < start - 25.0).unwrap_or(n);
            if cut < 8 {
                self.run.clear();
                return;
            }
            let ys = &self.run[2..cut];
            let k = ys.len() as f32;
            let mx = (k - 1.0) / 2.0;
            let my = ys.iter().sum::<f32>() / k;
            let (mut sxy, mut sxx) = (0f32, 0f32);
            for (i, y) in ys.iter().enumerate() {
                let dx = i as f32 - mx;
                sxy += dx * (y - my);
                sxx += dx * dx;
            }
            let slope = sxy / sxx; // dB per 10 ms frame
            if slope < -0.03 {
                let rt = (60.0 / -slope * 0.01).clamp(RT_MIN, RT_MAX);
                if self.candidates.len() < 48 {
                    self.candidates.push(rt);
                } else {
                    self.candidates[self.next_candidate] = rt;
                    self.next_candidate = (self.next_candidate + 1) % 48;
                }
                let mut sorted = self.candidates.clone();
                sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
                let p = sorted[(sorted.len() as f32 * 0.2) as usize];
                let w = if self.candidates.len() < 4 { 0.3 } else { 0.5 };
                self.rt60 += w * (p - self.rt60);
            }
        }
        self.run.clear();
    }

    /// From the input and DeepFilterNet's voice, fills the dry voice (in `voice`), the reverb and
    /// the ambience. The three add up to the input.
    fn split(&mut self, input: &[Complex32], voice: &mut [Complex32], reverb: &mut [Complex32], ambience: &mut [Complex32]) {
        let t = (REVERB_GAP + 1) as f32 * 0.01;
        let decay = 10f32.powf(-6.0 * t / self.rt60);
        let next = (self.at + 1) % self.psd.len(); // the oldest frame
        for k in 0..self.bins {
            let removed = input[k] - voice[k];
            let pv = voice[k].norm_sqr();
            self.removed[k] = 0.7 * self.removed[k] + 0.3 * removed.norm_sqr();
            let pr = self.removed[k];
            // steady noise: follows drops at once, may rise about 6 dB per second
            let n = &mut self.noise[k];
            *n = if *n < 0.0 || pr < *n { pr } else { *n * NOISE_RISE };
            let noise = *n * NOISE_BIAS;
            let late = decay * self.psd[next][k];
            // the late reverb comes out of the removed part first (never its steady noise) …
            let reverb_room = (pr - noise).max(0.0);
            let taken = late.min(reverb_room);
            let gr = if pr > 1e-12 { taken / pr } else { 0.0 };
            // … and what is left of it out of the voice
            let rest = late - taken;
            let pvs = 0.5 * pv + 0.5 * self.psd[self.at][k].min(pv * 4.0);
            let gv = if pvs > 1e-12 { (1.0 - 1.5 * rest / pvs).clamp(DRY_FLOOR, 1.0) } else { 1.0 };
            // gains: fast towards more voice, slower away from it
            let sv = if gv > self.voice_gain[k] { 0.6 } else { 0.4 };
            self.voice_gain[k] += sv * (gv - self.voice_gain[k]);
            let sr = if gr > self.removed_gain[k] { 0.6 } else { 0.4 };
            self.removed_gain[k] += sr * (gr - self.removed_gain[k]);
            let (gv, gr) = (self.voice_gain[k], self.removed_gain[k]);
            reverb[k] = voice[k] * (1.0 - gv) + removed * gr;
            ambience[k] = removed * (1.0 - gr);
            voice[k] *= gv;
            // the reverberant voice of this frame (voice and room, not the noise) predicts the
            // late reverb REVERB_GAP + 1 frames on
            self.psd[next][k] = pv + reverb_room;
        }
        self.at = next;
        let frame = std::mem::take(&mut self.psd[next]);
        self.track_decay(&frame);
        self.psd[next] = frame;
    }
}

// ---------------------------------------------------------------------------------------------
// One channel

thread_local! {
    /// The loaded model; instances are clones of it (the weights are shared).
    static TEMPLATE: std::cell::RefCell<Option<DfTract>> = const { std::cell::RefCell::new(None) };
}

fn template() -> DfTract {
    TEMPLATE.with(|t| {
        t.borrow_mut()
            .get_or_insert_with(|| {
                let rp = RuntimeParams::default_with_ch(1).with_atten_lim(100.0);
                DfTract::new(DfParams::default(), &rp).expect("DeepFilterNet model")
            })
            .clone()
    })
}

pub struct VoiceClean {
    sr: usize,
    df: DfTract,
    hop: usize,
    down: Option<Resampler>,
    up: Option<Resampler>,
    /// 48 kHz input waiting for a full hop, and 48 kHz output.
    in48: Vec<f32>,
    out48: Vec<f32>,
    /// Output at the project rate, waiting to be handed out.
    out: std::collections::VecDeque<f32>,
    frame_in: Array2<f32>,
    frame_out: Array2<f32>,
    dereverb: Dereverb,
    reverb_buf: Vec<Complex32>,
    ambience_buf: Vec<Complex32>,
    pub voice: f32,
    pub ambience: f32,
    pub reverb: f32,
    pub lsnr: f32,
    latency: usize,
    pub io: Vec<f32>,
}

impl VoiceClean {
    pub fn new(sr: usize) -> Self {
        let df = template();
        let hop = df.hop_size;
        let bins = df.n_freqs;
        let (mut down, up) = if sr == DF_SR { (None, None) } else { (Some(Resampler::new(sr, DF_SR)), Some(Resampler::new(DF_SR, sr))) };
        // The two resamplers delay by a fraction of a sample in all; starting the first one a few
        // phases later takes that fraction out, so the latency the mixer compensates is exact.
        if let (Some(d), Some(u)) = (down.as_mut(), up.as_ref()) {
            let total = (d.delay + u.delay) * sr as f64;
            let p0 = ((total - total.floor()) * d.l as f64).round() as usize;
            if p0 > 0 && p0 < d.l {
                d.start_phase = p0;
                d.phase = p0;
                d.delay -= p0 as f64 / (sr * d.l) as f64;
            }
        }
        // DeepFilterNet: one window minus one hop of STFT delay, plus its look-ahead frames
        let df_delay = (df.fft_size - hop + df.lookahead * hop) as f64 / DF_SR as f64;
        let rs_delay = down.as_ref().map_or(0.0, |r| r.delay) + up.as_ref().map_or(0.0, |r| r.delay);
        // plus one hop of buffering (at 48 kHz, which is what the output queue is primed with)
        let latency = ((df_delay + rs_delay + hop as f64 / DF_SR as f64) * sr as f64).round() as usize;
        let mut vc = VoiceClean {
            sr,
            df,
            hop,
            down,
            up,
            in48: Vec::with_capacity(hop * 4),
            out48: Vec::with_capacity(hop * 4),
            out: std::collections::VecDeque::with_capacity(IO_LEN * 2),
            frame_in: Array2::zeros((1, hop)),
            frame_out: Array2::zeros((1, hop)),
            dereverb: Dereverb::new(bins),
            reverb_buf: vec![Complex32::new(0.0, 0.0); bins],
            ambience_buf: vec![Complex32::new(0.0, 0.0); bins],
            voice: 1.0,
            ambience: 1.0,
            reverb: 1.0,
            lsnr: 0.0,
            latency,
            io: vec![0.0; IO_LEN],
        };
        vc.prime();
        vc
    }

    /// The output queue starts with one hop of silence so a full hop is always ready.
    fn prime(&mut self) {
        self.out.clear();
        let mut primed = Vec::new();
        match self.up.as_mut() {
            Some(up) => {
                for _ in 0..self.hop {
                    up.push(0.0, &mut primed);
                }
            }
            None => primed.resize(self.hop, 0.0),
        }
        self.out.extend(primed);
    }

    pub fn latency(&self) -> usize {
        self.latency
    }

    pub fn reset(&mut self) {
        self.df = template();
        if let Some(r) = self.down.as_mut() {
            r.reset();
        }
        if let Some(r) = self.up.as_mut() {
            r.reset();
        }
        self.in48.clear();
        self.out48.clear();
        self.dereverb.reset();
        self.prime();
    }

    fn run_hop(&mut self) {
        let hop = self.hop;
        self.frame_in.as_slice_mut().unwrap().copy_from_slice(&self.in48[..hop]);
        self.in48.drain(..hop);
        let (v, a, r) = (self.voice, self.ambience, self.reverb);
        let unity = v == 1.0 && a == 1.0 && r == 1.0;
        let dereverb = &mut self.dereverb;
        let reverb = &mut self.reverb_buf;
        let ambience = &mut self.ambience_buf;
        let lsnr = self.df.process_mix(self.frame_in.view(), self.frame_out.view_mut(), &mut |noisy, enh| {
            // ambience = what DeepFilterNet took away; split the rest into dry voice and reverb
            dereverb.split(noisy, enh, reverb, ambience);
            if unity {
                enh.copy_from_slice(noisy);
                return;
            }
            for k in 0..enh.len() {
                enh[k] = enh[k] * v + reverb[k] * r + ambience[k] * a;
            }
        });
        self.lsnr = lsnr.unwrap_or(0.0);
        let out = self.frame_out.as_slice().unwrap();
        match self.up.as_mut() {
            Some(up) => {
                let mut tmp = std::mem::take(&mut self.out48);
                tmp.clear();
                for &x in out {
                    up.push(x, &mut tmp);
                }
                self.out.extend(tmp.iter());
                self.out48 = tmp;
            }
            None => self.out.extend(out.iter()),
        }
    }

    /// Processes `n` samples of `self.io` in place.
    pub fn process(&mut self, n: usize) {
        let n = n.min(IO_LEN);
        for i in 0..n {
            let x = self.io[i];
            match self.down.as_mut() {
                Some(down) => down.push(x, &mut self.in48),
                None => self.in48.push(x),
            }
            while self.in48.len() >= self.hop {
                self.run_hop();
            }
        }
        for i in 0..n {
            self.io[i] = self.out.pop_front().unwrap_or(0.0);
        }
    }

    pub fn rt60(&self) -> f32 {
        self.dereverb.rt60
    }

    pub fn sample_rate(&self) -> usize {
        self.sr
    }
}

// ---------------------------------------------------------------------------------------------
// C interface for WebAssembly

/// Creates an instance for one channel at the given sample rate. The model is loaded once.
#[no_mangle]
pub extern "C" fn vc_new(sample_rate: u32) -> *mut VoiceClean {
    Box::into_raw(Box::new(VoiceClean::new(sample_rate as usize)))
}

/// # Safety
/// `p` must come from `vc_new` and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn vc_free(p: *mut VoiceClean) {
    if !p.is_null() {
        drop(Box::from_raw(p));
    }
}

/// # Safety
/// `p` must come from `vc_new`.
#[no_mangle]
pub unsafe extern "C" fn vc_io(p: *mut VoiceClean) -> *mut f32 {
    (*p).io.as_mut_ptr()
}

/// Linear gains of the three parts.
/// # Safety
/// `p` must come from `vc_new`.
#[no_mangle]
pub unsafe extern "C" fn vc_set(p: *mut VoiceClean, voice: f32, ambience: f32, reverb: f32) {
    let v = &mut *p;
    v.voice = voice;
    v.ambience = ambience;
    v.reverb = reverb;
}

/// Processes `n` (≤ 8192) samples of the I/O buffer in place.
/// # Safety
/// `p` must come from `vc_new`.
#[no_mangle]
pub unsafe extern "C" fn vc_process(p: *mut VoiceClean, n: u32) {
    (*p).process(n as usize)
}

/// # Safety
/// `p` must come from `vc_new`.
#[no_mangle]
pub unsafe extern "C" fn vc_latency(p: *mut VoiceClean) -> u32 {
    (*p).latency() as u32
}

/// # Safety
/// `p` must come from `vc_new`.
#[no_mangle]
pub unsafe extern "C" fn vc_reset(p: *mut VoiceClean) {
    (*p).reset()
}

/// Estimated reverberation time of the room in seconds.
/// # Safety
/// `p` must come from `vc_new`.
#[no_mangle]
pub unsafe extern "C" fn vc_rt60(p: *mut VoiceClean) -> f32 {
    (*p).rt60()
}

/// DeepFilterNet's local SNR estimate of the last hop, in dB.
/// # Safety
/// `p` must come from `vc_new`.
#[no_mangle]
pub unsafe extern "C" fn vc_lsnr(p: *mut VoiceClean) -> f32 {
    (*p).lsnr
}

/// Loads the model, so the first instance on the audio thread does not have to.
#[no_mangle]
pub extern "C" fn vc_init() {
    let _ = template();
}

#[cfg(target_arch = "wasm32")]
fn no_entropy(buf: &mut [u8]) -> Result<(), getrandom::Error> {
    // Nothing in inference needs randomness; a fixed sequence keeps the module free of imports.
    let mut x: u32 = 0x9E37_79B9;
    for b in buf.iter_mut() {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        *b = x as u8;
    }
    Ok(())
}
#[cfg(target_arch = "wasm32")]
getrandom::register_custom_getrandom!(no_entropy);
