export type FlushRequest = { id: number; quit: boolean };

// Closing waits for the frontend's newest queued draft, which has not yet crossed
// IPC. Subscribe before querying pending state to cover early native close/quit.
export function installAppearanceLifecycle(options: {
  subscribe: (receive: (request: FlushRequest) => void) => Promise<() => void>;
  pending: () => Promise<FlushRequest | null>;
  flush: () => Promise<void>;
  acknowledge: (id: number, error: string | null) => Promise<void>;
  closing: (value: boolean) => void;
  error: (cause: unknown) => void;
}) {
  let active = true;
  let unlisten: (() => void) | undefined;
  let latestId = -1;
  let queued: FlushRequest | null = null;
  let flushing = false;

  async function drain() {
    if (flushing || !active) return;
    flushing = true;
    options.closing(true);
    try {
      while (queued && active) {
        const request = queued;
        queued = null;
        let failure: string | null = null;
        try { await options.flush(); }
        catch (cause) { failure = String(cause); if (active) options.error(cause); }
        if (!active) return;
        try { await options.acknowledge(request.id, failure); }
        catch (cause) {
          // If IPC failed before delivery, the backend may resend the same Quit.
          // Permit an explicit retry; never retry acknowledgements in a loop.
          if (latestId === request.id) latestId = request.id - 1;
          if (active) options.error(cause);
        }
      }
    } finally {
      flushing = false;
      if (active) options.closing(false);
    }
  }

  function receive(request: FlushRequest) {
    if (!active || request.id <= latestId) return;
    latestId = request.id;
    queued = request;
    void drain();
  }

  void (async () => {
    try {
      const stop = await options.subscribe(receive);
      if (!active) { stop(); return; }
      unlisten = stop;
      const request = await options.pending();
      if (request) receive(request);
    } catch (cause) { if (active) options.error(cause); }
  })();

  return () => { active = false; queued = null; unlisten?.(); };
}
