// Canonical anchor geometry from the visual/audio spike.
  function positions(layout, count, seed) {
    if (count === 1 && layout !== 'Randomized') return [{ x: 220, y: 82 }];
    if (layout === 'Horizontal') return Array.from({ length: count }, (_, i) => ({ x: 105 + i * 230 / (count - 1), y: 82 }));
    if (layout === 'Triangular') {
      const points = [[220, 49], [144, 111], [296, 111], [182, 80], [258, 80], [220, 111]];
      return points.slice(0, count).map(([x, y]) => ({ x, y }));
    }
    if (layout === 'Randomized') {
      let value = seed >>> 0;
      const random = () => { value = (Math.imul(value, 1664525) + 1013904223) >>> 0; return value / 4294967296; };
      return Array.from({ length: count }, () => ({ x: 90 + random() * 260, y: 45 + random() * 74 }));
    }
    if (count === 3) return [{ x: 129, y: 86 }, { x: 302, y: 82 }, { x: 216, y: 97 }];
    return Array.from({ length: count }, (_, i) => ({ x: 220 + 76 * Math.cos(Math.PI * 2 * i / count), y: 82 + 22 * Math.sin(Math.PI * 2 * i / count) }));
  }
  function anchor(position, state, blob) {
    return { x: 220 + (position.x - 220) * state.spread + blob.x,
      y: 82 + (position.y - 82) * state.spread + blob.y };
  }

export { positions, anchor };
