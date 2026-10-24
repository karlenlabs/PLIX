// One serialized poll stream. Mutations invalidate old reads and defer refresh
// until both the active read and the transport/seek command have completed.
export function createMediaPoll<T>(options: {
  read: () => Promise<T>;
  accept: (state: T) => void;
  error: (cause: unknown) => void;
  discard: () => void;
}) {
  let active = true;
  let version = 0;
  let mutations = 0;
  let pending = false;
  let running: Promise<void> | null = null;

  async function drain() {
    while (active && pending && mutations === 0) {
      pending = false;
      const readVersion = version;
      try {
        const state = await options.read();
        if (!active) return;
        if (readVersion !== version) {
          options.discard();
          pending = true;
        } else {
          options.accept(state);
        }
      } catch (cause) {
        if (!active) return;
        if (readVersion !== version) {
          options.discard();
          pending = true;
        } else {
          options.error(cause);
        }
      }
    }
  }

  function refresh(): Promise<void> {
    if (!active) return Promise.resolve();
    pending = true;
    if (!running && mutations === 0) {
      running = drain().finally(() => {
        running = null;
        // Cover a refresh queued between drain finishing and this cleanup.
        if (active && pending && mutations === 0) return refresh();
      });
    }
    return running ?? Promise.resolve();
  }

  function beginMutation() {
    version++;
    mutations++;
    let finished = false;
    return async () => {
      if (finished) return;
      finished = true;
      version++;
      mutations--;
      await refresh();
    };
  }

  return { refresh, beginMutation, stop: () => { active = false; pending = false; } };
}

export type TransportCommand = "previous_track" | "play_pause" | "next_track";
type Capabilities = {
  playbackState: string;
  canPlay: boolean;
  canPause: boolean;
  canPrevious: boolean;
  canNext: boolean;
};

export function canTransport(media: Capabilities | null, command: TransportCommand): boolean {
  if (!media) return false;
  if (command === "previous_track") return media.canPrevious;
  if (command === "next_track") return media.canNext;
  if (media.playbackState === "unknown") return false;
  return media.playbackState === "playing" ? media.canPause : media.canPlay;
}

type SeekState = {
  canSeek: boolean;
  trackKey: string | null;
  seekMinMs: number | null;
  seekMaxMs: number | null;
};

export function clampSeek(media: SeekState | null, position: number): number | null {
  if (!media?.canSeek || !media.trackKey || !Number.isFinite(position) ||
      media.seekMinMs === null || media.seekMaxMs === null || media.seekMinMs > media.seekMaxMs) return null;
  return Math.min(media.seekMaxMs, Math.max(media.seekMinMs, Math.round(position)));
}
