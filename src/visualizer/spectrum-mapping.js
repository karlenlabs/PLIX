// Unchanged 16-band mapping and smoothing from the visual/audio spike.
  const unit = value => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const hz = (i, count) => 40 * 400 ** (i / count);
  function update(current, input, dt, smoothing) {
    smoothing = unit(smoothing);
    for (let i = 0; i < current.length; i++) {
      const t = i / (current.length - 1);
      const target = unit(input?.[i]);
      // Visual easing only. Low sectors move broadly/slowly, high sectors faster,
      // but with a finite time constant even at smoothing=0 (no frame jitter).
      const tau = target > current[i]
        ? (0.18 - 0.14 * t) + smoothing * (0.20 - 0.10 * t)
        : (0.28 - 0.20 * t) + smoothing * (0.30 - 0.16 * t);
      current[i] += (target - current[i]) * (1 - Math.exp(-Math.max(0, Math.min(0.05, dt)) / tau));
      if (target === 0 && current[i] < 0.00001) current[i] = 0;
    }
    return current;
  }
  function offset(angle, values, seed, smoothing, gains = [1, 1, 1]) {
    const count = values.length;
    if (!count) return 0;
    const turn = Math.PI * 2;
    // Rotate and gently warp the sectors per blob, without oscillating the input.
    const position = ((angle + seed * 0.37 + 0.12 * Math.sin(angle * 2 + seed)) / turn * count % count + count) % count;
    let sum = 0, kernelSum = 0, mean = 0;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1), center = i + 0.5 + 0.12 * Math.sin(i * 2.4 + seed);
      const distance = Math.abs(position - center);
      const cyclic = Math.min(distance, count - distance);
      const width = (1.65 - t + unit(smoothing) * 0.8) * (0.94 + 0.06 * Math.sin(seed));
      const kernel = Math.exp(-0.5 * (cyclic / width) ** 2);
      const frequency = hz(i + 0.5, count);
      const gain = gains[frequency < 180 ? 0 : frequency < 2500 ? 1 : 2];
      const weight = (0.82 + 0.12 * Math.sin(seed + i * 1.7)) * (1.3 - 0.35 * t);
      const value = unit(values[i]) * weight * (Number.isFinite(gain) ? Math.max(0, gain) : 0);
      sum += value * kernel; kernelSum += kernel; mean += value;
    }
    // Remove most common expansion; a single hot band stays a local deformation.
    return 0.55 * (sum / kernelSum - 0.65 * mean / count) * (0.9 + 0.1 * Math.sin(seed * 2));
  }

export { hz, update, offset };
