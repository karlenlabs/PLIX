//! Original three bands plus logarithmic 8/16 bands from the same RustFFT spectrum.
use rustfft::{num_complex::Complex, Fft, FftPlanner};
use std::{f32::consts::TAU, sync::Arc};

pub const SAMPLE_RATE: usize = 48_000;
pub const FFT_SIZE: usize = 1024;
pub const NORMALIZATION_REFERENCE: f32 = 0.1;
pub const BANDS: [(f32, f32); 3] = [(20.0, 180.0), (180.0, 2500.0), (2500.0, 12000.0)];

pub fn log_edges() -> [f32; 17] {
    std::array::from_fn(|i| (40.0 * 400.0_f64.powf(i as f64 / 16.0)) as f32)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Bands {
    pub normalized: [f32; 3],
    pub bands16: [f32; 16],
}

fn finite_sample(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

pub fn stereo_to_mono(left: f32, right: f32) -> f32 {
    0.5 * finite_sample(left) + 0.5 * finite_sample(right)
}

pub fn normalize(raw: f32) -> f32 {
    if raw.is_finite() && raw > 0.0 {
        raw / (raw + NORMALIZATION_REFERENCE)
    } else {
        0.0
    }
}

pub struct Analyzer {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    window_power: f64,
    mono: Vec<f32>,
    filled: usize,
    buffer: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    magnitudes: Vec<f32>,
    bin_band: Vec<Option<usize>>,
    log_weights: Vec<[f64; 16]>,
    latest: Bands,
    pub windows: u64,
}

impl Analyzer {
    pub fn new() -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        let scratch = vec![Complex::default(); fft.get_inplace_scratch_len()];
        // Periodic Hann, suitable for a DFT: w[n] = .5 - .5*cos(2*pi*n/N).
        let window: Vec<_> = (0..FFT_SIZE)
            .map(|n| 0.5 - 0.5 * (TAU * n as f32 / FFT_SIZE as f32).cos())
            .collect();
        let window_power = window.iter().map(|&w| f64::from(w).powi(2)).sum();
        let bin_band = (0..=FFT_SIZE / 2)
            .map(|k| {
                let hz = k as f32 * SAMPLE_RATE as f32 / FFT_SIZE as f32;
                BANDS.iter().enumerate().find_map(|(i, &(lo, hi))| {
                    (hz >= lo && (hz < hi || (i == 2 && hz == hi))).then_some(i)
                })
            })
            .collect();
        // Fractional bin-cell overlap avoids permanently empty narrow low bands.
        // It does not create frequency resolution beyond the existing 46.875 Hz/bin.
        // Positive-frequency cells only; DC is excluded as in the original bands.
        let edges = log_edges();
        let bin_hz = SAMPLE_RATE as f64 / FFT_SIZE as f64;
        let log_weights = (0..=FFT_SIZE / 2)
            .map(|k| {
                std::array::from_fn(|i| {
                    if k == 0 {
                        return 0.0;
                    }
                    let lo = ((k as f64 - 0.5) * bin_hz).max(f64::from(edges[i]));
                    let hi = ((k as f64 + 0.5) * bin_hz).min(f64::from(edges[i + 1]));
                    (hi - lo).max(0.0) / bin_hz
                })
            })
            .collect();
        Self {
            fft,
            window,
            window_power,
            mono: vec![0.0; FFT_SIZE],
            filled: 0,
            buffer: vec![Complex::default(); FFT_SIZE],
            scratch,
            magnitudes: vec![0.0; FFT_SIZE / 2 + 1],
            bin_band,
            log_weights,
            latest: Bands::default(),
            windows: 0,
        }
    }

    // No allocation, overlap, adaptive state, or packet-boundary assumptions on this path.
    // Return how many complete 1024-sample windows were analyzed.

    pub fn push_stereo(&mut self, frames: &[[f32; 2]]) -> u64 {
        let before = self.windows;
        for &[left, right] in frames {
            self.push_sample(stereo_to_mono(left, right));
        }
        self.windows - before
    }

    fn push_sample(&mut self, sample: f32) {
        self.mono[self.filled] = finite_sample(sample);
        self.filled += 1;
        if self.filled == FFT_SIZE {
            self.analyze();
            self.filled = 0;
        }
    }

    pub fn latest(&self) -> Bands {
        self.latest
    }

    pub fn reset(&mut self) {
        self.filled = 0;
        self.latest = Bands::default();
    }

    fn analyze(&mut self) {
        for ((value, &sample), &window) in self.buffer.iter_mut().zip(&self.mono).zip(&self.window)
        {
            *value = Complex::new(sample * window, 0.0);
        }
        self.fft
            .process_with_scratch(&mut self.buffer, &mut self.scratch);
        let mut power = [0.0_f64; 3];
        for (k, magnitude) in self.magnitudes.iter_mut().enumerate() {
            *magnitude = self.buffer[k].norm();
            if let Some(band) = self.bin_band[k] {
                power[band] += f64::from(*magnitude).powi(2);
            }
        }
        // All selected bins are positive frequencies below Nyquist, so the one-sided
        // energy factor is 2. Hann power correction preserves stationary RMS scale.
        let raw = power.map(|p| (2.0 * p / (FFT_SIZE as f64 * self.window_power)).sqrt() as f32);
        let mut log_power = [0.0_f64; 16];
        for (magnitude, weights) in self.magnitudes.iter().zip(&self.log_weights) {
            let p = f64::from(*magnitude).powi(2);
            for (sum, weight) in log_power.iter_mut().zip(weights) {
                *sum += p * weight;
            }
        }
        let rms = |p: f64| (2.0 * p / (FFT_SIZE as f64 * self.window_power)).sqrt() as f32;
        let raw16 = log_power.map(rms);
        // Merge adjacent powers before RMS/normalization, not normalized values.
        self.latest = Bands {
            normalized: raw.map(normalize),
            bands16: raw16.map(normalize),
        };
        self.windows += 1;
    }
}

