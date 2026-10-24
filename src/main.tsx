import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { AppearanceWindow, startWindowDrag, useAppearance } from "./appearance";
import { showPlayerContextMenu } from "./player_context_menu";
import { canTransport, clampSeek, createMediaPoll, type TransportCommand } from "./media_sync";
import { NEUTRAL_PALETTE, paletteFromArtwork, type ArtworkPalette } from "./artwork_accent";
import { VisualizerLayer } from "./visualizer/layer";
import { createAmbientHaze } from "./ambient_haze";
import "./design/ambient_haze.css";
import "./style.css";
import { productionStyle } from "./design/runtime";
import "./design/surface.css";
import "./design/effects.css";
import "./design/play_pause.css";
import "./design/warm_cream.css";

type MediaState = {
  sourceId: string;
  title: string | null;
  artist: string | null;
  playbackState: string;
  durationMs: number | null;
  positionMs: number | null;
  canPlay: boolean;
  canPause: boolean;
  canPrevious: boolean;
  canNext: boolean;
  canSeek: boolean;
  seekMinMs: number | null;
  seekMaxMs: number | null;
  trackKey: string | null;
  artwork: { dataUrl: string | null } | null;
};
type Snapshot = { media: MediaState | null; at: number };
type Scrub = { position: number; trackKey: string };

function formatTime(ms: number | null): string {
  if (ms === null) return "--:--";
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function Icon({ name }: { name: "previous" | "next" | "play" | "pause" | "music" }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      {name === "play" && <path d="M8 5.5a.8.8 0 0 1 1.2-.7l10 6.5a.8.8 0 0 1 0 1.4l-10 6.5a.8.8 0 0 1-1.2-.7z" />}
      {name === "pause" && <path d="M7 5h3v14H7zm7 0h3v14h-3z" />}
      {name === "previous" && <path d="M5 5h2v14H5zm13 .6v12.8a.6.6 0 0 1-.9.5L8 12.5a.6.6 0 0 1 0-1l9.1-6.4a.6.6 0 0 1 .9.5" />}
      {name === "next" && <path d="M17 5h2v14h-2zM6 5.6v12.8a.6.6 0 0 0 .9.5l9.1-6.4a.6.6 0 0 0 0-1L6.9 5.1a.6.6 0 0 0-.9.5" />}
      {name === "music" && <path d="M10 5v10.2a4 4 0 0 0-2-.5c-2.2 0-4 1.3-4 3s1.8 3 4 3 4-1.3 4-3V8l6-1.5v6.7a4 4 0 0 0-2-.5c-2.2 0-4 1.3-4 3s1.8 3 4 3 4-1.3 4-3V3z" />}
    </svg>
  );
}

type AudioVolume = { sessionId: string; level: number; muted: boolean };
type MuteTarget = { sessionId: string; muted: boolean };

function VolumeControl() {
  const [volume, setVolume] = useState<AudioVolume | null>(null);
  const [error, setError] = useState("");
  const [muteBusy, setMuteBusy] = useState(false);
  const toggleMute = useRef<() => void>(() => {});
  const dragging = useRef(false);
  const change = useRef<(percent: number) => void>(() => {});
  const finish = useRef<() => void>(() => {});
  const slider = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    let active = true;
    let current: AudioVolume | null = null;
    let pending: AudioVolume | null = null;
    let pendingMute: MuteTarget | null = null;
    let muting = false;
    let reading = false;
    let writing = false;
    let inFlightTarget: AudioVolume | null = null;
    let version = 0;
    let lastWrite = -Infinity;
    let timer: number | undefined;
    let wheelPixels = 0;

    function resetWheel() { wheelPixels = 0; }

    function unavailable(message: string) {
      current = null;
      pending = null;
      pendingMute = null;
      resetWheel();
      setMuteBusy(false);
      dragging.current = false;
      setVolume(null);
      setError(message);
    }

    function scheduleWrite() {
      if (!active || (!pending && !pendingMute) || writing || reading || timer !== undefined) return;
      timer = window.setTimeout(() => {
        timer = undefined;
        void write();
      }, Math.max(0, 80 - (performance.now() - lastWrite)));
    }

    function acceptWrite(result: AudioVolume) {
      current = result;
      if (pending?.sessionId === result.sessionId &&
          Math.round(pending.level * 100) === Math.round(result.level * 100)) pending = null;
      if (pending) pending = { ...pending, muted: result.muted };
      if (!pending && !dragging.current) setVolume(result);
      else setVolume(previous => previous ? { ...previous, muted: result.muted } : result);
      setError("");
    }

    async function write() {
      if (!active || (!pending && !pendingMute) || writing || reading) return;
      const muteTarget = pendingMute;
      const volumeTarget = muteTarget ? null : pending;
      const target = muteTarget ?? volumeTarget!;
      if (muteTarget) pendingMute = null;
      else pending = null;
      writing = true;
      muting = Boolean(muteTarget);
      inFlightTarget = volumeTarget;
      lastWrite = performance.now();
      try {
        const result = muteTarget
          ? await invoke<AudioVolume | null>("set_mute", muteTarget)
          : await invoke<AudioVolume | null>("set_volume", {
            sessionId: volumeTarget!.sessionId, level: volumeTarget!.level,
          });
        if (!active) return;
        if (!result || result.sessionId !== target.sessionId) {
          unavailable("Аудиосессия Яндекс Музыки недоступна");
        } else {
          acceptWrite(result);
        }
      } catch (cause) {
        console.error(muteTarget ? "Failed to set session mute" : "Failed to set session volume", cause);
        if (active) unavailable(muteTarget ? "Не удалось изменить mute" : "Не удалось изменить громкость");
      } finally {
        writing = false;
        muting = false;
        if (active && muteTarget) setMuteBusy(false);
        inFlightTarget = null;
        scheduleWrite();
      }
    }

    async function poll() {
      if (!active || reading || writing || pending || pendingMute || dragging.current) return;
      reading = true;
      const readVersion = version;
      try {
        const result = await invoke<AudioVolume | null>("get_volume");
        if (!active || readVersion !== version || dragging.current) return;
        if (current?.sessionId !== result?.sessionId) resetWheel();
        current = result;
        setVolume(result);
        setError(result ? "" : "Аудиосессия Яндекс Музыки недоступна");
      } catch (cause) {
        console.error("Failed to read session volume", cause);
        if (active && readVersion === version && !dragging.current) {
          unavailable("Аудиосессия Яндекс Музыки недоступна");
        }
      } finally {
        reading = false;
        scheduleWrite();
      }
    }

    change.current = percent => {
      if (!current) return;
      const level = Math.round(Math.min(100, Math.max(0, percent))) / 100;
      // Ignore repeated input values; keep only the newest pending movement.
      if (Math.round((pending ?? inFlightTarget ?? current).level * 100) === Math.round(level * 100)) return;
      version++;
      pending = { sessionId: current.sessionId, level, muted: current.muted };
      setVolume(pending);
      scheduleWrite();
    };
    toggleMute.current = () => {
      if (!current || pendingMute || muting) return;
      version++;
      pendingMute = { sessionId: current.sessionId, muted: !current.muted };
      setMuteBusy(true);
      scheduleWrite();
    };
    finish.current = () => {
      dragging.current = false;
      scheduleWrite();
      if (!pending && !writing) {
        // Also reconcile readback when the pointer finishes without a new value.
        if (current) setVolume(current);
      }
    };
    function wheel(event: WheelEvent) {
      // A native non-passive listener lets WebView2 cancel scrolling over this input.
      event.preventDefault();
      if (!active || !current) return;
      // Treat 100 CSS pixels, 3 lines or 1 page as one 5-percentage-point step.
      // Keep the fractional remainder for high-resolution wheels/touchpads.
      const mode = event.deltaMode;
      const pixels = mode === 0 ? event.deltaY
        : mode === 1 ? event.deltaY * 100 / 3
        : mode === 2 ? event.deltaY * 100 : 0;
      if (!Number.isFinite(pixels) || pixels === 0) return;
      const percent = Math.round((pending ?? inFlightTarget ?? current).level * 100);
      if ((percent === 100 && pixels < 0) || (percent === 0 && pixels > 0)) {
        resetWheel();
        return;
      }
      wheelPixels += pixels;
      // Ignore floating-point drift when subpixel deltas reach a complete step.
      const steps = Math.trunc((wheelPixels + Math.sign(wheelPixels) * 1e-7) / 100);
      if (steps === 0) return;
      wheelPixels -= steps * 100;
      const next = Math.min(100, Math.max(0, percent - steps * 5));
      if (next === 0 || next === 100) resetWheel();
      change.current(next);
    }
    const input = slider.current;
    input?.addEventListener("wheel", wheel, { passive: false });
    input?.addEventListener("pointerleave", resetWheel);
    void poll();
    const interval = window.setInterval(() => void poll(), 1000);
    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(timer);
      input?.removeEventListener("wheel", wheel);
      input?.removeEventListener("pointerleave", resetWheel);
      change.current = () => {};
      finish.current = () => {};
      toggleMute.current = () => {};
    };
  }, []);

  const percent = volume ? Math.round(volume.level * 100) : null;
  return (
    <div className="volume" title={error || "Громкость Яндекс Музыки"}>
      <button className="mute-button" type="button" disabled={!volume || muteBusy}
        aria-label={volume?.muted ? "Включить звук Яндекс Музыки" : "Выключить звук Яндекс Музыки"}
        aria-pressed={volume?.muted ?? false}
        title={error || (volume?.muted ? "Включить звук" : "Выключить звук")}
        onClick={() => toggleMute.current()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M4 9h4l5-4v14l-5-4H4z" strokeLinecap="round" strokeLinejoin="round" />
          <path d={volume?.muted ? "M17 9l5 6m0-6l-5 6" : "M17 8a6 6 0 0 1 0 8"}
            strokeLinecap="round" />
        </svg>
      </button>
      <input ref={slider} type="range" aria-label="Громкость Яндекс Музыки"
        aria-valuetext={percent === null ? "Недоступна" : percent + "%"}
        min={0} max={100} step={1} value={percent ?? 0} disabled={!volume}
        style={{ "--progress": (percent ?? 0) + "%" } as CSSProperties}
        onChange={event => change.current(Number(event.currentTarget.value))}
        onPointerDown={event => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={() => finish.current()} onPointerCancel={() => finish.current()}
        onKeyUp={() => finish.current()} onBlur={() => finish.current()} />
      <span className="volume-percent">{percent === null ? "—" : percent + "%"}</span>
    </div>
  );
}

function App() {
  const appearance = useAppearance();
  const player = useRef<HTMLElement | null>(null);
  const ambientHaze = useRef<ReturnType<typeof createAmbientHaze> | null>(null);
  const hazeEnabled = appearance.ready && appearance.snapshot.settings.ambientHazeEnabled;
  const hazeIntensity = appearance.ready ? appearance.snapshot.settings.ambientHazeIntensity : 35;
  useEffect(() => {
    if (!player.current) return;
    const haze = createAmbientHaze(player.current);
    ambientHaze.current = haze;
    return () => { haze.stop(); ambientHaze.current = null; };
  }, []);
  useEffect(() => {
    ambientHaze.current?.apply({ enabled: hazeEnabled, intensity: hazeIntensity });
  }, [hazeEnabled, hazeIntensity]);
  useEffect(() => {
    if (!import.meta.env.DEV || !("__TAURI_INTERNALS__" in window)) return () => {};
    let active = true;
    let stop: (() => void) | undefined;
    void import("./dev/visual_tuning_player").then(({ connectVisualTuning }) => {
      const player = document.querySelector<HTMLElement>(".player");
      if (active && player) stop = connectVisualTuning(player);
    });
    return () => { active = false; stop?.(); };
  }, []);

  const [media, setMedia] = useState<MediaState | null>(null);
  const [artwork, setArtwork] = useState<string | null>(null);
  const [artworkAccent, setArtworkAccent] = useState<{ source: string; palette: ArtworkPalette } | null>(null);
  const [openingYandex, setOpeningYandex] = useState(false);
  const openInFlight = useRef(false);
  const [position, setPosition] = useState<number | null>(null);
  const [scrub, setScrub] = useState<Scrub | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const snapshot = useRef<Snapshot>({ media: null, at: performance.now() });
  const scrubRef = useRef<Scrub | null>(null);
  const seeking = useRef(false);
  const gestureTrack = useRef<string | null>(null);
  const transporting = useRef(false);
  const polling = useRef<ReturnType<typeof createMediaPoll<MediaState | null>> | null>(null);

  useEffect(() => {
    let resetArtwork = true;
    let artworkTrack: string | null = null;
    const poll = createMediaPoll<MediaState | null>({
      read: () => invoke("get_media_state", { resetArtwork }),
      discard: () => { resetArtwork = true; },
      accept: state => {
        resetArtwork = false;
        if (!state || (state.trackKey !== null && artworkTrack !== state.trackKey)) {
          setArtwork(null);
        }
        if (!state || (state.trackKey !== null && artworkTrack !== state.trackKey) || !state.canSeek) {
          scrubRef.current = null;
          setScrub(null);
        }
        if (state?.trackKey) artworkTrack = state.trackKey;
        if (!state) artworkTrack = null;
        if (state?.artwork) setArtwork(state.artwork.dataUrl);
        snapshot.current = { media: state, at: performance.now() };
        setMedia(state);
      },
      error: cause => {
        console.error("Failed to read media session", cause);
        // An IPC/API failure does not establish that the session disappeared.
        const previous = snapshot.current.media;
        const unavailable = previous ? {
          ...previous, playbackState: "unknown", durationMs: null, positionMs: null,
          canPlay: false, canPause: false, canPrevious: false, canNext: false,
          canSeek: false, seekMinMs: null, seekMaxMs: null,
        } : null;
        snapshot.current = { media: unavailable, at: performance.now() };
        setMedia(unavailable);
        scrubRef.current = null;
        setScrub(null);
        resetArtwork = true;
      },
    });
    polling.current = poll;
    void poll.refresh();
    const timer = window.setInterval(() => void poll.refresh(), 1000);
    let frame: number;
    function animate() {
      const { media: current, at } = snapshot.current;
      const elapsed = current?.playbackState === "playing" ? performance.now() - at : 0;
      setPosition(current?.positionMs == null ? null :
        Math.min(current.durationMs ?? Infinity, current.positionMs + elapsed));
      frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    return () => {
      poll.stop();
      polling.current = null;
      clearInterval(timer);
      cancelAnimationFrame(frame);
    };
  }, []);

  async function openYandexMusic() {
    if (openInFlight.current) return;
    openInFlight.current = true;
    setOpeningYandex(true);
    setError("");
    try {
      await invoke("open_yandex_music");
    } catch (cause) {
      console.error("Failed to open/focus Yandex Music", cause);
      setError("Не удалось открыть Яндекс Музыку");
    } finally {
      openInFlight.current = false;
      setOpeningYandex(false);
    }
  }

  async function control(command: TransportCommand) {
    if (transporting.current || seeking.current || !canTransport(snapshot.current.media, command)) return;
    transporting.current = true;
    const finishMutation = polling.current?.beginMutation();
    setBusy(true);
    setError("");
    try {
      if (!await invoke<boolean>(command)) setError("Действие недоступно");
    } catch (cause) {
      console.error(command, cause);
      setError("Не удалось выполнить действие");
    } finally {
      transporting.current = false;
      await finishMutation?.();
      setBusy(false);
    }
  }

  function preview(value: number) {
    if (!media?.trackKey || (gestureTrack.current !== null && gestureTrack.current !== media.trackKey)) return;
    const position = clampSeek(media, value);
    if (position === null) return;
    const next = { position, trackKey: media.trackKey };
    scrubRef.current = next;
    setScrub(next);
  }

  async function commitSeek() {
    const target = scrubRef.current;
    if (!target || seeking.current || transporting.current) return;
    const current = snapshot.current.media;
    const position = clampSeek(current, target.position);
    if (current?.trackKey !== target.trackKey || position === null) {
      scrubRef.current = null;
      setScrub(null);
      return;
    }
    seeking.current = true;
    const finishMutation = polling.current?.beginMutation();
    setBusy(true);
    setError("");
    try {
      const accepted = await invoke<boolean>("seek_to", {
        positionMs: position, trackKey: target.trackKey,
      });
      if (accepted && snapshot.current.media?.trackKey === target.trackKey) {
        snapshot.current = {
          media: { ...snapshot.current.media, positionMs: position },
          at: performance.now(),
        };
      } else if (!accepted) setError("Перемотка недоступна");
    } catch (cause) {
      console.error("Seek failed", cause);
      setError("Не удалось перемотать");
    } finally {
      scrubRef.current = null;
      setScrub(null);
      seeking.current = false;
      setBusy(false);
      await finishMutation?.();
    }
  }

  const duration = media?.durationMs ?? null;
  const displayed = scrub?.trackKey === media?.trackKey ? scrub?.position ?? position : position;
  const canSeek = Boolean(media?.canSeek && media.trackKey && duration && media.positionMs !== null);
  const progress = duration ? Math.min(100, Math.max(0, (displayed ?? 0) / duration * 100)) : 0;
  const playing = media?.playbackState === "playing";
  const palette = artworkAccent?.source === artwork ? artworkAccent.palette : NEUTRAL_PALETTE;

  return (
    <main ref={player} className="player" data-player-design="true" data-visual-effects={appearance.ready && appearance.snapshot.settings.visualEffectsEnabled ? "true" : "false"} aria-label="PLIX" onMouseDown={startWindowDrag} onContextMenuCapture={showPlayerContextMenu}
      style={{ ...productionStyle, "--artwork-accent-dark": palette.dark, "--artwork-accent-light": palette.light,
        "--artwork-tint": palette.tint, "--ambient-1": palette.ambient[0],
        "--ambient-2": palette.ambient[1], "--ambient-3": palette.ambient[2] } as CSSProperties}>
      <VisualizerLayer preset={appearance.ready && appearance.snapshot.settings.visualEffectsEnabled ? appearance.snapshot.settings.visualization : "Off"} palette={palette} hybridPaletteEnabled={appearance.snapshot.settings.hybridPaletteEnabled} />
      <button className="artwork" type="button" aria-label="Открыть Яндекс Музыку"
        title={error || "Открыть Яндекс Музыку"} disabled={openingYandex} aria-busy={openingYandex}
        onClick={() => void openYandexMusic()}>
        {artwork ? <img key={artwork} src={artwork} alt="" draggable={false}
          onLoad={event => setArtworkAccent({ source: artwork, palette: paletteFromArtwork(event.currentTarget) })}
          onError={() => setArtwork(null)} /> :
          <span className="artwork-placeholder"><Icon name="music" /></span>}
      </button>
      <section className="content">
        <div className="metadata">
          <button className="appearance-button" aria-label="Открыть настройки внешнего вида" title="Внешний вид"
            onClick={() => void invoke("open_appearance").catch(cause => {
              console.error("Failed to open Appearance", cause);
              setError("Не удалось открыть настройки");
            })}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
              <path d="M4 7h16M4 17h16" strokeLinecap="round" />
              <circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" />
            </svg>
          </button>
          <h1 title={media?.title ?? undefined}>{media ? media.title || "Без названия" : "Нет музыки"}</h1>
          <p title={media?.artist ?? undefined}>{media ? media.artist || "Неизвестный исполнитель" : "Откройте Яндекс Музыку"}</p>
        </div>
        <div className="timeline" title={error || undefined}>
          <input type="range" aria-label="Позиция воспроизведения" aria-valuetext={formatTime(displayed)}
            min={0} max={duration ?? 1} step={1000} value={displayed ?? 0}
            disabled={!canSeek || busy} style={{ "--progress": `${progress}%` } as CSSProperties}
            onChange={event => preview(Number(event.currentTarget.value))}
            onPointerDown={event => {
              gestureTrack.current = media?.trackKey ?? null;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerUp={() => { void commitSeek(); gestureTrack.current = null; }}
            onPointerCancel={() => { gestureTrack.current = null; scrubRef.current = null; setScrub(null); }}
            onKeyUp={() => void commitSeek()} onBlur={() => void commitSeek()} />
          <div className="times"><span>{formatTime(displayed)}</span><span>{formatTime(duration)}</span></div>
        </div>
        <div className="player-footer">
          <VolumeControl />
          <div className="controls">
            <button aria-label="Предыдущий трек" title="Предыдущий трек" disabled={!canTransport(media, "previous_track") || busy} onClick={() => void control("previous_track")}><Icon name="previous" /></button>
            <button className="primary-control" aria-label={playing ? "Пауза" : "Воспроизвести"} title={playing ? "Пауза" : "Воспроизвести"} disabled={!canTransport(media, "play_pause") || busy} onClick={() => void control("play_pause")}><Icon name={playing ? "pause" : "play"} /></button>
            <button aria-label="Следующий трек" title="Следующий трек" disabled={!canTransport(media, "next_track") || busy} onClick={() => void control("next_track")}><Icon name="next" /></button>
          </div>
        </div>
      </section>
      <span className="sr-only" role="status">{error}</span>
    </main>
  );
}

const appearanceWindow = new URLSearchParams(window.location.search).get("window") === "appearance";
if (import.meta.env.DEV && new URLSearchParams(window.location.search).get("window") === "visual-tuning") {
  void import("./dev/visual_tuning_panel");
} else {
  createRoot(document.getElementById("root")!).render(appearanceWindow ? <AppearanceWindow /> : <App />);
}



