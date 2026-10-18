import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LevelInfo, LevelPack, SearchMode, SearchParams, SearchResult } from "../../shared/types";
import type { LevelGeometryPayload, LivePathSnapshot, SearchProgressEvent } from "../../preload";
import { LEVELS, LEVEL_PACKS } from "../../shared/levels";
import { ReplayStage } from "./components/ReplayStage";
import { LeaderboardPanel, type ReplaySelection } from "./components/LeaderboardPanel";
import { CustomMapBrowser, type CustomLevelSelection } from "./components/CustomMapBrowser";
import type { LineAnalysis } from "./lib/analysis";

type ActiveTab = "search" | "custom" | "leaderboard";

interface ProgressState {
  message: string;
  bestTimeMs: number | null;
  bestFinishTick: number | null;
  evaluations: number;
  generations: number;
  rollouts: number;
  done: boolean;
  error?: string;
}

const emptyProgress: ProgressState = {
  message: "Ready.",
  bestTimeMs: null,
  bestFinishTick: null,
  evaluations: 0,
  generations: 0,
  rollouts: 0,
  done: false,
};

export default function App() {
  const [packs, setPacks] = useState<LevelPack[]>(LEVEL_PACKS);
  const [levels, setLevels] = useState<LevelInfo[]>(LEVELS);
  const [selectedLevelId, setSelectedLevelId] = useState<string>(
    LEVELS[0]?.id ?? "",
  );
  const [selectedPack, setSelectedPack] = useState<string>("all");
  const [arrow, setArrow] = useState("Narrow Arrow");
  const [mode, setMode] = useState<SearchMode>("beam");
  const [beamWidth, setBeamWidth] = useState(64);
  const [actionRepeat, setActionRepeat] = useState(1);
  const [budgetSec, setBudgetSec] = useState(20);
  const [seedInputs, setSeedInputs] = useState("");
  const [geometry, setGeometry] = useState<LevelGeometryPayload["geometry"] | null>(null);
  const [path, setPath] = useState<SearchResult["path"] | null>(null);
  const [progress, setProgress] = useState<ProgressState>(emptyProgress);
  const [runs, setRuns] = useState<SearchResult[]>([]);
  const [analysis, setAnalysis] = useState<LineAnalysis | null>(null);
  const [activeSearch, setActiveSearch] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeSearchRef = useRef(false);
  // Live search preview.
  const [livePath, setLivePath] = useState<SearchResult["path"] | null>(null);
  const [liveTick, setLiveTick] = useState<number | null>(null);
  const liveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Extra brute-force controls.
  const [actionTicks, setActionTicks] = useState(4);
  const [maxCandidates, setMaxCandidates] = useState(50_000);
  const [bruteSeedInputs, setBruteSeedInputs] = useState("");
  // Playback.
  const [playing, setPlaying] = useState(false);
  const [playbackTick, setPlaybackTick] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const playTokenRef = useRef(0);
  // Replay loaded from leaderboard/run.
  const [replayPath, setReplayPath] = useState<SearchResult["path"] | null>(null);
  const [replayArrow, setReplayArrow] = useState("Narrow Arrow");
  const [replayMeta, setReplayMeta] = useState<{ username?: string; timeS?: number; levelId?: string } | null>(null);
  // Tabs.
  const [activeTab, setActiveTab] = useState<ActiveTab>("search");

  // Load initial geometry for the default level.
  useEffect(() => {
    void loadLevel(selectedLevelId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadLevel = async (id: string) => {
    try {
      setError(null);
      setPath(null);
      setAnalysis(null);
      const payload = await window.nf.getLevelData(id);
      setGeometry(payload.geometry);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  // Populate levels from IPC once mounted.
  useEffect(() => {
    void window.nf
      .listLevels()
      .then(setLevels)
      .catch((err: unknown) => setError(String(err)));
    void window.nf.listPacks().then(setPacks).catch(() => {});
    void refreshRuns();
  }, []);

  const refreshRuns = useCallback(async () => {
    try {
      setRuns(await window.nf.listRuns());
    } catch {
      /* non-fatal */
    }
  }, []);

  // Progress + result subscription.
  useEffect(() => {
    const unsub = window.nf.onSearchProgress((evt: SearchProgressEvent) => {
      if (evt.error) {
        setProgress({ ...emptyProgress, done: true, error: evt.error });
        setActiveSearch(false);
        activeSearchRef.current = false;
        return;
      }
      if (evt.done && evt.result) {
        setProgress({
          message: "Search complete.",
          bestTimeMs: evt.result.timeMs,
          bestFinishTick: evt.result.finishTick,
          evaluations: evt.result.evaluations,
          generations: evt.result.generations,
          rollouts: evt.result.rollouts,
          done: true,
        });
        setPath(evt.result.path);
        setActiveSearch(false);
        activeSearchRef.current = false;
        void refreshRuns();
        return;
      }
      setProgress({
        message: evt.message ?? "",
        bestTimeMs: evt.bestTimeMs ?? null,
        bestFinishTick: evt.bestFinishTick ?? null,
        evaluations: evt.evaluations ?? 0,
        generations: evt.generations ?? 0,
        rollouts: evt.rollouts ?? 0,
        done: false,
      });
    });
    return unsub;
  }, [refreshRuns]);

  // Live search preview: poll the active search's best path at ~8 Hz.
  useEffect(() => {
    if (!activeSearch) {
      if (liveTimerRef.current) {
        clearInterval(liveTimerRef.current);
        liveTimerRef.current = null;
      }
      return;
    }
    liveTimerRef.current = setInterval(() => {
      void window.nf
        .getLivePath()
        .then((snap: LivePathSnapshot | null) => {
          if (!snap) return;
          if (snap.path && snap.path.length) {
            setLivePath(snap.path);
          }
        })
        .catch(() => {});
    }, 130);
    return () => {
      if (liveTimerRef.current) clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    };
  }, [activeSearch]);

  // Playback tick loop.
  useEffect(() => {
    if (!playing) return;
    const source = replayPath && replayPath.length > 1 ? replayPath : path;
    if (!source || source.length < 2) {
      setPlaying(false);
      return;
    }
    const token = ++playTokenRef.current;
    const start = Date.now();
    let frame: number;
    const step = () => {
      if (playTokenRef.current !== token) return;
      const elapsed = (Date.now() - start) * playbackSpeed;
      const tick = Math.min(source.length - 1, Math.floor(elapsed / (1000 / 240)));
      setPlaybackTick(tick);
      setLiveTick(tick);
      if (tick >= source.length - 1) {
        setPlaying(false);
        return;
      }
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing, playbackSpeed, replayPath, path]);

  const filteredLevels = useMemo(() => {
    if (selectedPack === "all") return levels;
    return levels.filter((l) => l.packId === selectedPack);
  }, [levels, selectedPack]);

  const startSearch = async () => {
    if (activeSearchRef.current) return;
    if (!selectedLevelId) return;
    activeSearchRef.current = true;
    setActiveSearch(true);
    setPath(null);
    setAnalysis(null);
    setLivePath(null);
    setLiveTick(null);
    setReplayPath(null);
    setReplayMeta(null);
    setPlaying(false);
    setProgress({ ...emptyProgress, message: "Starting search…", done: false });

    const params: SearchParams = {
      mode,
      levelId: selectedLevelId,
      arrowName: arrow,
      budgetSec,
      rngSeed: 1,
      ...(mode === "beam"
        ? { beamWidth, actionRepeat, seedInputs: seedInputs || undefined }
        : {}),
      ...(mode === "genetic"
        ? { seedInputs: seedInputs || undefined }
        : {}),
      ...(mode === "brute"
        ? { actionTicks, maxCandidates, seedInputs: bruteSeedInputs || undefined }
        : {}),
    };
    try {
      const { searchId } = await window.nf.startSearch(params);
      void searchId;
    } catch (err) {
      setProgress({ ...emptyProgress, done: true, error: String(err instanceof Error ? err.message : err) });
      setActiveSearch(false);
      activeSearchRef.current = false;
      setLivePath(null);
    }
  };

  const cancelSearch = async () => {
    await window.nf.cancelSearch();
    setActiveSearch(false);
    activeSearchRef.current = false;
    setProgress({ ...progress, done: true, message: "Cancelled." });
    setLivePath(null);
    setLiveTick(null);
  };

  const importCustom = async () => {
    try {
      const res = await window.nf.importCustomMap();
      setSelectedLevelId(res.levelId);
      setGeometry(res.geometry);
      setPath(null);
      setAnalysis(null);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const exportRun = async (run: SearchResult) => {
    try {
      const res = await window.nf.exportRun(run);
      setError(res.saved ? null : "Export cancelled.");
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  const bestTimeMs = progress.done && progress.bestTimeMs != null ? progress.bestTimeMs : null;

  /** Open a leaderboard run's replay: simulate its inputs -> path + arrow. */
  const openLeaderboardReplay = async (sel: ReplaySelection) => {
    setReplayMeta({ username: sel.username, timeS: sel.timeS, levelId: sel.levelId });
    setReplayArrow(sel.arrowName);
    setLivePath(null);
    setError(null);
    try {
      const sim = await window.nf.simulateReplay({
        levelId: sel.levelId,
        arrowName: sel.arrowName,
        inputs: sel.inputs,
        inputCount: sel.inputCount,
      });
      setReplayPath(sim.path);
      setPath(sim.path);
      setAnalysis(null);
      setPlaybackTick(0);
      setLiveTick(0);
      setPlaying(false);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    }
  };

  /** Load a custom level from the browser into the map. */
  const openCustomLevel = async (sel: CustomLevelSelection) => {
    setSelectedLevelId(sel.levelId);
    setGeometry(sel.geometry);
    setPath(null);
    setReplayPath(null);
    setReplayMeta(null);
    setAnalysis(null);
    setError(null);
    setActiveTab("search");
  };

  const displayPath = replayPath && replayPath.length > 1 ? replayPath : path;
  const displayArrow = replayPath && replayPath.length > 1 ? replayArrow : arrow;
  const markerIdx = playing || liveTick != null ? liveTick ?? 0 : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "310px 1fr",
        gap: 14,
        padding: 16,
        height: "100vh",
        color: "#e6edf3",
        fontFamily: "system-ui, 'Segoe UI', sans-serif",
        background: "#0b0e14",
      }}
    >
      {/* Left: controls / panels */}
      <aside style={{ display: "flex", flexDirection: "column", gap: 10, overflowY: "auto", paddingRight: 4 }}>
        <header>
          <h1 style={{ fontSize: 18, margin: 0, color: "#fff" }}>Narrow Route Finder</h1>
          <p style={{ fontSize: 11, color: "#7d8590", margin: "2px 0 0" }}>
            Fastest input search using the real physics engine.
          </p>
        </header>

        <nav style={{ display: "flex", gap: 4 }}>
          {(
            [
              { id: "search", label: "Search" },
              { id: "custom", label: "Custom maps" },
              { id: "leaderboard", label: "Leaderboard" },
            ] as Array<{ id: ActiveTab; label: string }>
          ).map((t) => (
            <button
              key={t.id}
              style={{
                ...tabButtonStyle,
                ...(activeTab === t.id ? { background: "#21262d", color: "#fff" } : {}),
              }}
              onClick={() => setActiveTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {activeTab === "leaderboard" ? (
          <LeaderboardPanel
            levelId={selectedLevelId}
            deep
            onOpenReplay={(sel) => void openLeaderboardReplay(sel)}
          />
        ) : activeTab === "custom" ? (
          <CustomMapBrowser onOpenLevel={(sel) => void openCustomLevel(sel)} />
        ) : (
          <>
            <label style={labelStyle}>
              Pack
              <select
                style={selectStyle}
                value={selectedPack}
                onChange={(e) => setSelectedPack(e.target.value)}
              >
                <option value="all">All packs</option>
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>

            <label style={labelStyle}>
              Level
              <select
                style={{ ...selectStyle, maxWidth: "100%" }}
                value={selectedLevelId}
                onChange={(e) => void loadLevel(e.target.value)}
              >
                {filteredLevels.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>

            <label style={labelStyle}>
              Arrow
              <select style={selectStyle} value={arrow} onChange={(e) => setArrow(e.target.value)}>
                <option>Narrow Arrow</option>
                <option>Speedy Arrow</option>
                <option>Energy Arrow</option>
              </select>
            </label>

            <label style={labelStyle}>
              Search mode
              <select style={selectStyle} value={mode} onChange={(e) => setMode(e.target.value as SearchMode)}>
                <option value="beam">Beam search</option>
                <option value="genetic">Genetic optimizer</option>
                <option value="brute">Action-repeat brute force</option>
              </select>
            </label>

            {mode === "beam" && (
              <>
                <label style={labelStyle}>
                  Beam width
                  <input
                    style={inputStyle}
                    type="number"
                    min={2}
                    max={512}
                    value={beamWidth}
                    onChange={(e) => setBeamWidth(Math.max(2, Number(e.target.value)))}
                  />
                </label>
                <label style={labelStyle}>
                  Action repeat (ticks)
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    max={120}
                    value={actionRepeat}
                    onChange={(e) => setActionRepeat(Math.max(1, Number(e.target.value)))}
                  />
                </label>
              </>
            )}

            {mode === "genetic" && (
              <label style={labelStyle}>
                Seed run (base64 inputs)
                <textarea
                  style={{ ...inputStyle, height: 60, resize: "vertical", fontFamily: "monospace" }}
                  placeholder="Paste a known input base64 to polish"
                  value={seedInputs}
                  onChange={(e) => setSeedInputs(e.target.value)}
                />
              </label>
            )}

            {mode === "brute" && (
              <>
                <label style={labelStyle}>
                  Action ticks per decision
                  <input
                    style={inputStyle}
                    type="number"
                    min={1}
                    max={120}
                    value={actionTicks}
                    onChange={(e) => setActionTicks(Math.max(1, Number(e.target.value)))}
                  />
                </label>
                <label style={labelStyle}>
                  Max candidates
                  <input
                    style={inputStyle}
                    type="number"
                    min={100}
                    max={2_000_000}
                    value={maxCandidates}
                    onChange={(e) => setMaxCandidates(Math.max(100, Number(e.target.value)))}
                  />
                </label>
                <label style={labelStyle}>
                  Seed prefix (base64, optional)
                  <textarea
                    style={{ ...inputStyle, height: 50, resize: "vertical", fontFamily: "monospace" }}
                    placeholder="Start from a known prefix"
                    value={bruteSeedInputs}
                    onChange={(e) => setBruteSeedInputs(e.target.value)}
                  />
                </label>
              </>
            )}

            <label style={labelStyle}>
              Budget (seconds)
              <input
                style={inputStyle}
                type="number"
                min={1}
                max={600}
                value={budgetSec}
                onChange={(e) => setBudgetSec(Math.max(1, Number(e.target.value)))}
              />
            </label>

            <div style={{ display: "flex", gap: 8 }}>
              <button style={primaryButtonStyle} onClick={() => void startSearch()} disabled={activeSearch}>
                {activeSearch ? "Searching…" : "Run search"}
              </button>
              {activeSearch && (
                <button style={dangerButtonStyle} onClick={() => void cancelSearch()}>
                  Cancel
                </button>
              )}
            </div>
            <button style={linkButtonStyle} onClick={() => void importCustom()}>
              Import custom map from file…
            </button>
          </>
        )}

        {error && (
          <div style={{ color: "#f85149", fontSize: 12, background: "rgba(248,81,73,0.12)", padding: 8, borderRadius: 6 }}>
            {error}
          </div>
        )}

        {/* Progress */}
        {activeTab === "search" && (
          <div style={{ background: "#151a23", borderRadius: 8, padding: 10 }}>
            <strong style={{ fontSize: 12, color: "#9d8dff" }}>{mode}</strong>
            <p style={{ fontSize: 12, margin: "6px 0 0", color: progress.error ? "#f85149" : "#c9d1d9" }}>
              {progress.error ?? progress.message}
            </p>
            {bestTimeMs != null && (
              <p style={{ fontSize: 14, color: "#3fb950", margin: "4px 0 0" }}>
                Best: {(bestTimeMs / 1000).toFixed(3)}s
              </p>
            )}
            {(progress.evaluations > 0 || progress.rollouts > 0) && (
              <p style={{ fontSize: 11, color: "#7d8590", margin: "4px 0 0" }}>
                {progress.evaluations.toLocaleString()} evals · gen {progress.generations}
                {livePath && livePath.length > 0 ? ` · live ${livePath.length.toLocaleString()} pts` : ""}
              </p>
            )}
            {progress.done && progress.error && <p style={{ fontSize: 11, color: "#f85149" }}>{progress.error}</p>}
          </div>
        )}
      </aside>

      {/* Right: map + analysis + runs */}
      <main style={{ display: "flex", flexDirection: "column", gap: 10, minHeight: 0 }}>
        <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
          {geometry ? (
            <>
              <ReplayStage
                geometry={geometry}
                path={displayPath}
                arrowName={displayArrow}
                markerIndex={markerIdx}
                livePath={livePath}
                liveTick={playing || liveTick != null ? liveTick : null}
                onPathAnalysis={setAnalysis}
                width={920}
                height={640}
              />
              <div style={legendStyle}>
                <LegendDot color="#2ecc71" label="finish" />
                <LegendDot color="#e74c3c" label="hazard" />
                <LegendDot color="#c8c8cc" label="wall" />
                <LegendDot color="rgba(80,220,120,0.22)" label="zone" />
                <LegendDot color="rgba(180,90,255,0.9)" label="portal" />
              </div>
            </>
          ) : (
            <div style={{ display: "grid", placeItems: "center", height: "100%" }}>
              <p style={{ color: "#7d8590" }}>{activeSearch ? "Fetching level…" : "Select a level"}</p>
            </div>
          )}
        </div>

        {/* Replay transport */}
        {(displayPath && displayPath.length > 1) && (
          <div style={{ background: "#151a23", borderRadius: 8, padding: "6px 10px", display: "flex", alignItems: "center", gap: 10, fontSize: 12 }}>
            <button
              style={smallButtonStyle}
              onClick={() => {
                if (playing) {
                  setPlaying(false);
                } else {
                  if (liveTick == null || liveTick >= displayPath.length - 1) {
                    setPlaybackTick(0);
                    setLiveTick(0);
                  }
                  setPlaying(true);
                }
              }}
            >
              {playing ? "⏸ Pause" : "▶ Play"}
            </button>
            <button
              style={smallButtonStyle}
              onClick={() => {
                setPlaying(false);
                setPlaybackTick(0);
                setLiveTick(0);
              }}
            >
              ⏮
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(1, displayPath.length - 1)}
              value={playbackTick}
              onChange={(e) => {
                setPlaying(false);
                const t = Number(e.target.value);
                setPlaybackTick(t);
                setLiveTick(t);
              }}
              style={{ flex: 1, accentColor: "#7ad4ff" }}
            />
            <span style={{ color: "#7d8590", whiteSpace: "nowrap" }}>
              {(((liveTick ?? 0) / 240)).toFixed(2)}s / {(displayPath.length / 240).toFixed(2)}s
            </span>
            <select
              value={playbackSpeed}
              onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
              style={miniSelectStyle}
            >
              {[0.25, 0.5, 1, 2, 4].map((s) => (
                <option key={s} value={s}>
                  {s}×
                </option>
              ))}
            </select>
          </div>
        )}

        {replayMeta && (
          <div style={{ fontSize: 11, color: "#9aa4b2", background: "rgba(157,141,255,0.08)", border: "1px solid rgba(157,141,255,0.2)", borderRadius: 8, padding: "5px 10px" }}>
            Viewing <b style={{ color: "#e6edf3" }}>{replayMeta.username}</b>'s replay ({replayArrow}) ·{' '}
            {replayMeta.timeS != null ? `${replayMeta.timeS.toFixed(3)}s` : "?"}
          </div>
        )}

        {analysis && displayPath && displayPath.length > 1 && (
          <div style={{ background: "#151a23", borderRadius: 8, padding: 10, fontSize: 12, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <span>Distance <b>{(analysis.distancePx).toFixed(0)}px</b></span>
            <span>Avg speed <b>{analysis.avgSpeed.toFixed(1)}px/s</b></span>
            <span>Max <b>{analysis.maxSpeed.toFixed(1)}</b></span>
            <span>Brake % <b>{(analysis.brakeFraction * 100).toFixed(1)}%</b></span>
            <span>Ticks <b>{displayPath.length}</b></span>
          </div>
        )}

        <section style={{ overflowY: "auto", maxHeight: "30%" }}>
          <h3 style={{ margin: "4px 0 6px", fontSize: 13, color: "#c9d1d9" }}>Saved runs ({runs.length})</h3>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th style={thStyle}>Level</th>
                <th style={thStyle}>Arrow</th>
                <th style={thStyle}>Mode</th>
                <th style={thStyle}>Time</th>
                <th style={thStyle}>Ticks</th>
                <th style={thStyle}></th>
              </tr>
            </thead>
            <tbody>
              {runs.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ padding: 8, textAlign: "center", color: "#7d8590" }}>
                    No runs yet — run a search to see it here.
                  </td>
                </tr>
              )}
              {runs.map((run) => (
                <tr key={run.searchId} style={{ borderTop: "1px solid #21262d" }}>
                  <td style={tdStyle}>{run.levelName}</td>
                  <td style={tdStyle}>{run.arrowName}</td>
                  <td style={tdStyle}>{run.mode}</td>
                  <td style={tdStyle}>
                    {run.timeMs != null ? `${(run.timeMs / 1000).toFixed(3)}s` : "DNF"}
                  </td>
                  <td style={tdStyle}>{run.inputCount?.toLocaleString()}</td>
                  <td style={tdStyle}>
                    <button style={smallButtonStyle} onClick={() => exportRun(run)}>
                      Export
                    </button>
                    <button
                      style={smallButtonStyle}
                      onClick={() => {
                        setPath(run.path);
                        setReplayPath(null);
                        setReplayMeta(null);
                        setReplayArrow(run.arrowName);
                        setAnalysis(null);
                        setPlaybackTick(0);
                        setLiveTick(0);
                        setPlaying(false);
                      }}
                    >
                      Load
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <div style={{ fontSize: 11, color: "#7d8590", textAlign: "center" }}>
          Physics engine: Narrow Arrow Rust/WASM @ 240Hz · deterministic seeded search · live progress from worker pool
        </div>
      </main>
    </div>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "#9aa4b2", fontSize: 11 }}>
      <span style={{ width: 10, height: 10, background: color, borderRadius: 2, display: "inline-block" }} />
      {label}
    </span>
  );
}

const labelStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  fontSize: 12,
  color: "#9aa4b2",
};

const selectStyle: React.CSSProperties = {
  background: "#151a23",
  color: "#e6edf3",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
};

const inputStyle: React.CSSProperties = {
  background: "#151a23",
  color: "#e6edf3",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "6px 8px",
  fontSize: 13,
};

const primaryButtonStyle: React.CSSProperties = {
  background: "#238636",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const dangerButtonStyle: React.CSSProperties = {
  background: "#da3633",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "8px 12px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "#58a6ff",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "6px 10px",
  fontSize: 12,
  cursor: "pointer",
};

const smallButtonStyle: React.CSSProperties = {
  background: "#21262d",
  color: "#c9d1d9",
  border: "1px solid #30363d",
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: 11,
  marginRight: 4,
  cursor: "pointer",
};

const tabButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "#9aa4b2",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "5px 10px",
  fontSize: 12,
  cursor: "pointer",
  flex: 1,
};

const miniSelectStyle: React.CSSProperties = {
  background: "#151a23",
  color: "#e6edf3",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "3px 6px",
  fontSize: 11,
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 8px",
  color: "#7d8590",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "4px 8px",
  color: "#c9d1d9",
};

const legendStyle: React.CSSProperties = {
  position: "absolute",
  top: 8,
  right: 10,
  display: "flex",
  gap: 10,
  background: "rgba(13,17,23,0.85)",
  padding: "4px 10px",
  borderRadius: 999,
};