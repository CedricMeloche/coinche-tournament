import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Coinche Tournament Manager (Vite friendly)
 * - Hash routes:
 *    #/            Admin (full control)
 *    #/public      Public View (read-only scoreboard/stats)
 *    #/table?table=1  Table View (only that table's games; can enter score)
 * - NOTE: Without Supabase, data is per-device (localStorage). Public view won't auto-sync across devices yet.
 */

const LS_KEY = "coinche_tournament_vite_simple_v4";

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}
function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function safeInt(v) {
  if (v === "" || v === null || v === undefined) return null;
  const n = Number(String(v).replace(/[^0-9\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function clampNum(n, min = 0, max = 999999) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}
function fmt(n) {
  if (n === null || n === undefined) return "—";
  if (!Number.isFinite(Number(n))) return "—";
  return String(n);
}

/** Hash routing helpers */
function parseHashRoute() {
  const raw = window.location.hash || "#/";
  const withoutHash = raw.startsWith("#") ? raw.slice(1) : raw;
  const [pathPart, queryPart] = withoutHash.split("?");
  const path = pathPart || "/";
  const qs = new URLSearchParams(queryPart || "");
  const params = Object.fromEntries(qs.entries());
  return { path, params };
}
function setHash(path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  window.location.hash = qs ? `#${path}?${qs}` : `#${path}`;
}

/** Circle method RR scheduler */
function circleRoundRobin(teamIds) {
  const ids = [...teamIds];
  const hasOdd = ids.length % 2 === 1;
  if (hasOdd) ids.push("BYE");

  const n = ids.length;
  const rounds = n - 1;

  let left = ids.slice(0, n / 2);
  let right = ids.slice(n / 2).reverse();

  const out = [];
  for (let r = 0; r < rounds; r++) {
    const pairings = [];
    for (let i = 0; i < left.length; i++) {
      const a = left[i];
      const b = right[i];
      if (a !== "BYE" && b !== "BYE") pairings.push([a, b]);
    }
    out.push(pairings);

    // rotate (keep first fixed)
    const fixed = left[0];
    const movedFromLeft = left.pop();
    const movedFromRight = right.shift();
    left = [fixed, movedFromRight, ...left.slice(1)];
    right = [...right, movedFromLeft];
  }
  return out;
}

function computeMatchPoints(scoreWinner, threshold, highPts, lowPts) {
  if (scoreWinner === null) return 0;
  return scoreWinner >= threshold ? highPts : lowPts;
}

function sortStandings(rows) {
  return [...rows].sort((a, b) => {
    if (b.matchPoints !== a.matchPoints) return b.matchPoints - a.matchPoints;
    if (b.totalGamePoints !== a.totalGamePoints) return b.totalGamePoints - a.totalGamePoints;
    return a.name.localeCompare(b.name);
  });
}

function buildPoolAssignment(teamIds) {
  const shuffled = shuffleArray(teamIds);
  const mid = Math.ceil(shuffled.length / 2);
  return { A: shuffled.slice(0, mid), B: shuffled.slice(mid) };
}

/** ===== Fast mode Coinche scoring helpers ===== */
function roundTrickPoints(x) {
  if (x == null) return 0;
  const n = Math.max(0, Math.min(162, Number(x) || 0));
  return Math.floor((n + 4) / 10) * 10;
}

function computeFastCoincheScore({
  bidder,
  bid,
  coincheLevel,
  capot,
  bidderTrickPoints,
  announceA,
  announceB,
  beloteTeam,
}) {
  const BIDDER_IS_A = bidder === "A";
  const bidVal = Number(bid) || 0;

  const belotePts = beloteTeam === "NONE" ? 0 : 20;
  const beloteA = beloteTeam === "A" ? 20 : 0;
  const beloteB = beloteTeam === "B" ? 20 : 0;

  const rawBidder = Math.max(0, Math.min(162, Number(bidderTrickPoints) || 0));
  const rawOpp = 162 - rawBidder;

  const tricksBidder = roundTrickPoints(rawBidder);
  const tricksOpp = roundTrickPoints(rawOpp);

  const aAnn = Number(announceA) || 0;
  const bAnn = Number(announceB) || 0;

  const bidderAnn = BIDDER_IS_A ? aAnn : bAnn;

  const bidderHasBelote = (BIDDER_IS_A && beloteTeam === "A") || (!BIDDER_IS_A && beloteTeam === "B");
  const baseMin = bidderHasBelote ? 71 : 81;
  const special80 = bidVal === 80 ? 81 : 0;

  const announceHelp = bidderAnn + (bidderHasBelote ? 20 : 0);
  const required = Math.max(baseMin, special80, bidVal - announceHelp);

  const bidderSucceeded = capot ? true : rawBidder >= required;

  const mult = coincheLevel === "SURCOINCHE" ? 4 : coincheLevel === "COINCHE" ? 2 : 1;
  const isCoinche = coincheLevel !== "NONE";

  let scoreA = 0;
  let scoreB = 0;

  if (capot) {
    const winnerGets = 250 + aAnn + bAnn + belotePts + bidVal;
    if (BIDDER_IS_A) {
      scoreA = winnerGets;
      scoreB = 0;
    } else {
      scoreB = winnerGets;
      scoreA = 0;
    }
    return { scoreA, scoreB, bidderSucceeded: true };
  }

  if (isCoinche) {
    const winnerNonBelote = 160 + mult * bidVal + (aAnn + bAnn);
    if (bidderSucceeded) {
      if (BIDDER_IS_A) {
        scoreA = winnerNonBelote + beloteA;
        scoreB = beloteB;
      } else {
        scoreB = winnerNonBelote + beloteB;
        scoreA = beloteA;
      }
    } else {
      if (BIDDER_IS_A) {
        scoreB = winnerNonBelote + beloteB;
        scoreA = beloteA;
      } else {
        scoreA = winnerNonBelote + beloteA;
        scoreB = beloteB;
      }
    }
    return { scoreA, scoreB, bidderSucceeded };
  }

  if (bidderSucceeded) {
    if (BIDDER_IS_A) {
      scoreA = tricksBidder + aAnn + beloteA + bidVal;
      scoreB = tricksOpp + bAnn + beloteB;
    } else {
      scoreB = tricksBidder + bAnn + beloteB + bidVal;
      scoreA = tricksOpp + aAnn + beloteA;
    }
  } else {
    const oppGets = 160 + bidVal + (aAnn + bAnn);
    if (BIDDER_IS_A) {
      scoreA = beloteA;
      scoreB = oppGets + beloteB;
    } else {
      scoreB = beloteB;
      scoreA = oppGets + beloteA;
    }
  }

  return { scoreA, scoreB, bidderSucceeded };
}

/** ===== Simple UI components ===== */
function Section({ title, right, children }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 16, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10 }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>{title}</h2>
        <div>{right}</div>
      </div>
      {children}
    </div>
  );
}
function Btn({ children, onClick, disabled, kind = "primary" }) {
  const bg = kind === "primary" ? "#111827" : kind === "danger" ? "#b91c1c" : "#fff";
  const fg = kind === "primary" || kind === "danger" ? "#fff" : "#111827";
  const border = kind === "secondary" ? "1px solid #e5e7eb" : "1px solid transparent";
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "10px 12px",
        borderRadius: 12,
        border,
        background: disabled ? "#e5e7eb" : bg,
        color: disabled ? "#6b7280" : fg,
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: 800,
      }}
    >
      {children}
    </button>
  );
}
function Input({ value, onChange, placeholder, width = 220, type = "text", disabled }) {
  return (
    <input
      type={type}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width,
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        background: disabled ? "#f3f4f6" : "#fff",
        color: disabled ? "#6b7280" : "#111827",
      }}
    />
  );
}
function Select({ value, onChange, options, width = 160, disabled }) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width,
        padding: "10px 12px",
        borderRadius: 12,
        border: "1px solid #e5e7eb",
        background: disabled ? "#f3f4f6" : "#fff",
        color: disabled ? "#6b7280" : "#111827",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const tdStyle = {
  padding: "10px 10px",
  borderBottom: "1px solid #e5e7eb",
  whiteSpace: "nowrap",
  fontSize: 14,
};

function StatCard({ label, value }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 900 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 900, marginTop: 4 }}>{value}</div>
    </div>
  );
}

function FunMatchCard({ title, match }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
      <div style={{ fontSize: 12, color: "#6b7280", fontWeight: 900 }}>{title}</div>
      {match ? (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontWeight: 900 }}>
            {match.aName} {match.sa} — {match.sb} {match.bName}
          </div>
          <div style={{ marginTop: 4, fontSize: 12, color: "#6b7280" }}>
            {match.label} • Winner: <span style={{ fontWeight: 900 }}>{match.winner}</span> • Margin: {match.margin} • Total: {match.total}
          </div>
        </div>
      ) : (
        <div style={{ marginTop: 6, color: "#6b7280" }}>No completed games yet.</div>
      )}
    </div>
  );
}

function PodiumCard({ label, value }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 14 }}>
      <div style={{ color: "#6b7280", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 900 }}>{value ?? "—"}</div>
    </div>
  );
}

function GameCard({ g, teamById, onScore, onClear, onToggleFast, onFastPatch, readOnly }) {
  const teamA = teamById.get(g.teamAId)?.name ?? "—";
  const teamB = teamById.get(g.teamBId)?.name ?? "—";
  const pending = !g.winnerId;

  return (
    <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 12, marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
        <div style={{ fontWeight: 900 }}>
          Table {g.table} <span style={{ color: "#6b7280", fontWeight: 700 }}>•</span> {teamA} vs {teamB}
        </div>
        <div style={{ color: pending ? "#6b7280" : "#065f46", fontWeight: 900 }}>
          {pending ? "Pending" : `Winner: ${teamById.get(g.winnerId)?.name ?? "—"}`}
        </div>
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10, alignItems: "center" }}>
        <Input value={g.scoreA} onChange={(v) => onScore("A", v)} width={90} placeholder="A pts" disabled={readOnly} />
        <span style={{ color: "#6b7280" }}>vs</span>
        <Input value={g.scoreB} onChange={(v) => onScore("B", v)} width={90} placeholder="B pts" disabled={readOnly} />

        <div style={{ marginLeft: 10, color: "#6b7280", fontSize: 12 }}>
          Match pts: A +{g.matchPtsA} / B +{g.matchPtsB}
        </div>

        {!readOnly ? (
          <button onClick={onClear} style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#6b7280", fontWeight: 900, cursor: "pointer" }}>
            Clear
          </button>
        ) : null}
      </div>

      {/* Fast mode scoring */}
      <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 900 }}>
          <input type="checkbox" checked={Boolean(g.fast?.enabled)} onChange={(e) => onToggleFast(e.target.checked)} disabled={readOnly} />
          Fast mode scorer (auto-calculates game points)
        </label>

        {g.fast?.enabled ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 10, marginTop: 10 }}>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Bidder</div>
              <Select
                value={g.fast.bidder}
                onChange={(v) => onFastPatch({ bidder: v })}
                disabled={readOnly}
                options={[
                  { value: "A", label: "Team A (left)" },
                  { value: "B", label: "Team B (right)" },
                ]}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Bid</div>
              <Input value={String(g.fast.bid)} onChange={(v) => onFastPatch({ bid: Number(v || 0) })} width={120} disabled={readOnly} />
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Coinche</div>
              <Select
                value={g.fast.coincheLevel}
                onChange={(v) => onFastPatch({ coincheLevel: v })}
                disabled={readOnly}
                options={[
                  { value: "NONE", label: "None" },
                  { value: "COINCHE", label: "Coinche (x2)" },
                  { value: "SURCOINCHE", label: "Surcoinche (x4)" },
                ]}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Capot</div>
              <Select
                value={g.fast.capot ? "YES" : "NO"}
                onChange={(v) => onFastPatch({ capot: v === "YES" })}
                disabled={readOnly}
                options={[
                  { value: "NO", label: "No" },
                  { value: "YES", label: "Yes" },
                ]}
              />
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Bidder trick points (0–162)</div>
              <Input value={String(g.fast.bidderTrickPoints)} onChange={(v) => onFastPatch({ bidderTrickPoints: Number(v || 0) })} width={140} disabled={readOnly} />
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Announces Team A (non-belote)</div>
              <Input value={String(g.fast.announceA)} onChange={(v) => onFastPatch({ announceA: Number(v || 0) })} width={140} disabled={readOnly} />
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Announces Team B (non-belote)</div>
              <Input value={String(g.fast.announceB)} onChange={(v) => onFastPatch({ announceB: Number(v || 0) })} width={140} disabled={readOnly} />
            </div>

            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Belote (who has it)</div>
              <Select
                value={g.fast.beloteTeam}
                onChange={(v) => onFastPatch({ beloteTeam: v })}
                disabled={readOnly}
                options={[
                  { value: "NONE", label: "None" },
                  { value: "A", label: "Team A" },
                  { value: "B", label: "Team B" },
                ]}
              />
            </div>

            <div style={{ gridColumn: "1/-1", color: "#6b7280", fontSize: 12 }}>
              Fast mode writes the calculated score into the A/B score boxes above.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function App() {
  // ===== routing state =====
  const [route, setRouteState] = useState(() => parseHashRoute());
  useEffect(() => {
    const onHash = () => setRouteState(parseHashRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // ===== data =====
  const [loaded, setLoaded] = useState(false);
  const [tournamentName, setTournamentName] = useState("9th Annual Coinche Tournament");

  const [players, setPlayers] = useState([]); // {id,name}
  const [teams, setTeams] = useState([]); // {id,name,playerIds,isBye}
  const [avoidSameTeams, setAvoidSameTeams] = useState(true);
  const [pairHistory, setPairHistory] = useState([]); // pair keys

  const [manualTeamsMode, setManualTeamsMode] = useState(true);
  const [manualP1, setManualP1] = useState("");
  const [manualP2, setManualP2] = useState("");

  const [teamsLocked, setTeamsLocked] = useState(false);

  const [poolMap, setPoolMap] = useState({ A: [], B: [] });
  const [games, setGames] = useState([]); // pool games
  const [bracket, setBracket] = useState([]);

  const [winThreshold, setWinThreshold] = useState(2000);
  const [winHighPts, setWinHighPts] = useState(2);
  const [winLowPts, setWinLowPts] = useState(1);

  const [newPlayerName, setNewPlayerName] = useState("");
  const inputRef = useRef(null);

  // load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        setTournamentName(data.tournamentName ?? "9th Annual Coinche Tournament");
        setPlayers(data.players ?? []);
        setTeams(data.teams ?? []);
        setAvoidSameTeams(Boolean(data.avoidSameTeams ?? true));
        setPairHistory(data.pairHistory ?? []);
        setPoolMap(data.poolMap ?? { A: [], B: [] });
        setGames(data.games ?? []);
        setBracket(data.bracket ?? []);
        setWinThreshold(data.winThreshold ?? 2000);
        setWinHighPts(data.winHighPts ?? 2);
        setWinLowPts(data.winLowPts ?? 1);
        setManualTeamsMode(Boolean(data.manualTeamsMode ?? true));
        setTeamsLocked(Boolean(data.teamsLocked ?? false));
      }
    } catch {
      // ignore
    } finally {
      setLoaded(true);
    }
  }, []);

  // persist
  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        tournamentName,
        players,
        teams,
        avoidSameTeams,
        pairHistory,
        poolMap,
        games,
        bracket,
        winThreshold,
        winHighPts,
        winLowPts,
        manualTeamsMode,
        teamsLocked,
      })
    );
  }, [
    loaded,
    tournamentName,
    players,
    teams,
    avoidSameTeams,
    pairHistory,
    poolMap,
    games,
    bracket,
    winThreshold,
    winHighPts,
    winLowPts,
    manualTeamsMode,
    teamsLocked,
  ]);

  // maps
  const playerById = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamById = useMemo(() => new Map(teams.map((t) => [t.id, t])), [teams]);
  const realTeams = useMemo(() => teams.filter((t) => !t.isBye), [teams]);

  const tournamentReady = realTeams.length >= 8;

  function resetTournamentStructure() {
    setPoolMap({ A: [], B: [] });
    setGames([]);
    setBracket([]);
  }
  function fullReset() {
    setTournamentName("9th Annual Coinche Tournament");
    setPlayers([]);
    setTeams([]);
    setPairHistory([]);
    setManualP1("");
    setManualP2("");
    setTeamsLocked(false);
    resetTournamentStructure();
  }

  // players
  function addPlayer() {
    const name = newPlayerName.trim();
    if (!name) return;
    setPlayers((prev) => [...prev, { id: uid("p"), name }]);
    setNewPlayerName("");
    setTimeout(() => inputRef.current?.focus?.(), 0);
  }
  function removePlayer(id) {
    if (teamsLocked) return;
    setPlayers((prev) => prev.filter((p) => p.id !== id));
    setTeams([]);
    setPairHistory([]);
    resetTournamentStructure();
  }

  // team helpers
  function usedPlayerIdsFromTeams(ts) {
    const used = new Set();
    ts.forEach((t) => (t.playerIds || []).forEach((pid) => used.add(pid)));
    return used;
  }
  const usedPlayers = useMemo(() => usedPlayerIdsFromTeams(teams), [teams]);

  function safeResetAfterTeamChange() {
    if (teamsLocked) return;
    resetTournamentStructure();
  }
  function clearAllTeams() {
    if (teamsLocked) return;
    setTeams([]);
    safeResetAfterTeamChange();
  }
  function removeTeam(teamId) {
    if (teamsLocked) return;
    setTeams((prev) => prev.filter((t) => t.id !== teamId));
    safeResetAfterTeamChange();
  }
  function addManualTeam() {
    if (teamsLocked) return;
    if (!manualP1 || !manualP2) return;
    if (manualP1 === manualP2) return;
    if (usedPlayers.has(manualP1) || usedPlayers.has(manualP2)) return;

    const p1 = playerById.get(manualP1)?.name ?? "P1";
    const p2 = playerById.get(manualP2)?.name ?? "P2";

    const newTeam = {
      id: uid("t"),
      name: `${p1} / ${p2}`,
      playerIds: [manualP1, manualP2],
      isBye: false,
    };

    setTeams((prev) => [...prev, newTeam]);
    setManualP1("");
    setManualP2("");
    safeResetAfterTeamChange();
  }

  // teams (random)
  function buildRandomTeams() {
    if (teamsLocked) return;
    if (players.length < 2) return;

    const ids = players.map((p) => p.id);
    const tries = avoidSameTeams ? 40 : 1;
    let best = null;
    const historySet = new Set(pairHistory);

    for (let t = 0; t < tries; t++) {
      const shuffled = shuffleArray(ids);
      const pairs = [];
      for (let i = 0; i < shuffled.length; i += 2) {
        const a = shuffled[i];
        const b = shuffled[i + 1];
        if (!b) pairs.push([a, null]);
        else pairs.push([a, b]);
      }

      let repeats = 0;
      for (const [a, b] of pairs) {
        if (!b) continue;
        const key = [a, b].sort().join("|");
        if (historySet.has(key)) repeats++;
      }

      if (!best || repeats < best.repeats) {
        best = { pairs, repeats };
        if (repeats === 0) break;
      }
    }

    const finalPairs = best?.pairs ?? [];
    const builtTeams = finalPairs.map(([a, b]) => {
      if (!b) {
        const p1 = playerById.get(a)?.name ?? "Player";
        return { id: uid("t"), name: `${p1} + BYE`, playerIds: [a], isBye: true };
      }
      const p1 = playerById.get(a)?.name ?? "P1";
      const p2 = playerById.get(b)?.name ?? "P2";
      return { id: uid("t"), name: `${p1} / ${p2}`, playerIds: [a, b], isBye: false };
    });

    const newPairs = [];
    for (const tm of builtTeams) {
      if (tm.playerIds.length === 2) newPairs.push([...tm.playerIds].sort().join("|"));
    }

    setTeams(builtTeams);
    setPairHistory((prev) => Array.from(new Set([...prev, ...newPairs])));
    safeResetAfterTeamChange();
  }

  // scheduling: pools
  function createPoolsRoundRobin() {
    if (!tournamentReady) return;
    const teamIds = realTeams.map((t) => t.id);
    const pools = buildPoolAssignment(teamIds);
    setPoolMap(pools);

    const built = [];
    const makePoolGames = (poolName, ids, tableOffset) => {
      const rounds = circleRoundRobin(ids);
      rounds.forEach((pairings, rIdx) => {
        pairings.forEach(([a, b], pIdx) => {
          built.push({
            id: uid(`g_${poolName}`),
            stage: "POOL",
            pool: poolName,
            round: rIdx + 1,
            table: tableOffset + (pIdx + 1), // Pool A: 1-2, Pool B: 3-4 (for 8 teams)
            teamAId: a,
            teamBId: b,
            scoreA: "",
            scoreB: "",
            winnerId: null,
            matchPtsA: 0,
            matchPtsB: 0,
            fast: {
              enabled: false,
              bidder: "A",
              bid: 80,
              coincheLevel: "NONE",
              capot: false,
              bidderTrickPoints: 81,
              announceA: 0,
              announceB: 0,
              beloteTeam: "NONE",
            },
          });
        });
      });
    };

    makePoolGames("A", pools.A, 0);
    makePoolGames("B", pools.B, 2);

    setGames(built);
    setBracket([]);
  }

  // game scoring
  function recomputeGameOutcome(g) {
    const a = safeInt(g.scoreA);
    const b = safeInt(g.scoreB);
    if (a === null || b === null) return { ...g, winnerId: null, matchPtsA: 0, matchPtsB: 0 };
    if (a === b) return { ...g, winnerId: null, matchPtsA: 0, matchPtsB: 0 };
    const winnerId = a > b ? g.teamAId : g.teamBId;
    const winnerScore = Math.max(a, b);
    const mp = computeMatchPoints(winnerScore, winThreshold, winHighPts, winLowPts);
    return {
      ...g,
      winnerId,
      matchPtsA: winnerId === g.teamAId ? mp : 0,
      matchPtsB: winnerId === g.teamBId ? mp : 0,
    };
  }
  function setGameScore(gameId, side, value) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;
        const updated = { ...g, [side === "A" ? "scoreA" : "scoreB"]: value };
        return recomputeGameOutcome(updated);
      })
    );
  }
  function clearGame(gameId) {
    setGames((prev) =>
      prev.map((g) =>
        g.id === gameId ? { ...g, scoreA: "", scoreB: "", winnerId: null, matchPtsA: 0, matchPtsB: 0 } : g
      )
    );
  }
  function toggleFast(gameId, enabled) {
    setGames((prev) => prev.map((g) => (g.id === gameId ? { ...g, fast: { ...g.fast, enabled } } : g)));
  }
  function updateFast(gameId, patch) {
    setGames((prev) =>
      prev.map((g) => {
        if (g.id !== gameId) return g;
        const fast = { ...g.fast, ...patch };
        const updated = { ...g, fast };

        if (!fast.enabled) return updated;

        const res = computeFastCoincheScore({
          bidder: fast.bidder,
          bid: Number(fast.bid) || 0,
          coincheLevel: fast.coincheLevel,
          capot: Boolean(fast.capot),
          bidderTrickPoints: Number(fast.bidderTrickPoints) || 0,
          announceA: Number(fast.announceA) || 0,
          announceB: Number(fast.announceB) || 0,
          beloteTeam: fast.beloteTeam,
        });

        updated.scoreA = String(res.scoreA);
        updated.scoreB = String(res.scoreB);
        return recomputeGameOutcome(updated);
      })
    );
  }

  // standings
  function poolStandings(poolName) {
    const ids = poolMap[poolName] || [];
    const rows = ids
      .map((id) => {
        const t = teamById.get(id);
        return t ? { teamId: t.id, name: t.name, matchPoints: 0, totalGamePoints: 0, gamesPlayed: 0 } : null;
      })
      .filter(Boolean);

    const byId = new Map(rows.map((r) => [r.teamId, r]));

    games
      .filter((g) => g.stage === "POOL" && g.pool === poolName)
      .forEach((g) => {
        const a = byId.get(g.teamAId);
        const b = byId.get(g.teamBId);
        if (!a || !b) return;

        const sa = safeInt(g.scoreA);
        const sb = safeInt(g.scoreB);
        if (sa !== null && sb !== null) {
          a.totalGamePoints += sa;
          b.totalGamePoints += sb;
          a.gamesPlayed += 1;
          b.gamesPlayed += 1;
        }
        a.matchPoints += g.matchPtsA ?? 0;
        b.matchPoints += g.matchPtsB ?? 0;
      });

    return sortStandings(rows);
  }

  const standingsA = useMemo(() => (tournamentReady ? poolStandings("A") : []), [tournamentReady, games, poolMap, teamById]);
  const standingsB = useMemo(() => (tournamentReady ? poolStandings("B") : []), [tournamentReady, games, poolMap, teamById]);

  // bracket (kept as-is)
  function propagateBracketWinners(ms) {
    const byId = new Map(ms.map((m) => [m.id, { ...m }]));
    for (const m of ms) {
      if (!m.winnerId || !m.nextMatchId) continue;
      const next = byId.get(m.nextMatchId);
      if (!next) continue;
      const slotKey = m.nextSlot === "A" ? "teamAId" : "teamBId";
      if (next[slotKey] !== m.winnerId) {
        next[slotKey] = m.winnerId;
        next.winnerId = null;
        next.scoreA = "";
        next.scoreB = "";
      }
      byId.set(next.id, next);
    }
    return Array.from(byId.values());
  }
  function fillThirdPlace(ms) {
    const sf = ms.filter((x) => x.round === "SF");
    const third = ms.find((x) => x.round === "3P");
    if (!third || sf.length !== 2) return ms;
    if (!sf[0].teamAId || !sf[0].teamBId || !sf[0].winnerId) return ms;
    if (!sf[1].teamAId || !sf[1].teamBId || !sf[1].winnerId) return ms;

    const loser1 = sf[0].winnerId === sf[0].teamAId ? sf[0].teamBId : sf[0].teamAId;
    const loser2 = sf[1].winnerId === sf[1].teamAId ? sf[1].teamBId : sf[1].teamAId;

    if (third.teamAId === loser1 && third.teamBId === loser2) return ms;
    return ms.map((m) => (m.id === third.id ? { ...m, teamAId: loser1, teamBId: loser2, winnerId: null, scoreA: "", scoreB: "" } : m));
  }

  function buildBracketFromPools() {
    const a = standingsA.slice(0, 4).map((x) => x.teamId);
    const b = standingsB.slice(0, 4).map((x) => x.teamId);
    if (a.length < 4 || b.length < 4) return;

    const qf = [
      { label: "QF1", A: a[0], B: b[3] },
      { label: "QF2", A: a[1], B: b[2] },
      { label: "QF3", A: b[0], B: a[3] },
      { label: "QF4", A: b[1], B: a[2] },
    ];

    const sfIds = [uid("m_sf"), uid("m_sf")];
    const fId = uid("m_f");
    const thirdId = uid("m_3p");

    const newBracket = [];

    qf.forEach((m, idx) => {
      const nextMatchId = idx < 2 ? sfIds[0] : sfIds[1];
      const nextSlot = idx % 2 === 0 ? "A" : "B";
      newBracket.push({
        id: uid("m_qf"),
        label: m.label,
        round: "QF",
        idx,
        teamAId: m.A,
        teamBId: m.B,
        scoreA: "",
        scoreB: "",
        winnerId: null,
        nextMatchId,
        nextSlot,
      });
    });

    newBracket.push({
      id: sfIds[0],
      label: "SF1",
      round: "SF",
      idx: 0,
      teamAId: null,
      teamBId: null,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId: fId,
      nextSlot: "A",
    });
    newBracket.push({
      id: sfIds[1],
      label: "SF2",
      round: "SF",
      idx: 1,
      teamAId: null,
      teamBId: null,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId: fId,
      nextSlot: "B",
    });

    newBracket.push({
      id: fId,
      label: "Final",
      round: "F",
      idx: 0,
      teamAId: null,
      teamBId: null,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId: null,
      nextSlot: null,
    });

    newBracket.push({
      id: thirdId,
      label: "3rd Place",
      round: "3P",
      idx: 0,
      teamAId: null,
      teamBId: null,
      scoreA: "",
      scoreB: "",
      winnerId: null,
      nextMatchId: null,
      nextSlot: null,
    });

    setBracket(fillThirdPlace(propagateBracketWinners(newBracket)));
  }

  function setBracketScore(matchId, side, value) {
    setBracket((prev) => {
      const updated = prev.map((m) => (m.id === matchId ? { ...m, [side === "A" ? "scoreA" : "scoreB"]: value } : m));
      const withWinners = updated.map((m) => {
        if (m.id !== matchId) return m;
        if (!m.teamAId || !m.teamBId) return { ...m, winnerId: null };
        const a = safeInt(m.scoreA);
        const b = safeInt(m.scoreB);
        if (a === null || b === null) return { ...m, winnerId: null };
        if (a === b) return { ...m, winnerId: null };
        return { ...m, winnerId: a > b ? m.teamAId : m.teamBId };
      });
      return fillThirdPlace(propagateBracketWinners(withWinners));
    });
  }

  function clearBracketMatch(matchId) {
    setBracket((prev) => {
      const cleared = prev.map((m) => (m.id === matchId ? { ...m, scoreA: "", scoreB: "", winnerId: null } : m));
      return fillThirdPlace(propagateBracketWinners(cleared));
    });
  }

  // winner board
  const winnerBoard = useMemo(() => {
    const final = bracket.find((m) => m.round === "F");
    const third = bracket.find((m) => m.round === "3P");

    const champId = final?.winnerId ?? null;
    const runnerId = final?.winnerId ? (final.winnerId === final.teamAId ? final.teamBId : final.teamAId) : null;
    const thirdId = third?.winnerId ?? null;

    return {
      champion: champId ? teamById.get(champId)?.name : null,
      runnerUp: runnerId ? teamById.get(runnerId)?.name : null,
      third: thirdId ? teamById.get(thirdId)?.name : null,
    };
  }, [bracket, teamById]);

  // pool games per pool
  const poolGamesA = useMemo(
    () => games.filter((g) => g.stage === "POOL" && g.pool === "A").sort((x, y) => x.round - y.round || x.table - y.table),
    [games]
  );
  const poolGamesB = useMemo(
    () => games.filter((g) => g.stage === "POOL" && g.pool === "B").sort((x, y) => x.round - y.round || x.table - y.table),
    [games]
  );

  // ===== Live scoreboard + stats (pool+bracket for PF/PA/W/L; MP from pool only)
  const allMatchesForStats = useMemo(() => {
    const poolMatches = games.map((g) => ({
      id: g.id,
      stage: "POOL",
      label: `Pool ${g.pool} R${g.round} (Table ${g.table})`,
      teamAId: g.teamAId,
      teamBId: g.teamBId,
      scoreA: g.scoreA,
      scoreB: g.scoreB,
    }));
    const bracketMatches = bracket.map((m) => ({
      id: m.id,
      stage: "BRACKET",
      label: `${m.label} (${m.round})`,
      teamAId: m.teamAId,
      teamBId: m.teamBId,
      scoreA: m.scoreA,
      scoreB: m.scoreB,
    }));
    return [...poolMatches, ...bracketMatches];
  }, [games, bracket]);

  const scoreboard = useMemo(() => {
    const rows = realTeams.map((t) => ({
      teamId: t.id,
      name: t.name,
      pool: poolMap.A.includes(t.id) ? "A" : poolMap.B.includes(t.id) ? "B" : "—",
      gp: 0,
      w: 0,
      l: 0,
      mp: 0,
      pf: 0,
      pa: 0,
      diff: 0,
      avgFor: 0,
      avgAgainst: 0,
    }));
    const byId = new Map(rows.map((r) => [r.teamId, r]));

    // MP from pool only
    games.forEach((g) => {
      const a = byId.get(g.teamAId);
      const b = byId.get(g.teamBId);
      if (!a || !b) return;
      a.mp += g.matchPtsA ?? 0;
      b.mp += g.matchPtsB ?? 0;
    });

    // W/L and PF/PA from all matches with scores
    allMatchesForStats.forEach((m) => {
      const a = byId.get(m.teamAId);
      const b = byId.get(m.teamBId);
      if (!a || !b) return;

      const sa = safeInt(m.scoreA);
      const sb = safeInt(m.scoreB);
      if (sa === null || sb === null) return;

      a.gp += 1;
      b.gp += 1;

      a.pf += sa;
      a.pa += sb;
      b.pf += sb;
      b.pa += sa;

      if (sa > sb) {
        a.w += 1;
        b.l += 1;
      } else if (sb > sa) {
        b.w += 1;
        a.l += 1;
      }
    });

    rows.forEach((r) => {
      r.diff = r.pf - r.pa;
      r.avgFor = r.gp ? Math.round((r.pf / r.gp) * 10) / 10 : 0;
      r.avgAgainst = r.gp ? Math.round((r.pa / r.gp) * 10) / 10 : 0;
    });

    return [...rows].sort((x, y) => {
      if (y.mp !== x.mp) return y.mp - x.mp;
      if (y.diff !== x.diff) return y.diff - x.diff;
      if (y.pf !== x.pf) return y.pf - x.pf;
      return x.name.localeCompare(y.name);
    });
  }, [realTeams, poolMap, games, allMatchesForStats]);

  const liveStats = useMemo(() => {
    const played = [];
    allMatchesForStats.forEach((m) => {
      const aName = teamById.get(m.teamAId)?.name;
      const bName = teamById.get(m.teamBId)?.name;
      if (!aName || !bName) return;

      const sa = safeInt(m.scoreA);
      const sb = safeInt(m.scoreB);
      if (sa === null || sb === null) return;

      const total = sa + sb;
      const margin = Math.abs(sa - sb);
      const winner = sa > sb ? aName : sb > sa ? bName : "Tie";
      played.push({ ...m, aName, bName, sa, sb, total, margin, winner });
    });

    const totalGames = played.length;
    const totalPoints = played.reduce((acc, x) => acc + x.total, 0);

    const biggestBlowout = played.length ? [...played].sort((a, b) => b.margin - a.margin || b.total - a.total)[0] : null;
    const closestGame = played.length ? [...played].sort((a, b) => a.margin - b.margin || b.total - a.total)[0] : null;
    const highestScoringGame = played.length ? [...played].sort((a, b) => b.total - a.total || a.margin - b.margin)[0] : null;

    const mostPointsTeam = scoreboard.length ? [...scoreboard].sort((a, b) => b.pf - a.pf)[0] : null;
    const bestDefenseTeam = scoreboard.length ? [...scoreboard].filter((r) => r.gp > 0).sort((a, b) => a.pa - b.pa)[0] ?? null : null;
    const bestDiffTeam = scoreboard.length ? [...scoreboard].filter((r) => r.gp > 0).sort((a, b) => b.diff - a.diff)[0] ?? null : null;

    return {
      totalGames,
      totalPoints,
      avgPointsPerGame: totalGames ? Math.round((totalPoints / totalGames) * 10) / 10 : 0,
      biggestBlowout,
      closestGame,
      highestScoringGame,
      mostPointsTeam,
      bestDefenseTeam,
      bestDiffTeam,
    };
  }, [allMatchesForStats, teamById, scoreboard]);

  // ===== Table View helpers
  const tableParam = route.path === "/table" ? clampNum(route.params.table ?? 1, 1, 20) : 1;
  const tableGames = useMemo(() => games.filter((g) => g.stage === "POOL" && g.table === Number(tableParam)).sort((a, b) => a.round - b.round), [games, tableParam]);

  const defaultRoundForTable = useMemo(() => {
    // first round that isn't fully scored yet, else last round
    const firstIncomplete = tableGames.find((g) => safeInt(g.scoreA) === null || safeInt(g.scoreB) === null);
    return firstIncomplete?.round ?? (tableGames[tableGames.length - 1]?.round ?? 1);
  }, [tableGames]);

  const [tableRound, setTableRound] = useState(1);
  useEffect(() => {
    setTableRound(defaultRoundForTable);
  }, [defaultRoundForTable, tableParam]);

  const gameForTableRound = useMemo(() => tableGames.find((g) => g.round === Number(tableRound)) ?? null, [tableGames, tableRound]);

  // ===== Links
  const base = `${window.location.origin}${window.location.pathname}`;
  const publicUrl = `${base}#/public`;
  const adminUrl = `${base}#/`;
  const tableUrl = (n) => `${base}#/table?table=${n}`;

  // ===== Top nav (works for all pages)
  function TopNav() {
    const active = route.path;
    const pill = (label, path, params) => (
      <button
        onClick={() => setHash(path, params)}
        style={{
          border: "1px solid #e5e7eb",
          background: active === path ? "#111827" : "#fff",
          color: active === path ? "#fff" : "#111827",
          borderRadius: 999,
          padding: "8px 12px",
          fontWeight: 900,
          cursor: "pointer",
        }}
      >
        {label}
      </button>
    );

    return (
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
        {pill("Admin", "/")}
        {pill("Public View", "/public")}
        {pill(`Table View`, "/table", { table: String(tableParam) })}
        <div style={{ marginLeft: "auto", color: "#6b7280", fontWeight: 800, alignSelf: "center" }}>
          {route.path === "/table" ? `Table ${tableParam}` : ""}
        </div>
      </div>
    );
  }

  // ===== Shared Scoreboard section (used by Admin + Public)
  function ScoreboardSection({ readOnly }) {
    return (
      <Section
        title="Live Scoreboard + Stats"
        right={<div style={{ color: "#065f46", fontWeight: 900 }}>{readOnly ? "Read-only" : "Auto-updates as you type"}</div>}
      >
        {realTeams.length === 0 ? (
          <div style={{ color: "#6b7280" }}>Create teams to see the scoreboard.</div>
        ) : (
          <>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12, marginBottom: 12 }}>
              <StatCard label="Games played" value={fmt(liveStats.totalGames)} />
              <StatCard label="Total points entered" value={fmt(liveStats.totalPoints)} />
              <StatCard label="Avg points/game" value={fmt(liveStats.avgPointsPerGame)} />
              <StatCard
                label="Top offense (PF)"
                value={liveStats.mostPointsTeam ? `${liveStats.mostPointsTeam.name} (${liveStats.mostPointsTeam.pf})` : "—"}
              />
              <StatCard
                label="Best defense (lowest PA)"
                value={liveStats.bestDefenseTeam ? `${liveStats.bestDefenseTeam.name} (${liveStats.bestDefenseTeam.pa})` : "—"}
              />
              <StatCard label="Best diff" value={liveStats.bestDiffTeam ? `${liveStats.bestDiffTeam.name} (${liveStats.bestDiffTeam.diff})` : "—"} />
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 12 }}>
              <FunMatchCard title="Biggest blowout" match={liveStats.biggestBlowout} />
              <FunMatchCard title="Closest game" match={liveStats.closestGame} />
              <FunMatchCard title="Highest scoring game" match={liveStats.highestScoringGame} />
            </div>

            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
                <thead>
                  <tr>
                    {["#", "Team", "Pool", "GP", "W", "L", "MP", "PF", "PA", "Diff", "Avg PF", "Avg PA"].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: "left",
                          fontSize: 12,
                          color: "#6b7280",
                          padding: "10px 10px",
                          borderBottom: "1px solid #e5e7eb",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {scoreboard.map((r, idx) => (
                    <tr key={r.teamId} style={{ background: idx % 2 === 0 ? "#fff" : "#fafafa" }}>
                      <td style={tdStyle}>{idx + 1}</td>
                      <td style={{ ...tdStyle, fontWeight: 900, maxWidth: 320, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.name}
                      </td>
                      <td style={tdStyle}>{r.pool}</td>
                      <td style={tdStyle}>{r.gp}</td>
                      <td style={tdStyle}>{r.w}</td>
                      <td style={tdStyle}>{r.l}</td>
                      <td style={{ ...tdStyle, fontWeight: 900 }}>{r.mp}</td>
                      <td style={tdStyle}>{r.pf}</td>
                      <td style={tdStyle}>{r.pa}</td>
                      <td style={{ ...tdStyle, fontWeight: 900, color: r.diff > 0 ? "#065f46" : r.diff < 0 ? "#b91c1c" : "#111827" }}>{r.diff}</td>
                      <td style={tdStyle}>{r.avgFor}</td>
                      <td style={tdStyle}>{r.avgAgainst}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280" }}>
              Notes: MP = pool match points only. W/L and PF/PA include pool + bracket games where both scores are entered.
            </div>
          </>
        )}
      </Section>
    );
  }

  // ===== Admin page (your original + link launcher)
  function AdminView() {
    const teamActionsDisabled = teamsLocked;

    return (
      <>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 12 }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 26 }}>{tournamentName}</h1>
            <div style={{ color: "#6b7280", marginTop: 4 }}>
              Mode: {tournamentReady ? "8+ teams (2 pools + bracket)" : "Add players to reach 8 teams"}
              {teamsLocked ? " • Teams Locked" : ""}
            </div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <Btn kind="secondary" onClick={resetTournamentStructure} disabled={games.length === 0 && bracket.length === 0}>
              Reset tournament
            </Btn>
            <Btn kind="danger" onClick={fullReset}>
              Full reset
            </Btn>
          </div>
        </div>

        <Section title="Quick Links (Projector + Tables)">
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 10 }}>
            <LinkRow label="Admin" url={adminUrl} />
            <LinkRow label="Public View (TV/Projector)" url={publicUrl} />
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
              {[1, 2, 3, 4].map((n) => (
                <LinkRow key={n} label={`Table View (Table ${n})`} url={tableUrl(n)} />
              ))}
            </div>
            <div style={{ fontSize: 12, color: "#b45309", fontWeight: 900 }}>
              Heads-up: Until we add Supabase, each device keeps its own scores. Public View won’t auto-update from other phones yet.
            </div>
          </div>
        </Section>

        <ScoreboardSection readOnly={false} />

        <Section
          title="Settings"
          right={
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <input type="checkbox" checked={avoidSameTeams} onChange={(e) => setAvoidSameTeams(e.target.checked)} disabled={teamActionsDisabled} />
                Avoid same teams
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 900 }}>
                <input type="checkbox" checked={teamsLocked} onChange={(e) => setTeamsLocked(e.target.checked)} />
                Lock teams
              </label>
            </div>
          }
        >
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Tournament name</div>
              <Input value={tournamentName} onChange={setTournamentName} width={360} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Win threshold</div>
              <Input value={String(winThreshold)} onChange={(v) => setWinThreshold(clampNum(v, 0, 999999))} width={120} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Win ≥ threshold</div>
              <Input value={String(winHighPts)} onChange={(v) => setWinHighPts(clampNum(v, 0, 20))} width={120} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6b7280" }}>Win &lt; threshold</div>
              <Input value={String(winLowPts)} onChange={(v) => setWinLowPts(clampNum(v, 0, 20))} width={120} />
            </div>
          </div>
        </Section>

        <Section title={`Players (${players.length})`}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <Input value={newPlayerName} onChange={setNewPlayerName} placeholder="Add player name" width={260} disabled={teamActionsDisabled} />
            <Btn onClick={addPlayer} disabled={!newPlayerName.trim() || teamActionsDisabled}>
              Add player
            </Btn>
            <Btn kind="secondary" onClick={buildRandomTeams} disabled={players.length < 2 || teamActionsDisabled}>
              Randomize teams
            </Btn>
          </div>

          {teamsLocked ? (
            <div style={{ marginTop: 8, fontSize: 12, color: "#b45309", fontWeight: 900 }}>
              Teams are locked — adding/removing players is disabled (unlock teams to change players).
            </div>
          ) : null}

          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
            {players.map((p) => (
              <div key={p.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff", display: "flex", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.name}</div>
                <button
                  onClick={() => removePlayer(p.id)}
                  disabled={teamsLocked}
                  style={{ border: "none", background: "transparent", color: teamsLocked ? "#9ca3af" : "#b91c1c", fontWeight: 900, cursor: teamsLocked ? "not-allowed" : "pointer" }}
                >
                  Remove
                </button>
              </div>
            ))}
            {players.length === 0 && <div style={{ color: "#6b7280" }}>Add players to get started.</div>}
          </div>
        </Section>

        <Section title={`Teams (${realTeams.length})`} right={<div style={{ color: "#6b7280", fontSize: 12 }}>Need 16 players for 8 teams</div>}>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: 900 }}>
              <input type="checkbox" checked={manualTeamsMode} onChange={(e) => setManualTeamsMode(e.target.checked)} disabled={teamActionsDisabled} />
              Manual teams mode
            </label>

            <Btn kind="secondary" onClick={buildRandomTeams} disabled={players.length < 2 || teamActionsDisabled}>
              Randomize teams
            </Btn>

            <Btn kind="secondary" onClick={() => clearAllTeams()} disabled={teams.length === 0 || teamActionsDisabled}>
              Clear teams
            </Btn>

            {teamsLocked ? <div style={{ fontSize: 12, color: "#b45309", fontWeight: 900 }}>Locked: team changes disabled</div> : null}
          </div>

          {manualTeamsMode ? (
            <div style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 12, marginBottom: 12 }}>
              <div style={{ fontWeight: 900, marginBottom: 8 }}>Create team manually</div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>Player 1</div>
                  <Select
                    value={manualP1}
                    onChange={setManualP1}
                    disabled={teamActionsDisabled}
                    options={[
                      { value: "", label: "Select..." },
                      ...players
                        .filter((p) => !usedPlayers.has(p.id) || p.id === manualP1)
                        .map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    width={220}
                  />
                </div>

                <div>
                  <div style={{ fontSize: 12, color: "#6b7280" }}>Player 2</div>
                  <Select
                    value={manualP2}
                    onChange={setManualP2}
                    disabled={teamActionsDisabled}
                    options={[
                      { value: "", label: "Select..." },
                      ...players
                        .filter((p) => !usedPlayers.has(p.id) || p.id === manualP2)
                        .map((p) => ({ value: p.id, label: p.name })),
                    ]}
                    width={220}
                  />
                </div>

                <Btn onClick={addManualTeam} disabled={teamActionsDisabled || !manualP1 || !manualP2 || manualP1 === manualP2}>
                  Add Team
                </Btn>

                {manualP1 && manualP2 && manualP1 === manualP2 ? <div style={{ color: "#b91c1c", fontWeight: 900 }}>Pick 2 different players</div> : null}
              </div>

              <div style={{ marginTop: 8, fontSize: 12, color: "#6b7280" }}>Prevents using the same player in two teams.</div>
            </div>
          ) : null}

          {teams.length === 0 ? (
            <div style={{ color: "#6b7280" }}>Use “Manual teams mode” (Add Team) or “Randomize teams”.</div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 10 }}>
              {teams.map((t) => (
                <div key={t.id} style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12, background: "#fff" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                    <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</div>

                    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                      <button
                        onClick={() => removeTeam(t.id)}
                        disabled={teamActionsDisabled}
                        style={{
                          border: "none",
                          background: "transparent",
                          color: teamActionsDisabled ? "#9ca3af" : "#b91c1c",
                          fontWeight: 900,
                          cursor: teamActionsDisabled ? "not-allowed" : "pointer",
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  </div>

                  <div style={{ marginTop: 6, fontSize: 12, color: "#6b7280" }}>
                    {t.playerIds.map((pid) => playerById.get(pid)?.name).filter(Boolean).join(", ")}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Tournament"
          right={
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <Btn kind="primary" onClick={createPoolsRoundRobin} disabled={!tournamentReady}>
                Create 2 pools + round robin
              </Btn>
              <Btn kind="secondary" onClick={buildBracketFromPools} disabled={standingsA.length < 4 || standingsB.length < 4}>
                Create bracket
              </Btn>
            </div>
          }
        >
          {!tournamentReady ? (
            <div style={{ color: "#6b7280" }}>
              Add players until you have <b>8 teams</b> (16 players).
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
              <div>
                <h3 style={{ marginTop: 0 }}>Pool A</h3>
                <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 8 }}>
                  {poolMap.A.map((id) => teamById.get(id)?.name).filter(Boolean).join(" • ")}
                </div>

                {poolGamesA.length === 0 ? (
                  <div style={{ color: "#6b7280" }}>Create pools to see games.</div>
                ) : (
                  <>
                    {Array.from(new Set(poolGamesA.map((g) => g.round))).map((r) => (
                      <div key={r} style={{ marginBottom: 14 }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>Round {r}</div>
                        {poolGamesA
                          .filter((g) => g.round === r)
                          .map((g) => (
                            <GameCard
                              key={g.id}
                              g={g}
                              teamById={teamById}
                              onScore={(side, v) => setGameScore(g.id, side, v)}
                              onClear={() => clearGame(g.id)}
                              onToggleFast={(en) => toggleFast(g.id, en)}
                              onFastPatch={(patch) => updateFast(g.id, patch)}
                              readOnly={false}
                            />
                          ))}
                      </div>
                    ))}
                  </>
                )}

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Standings</div>
                  {standingsA.map((s, idx) => (
                    <div key={s.teamId} style={{ display: "flex", justifyContent: "space-between", background: "#fff", border: "1px solid #e5e7eb", padding: 10, borderRadius: 12, marginBottom: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          #{idx + 1} {s.name}
                        </div>
                        <div style={{ fontSize: 12, color: "#6b7280" }}>Tiebreak: {s.totalGamePoints}</div>
                      </div>
                      <div style={{ fontWeight: 900 }}>Pts: {s.matchPoints}</div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <h3 style={{ marginTop: 0 }}>Pool B</h3>
                <div style={{ color: "#6b7280", fontSize: 12, marginBottom: 8 }}>
                  {poolMap.B.map((id) => teamById.get(id)?.name).filter(Boolean).join(" • ")}
                </div>

                {poolGamesB.length === 0 ? (
                  <div style={{ color: "#6b7280" }}>Create pools to see games.</div>
                ) : (
                  <>
                    {Array.from(new Set(poolGamesB.map((g) => g.round))).map((r) => (
                      <div key={r} style={{ marginBottom: 14 }}>
                        <div style={{ fontWeight: 900, marginBottom: 6 }}>Round {r}</div>
                        {poolGamesB
                          .filter((g) => g.round === r)
                          .map((g) => (
                            <GameCard
                              key={g.id}
                              g={g}
                              teamById={teamById}
                              onScore={(side, v) => setGameScore(g.id, side, v)}
                              onClear={() => clearGame(g.id)}
                              onToggleFast={(en) => toggleFast(g.id, en)}
                              onFastPatch={(patch) => updateFast(g.id, patch)}
                              readOnly={false}
                            />
                          ))}
                      </div>
                    ))}
                  </>
                )}

                <div style={{ marginTop: 10 }}>
                  <div style={{ fontWeight: 900, marginBottom: 6 }}>Standings</div>
                  {standingsB.map((s, idx) => (
                    <div key={s.teamId} style={{ display: "flex", justifyContent: "space-between", background: "#fff", border: "1px solid #e5e7eb", padding: 10, borderRadius: 12, marginBottom: 8 }}>
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 900, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          #{idx + 1} {s.name}
                        </div>
                        <div style={{ fontSize: 12, color: "#6b7280" }}>Tiebreak: {s.totalGamePoints}</div>
                      </div>
                      <div style={{ fontWeight: 900 }}>Pts: {s.matchPoints}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </Section>

        <Section title="Bracket + Winner Board">
          {bracket.length === 0 ? (
            <div style={{ color: "#6b7280" }}>Create bracket once Pool standings have at least top 4 each.</div>
          ) : (
            <>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 12 }}>
                {bracket
                  .slice()
                  .sort((a, b) => {
                    const order = { QF: 1, SF: 2, F: 3, "3P": 4 };
                    return (order[a.round] ?? 99) - (order[b.round] ?? 99) || (a.idx ?? 0) - (b.idx ?? 0);
                  })
                  .map((m) => (
                    <div key={m.id} style={{ background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                        <div style={{ fontWeight: 900 }}>
                          {m.label} <span style={{ color: "#6b7280", fontWeight: 700 }}>({m.round})</span>
                        </div>
                        <div style={{ color: m.winnerId ? "#065f46" : "#6b7280", fontWeight: 900 }}>
                          {m.winnerId ? `Winner: ${teamById.get(m.winnerId)?.name ?? "—"}` : "Pending"}
                        </div>
                      </div>

                      <div style={{ marginTop: 8 }}>
                        <div style={{ fontWeight: 800 }}>{teamById.get(m.teamAId)?.name ?? "TBD"}</div>
                        <div style={{ fontWeight: 800 }}>{teamById.get(m.teamBId)?.name ?? "TBD"}</div>
                      </div>

                      <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "center" }}>
                        <Input value={m.scoreA} onChange={(v) => setBracketScore(m.id, "A", v)} width={90} placeholder="A pts" />
                        <span style={{ color: "#6b7280" }}>vs</span>
                        <Input value={m.scoreB} onChange={(v) => setBracketScore(m.id, "B", v)} width={90} placeholder="B pts" />
                        <button
                          onClick={() => clearBracketMatch(m.id)}
                          style={{ marginLeft: "auto", border: "none", background: "transparent", color: "#6b7280", fontWeight: 900, cursor: "pointer" }}
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  ))}
              </div>

              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
                <PodiumCard label="Champion" value={winnerBoard.champion} />
                <PodiumCard label="Runner-up" value={winnerBoard.runnerUp} />
                <PodiumCard label="3rd Place" value={winnerBoard.third} />
              </div>
            </>
          )}
        </Section>
      </>
    );
  }

  // ===== Public view (read-only)
  function PublicView() {
    return (
      <>
        <div style={{ marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 26 }}>{tournamentName}</h1>
          <div style={{ color: "#6b7280", marginTop: 4, fontWeight: 800 }}>Public View (read-only)</div>
        </div>

        <ScoreboardSection readOnly={true} />

        <Section title="Winners">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
            <PodiumCard label="Champion" value={winnerBoard.champion} />
            <PodiumCard label="Runner-up" value={winnerBoard.runnerUp} />
            <PodiumCard label="3rd Place" value={winnerBoard.third} />
          </div>
        </Section>

        <div style={{ color: "#6b7280", fontSize: 12 }}>
          Tip: Put this page on a TV/projector. (Live sync across devices requires Supabase.)
        </div>
      </>
    );
  }

  // ===== Table view (only this table; can enter score)
  function TableView() {
    const rounds = Array.from(new Set(tableGames.map((g) => g.round))).sort((a, b) => a - b);

    return (
      <>
        <div style={{ marginBottom: 10 }}>
          <h1 style={{ margin: 0, fontSize: 26 }}>{tournamentName}</h1>
          <div style={{ color: "#6b7280", marginTop: 4, fontWeight: 900 }}>Table View — Table {tableParam}</div>
        </div>

        <Section
          title="Pick your round"
          right={
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <Btn kind="secondary" onClick={() => setHash("/table", { table: String(tableParam) })}>
                Refresh
              </Btn>
            </div>
          }
        >
          {tableGames.length === 0 ? (
            <div style={{ color: "#6b7280" }}>
              No games found for Table {tableParam}. (Create pools first on Admin.)
            </div>
          ) : (
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <div style={{ fontWeight: 900 }}>Round:</div>
              <Select
                value={String(tableRound)}
                onChange={(v) => setTableRound(Number(v))}
                options={rounds.map((r) => ({ value: String(r), label: `Round ${r}` }))}
                width={160}
              />
              <div style={{ color: "#6b7280", fontWeight: 800 }}>
                Auto-picks the next incomplete round when you open this page.
              </div>
            </div>
          )}
        </Section>

        <Section title={`Your Match (Table ${tableParam})`}>
          {gameForTableRound ? (
            <GameCard
              g={gameForTableRound}
              teamById={teamById}
              onScore={(side, v) => setGameScore(gameForTableRound.id, side, v)}
              onClear={() => clearGame(gameForTableRound.id)}
              onToggleFast={(en) => toggleFast(gameForTableRound.id, en)}
              onFastPatch={(patch) => updateFast(gameForTableRound.id, patch)}
              readOnly={false}
            />
          ) : (
            <div style={{ color: "#6b7280" }}>No match loaded.</div>
          )}
        </Section>

        <Section title="Mini scoreboard (read-only)">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "separate", borderSpacing: 0 }}>
              <thead>
                <tr>
                  {["#", "Team", "Pool", "MP", "W", "L", "PF", "PA", "Diff"].map((h) => (
                    <th key={h} style={{ textAlign: "left", fontSize: 12, color: "#6b7280", padding: "10px 10px", borderBottom: "1px solid #e5e7eb", whiteSpace: "nowrap" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {scoreboard.map((r, idx) => (
                  <tr key={r.teamId} style={{ background: idx % 2 === 0 ? "#fff" : "#fafafa" }}>
                    <td style={tdStyle}>{idx + 1}</td>
                    <td style={{ ...tdStyle, fontWeight: 900 }}>{r.name}</td>
                    <td style={tdStyle}>{r.pool}</td>
                    <td style={{ ...tdStyle, fontWeight: 900 }}>{r.mp}</td>
                    <td style={tdStyle}>{r.w}</td>
                    <td style={tdStyle}>{r.l}</td>
                    <td style={tdStyle}>{r.pf}</td>
                    <td style={tdStyle}>{r.pa}</td>
                    <td style={{ ...tdStyle, fontWeight: 900, color: r.diff > 0 ? "#065f46" : r.diff < 0 ? "#b91c1c" : "#111827" }}>{r.diff}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div style={{ marginTop: 10, fontSize: 12, color: "#6b7280" }}>
            This is read-only; only your match is editable above.
          </div>
        </Section>

        <div style={{ color: "#b45309", fontSize: 12, fontWeight: 900 }}>
          Note: Until we add Supabase, scores entered here won’t automatically appear on other devices.
        </div>
      </>
    );
  }

  // ===== render page by route
  const page =
    route.path === "/public" ? (
      <PublicView />
    ) : route.path === "/table" ? (
      <TableView />
    ) : (
      <AdminView />
    );

  return (
    <div style={{ minHeight: "100vh", background: "#f3f4f6", padding: 18 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <TopNav />
        {page}
      </div>
    </div>
  );
}

function LinkRow({ label, url }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      alert("Copied link!");
    } catch {
      // ignore
    }
  }

  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center", background: "#fff", border: "1px solid #e5e7eb", borderRadius: 14, padding: 12 }}>
      <div style={{ fontWeight: 900 }}>{label}</div>
      <div style={{ color: "#6b7280", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 720 }}>
        {url}
      </div>
      <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
        <Btn kind="secondary" onClick={copy}>Copy</Btn>
        <Btn onClick={() => window.open(url, "_blank")}>Open</Btn>
      </div>
    </div>
  );
}