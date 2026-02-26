import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Coinche Table Manager (Admin + Table View) — Vite single-file
 *
 * ✅ Admin View (default):
 * - Add unlimited Players
 * - Create unlimited Teams (any size)
 * - Create unlimited Tables
 * - Assign Teams to Tables
 * - See GLOBAL scoreboard + stats
 * - See ALL hands (and delete any)
 * - Generate “Table Links” for each table (players use these)
 *
 * ✅ Table View (per table):
 * - Open via URL:  /?table=<TABLE_ID>
 * - Only shows THAT table
 * - Players enter hands and scores ONLY for that table
 * - Table-only scoreboard + stats + recent hands (delete only within table)
 *
 * ❌ No pools/brackets/scheduling/timers
 *
 * Persistence: localStorage
 */

const LS_KEY = "coinche_table_manager_admin_table_v2";

/** --- Helpers --- **/
const uid = () =>
  Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(2, 6);

function clampInt(v, fallback = 0) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function fmtDateTime(ts) {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function csvEscape(s) {
  const str = String(s ?? "");
  if (/[,"\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

const SUITS = [
  { key: "S", label: "♠ Spades" },
  { key: "H", label: "♥ Hearts" },
  { key: "D", label: "♦ Diamonds" },
  { key: "C", label: "♣ Clubs" },
];

const DEFAULT_STATE = {
  players: [],
  teams: [],
  tables: [],
  hands: [],
  settings: {
    adminName: "Admin",
  },
};

/** --- URL view resolver --- **/
function getViewFromURL() {
  const sp = new URLSearchParams(window.location.search);
  const tableId = sp.get("table");
  if (tableId) return { mode: "table", tableId };
  return { mode: "admin", tableId: null };
}

export default function App() {
  const initialView = useMemo(getViewFromURL, []);
  const [view, setView] = useState(initialView); // { mode: 'admin'|'table', tableId }

  const [state, setState] = useState(DEFAULT_STATE);

  // Load
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") setState({ ...DEFAULT_STATE, ...parsed });
      }
    } catch {
      // ignore
    }
  }, []);

  // Save
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(state));
    } catch {
      // ignore
    }
  }, [state]);

  // If URL changes (rare), re-evaluate view
  useEffect(() => {
    const onPop = () => setView(getViewFromURL());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const playersById = useMemo(() => new Map(state.players.map((p) => [p.id, p])), [state.players]);
  const teamsById = useMemo(() => new Map(state.teams.map((t) => [t.id, t])), [state.teams]);
  const tablesById = useMemo(() => new Map(state.tables.map((tb) => [tb.id, tb])), [state.tables]);

  const activeTable = useMemo(() => {
    if (view.mode !== "table") return null;
    return tablesById.get(view.tableId) || null;
  }, [view, tablesById]);

  /** --- Scoreboard computation --- **/
  function computeScoreboard(hands, teams) {
    const base = {};
    for (const t of teams) {
      base[t.id] = {
        teamId: t.id,
        name: t.name,
        pointsFor: 0,
        pointsAgainst: 0,
        net: 0,
        hands: 0,
        wins: 0,
        losses: 0,
        coinches: 0,
        capots: 0,
        belotes: 0,
      };
    }

    for (const h of hands) {
      const a = base[h.teamAId];
      const b = base[h.teamBId];
      if (!a || !b) continue;

      const aPts = clampInt(h.teamAPoints, 0);
      const bPts = clampInt(h.teamBPoints, 0);

      a.pointsFor += aPts;
      a.pointsAgainst += bPts;
      b.pointsFor += bPts;
      b.pointsAgainst += aPts;

      a.hands += 1;
      b.hands += 1;

      if (aPts > bPts) {
        a.wins += 1;
        b.losses += 1;
      } else if (bPts > aPts) {
        b.wins += 1;
        a.losses += 1;
      }

      if (h.coinche) {
        if (h.coincheTeam === "A") a.coinches += 1;
        if (h.coincheTeam === "B") b.coinches += 1;
      }
      if (h.capot) {
        if (h.capotTeam === "A") a.capots += 1;
        if (h.capotTeam === "B") b.capots += 1;
      }
      if (h.belote) {
        if (h.beloteTeam === "A") a.belotes += 1;
        if (h.beloteTeam === "B") b.belotes += 1;
      }
    }

    const arr = Object.values(base).map((x) => ({ ...x, net: x.pointsFor - x.pointsAgainst }));
    arr.sort((x, y) => {
      if (y.pointsFor !== x.pointsFor) return y.pointsFor - x.pointsFor;
      if (y.net !== x.net) return y.net - x.net;
      return (x.name || "").localeCompare(y.name || "");
    });
    return arr;
  }

  const globalScoreboard = useMemo(
    () => computeScoreboard(state.hands, state.teams),
    [state.hands, state.teams]
  );

  const globalFunnyStats = useMemo(() => buildFunnyStats(globalScoreboard), [globalScoreboard]);

  /** --- Table-specific derived --- **/
  const tableHands = useMemo(() => {
    if (view.mode !== "table" || !activeTable) return [];
    return state.hands.filter((h) => h.tableId === activeTable.id);
  }, [view, activeTable, state.hands]);

  const tableTeams = useMemo(() => {
    if (view.mode !== "table" || !activeTable) return [];
    const ids = activeTable.teamIds || [];
    return ids.map((id) => teamsById.get(id)).filter(Boolean);
  }, [view, activeTable, teamsById]);

  const tableScoreboard = useMemo(() => {
    if (view.mode !== "table" || !activeTable) return [];
    return computeScoreboard(tableHands, tableTeams);
  }, [view, activeTable, tableHands, tableTeams]);

  const tableFunnyStats = useMemo(() => buildFunnyStats(tableScoreboard), [tableScoreboard]);

  /** --- Actions: Players (Admin only) --- **/
  const [newPlayerName, setNewPlayerName] = useState("");

  function addPlayer() {
    const name = newPlayerName.trim();
    if (!name) return;
    setState((s) => ({ ...s, players: [...s.players, { id: uid(), name }] }));
    setNewPlayerName("");
  }

  function removePlayer(playerId) {
    setState((s) => {
      const players = s.players.filter((p) => p.id !== playerId);
      const teams = s.teams.map((t) => ({
        ...t,
        playerIds: t.playerIds.filter((id) => id !== playerId),
      }));
      return { ...s, players, teams };
    });
  }

  /** --- Actions: Teams (Admin only) --- **/
  const [newTeamName, setNewTeamName] = useState("");
  const [teamDraft, setTeamDraft] = useState([]);

  function toggleDraftPlayer(pid) {
    setTeamDraft((d) => (d.includes(pid) ? d.filter((x) => x !== pid) : [...d, pid]));
  }

  function createTeamFromDraft() {
    const name = newTeamName.trim() || `Team ${state.teams.length + 1}`;
    if (teamDraft.length === 0) return;

    setState((s) => ({
      ...s,
      teams: [
        ...s.teams,
        {
          id: uid(),
          name,
          playerIds: [...teamDraft],
          locked: false,
        },
      ],
    }));
    setNewTeamName("");
    setTeamDraft([]);
  }

  function removeTeam(teamId) {
    setState((s) => {
      const teams = s.teams.filter((t) => t.id !== teamId);
      const tables = s.tables.map((tb) => ({
        ...tb,
        teamIds: tb.teamIds.filter((id) => id !== teamId),
      }));
      const hands = s.hands.filter((h) => h.teamAId !== teamId && h.teamBId !== teamId);
      return { ...s, teams, tables, hands };
    });
  }

  function toggleTeamLock(teamId) {
    setState((s) => ({
      ...s,
      teams: s.teams.map((t) => (t.id === teamId ? { ...t, locked: !t.locked } : t)),
    }));
  }

  function randomizeUnlockedTeams() {
    setState((s) => {
      const unlocked = s.teams.filter((t) => !t.locked);
      if (unlocked.length === 0) return s;

      const sizes = unlocked.map((t) => t.playerIds.length);
      const poolPlayers = unlocked.flatMap((t) => t.playerIds);

      const arr = [...poolPlayers];
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
      }

      const rebuilt = [];
      let idx = 0;
      for (let i = 0; i < unlocked.length; i++) {
        const size = sizes[i];
        rebuilt.push({ ...unlocked[i], playerIds: arr.slice(idx, idx + size) });
        idx += size;
      }

      const map = new Map(rebuilt.map((t) => [t.id, t]));
      return { ...s, teams: s.teams.map((t) => map.get(t.id) || t) };
    });
  }

  /** --- Actions: Tables --- **/
  const [newTableName, setNewTableName] = useState("");

  function addTable() {
    const name = newTableName.trim() || `Table ${state.tables.length + 1}`;
    setState((s) => ({
      ...s,
      tables: [...s.tables, { id: uid(), name, teamIds: [] }],
    }));
    setNewTableName("");
  }

  function removeTable(tableId) {
    setState((s) => ({
      ...s,
      tables: s.tables.filter((t) => t.id !== tableId),
      hands: s.hands.filter((h) => h.tableId !== tableId),
    }));
  }

  function setTableTeamIds(tableId, teamIds) {
    setState((s) => ({
      ...s,
      tables: s.tables.map((tb) => (tb.id === tableId ? { ...tb, teamIds } : tb)),
    }));
  }

  /** --- Hands --- **/
  function addHand(hand) {
    setState((s) => ({ ...s, hands: [hand, ...s.hands] }));
  }

  function deleteHand(handId) {
    setState((s) => ({ ...s, hands: s.hands.filter((h) => h.id !== handId) }));
  }

  /** --- Export CSV (Admin) --- **/
  function exportCSV() {
    const lines = [];
    const header = [
      "hand_id",
      "timestamp",
      "table",
      "teamA",
      "teamB",
      "suit",
      "contract",
      "teamA_points",
      "teamB_points",
      "coinche",
      "coinche_team",
      "capot",
      "capot_team",
      "belote",
      "belote_team",
      "notes",
    ];
    lines.push(header.join(","));

    for (const h of [...state.hands].reverse()) {
      const tableName = tablesById.get(h.tableId)?.name || "";
      const teamAName = teamsById.get(h.teamAId)?.name || "";
      const teamBName = teamsById.get(h.teamBId)?.name || "";
      const suitLabel = SUITS.find((s) => s.key === h.suit)?.label || h.suit || "";
      const row = [
        h.id,
        new Date(h.ts).toISOString(),
        csvEscape(tableName),
        csvEscape(teamAName),
        csvEscape(teamBName),
        csvEscape(suitLabel),
        csvEscape(h.contract || ""),
        String(clampInt(h.teamAPoints, 0)),
        String(clampInt(h.teamBPoints, 0)),
        h.coinche ? "TRUE" : "FALSE",
        csvEscape(h.coincheTeam || ""),
        h.capot ? "TRUE" : "FALSE",
        csvEscape(h.capotTeam || ""),
        h.belote ? "TRUE" : "FALSE",
        csvEscape(h.beloteTeam || ""),
        csvEscape(h.notes || ""),
      ];
      lines.push(row.join(","));
    }

    lines.push("");
    lines.push("GLOBAL_SCOREBOARD");
    lines.push(["team", "points_for", "points_against", "net", "hands", "wins", "losses"].join(","));
    for (const s of globalScoreboard) {
      lines.push([csvEscape(s.name), s.pointsFor, s.pointsAgainst, s.net, s.hands, s.wins, s.losses].join(","));
    }

    downloadText(`coinche_tables_${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\n"));
  }

  function resetAll() {
    if (!confirm("Reset everything? This will delete players, teams, tables, and hands.")) return;
    setState(DEFAULT_STATE);
  }

  /** --- Render: Admin vs Table --- **/
  if (view.mode === "table") {
    return (
      <div style={styles.page}>
        <TableHeader
          table={activeTable}
          onGoAdmin={() => {
            // Go to admin by clearing query params
            window.history.pushState({}, "", window.location.pathname);
            setView({ mode: "admin", tableId: null });
          }}
        />

        {!activeTable ? (
          <Card title="Table not found">
            <div style={styles.muted}>
              This table link doesn’t match an existing table in this browser’s storage.
            </div>
            <div style={{ marginTop: 10, ...styles.muted }}>
              If you’re on a different device, you need to open the same deployed app instance that has the tournament
              data (Admin created tables/teams).
            </div>
          </Card>
        ) : (
          <>
            <div style={styles.grid}>
              <Card title="This Table Scoreboard">
                <ScoreboardTable scoreboard={tableScoreboard} />
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontWeight: 800, marginBottom: 6 }}>Funny stats</div>
                  {tableFunnyStats.length === 0 ? (
                    <div style={styles.muted}>Play a few hands to see stats.</div>
                  ) : (
                    <ul style={styles.list}>
                      {tableFunnyStats.map((x, idx) => (
                        <li key={idx} style={styles.listItem}>
                          <span>{x.label}</span>
                          <strong>{x.value}</strong>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card title="Hand Entry (This Table)">
                <HandEntry
                  table={activeTable}
                  teamsById={teamsById}
                  addHand={addHand}
                  disabledReason={getHandEntryDisabledReason(activeTable, teamsById)}
                />
              </Card>

              <Card title="Recent Hands (This Table)">
                <HandsList
                  hands={tableHands}
                  tablesById={tablesById}
                  teamsById={teamsById}
                  onDeleteHand={deleteHand}
                  limit={80}
                />
              </Card>
            </div>

            <Footer />
          </>
        )}
      </div>
    );
  }

  // ADMIN VIEW
  return (
    <div style={styles.page}>
      <AdminHeader onExport={exportCSV} onReset={resetAll} />

      <div style={styles.grid}>
        <Card title="Players (Admin)">
          <div style={styles.row}>
            <input
              style={styles.input}
              placeholder="Add player name…"
              value={newPlayerName}
              onChange={(e) => setNewPlayerName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addPlayer()}
            />
            <button style={styles.button} onClick={addPlayer}>
              Add
            </button>
          </div>

          <div style={{ marginTop: 10 }}>
            {state.players.length === 0 ? (
              <div style={styles.muted}>No players yet.</div>
            ) : (
              <ul style={styles.list}>
                {state.players.map((p) => (
                  <li key={p.id} style={styles.listItem}>
                    <span>{p.name}</span>
                    <button style={styles.smallDanger} onClick={() => removePlayer(p.id)}>
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Teams (Admin)">
          <div style={styles.rowBetween}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={styles.badge}>Teams: {state.teams.length}</span>
              <span style={styles.badge}>Players: {state.players.length}</span>
            </div>
            <button style={styles.button} onClick={randomizeUnlockedTeams} disabled={state.teams.length === 0}>
              Randomize Unlocked
            </button>
          </div>

          <div style={{ marginTop: 12, padding: 10, border: "1px solid #ddd", borderRadius: 10 }}>
            <div style={{ fontWeight: 800, marginBottom: 8 }}>Create a team</div>

            <div style={styles.row}>
              <input
                style={styles.input}
                placeholder={`Team name (optional)…`}
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
              />
              <button style={styles.button} onClick={createTeamFromDraft} disabled={teamDraft.length === 0}>
                Create
              </button>
            </div>

            <div style={{ marginTop: 8, ...styles.muted }}>
              Select players, then click Create. (Any team size.)
            </div>

            <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
              {state.players.map((p) => {
                const active = teamDraft.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() => toggleDraftPlayer(p.id)}
                    style={{ ...styles.pill, ...(active ? styles.pillActive : {}) }}
                  >
                    {p.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            {state.teams.length === 0 ? (
              <div style={styles.muted}>No teams yet.</div>
            ) : (
              <ul style={styles.list}>
                {state.teams.map((t) => (
                  <li key={t.id} style={{ ...styles.listItem, alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                        <strong>{t.name}</strong>
                        <span style={styles.badge}>{t.playerIds.length} players</span>
                        {t.locked ? <span style={styles.badge}>Locked</span : <span style={styles.badge}>Unlocked</span>}
                      </div>
                      <div style={{ marginTop: 6, ...styles.muted }}>
                        {t.playerIds.length === 0
                          ? "No players assigned."
                          : t.playerIds.map((id) => playersById.get(id)?.name || "Unknown").join(" · ")}
                      </div>
                    </div>

                    <div style={{ display: "flex", gap: 8 }}>
                      <button style={styles.small} onClick={() => toggleTeamLock(t.id)}>
                        {t.locked ? "Unlock" : "Lock"}
                      </button>
                      <button style={styles.smallDanger} onClick={() => removeTeam(t.id)}>
                        Delete
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Tables (Admin)">
          <div style={styles.row}>
            <input
              style={styles.input}
              placeholder="Add table name…"
              value={newTableName}
              onChange={(e) => setNewTableName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addTable()}
            />
            <button style={styles.button} onClick={addTable}>
              Add
            </button>
          </div>

          <div style={{ marginTop: 12 }}>
            {state.tables.length === 0 ? (
              <div style={styles.muted}>No tables yet.</div>
            ) : (
              <div style={{ display: "grid", gap: 10 }}>
                {state.tables.map((tb) => (
                  <TableCard
                    key={tb.id}
                    table={tb}
                    teams={state.teams}
                    teamsById={teamsById}
                    setTableTeamIds={setTableTeamIds}
                    onRemove={() => removeTable(tb.id)}
                    onOpenTableView={() => openTableViewLink(tb.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card title="Global Scoreboard (Admin)">
          <ScoreboardTable scoreboard={globalScoreboard} />

          <div style={{ marginTop: 12 }}>
            <div style={{ fontWeight: 800, marginBottom: 6 }}>Funny stats</div>
            {globalFunnyStats.length === 0 ? (
              <div style={styles.muted}>Play a few hands to see stats.</div>
            ) : (
              <ul style={styles.list}>
                {globalFunnyStats.map((x, idx) => (
                  <li key={idx} style={styles.listItem}>
                    <span>{x.label}</span>
                    <strong>{x.value}</strong>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Card>

        <Card title="Hand Entry (Admin — choose a table)">
          {state.tables.length === 0 ? (
            <div style={styles.muted}>Create a table first.</div>
          ) : (
            <div style={{ display: "grid", gap: 12 }}>
              {state.tables.map((tb) => (
                <HandEntry
                  key={tb.id}
                  table={tb}
                  teamsById={teamsById}
                  addHand={addHand}
                  disabledReason={getHandEntryDisabledReason(tb, teamsById)}
                />
              ))}
            </div>
          )}
        </Card>

        <Card title="Recent Hands (Admin — all tables)">
          <HandsList
            hands={state.hands}
            tablesById={tablesById}
            teamsById={teamsById}
            onDeleteHand={deleteHand}
            limit={120}
          />
        </Card>
      </div>

      <Footer />
    </div>
  );
}

/** --- View Helpers --- **/
function openTableViewLink(tableId) {
  const base = window.location.origin + window.location.pathname;
  const url = `${base}?table=${encodeURIComponent(tableId)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

/** --- Stats Helpers --- **/
function buildFunnyStats(scoreboard) {
  if (!scoreboard || scoreboard.length === 0) return [];
  const bestNet = [...scoreboard].sort((a, b) => b.net - a.net)[0];
  const mostWins = [...scoreboard].sort((a, b) => b.wins - a.wins)[0];
  const mostCoinches = [...scoreboard].sort((a, b) => b.coinches - a.coinches)[0];
  const mostBelotes = [...scoreboard].sort((a, b) => b.belotes - a.belotes)[0];
  const mostCapots = [...scoreboard].sort((a, b) => b.capots - a.capots)[0];

  return [
    bestNet && { label: "Best Net Points", value: `${bestNet.name} (${bestNet.net})` },
    mostWins && { label: "Most Wins", value: `${mostWins.name} (${mostWins.wins})` },
    mostCoinches && { label: "Most Coinches", value: `${mostCoinches.name} (${mostCoinches.coinches})` },
    mostBelotes && { label: "Most Belotes", value: `${mostBelotes.name} (${mostBelotes.belotes})` },
    mostCapots && { label: "Most Capots", value: `${mostCapots.name} (${mostCapots.capots})` },
  ].filter(Boolean);
}

/** --- Components --- **/
function AdminHeader({ onExport, onReset }) {
  return (
    <div style={styles.header}>
      <div>
        <div style={styles.h1}>Coinche Table Manager — Admin</div>
        <div style={styles.muted}>
          Admin sets up players/teams/tables. Players use their table link to enter hands.
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button style={styles.button} onClick={onExport}>
          Export CSV
        </button>
        <button style={styles.danger} onClick={onReset}>
          Reset All
        </button>
      </div>
    </div>
  );
}

function TableHeader({ table, onGoAdmin }) {
  return (
    <div style={styles.header}>
      <div>
        <div style={styles.h1}>Table View</div>
        <div style={styles.muted}>
          {table ? (
            <>
              You are entering hands for: <strong>{table.name}</strong>
            </>
          ) : (
            "Table not found in this browser."
          )}
        </div>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button style={styles.small} onClick={onGoAdmin}>
          Go to Admin
        </button>
      </div>
    </div>
  );
}

function Footer() {
  return (
    <div style={{ marginTop: 20, ...styles.muted }}>
      Tip: Assign at least <strong>2 teams</strong> to each table to enable hand entry.
    </div>
  );
}

function Card({ title, children }) {
  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>{title}</div>
      <div>{children}</div>
    </div>
  );
}

function ScoreboardTable({ scoreboard }) {
  if (!scoreboard || scoreboard.length === 0) {
    return <div style={styles.muted}>No team scores yet.</div>;
  }
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Team</th>
            <th style={styles.thRight}>For</th>
            <th style={styles.thRight}>Against</th>
            <th style={styles.thRight}>Net</th>
            <th style={styles.thRight}>Hands</th>
            <th style={styles.thRight}>W</th>
            <th style={styles.thRight}>L</th>
          </tr>
        </thead>
        <tbody>
          {scoreboard.map((s) => (
            <tr key={s.teamId}>
              <td style={styles.td}>{s.name}</td>
              <td style={styles.tdRight}>{s.pointsFor}</td>
              <td style={styles.tdRight}>{s.pointsAgainst}</td>
              <td style={styles.tdRight}>{s.net}</td>
              <td style={styles.tdRight}>{s.hands}</td>
              <td style={styles.tdRight}>{s.wins}</td>
              <td style={styles.tdRight}>{s.losses}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TableCard({ table, teams, teamsById, setTableTeamIds, onRemove, onOpenTableView }) {
  const selected = table.teamIds || [];
  const [open, setOpen] = useState(false);

  function toggleTeam(teamId) {
    const has = selected.includes(teamId);
    const next = has ? selected.filter((x) => x !== teamId) : [...selected, teamId];
    setTableTeamIds(table.id, next);
  }

  const teamNames = selected.slice(0, 2).map((id) => teamsById.get(id)?.name || "Unknown").join(" vs ");

  const tableLink = `${window.location.origin}${window.location.pathname}?table=${encodeURIComponent(table.id)}`;

  return (
    <div style={styles.tableCard}>
      <div style={styles.rowBetween}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong>{table.name}</strong>
            <span style={styles.badge}>
              {selected.length === 0 ? "No teams" : selected.length === 1 ? "1 team" : `${selected.length} teams`}
            </span>
            {selected.length >= 2 ? <span style={styles.badge}>{teamNames}</span> : null}
          </div>
          <div style={{ marginTop: 6, ...styles.muted }}>
            Table link (share with players):
          </div>
          <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <code style={styles.code}>{tableLink}</code>
            <button
              style={styles.small}
              onClick={() => navigator.clipboard?.writeText?.(tableLink)}
              title="Copy link"
            >
              Copy
            </button>
            <button style={styles.small} onClick={onOpenTableView}>
              Open Table View
            </button>
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button style={styles.small} onClick={() => setOpen((v) => !v)}>
            {open ? "Hide Teams" : "Assign Teams"}
          </button>
          <button style={styles.smallDanger} onClick={onRemove}>
            Delete
          </button>
        </div>
      </div>

      {open ? (
        <div style={{ marginTop: 10, display: "flex", flexWrap: "wrap", gap: 8 }}>
          {teams.length === 0 ? (
            <div style={styles.muted}>Create teams first.</div>
          ) : (
            teams.map((t) => {
              const active = selected.includes(t.id);
              return (
                <button
                  key={t.id}
                  onClick={() => toggleTeam(t.id)}
                  style={{ ...styles.pill, ...(active ? styles.pillActive : {}) }}
                >
                  {t.name}
                </button>
              );
            })
          )}
        </div>
      ) : null}

      <div style={{ marginTop: 10, ...styles.muted }}>
        Hand entry uses the <strong>first 2</strong> teams selected (Team A vs Team B). You can select more if you want,
        but only the first two are used for entry on that table.
      </div>
    </div>
  );
}

function getHandEntryDisabledReason(table, teamsById) {
  const ids = table.teamIds || [];
  if (ids.length < 2) return "Assign at least 2 teams to this table.";
  const a = teamsById.get(ids[0]);
  const b = teamsById.get(ids[1]);
  if (!a || !b) return "Team selection is invalid.";
  return "";
}

function HandEntry({ table, teamsById, addHand, disabledReason }) {
  const teamIds = table.teamIds || [];
  const teamAId = teamIds[0] || "";
  const teamBId = teamIds[1] || "";

  const teamAName = teamsById.get(teamAId)?.name || "Team A";
  const teamBName = teamsById.get(teamBId)?.name || "Team B";

  const [suit, setSuit] = useState("S");
  const [contract, setContract] = useState("");
  const [aPts, setAPts] = useState("");
  const [bPts, setBPts] = useState("");

  const [coinche, setCoinche] = useState(false);
  const [coincheTeam, setCoincheTeam] = useState("A");

  const [capot, setCapot] = useState(false);
  const [capotTeam, setCapotTeam] = useState("A");

  const [belote, setBelote] = useState(false);
  const [beloteTeam, setBeloteTeam] = useState("A");

  const [notes, setNotes] = useState("");

  const quickRef = useRef(null);

  function clearEntry() {
    setContract("");
    setAPts("");
    setBPts("");
    setCoinche(false);
    setCapot(false);
    setBelote(false);
    setNotes("");
  }

  function commitHand() {
    if (disabledReason) return;

    const hand = {
      id: uid(),
      ts: Date.now(),
      tableId: table.id,
      teamAId,
      teamBId,
      suit,
      contract: contract.trim(),
      teamAPoints: clampInt(aPts, 0),
      teamBPoints: clampInt(bPts, 0),
      coinche,
      coincheTeam: coinche ? coincheTeam : "",
      capot,
      capotTeam: capot ? capotTeam : "",
      belote,
      beloteTeam: belote ? beloteTeam : "",
      notes: notes.trim(),
    };

    addHand(hand);
    clearEntry();
    quickRef.current?.focus?.();
  }

  const disabled = Boolean(disabledReason);

  return (
    <div style={styles.entryCard}>
      <div style={styles.rowBetween}>
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <strong>{table.name}</strong>
            <span style={styles.badge}>
              {teamAName} vs {teamBName}
            </span>
          </div>
          {disabled ? <div style={{ marginTop: 6, color: "#b00020" }}>{disabledReason}</div> : null}
        </div>
        <button style={{ ...styles.button, opacity: disabled ? 0.5 : 1 }} onClick={commitHand} disabled={disabled}>
          Add Hand
        </button>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: 10 }}>
        <div>
          <div style={styles.label}>Suit</div>
          <select style={styles.select} value={suit} onChange={(e) => setSuit(e.target.value)}>
            {SUITS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ gridColumn: "span 2" }}>
          <div style={styles.label}>Contract (optional)</div>
          <input
            ref={quickRef}
            style={styles.input}
            placeholder="e.g., 80, 100, 160…"
            value={contract}
            onChange={(e) => setContract(e.target.value)}
          />
        </div>

        <div>
          <div style={styles.label}>{teamAName} points</div>
          <input style={styles.input} value={aPts} onChange={(e) => setAPts(e.target.value)} placeholder="0" />
        </div>

        <div>
          <div style={styles.label}>{teamBName} points</div>
          <input style={styles.input} value={bPts} onChange={(e) => setBPts(e.target.value)} placeholder="0" />
        </div>

        <div>
          <div style={styles.label}>Notes (optional)</div>
          <input style={styles.input} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="…" />
        </div>
      </div>

      <div style={{ marginTop: 10, display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 10 }}>
        <ToggleRow
          title="Coinche"
          enabled={coinche}
          setEnabled={setCoinche}
          team={coincheTeam}
          setTeam={setCoincheTeam}
          teamAName={teamAName}
          teamBName={teamBName}
        />
        <ToggleRow
          title="Capot"
          enabled={capot}
          setEnabled={setCapot}
          team={capotTeam}
          setTeam={setCapotTeam}
          teamAName={teamAName}
          teamBName={teamBName}
        />
        <ToggleRow
          title="Belote"
          enabled={belote}
          setEnabled={setBelote}
          team={beloteTeam}
          setTeam={setBeloteTeam}
          teamAName={teamAName}
          teamBName={teamBName}
        />
      </div>
    </div>
  );
}

function ToggleRow({ title, enabled, setEnabled, team, setTeam, teamAName, teamBName }) {
  return (
    <div style={{ padding: 10, border: "1px solid #ddd", borderRadius: 10 }}>
      <div style={styles.rowBetween}>
        <strong>{title}</strong>
        <label style={{ display: "flex", gap: 8, alignItems: "center", cursor: "pointer" }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span style={styles.muted}>On</span>
        </label>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={styles.label}>Which team?</div>
        <select style={styles.select} value={team} onChange={(e) => setTeam(e.target.value)} disabled={!enabled}>
          <option value="A">{teamAName}</option>
          <option value="B">{teamBName}</option>
        </select>
      </div>
    </div>
  );
}

function HandsList({ hands, tablesById, teamsById, onDeleteHand, limit = 80 }) {
  if (!hands || hands.length === 0) return <div style={styles.muted}>No hands recorded yet.</div>;

  return (
    <div style={{ display: "grid", gap: 10 }}>
      {hands.slice(0, limit).map((h) => {
        const tableName = tablesById.get(h.tableId)?.name || "Unknown table";
        const ta = teamsById.get(h.teamAId)?.name || "Team A";
        const tb = teamsById.get(h.teamBId)?.name || "Team B";
        const suitLabel = SUITS.find((s) => s.key === h.suit)?.label || h.suit || "—";

        return (
          <div key={h.id} style={styles.handCard}>
            <div style={styles.rowBetween}>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <strong>{tableName}</strong>
                <span style={styles.badge}>{fmtDateTime(h.ts)}</span>
                <span style={styles.badge}>{suitLabel}</span>
                {h.contract ? <span style={styles.badge}>Contract: {h.contract}</span> : null}
                {h.coinche ? <span style={styles.badge}>Coinche ({h.coincheTeam})</span> : null}
                {h.capot ? <span style={styles.badge}>Capot ({h.capotTeam})</span> : null}
                {h.belote ? <span style={styles.badge}>Belote ({h.beloteTeam})</span> : null}
              </div>
              <button style={styles.smallDanger} onClick={() => onDeleteHand(h.id)}>
                Delete
              </button>
            </div>

            <div style={{ marginTop: 8, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={styles.teamScoreBox}>
                <div style={styles.muted}>{ta}</div>
                <div style={styles.bigNumber}>{clampInt(h.teamAPoints, 0)}</div>
              </div>
              <div style={styles.teamScoreBox}>
                <div style={styles.muted}>{tb}</div>
                <div style={styles.bigNumber}>{clampInt(h.teamBPoints, 0)}</div>
              </div>
            </div>

            {h.notes ? <div style={{ marginTop: 8, ...styles.muted }}>Notes: {h.notes}</div> : null}
          </div>
        );
      })}
    </div>
  );
}

/** --- Styles --- **/
const styles = {
  page: {
    fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif",
    padding: 16,
    maxWidth: 1200,
    margin: "0 auto",
    background: "#fafafa",
    color: "#111",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    gap: 12,
    alignItems: "center",
    padding: 14,
    borderRadius: 14,
    background: "white",
    border: "1px solid #e6e6e6",
    marginBottom: 14,
  },
  h1: { fontSize: 22, fontWeight: 900, lineHeight: 1.1 },
  muted: { color: "#666", fontSize: 13 },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))",
    gap: 14,
  },
  card: {
    background: "white",
    border: "1px solid #e6e6e6",
    borderRadius: 14,
    padding: 14,
    boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
  },
  cardTitle: { fontSize: 16, fontWeight: 800, marginBottom: 10 },
  row: { display: "flex", gap: 10, alignItems: "center" },
  rowBetween: { display: "flex", gap: 10, alignItems: "center", justifyContent: "space-between" },
  input: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #ddd",
    outline: "none",
  },
  select: {
    width: "100%",
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #ddd",
    outline: "none",
    background: "white",
  },
  label: { fontSize: 12, color: "#444", marginBottom: 6, fontWeight: 700 },
  button: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "#111",
    color: "white",
    fontWeight: 800,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  small: {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #ddd",
    background: "white",
    fontWeight: 700,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  danger: {
    padding: "10px 12px",
    borderRadius: 10,
    border: "1px solid #f0b3b3",
    background: "#b00020",
    color: "white",
    fontWeight: 900,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  smallDanger: {
    padding: "8px 10px",
    borderRadius: 10,
    border: "1px solid #f0b3b3",
    background: "white",
    color: "#b00020",
    fontWeight: 800,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  badge: {
    display: "inline-flex",
    padding: "4px 8px",
    borderRadius: 999,
    border: "1px solid #ddd",
    fontSize: 12,
    color: "#333",
    background: "#fff",
  },
  code: {
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
    fontSize: 12,
    padding: "6px 8px",
    borderRadius: 10,
    border: "1px solid #eee",
    background: "#fafafa",
    overflowX: "auto",
    maxWidth: "100%",
  },
  list: { listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 },
  listItem: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    padding: 10,
    borderRadius: 12,
    border: "1px solid #eee",
    background: "#fff",
    alignItems: "center",
  },
  pill: {
    padding: "8px 10px",
    borderRadius: 999,
    border: "1px solid #ddd",
    background: "white",
    cursor: "pointer",
    fontWeight: 700,
  },
  pillActive: {
    background: "#111",
    color: "white",
    border: "1px solid #111",
  },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", borderBottom: "1px solid #eee", padding: "8px 6px", fontSize: 12, color: "#555" },
  thRight: { textAlign: "right", borderBottom: "1px solid #eee", padding: "8px 6px", fontSize: 12, color: "#555" },
  td: { borderBottom: "1px solid #f3f3f3", padding: "8px 6px", fontSize: 13 },
  tdRight: { textAlign: "right", borderBottom: "1px solid #f3f3f3", padding: "8px 6px", fontSize: 13 },
  tableCard: { padding: 12, border: "1px solid #eee", borderRadius: 14, background: "#fff" },
  entryCard: { padding: 12, border: "1px solid #eee", borderRadius: 14, background: "#fff" },
  handCard: { padding: 12, border: "1px solid #eee", borderRadius: 14, background: "#fff" },
  teamScoreBox: { padding: 10, border: "1px solid #eee", borderRadius: 12, background: "#fafafa" },
  bigNumber: { fontSize: 22, fontWeight: 900, marginTop: 2 },
};