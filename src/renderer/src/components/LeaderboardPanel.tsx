/**
 * LeaderboardPanel — browse a level's in-game leaderboard (all arrows or a
 * single arrow), with optional deep merge (all 3 arrow boards = up to 450
 * rows). Clicking a row opens that run's replay payload (inputs + arrow),
 * fetched from `/runs/{id}`.
 */
import { useCallback, useEffect, useState } from "react";
import type { LeaderboardEntry } from "../../../shared/types";
import { arrowKind } from "../lib/arrow-sprites";

export interface ReplaySelection {
  runId: number;
  username: string;
  timeS: number;
  arrowName: string;
  inputs: string;
  inputCount: number;
  levelId: string;
}

interface LeaderboardPanelProps {
  levelId: string;
  arrowFilter?: string;
  deep?: boolean;
  onOpenReplay?: (sel: ReplaySelection) => void;
  /** Request a run's inputs be used as a reference seed (learn-from-run). */
  onUseAsReference?: (sel: ReplaySelection) => void;
}

const ARROW_LABELS = ["All arrows", "Narrow Arrow", "Speedy Arrow", "Energy Arrow"];

export function LeaderboardPanel({ levelId, arrowFilter = "all", deep = false, onOpenReplay, onUseAsReference }: LeaderboardPanelProps) {
  const [entries, setEntries] = useState<LeaderboardEntry[] | null>(null);
  const [arrow, setArrow] = useState(arrowFilter);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<number | null>(null);
  const [seeding, setSeeding] = useState<number | null>(null);

  const load = useCallback(async (id: string, filter: string) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const opts: { levelId: string; deep?: boolean; arrowFilter?: string } = { levelId: id };
      if (filter !== "all") opts.arrowFilter = filter;
      if (deep) opts.deep = true;
      const rows = await window.nf.getLeaderboard(opts);
      setEntries(rows);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [deep]);

  useEffect(() => {
    void load(levelId, arrow);
  }, [levelId, arrow, load]);

  const openReplay = async (entry: LeaderboardEntry) => {
    if (!onOpenReplay) return;
    setOpening(entry.run_id);
    try {
      const payload = await window.nf.getRunReplay(entry.run_id);
      onOpenReplay({
        runId: entry.run_id,
        username: entry.username,
        timeS: entry.completion_time,
        arrowName: payload.arrow_name ?? entry.arrow_name ?? "Narrow Arrow",
        inputs: payload.inputs ?? "",
        inputCount: payload.input_count ?? 0,
        levelId,
      });
    } catch (err) {
      setError(`Couldn't load replay: ${err instanceof Error ? err.message : err}`);
    } finally {
      setOpening(null);
    }
  };

  const useAsReference = async (entry: LeaderboardEntry) => {
    if (!onUseAsReference) return;
    setSeeding(entry.run_id);
    try {
      const payload = await window.nf.getRunReplay(entry.run_id);
      const sel: ReplaySelection = {
        runId: entry.run_id,
        username: entry.username,
        timeS: entry.completion_time,
        arrowName: payload.arrow_name ?? entry.arrow_name ?? "Narrow Arrow",
        inputs: payload.inputs ?? "",
        inputCount: payload.input_count ?? 0,
        levelId,
      };
      onUseAsReference(sel);
    } catch (err) {
      setError(`Couldn't load replay: ${err instanceof Error ? err.message : err}`);
    } finally {
      setSeeding(null);
    }
  };

  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 6 }}>
        <span style={{ color: "#9aa4b2" }}>Arrow</span>
        <select
          style={selectStyle}
          value={arrow}
          onChange={(e) => setArrow(e.target.value)}
        >
          {ARROW_LABELS.map((l) => (
            <option key={l} value={l === "All arrows" ? "all" : l}>
              {l}
            </option>
          ))}
        </select>
        <button style={linkButtonStyle} onClick={() => void load(levelId, arrow)} disabled={loading}>
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {error && <div style={{ color: "#f85149", marginBottom: 6 }}>{error}</div>}

      {entries === null && !loading && <p style={{ color: "#7d8590" }}>Select a level to see its board.</p>}

      {entries && entries.length === 0 && !loading && (
        <p style={{ color: "#7d8590" }}>No runs on this board yet.</p>
      )}

      {entries && entries.length > 0 && (
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={thStyle}>#</th>
              <th style={thStyle}>Player</th>
              <th style={thStyle}>Arrow</th>
              <th style={thStyle}>Time</th>
              <th style={thStyle}></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e, i) => (
              <tr key={e.run_id ?? i} style={{ borderTop: "1px solid #21262d" }}>
                <td style={tdStyle}>{i + 1}</td>
                <td style={{ ...tdStyle, color: "#e6edf3" }}>{e.username}</td>
                <td style={tdStyle}>
                  <ArrowTag name={e.arrow_name} />
                </td>
                <td style={{ ...tdStyle, color: "#3fb950", fontWeight: 600 }}>
                  {e.completion_time.toFixed(3)}s
                </td>
                <td style={tdStyle}>
                  <button
                    style={smallButtonStyle}
                    onClick={() => void openReplay(e)}
                    disabled={!e.replay_available || opening === e.run_id}
                  >
                    {opening === e.run_id ? "…" : e.replay_available ? "Replay" : "—"}
                  </button>
                  <button
                    style={{ ...smallButtonStyle, color: "#d29922" }}
                    onClick={() => void useAsReference(e)}
                    disabled={seeding === e.run_id}
                    title="Use this run as a reference seed to learn from"
                  >
                    {seeding === e.run_id ? "…" : "Learn"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function ArrowTag({ name }: { name?: string }) {
  const kind = arrowKind(name);
  const colour = kind === "speedy" ? "#fbbf24" : kind === "energy" ? "#f472b6" : "#60a5fa";
  return <span style={{ color: colour }}>{name ?? "—"}</span>;
}

const selectStyle: React.CSSProperties = {
  background: "#151a23",
  color: "#e6edf3",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "4px 6px",
  fontSize: 12,
};

const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "#58a6ff",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "3px 8px",
  fontSize: 11,
  cursor: "pointer",
};

const smallButtonStyle: React.CSSProperties = {
  background: "#21262d",
  color: "#c9d1d9",
  border: "1px solid #30363d",
  borderRadius: 4,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
};

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "4px 6px",
  color: "#7d8590",
  fontWeight: 600,
};

const tdStyle: React.CSSProperties = {
  padding: "4px 6px",
  color: "#c9d1d9",
};