import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { invoke } from "@tauri-apps/api/core";
import { createMediaPoll } from "../media_sync";
import "./media_sources.css";

type Source = { mode: "desktop" | "browser"; revision: string; selectedId: string | null };
type Candidate = {
  id: string; sourceId: string; recognizedBrowser: boolean;
  title: string | null; artist: string | null; album: string | null; subtitle: string | null;
  error: string | null; capabilities: Record<string, boolean | null> | null;
  timeline: Record<string, number | null> | null;
};
type Listing = { source: Source; sessions: Candidate[] };

function MediaSources() {
  const [data, setData] = useState<Listing | null>(null);
  const [includeUnknown, setIncludeUnknown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const action = useRef(false);
  const polling = useRef<ReturnType<typeof createMediaPoll<Listing>> | null>(null);

  useEffect(() => {
    const poll = createMediaPoll<Listing>({
      read: () => invoke("dev_list_media_sources", { includeUnknown }),
      accept: result => setData(previous => previous && BigInt(previous.source.revision) > BigInt(result.source.revision) ? previous : result),
      error: cause => setError(String(cause)),
      discard: () => {},
    });
    polling.current = poll;
    let active = true;
    void invoke<Source>("dev_get_media_source").then(source => {
      if (active) setData(previous => previous && BigInt(previous.source.revision) > BigInt(source.revision) ? previous : { source, sessions: previous?.sessions ?? [] });
    }).catch(cause => { if (active) setError(String(cause)); });
    void poll.refresh();
    const timer = window.setInterval(() => void poll.refresh(), 2000);
    return () => { active = false; poll.stop(); polling.current = null; clearInterval(timer); };
  }, [includeUnknown]);

  async function change(mode?: Source["mode"], id?: string) {
    if (!data || action.current) return;
    action.current = true;
    setBusy(true);
    const finish = polling.current?.beginMutation();
    try {
      const source = mode
        ? await invoke<Source>("dev_set_media_mode", { mode, revision: data.source.revision })
        : await invoke<Source>("dev_select_media_session", { id, revision: data.source.revision, includeUnknown });
      setData(previous => previous ? { ...previous, source } : previous);
      setError("");
    } catch (cause) { setError(String(cause)); }
    finally { await finish?.(); action.current = false; setBusy(false); }
  }

  return <main className="media-sources-panel">
    <h1>Источники медиа · DEV</h1>
    <p>Browser — эксперимент. Выберите сессию вручную. GSMTC не сообщает адрес сайта:
      название трека и имя браузера не подтверждают Яндекс Музыку.</p>
    <div className="source-actions">
      <button disabled={busy || !data || data.source.mode === "desktop"} onClick={() => void change("desktop")}>Desktop</button>
      <button disabled={busy || !data || data.source.mode === "browser"} onClick={() => void change("browser")}>Browser</button>
      <button disabled={busy} onClick={() => void polling.current?.refresh()}>Обновить</button>
    </div>
    <p><strong>Режим: {data?.source.mode ?? "загрузка"}</strong>. Выбор: {data?.source.selectedId ?? "нет"}.</p>
    <p>В Browser громкость и mute отключены. Управляйте выбранным источником на основном экране PLIX.
      Закрытие этой панели сохраняет режим до переключения в Desktop или перезапуска PLIX.</p>
    <label><input type="checkbox" checked={includeUnknown} disabled={busy}
      onChange={event => setIncludeUnknown(event.currentTarget.checked)} /> Показать также нераспознанные приложения (без desktop Яндекс Музыки)</label>
    {error && <p role="alert" className="source-error">{error}</p>}
    {data?.sessions.length === 0 && <p>Кандидатов нет. Запустите музыку в браузере и нажмите «Обновить».
      Если AUMID браузера не распознан, включите показ нераспознанных приложений.</p>}
    <ul>{data?.sessions.map(session => <li key={session.id}>
      <strong>{session.sourceId}</strong> · {session.id}
      {!session.recognizedBrowser && <span> · приложение не распознано как браузер</span>}
      <p>{session.title ?? "Title недоступен"} · {session.artist ?? "Artist недоступен"}</p>
      <p>AlbumTitle: {session.album ?? "—"} · Subtitle: {session.subtitle ?? "—"}</p>
      <button disabled={busy || data.source.mode !== "browser" || data.source.selectedId === session.id}
        onClick={() => void change(undefined, session.id)}>{data.source.selectedId === session.id ? "Выбрана" : "Выбрать эту сессию"}</button>
      {session.error && <p className="source-error">Метаданные: {session.error}</p>}
      <details><summary>Capabilities и timeline (100 ns ticks)</summary>
        <pre>{JSON.stringify({ capabilities: session.capabilities, timeline: session.timeline }, null, 2)}</pre>
      </details>
    </li>)}</ul>
    <p>Возврат к обычному поведению: Desktop. После перезапуска всегда выбран Desktop.</p>
  </main>;
}

document.body.classList.add("media-sources-dev");
createRoot(document.getElementById("root")!).render(<MediaSources />);
