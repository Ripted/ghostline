/**
 * CustomMapBrowser — browse/search the game's published (custom) levels via
 * `/published-levels`. Shows a grid of level cards with creator, plays/likes,
 * a thumbnail (level image), and a "Load" button that imports the selected
 * level into the app (fetched through `/level-details`).
 */
import { useCallback, useEffect, useState } from "react";
import type { LevelGeometryPayload, PublishedLevel } from "../../../shared/types";

export interface CustomLevelSelection {
  levelId: string;
  name: string;
  geometry: LevelGeometryPayload["geometry"];
}

interface CustomMapBrowserProps {
  onOpenLevel?: (sel: CustomLevelSelection) => void;
}

const FILTERS = [
  { value: "discover", label: "Discover" },
  { value: "new", label: "New" },
  { value: "popular", label: "Popular" },
  { value: "liked", label: "Liked" },
];

function levelIdOf(l: PublishedLevel): string {
  return String(l.level_id ?? l.id ?? l.map_name ?? "?");
}
function levelNameOf(l: PublishedLevel): string {
  return l.name ?? l.title ?? l.map_name ?? levelIdOf(l);
}
function creatorOf(l: PublishedLevel): string {
  return l.creator_name ?? l.author ?? l.username ?? "Unknown";
}

export function CustomMapBrowser({ onOpenLevel }: CustomMapBrowserProps) {
  const [filter, setFilter] = useState("discover");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [levels, setLevels] = useState<PublishedLevel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const load = useCallback(async (f: string, p: number, q: string) => {
    setLoading(true);
    setError(null);
    try {
      const opts: { filter?: string; page?: number; search?: string } = { filter: f, page: p };
      if (q.trim()) opts.search = q.trim();
      const rows = await window.nf.listPublishedLevels(opts);
      setLevels(rows);
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
      setLevels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filter, page, search);
  }, [filter, page, search, load]);

  const openLevel = async (l: PublishedLevel) => {
    if (!onOpenLevel) return;
    const id = levelIdOf(l);
    setOpening(id);
    try {
      const payload = await window.nf.getLevelData(id);
      onOpenLevel({
        levelId: id,
        name: levelNameOf(l),
        geometry: payload.geometry,
      });
    } catch (err) {
      setError(`Couldn't load level: ${err instanceof Error ? err.message : err}`);
    } finally {
      setOpening(null);
    }
  };

  const submitSearch = () => {
    setPage(0);
    setSearch(query);
  };

  return (
    <div style={{ fontSize: 12 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8, flexWrap: "wrap" }}>
        {FILTERS.map((f) => (
          <button
            key={f.value}
            style={{
              ...tabStyle,
              ...(filter === f.value ? { background: "#21262d", color: "#fff" } : {}),
            }}
            onClick={() => {
              setFilter(f.value);
              setPage(0);
            }}
          >
            {f.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <input
          style={inputStyle}
          placeholder="by:username or level name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submitSearch();
          }}
        />
        <button style={linkButtonStyle} onClick={submitSearch}>
          Search
        </button>
      </div>

      {error && <div style={{ color: "#f85149", marginBottom: 6 }}>{error}</div>}
      {loading && <p style={{ color: "#7d8590" }}>Loading custom levels…</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10, maxHeight: "100%", overflowY: "auto" }}>
        {(levels ?? []).map((l, i) => {
          const id = levelIdOf(l);
          return (
            <div key={id ?? i} style={{ background: "#151a23", borderRadius: 8, padding: 8, border: "1px solid #21262d" }}>
              <div style={{ width: "100%", aspectRatio: "16/10", background: "#0e1117", borderRadius: 6, overflow: "hidden", marginBottom: 6 }}>
                <img
                  src={id === "?" ? undefined : window.nf.levelImageUrl(id)}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                  }}
                />
              </div>
              <div style={{ color: "#e6edf3", fontWeight: 600, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {levelNameOf(l)}
              </div>
              <div style={{ color: "#7d8590", margin: "2px 0 6px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                by {creatorOf(l)}
              </div>
              {(l.play_count != null || l.plays != null || l.like_count != null || l.likes != null) && (
                <div style={{ color: "#9aa4b2", marginBottom: 4 }}>
                  {(l.play_count ?? l.plays ?? 0).toLocaleString()} plays · {(l.like_count ?? l.likes ?? 0).toLocaleString()} likes
                </div>
              )}
              {l.world_record && l.world_record.completion_time != null && (
                <div style={{ color: "#f0b429", fontSize: 11, marginBottom: 6 }}>
                  WR {l.world_record.completion_time.toFixed(3)}s{l.world_record.username ? ` · ${l.world_record.username}` : ""}
                  {l.world_record.arrow_name ? ` (${l.world_record.arrow_name})` : ""}
                </div>
              )}
              <button style={primaryButtonStyle} onClick={() => void openLevel(l)} disabled={opening === id}>
                {opening === id ? "Loading…" : "Load"}
              </button>
            </div>
          );
        })}
        {levels && levels.length === 0 && !loading && (
          <p style={{ color: "#7d8590", gridColumn: "1/-1" }}>No custom levels found for this filter.</p>
        )}
      </div>

      {(levels ?? []).length > 0 && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8 }}>
          <button
            style={linkButtonStyle}
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            ← Prev
          </button>
          <span style={{ color: "#7d8590" }}>Page {page + 1}</span>
          <button style={linkButtonStyle} onClick={() => setPage((p) => p + 1)}>
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

const tabStyle: React.CSSProperties = {
  background: "transparent",
  color: "#9aa4b2",
  border: "1px solid #30363d",
  borderRadius: 999,
  padding: "4px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  background: "#151a23",
  color: "#e6edf3",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "5px 8px",
  fontSize: 12,
  minWidth: 180,
};

const linkButtonStyle: React.CSSProperties = {
  background: "transparent",
  color: "#58a6ff",
  border: "1px solid #30363d",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 11,
  cursor: "pointer",
};

const primaryButtonStyle: React.CSSProperties = {
  background: "#238636",
  color: "#fff",
  border: "none",
  borderRadius: 6,
  padding: "4px 10px",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};