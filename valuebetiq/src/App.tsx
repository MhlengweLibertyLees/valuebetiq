import { useState, useEffect, useCallback } from "react";

// ─── Leagues ────────────────────────────────────────────────────────────────
const LEAGUES = [
  { key: "soccer_epl", label: "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League" },
  { key: "soccer_spain_la_liga", label: "🇪🇸 La Liga" },
  { key: "soccer_germany_bundesliga", label: "🇩🇪 Bundesliga" },
  { key: "soccer_italy_serie_a", label: "🇮🇹 Serie A" },
  { key: "soccer_france_ligue_one", label: "🇫🇷 Ligue 1" },
  { key: "soccer_uefa_champs_league", label: "🌍 Champions League" },
  { key: "soccer_south_africa_premier_division", label: "🇿🇦 PSL" },
];

// ─── Math helpers ────────────────────────────────────────────────────────────
const avg = (arr) => {
  const c = arr.filter((v) => v != null && !isNaN(v));
  return c.length ? c.reduce((a, b) => a + b, 0) / c.length : null;
};

function removeMargin(oddsArr) {
  const imp = oddsArr.map((o) => 1 / o);
  const tot = imp.reduce((a, b) => a + b, 0);
  return imp.map((p) => (p / tot) * 100);
}

function calcEV(trueProb, odds) {
  if (!odds || !trueProb) return null;
  return (trueProb / 100) * odds - 1;
}

function calcKelly(trueProb, odds) {
  if (!odds || !trueProb) return 0;
  const p = trueProb / 100,
    b = odds - 1;
  return Math.max(0, ((b * p - (1 - p)) / b) * 25);
}

// ─── Poisson / First-10 model ────────────────────────────────────────────────
function poisson(lambda, k) {
  let r = Math.exp(-lambda);
  for (let i = 0; i < k; i++) r *= lambda / (i + 1);
  return r;
}

function estimateXG(totals) {
  const o25 = totals.find((t) => t.name === "Over" && t.point === 2.5);
  const u25 = totals.find((t) => t.name === "Under" && t.point === 2.5);
  if (!o25 && !u25) return 2.5;
  const oi = o25 ? 1 / o25.avgOdds : 0.5;
  const ui = u25 ? 1 / u25.avgOdds : 0.5;
  const trueOver = oi / (oi + ui);
  let lo = 0.1,
    hi = 8,
    lam = 2.5;
  for (let i = 0; i < 40; i++) {
    lam = (lo + hi) / 2;
    const p = 1 - (poisson(lam, 0) + poisson(lam, 1) + poisson(lam, 2));
    if (p < trueOver) lo = lam;
    else hi = lam;
  }
  return lam;
}

function calcFirst10(totals, homeProb, awayProb, drawProb) {
  const lam90 = estimateXG(totals);
  const lam10 = lam90 / 9;
  const tot = homeProb + awayProb + (drawProb || 0);
  const homeLam = lam10 * (homeProb / tot) * 1.08;
  const awayLam = lam10 * (awayProb / tot) * 0.95;
  const pH = 1 - poisson(homeLam, 0);
  const pA = 1 - poisson(awayLam, 0);
  const pGoal = 1 - poisson(lam10, 0);
  const pNoGoal = 1 - pGoal;
  const fo = (p) => (p > 0 ? (1 / p).toFixed(2) : "—");
  return {
    xg90: lam90.toFixed(2),
    xg10: lam10.toFixed(3),
    pGoal: +(pGoal * 100).toFixed(1),
    pNoGoal: +(pNoGoal * 100).toFixed(1),
    pHome: +(pH * 100).toFixed(1),
    pAway: +(pA * 100).toFixed(1),
    pBoth: +(pH * pA * 100).toFixed(1),
    pHomeOnly: +(pH * (1 - pA) * 100).toFixed(1),
    pAwayOnly: +((1 - pH) * pA * 100).toFixed(1),
    foGoal: fo(pGoal),
    foNoGoal: fo(pNoGoal),
    foHome: fo(pH),
    foAway: fo(pA),
  };
}

// ─── Build match from API game object ────────────────────────────────────────
function buildMatch(game) {
  try {
    const bks = game.bookmakers || [];
    if (!bks.length) return null;

    const h2hMkts = bks
      .map((b) => b.markets?.find((m) => m.key === "h2h"))
      .filter(Boolean);
    if (!h2hMkts.length) return null;

    const pick = (mkt, name) =>
      mkt.outcomes?.find((o) => o.name === name)?.price;

    const homeOdds = avg(h2hMkts.map((m) => pick(m, game.home_team)));
    const awayOdds = avg(h2hMkts.map((m) => pick(m, game.away_team)));
    const drawOdds = avg(h2hMkts.map((m) => pick(m, "Draw")));
    if (!homeOdds || !awayOdds) return null;

    const [homeProb, awayProb, drawProb] = removeMargin([
      homeOdds,
      awayOdds,
      ...(drawOdds ? [drawOdds] : []),
    ]);

    // totals
    const totMkts = bks
      .map((b) => b.markets?.find((m) => m.key === "totals"))
      .filter(Boolean);
    const tMap = {};
    totMkts.forEach((mkt) =>
      (mkt.outcomes || []).forEach((o) => {
        const k = `${o.name}_${o.point}`;
        if (!tMap[k]) tMap[k] = { name: o.name, point: o.point, prices: [] };
        tMap[k].prices.push(o.price);
      })
    );
    const totals = Object.values(tMap).map((t) => ({
      name: t.name,
      point: t.point,
      avgOdds: avg(t.prices),
    }));

    const bookmakers = h2hMkts.map((mkt, i) => ({
      title: bks[i]?.title || "–",
      home: pick(mkt, game.home_team),
      draw: pick(mkt, "Draw"),
      away: pick(mkt, game.away_team),
    }));

    return {
      id: game.id,
      homeTeam: game.home_team,
      awayTeam: game.away_team,
      commenceTime: game.commence_time,
      homeOdds,
      awayOdds,
      drawOdds: drawOdds || null,
      homeProb: +homeProb.toFixed(1),
      awayProb: +awayProb.toFixed(1),
      drawProb: drawProb ? +drawProb.toFixed(1) : null,
      totals,
      bookmakers,
    };
  } catch (e) {
    return null;
  }
}

// ─── Tiny UI components ──────────────────────────────────────────────────────
const MN = { fontFamily: "monospace" };

function Pill({ children, color = "0,180,255" }) {
  return (
    <span
      style={{
        fontSize: 10,
        padding: "2px 8px",
        borderRadius: 4,
        fontFamily: "monospace",
        background: `rgba(${color},.12)`,
        color: `rgb(${color})`,
        border: `1px solid rgba(${color},.28)`,
      }}
    >
      {children}
    </span>
  );
}

function Bar({ pct, color = "0,255,128" }) {
  return (
    <div
      style={{
        height: 4,
        background: "rgba(255,255,255,.06)",
        borderRadius: 2,
        overflow: "hidden",
        marginTop: 4,
      }}
    >
      <div
        style={{
          height: "100%",
          width: `${Math.min(pct, 100)}%`,
          background: `rgb(${color})`,
          borderRadius: 2,
          transition: "width .5s",
        }}
      />
    </div>
  );
}

function Card({ children, glow }) {
  return (
    <div
      style={{
        background: "rgba(0,0,0,.22)",
        borderRadius: 10,
        padding: 14,
        marginBottom: 10,
        ...(glow
          ? { border: "1px solid rgba(0,255,128,.15)" }
          : { border: "1px solid rgba(255,255,255,.06)" }),
      }}
    >
      {children}
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div
      style={{
        fontSize: 10,
        color: "#00ccff",
        letterSpacing: 2,
        marginBottom: 12,
        fontFamily: "monospace",
      }}
    >
      {children}
    </div>
  );
}

function StatBox({ label, value, sub, color = "#ccd8ee", accent }) {
  return (
    <div
      style={{
        background: accent ? "rgba(0,255,128,.06)" : "rgba(255,255,255,.03)",
        border: `1px solid ${
          accent ? "rgba(0,255,128,.2)" : "rgba(255,255,255,.07)"
        }`,
        borderRadius: 8,
        padding: "12px 8px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          fontSize: 9,
          color: "#667788",
          marginBottom: 4,
          fontFamily: "monospace",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 22,
          fontWeight: 700,
          color,
          fontFamily: "monospace",
        }}
      >
        {value}
      </div>
      {sub && (
        <div
          style={{
            fontSize: 10,
            color: "#445566",
            fontFamily: "monospace",
            marginTop: 4,
          }}
        >
          {sub}
        </div>
      )}
    </div>
  );
}

function TabBtn({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: active ? "rgba(0,204,255,.12)" : "rgba(255,255,255,.03)",
        border: `1px solid ${
          active ? "rgba(0,204,255,.3)" : "rgba(255,255,255,.07)"
        }`,
        borderRadius: 6,
        padding: "6px 14px",
        color: active ? "#00ccff" : "#556677",
        fontSize: 11,
        fontFamily: "monospace",
        cursor: "pointer",
        transition: "all .15s",
      }}
    >
      {label}
    </button>
  );
}

// ─── Markets Tab ─────────────────────────────────────────────────────────────
function MarketsTab({ match, bankroll }) {
  const {
    homeTeam,
    awayTeam,
    homeOdds,
    drawOdds,
    awayOdds,
    homeProb,
    drawProb,
    awayProb,
    totals,
    bookmakers,
  } = match;

  const outcomes = [
    {
      label: homeTeam,
      odds: homeOdds,
      prob: homeProb,
      ev: calcEV(homeProb, homeOdds),
    },
    ...(drawOdds
      ? [
          {
            label: "Draw",
            odds: drawOdds,
            prob: drawProb,
            ev: calcEV(drawProb, drawOdds),
          },
        ]
      : []),
    {
      label: awayTeam,
      odds: awayOdds,
      prob: awayProb,
      ev: calcEV(awayProb, awayOdds),
    },
  ];

  const f10 = calcFirst10(totals, homeProb, awayProb, drawProb);
  const lines = [0.5, 1.5, 2.5, 3.5, 4.5];
  const hasTot = totals.length > 0;

  // Double chance probs
  const dc = [
    { label: `1X — ${homeTeam} or Draw`, prob: homeProb + (drawProb || 0) },
    { label: `12 — ${homeTeam} or ${awayTeam}`, prob: homeProb + awayProb },
    { label: `X2 — Draw or ${awayTeam}`, prob: awayProb + (drawProb || 0) },
  ];

  return (
    <div>
      {/* ── 1X2 ── */}
      <Card>
        <SectionTitle>⚽ MATCH RESULT (1X2)</SectionTitle>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${outcomes.length},1fr)`,
            gap: 8,
          }}
        >
          {outcomes.map((o, i) => {
            const val = o.ev > 0.05;
            const kelly = calcKelly(o.prob, o.odds);
            return (
              <div
                key={i}
                style={{
                  background: val
                    ? "rgba(0,255,128,.07)"
                    : "rgba(255,255,255,.03)",
                  border: `1px solid ${
                    val ? "rgba(0,255,128,.22)" : "rgba(255,255,255,.07)"
                  }`,
                  borderRadius: 8,
                  padding: "12px 8px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    color: "#667788",
                    marginBottom: 4,
                    ...MN,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {o.label}
                </div>
                <div
                  style={{
                    fontSize: 22,
                    fontWeight: 700,
                    color: val ? "#00ff80" : "#e8f0ff",
                    ...MN,
                  }}
                >
                  {o.odds?.toFixed(2)}
                </div>
                <Bar pct={o.prob} color={val ? "0,255,128" : "80,130,200"} />
                <div
                  style={{
                    fontSize: 10,
                    color: "#8899aa",
                    marginTop: 4,
                    ...MN,
                  }}
                >
                  {o.prob?.toFixed(1)}% true
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    marginTop: 2,
                    ...MN,
                    color: val ? "#00ff80" : o.ev > 0 ? "#ffc800" : "#ff5555",
                  }}
                >
                  {o.ev != null
                    ? `${o.ev > 0 ? "+" : ""}${(o.ev * 100).toFixed(1)}% EV`
                    : ""}
                </div>
                {val && (
                  <div
                    style={{
                      fontSize: 9,
                      color: "#334455",
                      marginTop: 3,
                      ...MN,
                    }}
                  >
                    💰 R{((kelly / 100) * bankroll).toFixed(2)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Double Chance ── */}
      <Card>
        <SectionTitle>🎲 DOUBLE CHANCE</SectionTitle>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
          }}
        >
          {dc.map((d, i) => (
            <div
              key={i}
              style={{
                background: "rgba(255,255,255,.03)",
                border: "1px solid rgba(255,255,255,.07)",
                borderRadius: 8,
                padding: "10px 8px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  color: "#556677",
                  marginBottom: 5,
                  ...MN,
                  lineHeight: 1.5,
                }}
              >
                {d.label}
              </div>
              <div
                style={{
                  fontSize: 20,
                  fontWeight: 700,
                  color: d.prob > 65 ? "#00ff80" : "#ccd8ee",
                  ...MN,
                }}
              >
                {d.prob.toFixed(1)}%
              </div>
              <Bar
                pct={d.prob}
                color={d.prob > 65 ? "0,255,128" : "80,130,200"}
              />
            </div>
          ))}
        </div>
      </Card>

      {/* ── First 10 Minutes ── */}
      <Card glow>
        <SectionTitle>⏱ FIRST 10 MINUTES — Poisson Model</SectionTitle>
        <div
          style={{
            fontSize: 10,
            color: "#334455",
            ...MN,
            marginBottom: 14,
            padding: "6px 10px",
            background: "rgba(255,255,255,.02)",
            borderRadius: 6,
            lineHeight: 1.8,
          }}
        >
          xG/90min ≈ <span style={{ color: "#00ccff" }}>{f10.xg90}</span>{" "}
          &nbsp;·&nbsp; xG/10min ≈{" "}
          <span style={{ color: "#00ccff" }}>{f10.xg10}</span>
        </div>

        {/* Goal / No Goal */}
        <div
          style={{
            fontSize: 10,
            color: "#667788",
            ...MN,
            letterSpacing: 1,
            marginBottom: 8,
          }}
        >
          GOAL BEFORE 10:00?
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginBottom: 14,
          }}
        >
          {[
            { label: "⚽ Goal scored", prob: f10.pGoal, odds: f10.foGoal },
            { label: "🚫 No goal", prob: f10.pNoGoal, odds: f10.foNoGoal },
          ].map((o, i) => (
            <div
              key={i}
              style={{
                background:
                  o.prob > 50 ? "rgba(0,255,128,.06)" : "rgba(255,255,255,.03)",
                border: `1px solid ${
                  o.prob > 50 ? "rgba(0,255,128,.2)" : "rgba(255,255,255,.07)"
                }`,
                borderRadius: 8,
                padding: "12px 10px",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "#667788",
                  ...MN,
                  marginBottom: 4,
                }}
              >
                {o.label}
              </div>
              <div
                style={{
                  fontSize: 26,
                  fontWeight: 700,
                  fontFamily: "monospace",
                  color: o.prob > 50 ? "#00ff80" : "#ccd8ee",
                }}
              >
                {o.prob}%
              </div>
              <Bar
                pct={o.prob}
                color={o.prob > 50 ? "0,255,128" : "80,130,200"}
              />
              <div
                style={{ fontSize: 10, color: "#445566", ...MN, marginTop: 6 }}
              >
                Fair odds: <span style={{ color: "#ccd8ee" }}>{o.odds}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Which team scores first */}
        <div
          style={{
            fontSize: 10,
            color: "#667788",
            ...MN,
            letterSpacing: 1,
            marginBottom: 8,
          }}
        >
          FIRST GOAL — WHICH TEAM?
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            marginBottom: 14,
          }}
        >
          {[
            { label: `🏠 ${homeTeam}`, prob: f10.pHome, odds: f10.foHome },
            { label: `✈️ ${awayTeam}`, prob: f10.pAway, odds: f10.foAway },
          ].map((o, i) => {
            const best = f10.pHome >= f10.pAway ? 0 : 1;
            const top = i === best;
            return (
              <div
                key={i}
                style={{
                  background: top
                    ? "rgba(0,255,128,.06)"
                    : "rgba(255,255,255,.03)",
                  border: `1px solid ${
                    top ? "rgba(0,255,128,.2)" : "rgba(255,255,255,.07)"
                  }`,
                  borderRadius: 8,
                  padding: "12px 10px",
                  textAlign: "center",
                }}
              >
                <div
                  style={{
                    fontSize: 9,
                    color: "#667788",
                    ...MN,
                    marginBottom: 4,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {o.label}
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    fontFamily: "monospace",
                    color: top ? "#00ff80" : "#ccd8ee",
                  }}
                >
                  {o.prob}%
                </div>
                <Bar pct={o.prob} color={top ? "0,255,128" : "80,130,200"} />
                <div
                  style={{
                    fontSize: 10,
                    color: "#445566",
                    ...MN,
                    marginTop: 6,
                  }}
                >
                  Fair odds: <span style={{ color: "#ccd8ee" }}>{o.odds}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Scenario breakdown */}
        <div
          style={{
            background: "rgba(0,0,0,.2)",
            borderRadius: 8,
            padding: "10px 14px",
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "#667788",
              ...MN,
              letterSpacing: 1,
              marginBottom: 10,
            }}
          >
            SCENARIO BREAKDOWN
          </div>
          {[
            {
              label: `🏠 ${homeTeam} scores only`,
              prob: f10.pHomeOnly,
              c: "0,200,120",
            },
            {
              label: `✈️ ${awayTeam} scores only`,
              prob: f10.pAwayOnly,
              c: "100,160,255",
            },
            { label: "⚽ Both teams score", prob: f10.pBoth, c: "255,200,0" },
            {
              label: "🚫 No goal (0–0 at 10')",
              prob: f10.pNoGoal,
              c: "100,120,140",
            },
          ].map((s, i) => (
            <div key={i} style={{ marginBottom: 9 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  ...MN,
                  marginBottom: 3,
                }}
              >
                <span style={{ color: "#8899aa" }}>{s.label}</span>
                <span style={{ color: `rgb(${s.c})`, fontWeight: 700 }}>
                  {s.prob}%
                </span>
              </div>
              <Bar pct={s.prob} color={s.c} />
            </div>
          ))}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "#2a3444",
            ...MN,
            marginTop: 10,
            lineHeight: 1.7,
          }}
        >
          ℹ Model uses Poisson distribution on consensus xG. Compare fair odds
          vs bookmaker to find value.
        </div>
      </Card>

      {/* ── Total Goals ── */}
      {hasTot && (
        <Card>
          <SectionTitle>🎯 TOTAL GOALS — OVER / UNDER</SectionTitle>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: 12,
              ...MN,
            }}
          >
            <thead>
              <tr
                style={{
                  color: "#445566",
                  borderBottom: "1px solid rgba(255,255,255,.07)",
                }}
              >
                {["Line", "Over", "Under", "Over Prob", "Tip"].map((h, i) => (
                  <td
                    key={i}
                    style={{
                      padding: "5px 7px",
                      textAlign: i > 0 ? "center" : "left",
                      paddingBottom: 9,
                    }}
                  >
                    {h}
                  </td>
                ))}
              </tr>
            </thead>
            <tbody>
              {lines
                .map((line) => {
                  const ov = totals.find(
                    (t) => t.name === "Over" && t.point === line
                  );
                  const un = totals.find(
                    (t) => t.name === "Under" && t.point === line
                  );
                  if (!ov && !un) return null;
                  const oi = ov ? 1 / ov.avgOdds : 0;
                  const ui = un ? 1 / un.avgOdds : 0;
                  const tOv = (oi / (oi + ui || 1)) * 100;
                  const good = tOv > 55;
                  return (
                    <tr
                      key={line}
                      style={{
                        borderBottom: "1px solid rgba(255,255,255,.03)",
                      }}
                    >
                      <td
                        style={{
                          padding: "7px 7px",
                          color: "#e8f0ff",
                          fontWeight: 600,
                        }}
                      >
                        Goals {line}
                      </td>
                      <td
                        style={{
                          padding: "7px 7px",
                          textAlign: "center",
                          color: good ? "#00ff80" : "#ccd8ee",
                          fontWeight: good ? 700 : 400,
                        }}
                      >
                        {ov?.avgOdds?.toFixed(2) ?? "—"}
                      </td>
                      <td
                        style={{
                          padding: "7px 7px",
                          textAlign: "center",
                          color: "#8899aa",
                        }}
                      >
                        {un?.avgOdds?.toFixed(2) ?? "—"}
                      </td>
                      <td
                        style={{
                          padding: "7px 7px",
                          textAlign: "center",
                          color:
                            tOv > 55
                              ? "#00ff80"
                              : tOv < 45
                              ? "#ff5555"
                              : "#ffc800",
                        }}
                      >
                        {tOv.toFixed(0)}%
                      </td>
                      <td style={{ padding: "7px 7px", textAlign: "center" }}>
                        <Pill
                          color={
                            tOv > 55
                              ? "0,255,128"
                              : tOv < 45
                              ? "255,80,80"
                              : "255,200,0"
                          }
                        >
                          {tOv > 55
                            ? `Over ${line} ✓`
                            : tOv < 45
                            ? `Under ${line} ✓`
                            : "Even"}
                        </Pill>
                      </td>
                    </tr>
                  );
                })
                .filter(Boolean)}
            </tbody>
          </table>
        </Card>
      )}

      {/* ── Bookmaker Comparison ── */}
      {bookmakers.length > 1 && (
        <Card>
          <SectionTitle>📊 BOOKMAKER COMPARISON — 🟢 best odds</SectionTitle>
          <div style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: 11,
                ...MN,
              }}
            >
              <thead>
                <tr
                  style={{
                    color: "#445566",
                    borderBottom: "1px solid rgba(255,255,255,.07)",
                  }}
                >
                  <td style={{ padding: "5px 8px" }}>Bookmaker</td>
                  <td style={{ padding: "5px 8px", textAlign: "center" }}>
                    {homeTeam}
                  </td>
                  {drawOdds && (
                    <td style={{ padding: "5px 8px", textAlign: "center" }}>
                      Draw
                    </td>
                  )}
                  <td style={{ padding: "5px 8px", textAlign: "center" }}>
                    {awayTeam}
                  </td>
                </tr>
              </thead>
              <tbody>
                {bookmakers.map((b, i) => {
                  const bH = Math.max(...bookmakers.map((x) => x.home || 0));
                  const bA = Math.max(...bookmakers.map((x) => x.away || 0));
                  return (
                    <tr
                      key={i}
                      style={{
                        borderBottom: "1px solid rgba(255,255,255,.03)",
                        color: "#8899aa",
                      }}
                    >
                      <td style={{ padding: "6px 8px", color: "#ccd8ee" }}>
                        {b.title}
                      </td>
                      <td
                        style={{
                          padding: "6px 8px",
                          textAlign: "center",
                          color: b.home === bH ? "#00ff80" : "#8899aa",
                          fontWeight: b.home === bH ? 700 : 400,
                        }}
                      >
                        {b.home?.toFixed(2) ?? "—"}
                      </td>
                      {drawOdds && (
                        <td style={{ padding: "6px 8px", textAlign: "center" }}>
                          {b.draw?.toFixed(2) ?? "—"}
                        </td>
                      )}
                      <td
                        style={{
                          padding: "6px 8px",
                          textAlign: "center",
                          color: b.away === bA ? "#00ff80" : "#8899aa",
                          fontWeight: b.away === bA ? 700 : 400,
                        }}
                      >
                        {b.away?.toFixed(2) ?? "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

// ─── Summary / Prediction Tab ─────────────────────────────────────────────────
function SummaryTab({ match, bankroll }) {
  const {
    homeTeam,
    awayTeam,
    homeOdds,
    drawOdds,
    awayOdds,
    homeProb,
    drawProb,
    awayProb,
    totals,
  } = match;

  const outcomes = [
    {
      label: homeTeam,
      odds: homeOdds,
      prob: homeProb,
      ev: calcEV(homeProb, homeOdds),
    },
    ...(drawOdds
      ? [
          {
            label: "Draw",
            odds: drawOdds,
            prob: drawProb,
            ev: calcEV(drawProb, drawOdds),
          },
        ]
      : []),
    {
      label: awayTeam,
      odds: awayOdds,
      prob: awayProb,
      ev: calcEV(awayProb, awayOdds),
    },
  ];
  const best = outcomes.reduce((a, b) => (a.prob > b.prob ? a : b));
  const valBet = outcomes
    .filter((o) => o.ev > 0.05)
    .sort((a, b) => b.ev - a.ev)[0];
  const f10 = calcFirst10(totals, homeProb, awayProb, drawProb);
  const o25 = totals.find((t) => t.name === "Over" && t.point === 2.5);
  const u25 = totals.find((t) => t.name === "Under" && t.point === 2.5);
  const oi = o25 ? 1 / o25.avgOdds : 0;
  const ui = u25 ? 1 / u25.avgOdds : 0;
  const tOver = o25 || u25 ? (oi / (oi + ui)) * 100 : null;
  const confidence =
    best.prob >= 60 ? "High" : best.prob >= 50 ? "Medium" : "Low";
  const confColor =
    best.prob >= 60
      ? "0,255,128"
      : best.prob >= 50
      ? "255,200,0"
      : "255,100,100";

  const tips = [];
  if (valBet)
    tips.push({
      icon: "⚡",
      text: `Value bet: ${valBet.label} at ${valBet.odds?.toFixed(2)} (+${(
        valBet.ev * 100
      ).toFixed(1)}% EV)`,
      c: "0,255,128",
    });
  if (tOver > 60)
    tips.push({
      icon: "⬆️",
      text: `High scoring likely — Over 2.5 has ${tOver.toFixed(
        0
      )}% true probability`,
      c: "0,200,255",
    });
  if (tOver < 40)
    tips.push({
      icon: "⬇️",
      text: `Low scoring — Under 2.5 looks strong at ${(100 - tOver).toFixed(
        0
      )}%`,
      c: "255,200,0",
    });
  if (f10.pGoal > 30)
    tips.push({
      icon: "⏱",
      text: `Early goal likely — ${f10.pGoal}% chance in first 10 mins`,
      c: "255,180,0",
    });
  if (best.prob > 65)
    tips.push({
      icon: "🎯",
      text: `Strong favourite: ${best.label} at ${best.prob}% probability`,
      c: "0,255,128",
    });
  if (!valBet)
    tips.push({
      icon: "⚠️",
      text: "No value bet found — bookmakers have priced this match correctly",
      c: "255,100,100",
    });

  return (
    <div>
      {/* Confidence */}
      <Card glow>
        <SectionTitle>🧠 AI PREDICTION SUMMARY</SectionTitle>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 10,
            marginBottom: 14,
          }}
        >
          <StatBox
            label="Most Likely"
            value={best.label}
            color={`rgb(${confColor})`}
            accent
          />
          <StatBox
            label="Win Probability"
            value={`${best.prob}%`}
            color={`rgb(${confColor})`}
          />
          <StatBox
            label="Confidence"
            value={confidence}
            color={`rgb(${confColor})`}
          />
        </div>
        <div
          style={{
            background: "rgba(0,0,0,.2)",
            borderRadius: 8,
            padding: "10px 14px",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "#667788",
              ...MN,
              letterSpacing: 1,
              marginBottom: 10,
            }}
          >
            PROBABILITY BREAKDOWN
          </div>
          {outcomes.map((o, i) => (
            <div key={i} style={{ marginBottom: 9 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 11,
                  ...MN,
                  marginBottom: 3,
                }}
              >
                <span style={{ color: "#aabbcc" }}>{o.label}</span>
                <span style={{ color: "#e8f0ff", fontWeight: 700 }}>
                  {o.prob?.toFixed(1)}%
                </span>
              </div>
              <Bar
                pct={o.prob}
                color={o.prob === best.prob ? "0,255,128" : "80,130,200"}
              />
            </div>
          ))}
        </div>
        {tips.length > 0 && (
          <div>
            <div
              style={{
                fontSize: 10,
                color: "#667788",
                ...MN,
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              ANALYST TIPS
            </div>
            {tips.map((t, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  gap: 10,
                  padding: "8px 12px",
                  background: `rgba(${t.c},.05)`,
                  border: `1px solid rgba(${t.c},.15)`,
                  borderRadius: 7,
                  marginBottom: 6,
                }}
              >
                <span>{t.icon}</span>
                <span style={{ fontSize: 12, color: `rgb(${t.c})`, ...MN }}>
                  {t.text}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Quick stats */}
      <Card>
        <SectionTitle>📌 KEY NUMBERS AT A GLANCE</SectionTitle>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: 8,
          }}
        >
          <StatBox
            label="Best Odds"
            value={outcomes.reduce((a, b) => (a.odds > b.odds ? a : b)).label}
            sub={outcomes
              .reduce((a, b) => (a.odds > b.odds ? a : b))
              .odds?.toFixed(2)}
          />
          <StatBox label="xG / 90min" value={f10.xg90} color="#00ccff" />
          <StatBox
            label="Goal in 10'"
            value={`${f10.pGoal}%`}
            color="#ffc800"
          />
          {tOver != null && (
            <>
              <StatBox
                label="Over 2.5 Prob"
                value={`${tOver.toFixed(0)}%`}
                color={tOver > 55 ? "#00ff80" : "#ff8844"}
              />
              <StatBox
                label="Under 2.5 Prob"
                value={`${(100 - tOver).toFixed(0)}%`}
                color={100 - tOver > 55 ? "#00ff80" : "#ff8844"}
              />
            </>
          )}
          {valBet && (
            <StatBox
              label="Value EV"
              value={`+${(valBet.ev * 100).toFixed(1)}%`}
              sub={`Stake R${(
                (calcKelly(valBet.prob, valBet.odds) / 100) *
                bankroll
              ).toFixed(2)}`}
              color="#00ff80"
              accent
            />
          )}
        </div>
      </Card>
    </div>
  );
}

// ─── Match Card ──────────────────────────────────────────────────────────────
function MatchCard({ match, bankroll }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("summary");

  const {
    homeTeam,
    awayTeam,
    homeOdds,
    drawOdds,
    awayOdds,
    homeProb,
    drawProb,
    awayProb,
    commenceTime,
  } = match;

  const evH = calcEV(homeProb, homeOdds);
  const evA = calcEV(awayProb, awayOdds);
  const evD = drawOdds ? calcEV(drawProb, drawOdds) : null;
  const bestEV = Math.max(evH ?? -999, evA ?? -999, evD ?? -999);
  const hasVal = bestEV > 0.05;

  const maxP = Math.max(homeProb, drawProb ?? 0, awayProb);
  const pred =
    maxP === homeProb
      ? { label: homeTeam, prob: homeProb }
      : drawProb && maxP === drawProb
      ? { label: "Draw", prob: drawProb }
      : { label: awayTeam, prob: awayProb };

  const time = new Date(commenceTime).toLocaleString("en-ZA", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  const miniOdds = [
    { l: "1", o: homeOdds, p: homeProb, ev: evH },
    ...(drawOdds ? [{ l: "X", o: drawOdds, p: drawProb, ev: evD }] : []),
    { l: "2", o: awayOdds, p: awayProb, ev: evA },
  ];

  return (
    <div
      style={{
        background: hasVal ? "rgba(0,255,128,.035)" : "rgba(255,255,255,.025)",
        border: `1px solid ${
          hasVal ? "rgba(0,255,128,.2)" : "rgba(255,255,255,.07)"
        }`,
        borderRadius: 12,
        padding: "14px 18px",
        marginBottom: 10,
        position: "relative",
      }}
    >
      {hasVal && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            background:
              "linear-gradient(90deg,transparent,#00ff80,transparent)",
            borderRadius: "12px 12px 0 0",
          }}
        />
      )}

      {/* Clickable header */}
      <div
        onClick={() => setOpen((o) => !o)}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 10,
          }}
        >
          <div>
            <div
              style={{
                display: "flex",
                gap: 7,
                marginBottom: 5,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 10, color: "#445566", ...MN }}>
                {time}
              </span>
              {hasVal && (
                <Pill color="0,255,128">
                  ⚡ +{(bestEV * 100).toFixed(1)}% EV
                </Pill>
              )}
            </div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "#e8f0ff" }}>
              {homeTeam}{" "}
              <span style={{ color: "#334455", fontWeight: 400 }}>vs</span>{" "}
              {awayTeam}
            </div>
          </div>
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "flex-end",
              gap: 5,
            }}
          >
            <span
              style={{
                fontSize: 12,
                padding: "4px 10px",
                borderRadius: 5,
                ...MN,
                fontWeight: 700,
                background:
                  pred.prob >= 55
                    ? "rgba(0,255,128,.1)"
                    : "rgba(255,200,0,.08)",
                color: pred.prob >= 55 ? "#00ff80" : "#ffc800",
                border: `1px solid ${
                  pred.prob >= 55
                    ? "rgba(0,255,128,.25)"
                    : "rgba(255,200,0,.18)"
                }`,
              }}
            >
              🎯 {pred.label} · {pred.prob}%
            </span>
            <span style={{ fontSize: 10, color: "#334455", ...MN }}>
              {open ? "▲ less" : "▼ analyse"}
            </span>
          </div>
        </div>

        {/* Mini odds */}
        <div style={{ display: "flex", gap: 6 }}>
          {miniOdds.map((x, i) => (
            <div
              key={i}
              style={{
                flex: 1,
                background:
                  x.ev > 0.05 ? "rgba(0,255,128,.07)" : "rgba(255,255,255,.03)",
                border: `1px solid ${
                  x.ev > 0.05 ? "rgba(0,255,128,.2)" : "rgba(255,255,255,.06)"
                }`,
                borderRadius: 7,
                padding: "6px 4px",
                textAlign: "center",
              }}
            >
              <div style={{ fontSize: 9, color: "#556677", ...MN }}>{x.l}</div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: x.ev > 0.05 ? "#00ff80" : "#ccd8ee",
                  ...MN,
                }}
              >
                {x.o?.toFixed(2)}
              </div>
              <div style={{ fontSize: 9, color: "#445566", ...MN }}>
                {x.p?.toFixed(0)}%
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Expanded */}
      {open && (
        <div
          style={{
            marginTop: 14,
            borderTop: "1px solid rgba(255,255,255,.06)",
            paddingTop: 14,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            style={{
              display: "flex",
              gap: 6,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            <TabBtn
              label="🧠 Summary"
              active={tab === "summary"}
              onClick={() => setTab("summary")}
            />
            <TabBtn
              label="📈 Markets"
              active={tab === "markets"}
              onClick={() => setTab("markets")}
            />
          </div>
          {tab === "summary" && (
            <SummaryTab match={match} bankroll={bankroll} />
          )}
          {tab === "markets" && (
            <MarketsTab match={match} bankroll={bankroll} />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main App ────────────────────────────────────────────────────────────────
export default function App() {
  const [apiKey, setApiKey] = useState("");
  const [savedKey, setSavedKey] = useState("");
  const [league, setLeague] = useState(LEAGUES[0]);
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [bankroll, setBankroll] = useState(1000);
  const [sortBy, setSortBy] = useState("value");
  const [remaining, setRemaining] = useState(null);

  const fetchMatches = useCallback(async (key, lg) => {
    setLoading(true);
    setError("");
    setMatches([]);
    try {
      const url =
        `https://api.the-odds-api.com/v4/sports/${lg.key}/odds/` +
        `?apiKey=${key}&regions=uk,eu&markets=h2h,totals&oddsFormat=decimal&dateFormat=iso`;
      const res = await fetch(url);
      setRemaining(res.headers.get("x-requests-remaining"));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Error ${res.status}`);
      }
      const data = await res.json();
      if (!data.length) {
        setError(
          "No upcoming matches for this league right now — try another."
        );
        return;
      }
      setMatches(data.map(buildMatch).filter(Boolean));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleConnect = () => {
    if (!apiKey.trim()) {
      setError("Please paste your API key.");
      return;
    }
    setSavedKey(apiKey.trim());
    fetchMatches(apiKey.trim(), league);
  };

  useEffect(() => {
    if (savedKey) fetchMatches(savedKey, league);
  }, [league]);

  const evOf = (m) =>
    Math.max(
      calcEV(m.homeProb, m.homeOdds) ?? -999,
      m.drawOdds ? calcEV(m.drawProb, m.drawOdds) ?? -999 : -999,
      calcEV(m.awayProb, m.awayOdds) ?? -999
    );

  const sorted = [...matches].sort((a, b) =>
    sortBy === "value"
      ? evOf(b) - evOf(a)
      : new Date(a.commenceTime) - new Date(b.commenceTime)
  );
  const valueBets = matches.filter((m) => evOf(m) > 0.05).length;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0a0d14",
        backgroundImage:
          "radial-gradient(ellipse at 20% 0%,rgba(0,80,160,.15) 0%,transparent 60%)",
        color: "#ccd8ee",
        fontFamily: "sans-serif",
      }}
    >
      <style>{`
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        *{box-sizing:border-box}
        select option{background:#0d1117}
        input::placeholder{color:#2a3444}
        ::-webkit-scrollbar{width:5px;height:5px}
        ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.1);border-radius:3px}
      `}</style>

      {/* ── Header ── */}
      <div
        style={{
          borderBottom: "1px solid rgba(255,255,255,.06)",
          padding: "14px 20px",
          background: "rgba(0,0,0,.5)",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: 10,
        }}
      >
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: savedKey ? "#00ff80" : "#ff4444",
                boxShadow: `0 0 10px ${savedKey ? "#00ff80" : "#ff4444"}`,
                animation: "pulse 2s infinite",
              }}
            />
            <span style={{ fontSize: 19, fontWeight: 800, color: "#e8f0ff" }}>
              ⚽ ValueBet<span style={{ color: "#00ff80" }}>IQ</span>
              <span
                style={{
                  fontSize: 11,
                  color: "#334455",
                  fontWeight: 400,
                  marginLeft: 6,
                }}
              >
                Soccer
              </span>
            </span>
          </div>
          <div style={{ fontSize: 10, color: "#445566", ...MN, marginTop: 2 }}>
            {savedKey
              ? `LIVE · ${matches.length} MATCHES · ${valueBets} VALUE BETS${
                  remaining ? ` · ${remaining} API calls left` : ""
                }`
              : "PASTE YOUR FREE API KEY TO START"}
          </div>
        </div>
        {savedKey && (
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            {[
              { l: "VALUE BETS", v: valueBets, c: "#00ff80" },
              { l: "MATCHES", v: matches.length, c: "#aabbcc" },
            ].map((s, i) => (
              <div key={i} style={{ textAlign: "center" }}>
                <div
                  style={{ fontSize: 20, fontWeight: 700, color: s.c, ...MN }}
                >
                  {s.v}
                </div>
                <div style={{ fontSize: 9, color: "#445566", ...MN }}>
                  {s.l}
                </div>
              </div>
            ))}
            <button
              onClick={() => {
                setSavedKey("");
                setMatches([]);
                setApiKey("");
              }}
              style={{
                background: "rgba(255,60,60,.08)",
                border: "1px solid rgba(255,60,60,.2)",
                borderRadius: 6,
                padding: "7px 13px",
                color: "#ff6655",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </div>

      <div style={{ maxWidth: 920, margin: "0 auto", padding: "16px 14px" }}>
        {/* ── Key input ── */}
        {!savedKey && (
          <div
            style={{
              background: "rgba(0,0,0,.4)",
              border: "1px solid rgba(0,180,255,.2)",
              borderRadius: 12,
              padding: 28,
              marginBottom: 20,
              textAlign: "center",
            }}
          >
            <div style={{ fontSize: 28, marginBottom: 8 }}>🔑</div>
            <div
              style={{
                fontSize: 16,
                fontWeight: 700,
                color: "#e8f0ff",
                marginBottom: 6,
              }}
            >
              One free API key — that's it
            </div>
            <div
              style={{
                fontSize: 12,
                color: "#667788",
                marginBottom: 22,
                lineHeight: 2,
              }}
            >
              1. Go to{" "}
              <a
                href="https://the-odds-api.com"
                target="_blank"
                rel="noreferrer"
                style={{ color: "#00ccff" }}
              >
                the-odds-api.com
              </a>
              <br />
              2. Click <strong style={{ color: "#ccd8ee" }}>
                Get API Key
              </strong>{" "}
              → enter email → verify
              <br />
              3. Copy your key → paste below → press{" "}
              <strong style={{ color: "#ccd8ee" }}>Go Live</strong>
              <br />
              <span style={{ color: "#445566" }}>
                Free forever · 500 requests/month · No credit card
              </span>
            </div>
            <div
              style={{
                display: "flex",
                gap: 10,
                maxWidth: 500,
                margin: "0 auto",
              }}
            >
              <input
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleConnect()}
                placeholder="Paste your Odds API key here..."
                style={{
                  flex: 1,
                  background: "rgba(0,0,0,.5)",
                  border: "1px solid rgba(0,180,255,.35)",
                  borderRadius: 8,
                  padding: "12px 14px",
                  color: "#ccd8ee",
                  fontSize: 13,
                  ...MN,
                  outline: "none",
                }}
              />
              <button
                onClick={handleConnect}
                style={{
                  background: "linear-gradient(135deg,#0099ff,#00dd80)",
                  border: "none",
                  borderRadius: 8,
                  padding: "12px 22px",
                  color: "#000",
                  fontWeight: 800,
                  cursor: "pointer",
                  fontSize: 14,
                  whiteSpace: "nowrap",
                }}
              >
                Go Live →
              </button>
            </div>
            {error && (
              <div
                style={{
                  marginTop: 14,
                  padding: "10px 16px",
                  background: "rgba(255,60,60,.08)",
                  borderRadius: 6,
                  color: "#ff6655",
                  fontSize: 12,
                  ...MN,
                  display: "inline-block",
                }}
              >
                ❌ {error}
              </div>
            )}
          </div>
        )}

        {/* ── Controls ── */}
        {savedKey && (
          <>
            <div
              style={{
                display: "flex",
                gap: 10,
                marginBottom: 14,
                flexWrap: "wrap",
              }}
            >
              <select
                value={league.key}
                onChange={(e) =>
                  setLeague(LEAGUES.find((l) => l.key === e.target.value))
                }
                style={{
                  flex: 2,
                  minWidth: 180,
                  background: "rgba(255,255,255,.04)",
                  border: "1px solid rgba(255,255,255,.1)",
                  borderRadius: 8,
                  padding: "9px 12px",
                  color: "#ccd8ee",
                  fontSize: 13,
                  ...MN,
                  cursor: "pointer",
                }}
              >
                {LEAGUES.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
                ))}
              </select>

              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value)}
                style={{
                  background: "rgba(255,255,255,.04)",
                  border: "1px solid rgba(255,255,255,.1)",
                  borderRadius: 8,
                  padding: "9px 12px",
                  color: "#ccd8ee",
                  fontSize: 12,
                  ...MN,
                  cursor: "pointer",
                }}
              >
                <option value="value">⚡ Best Value First</option>
                <option value="time">🕐 Kickoff Time</option>
              </select>

              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  background: "rgba(255,255,255,.03)",
                  border: "1px solid rgba(0,255,128,.18)",
                  borderRadius: 8,
                  padding: "7px 14px",
                }}
              >
                <span style={{ fontSize: 11, color: "#667788", ...MN }}>
                  💰 R
                </span>
                <input
                  type="number"
                  value={bankroll}
                  onChange={(e) =>
                    setBankroll(Math.max(1, Number(e.target.value)))
                  }
                  style={{
                    width: 80,
                    background: "transparent",
                    border: "none",
                    color: "#00ff80",
                    fontSize: 15,
                    ...MN,
                    fontWeight: 700,
                    outline: "none",
                  }}
                />
              </div>

              <button
                onClick={() => fetchMatches(savedKey, league)}
                style={{
                  background: "rgba(0,255,128,.08)",
                  border: "1px solid rgba(0,255,128,.2)",
                  borderRadius: 8,
                  padding: "9px 18px",
                  color: "#00ff80",
                  cursor: "pointer",
                  fontSize: 13,
                  ...MN,
                }}
              >
                ↻ Refresh
              </button>
            </div>

            {/* Legend */}
            <div
              style={{
                display: "flex",
                gap: 14,
                marginBottom: 14,
                flexWrap: "wrap",
              }}
            >
              {[
                { c: "0,255,128", l: "Value bet (EV>5%)" },
                { c: "255,200,0", l: "Edge (EV 0–5%)" },
                { c: "255,80,80", l: "No value" },
              ].map((x, i) => (
                <div
                  key={i}
                  style={{ display: "flex", alignItems: "center", gap: 5 }}
                >
                  <div
                    style={{
                      width: 7,
                      height: 7,
                      borderRadius: "50%",
                      background: `rgb(${x.c})`,
                    }}
                  />
                  <span style={{ fontSize: 10, color: "#445566", ...MN }}>
                    {x.l}
                  </span>
                </div>
              ))}
              <span
                style={{
                  fontSize: 10,
                  color: "#2a3444",
                  ...MN,
                  marginLeft: "auto",
                }}
              >
                Click match → 🧠 Summary · 📈 Markets
              </span>
            </div>

            {loading && (
              <div style={{ textAlign: "center", padding: 60 }}>
                <div
                  style={{
                    width: 32,
                    height: 32,
                    border: "3px solid rgba(255,255,255,.07)",
                    borderTop: "3px solid #00ccff",
                    borderRadius: "50%",
                    margin: "0 auto 16px",
                    animation: "spin 1s linear infinite",
                  }}
                />
                <div style={{ ...MN, fontSize: 12, color: "#445566" }}>
                  Fetching live soccer odds...
                </div>
              </div>
            )}

            {!loading && error && (
              <div
                style={{
                  padding: "14px 18px",
                  background: "rgba(255,60,60,.07)",
                  border: "1px solid rgba(255,60,60,.2)",
                  borderRadius: 10,
                  color: "#ff6655",
                  ...MN,
                  fontSize: 12,
                  marginBottom: 14,
                }}
              >
                ❌ {error}
              </div>
            )}

            {!loading && !error && matches.length === 0 && (
              <div
                style={{
                  textAlign: "center",
                  padding: 60,
                  color: "#334455",
                  ...MN,
                  fontSize: 12,
                  lineHeight: 2,
                }}
              >
                No upcoming matches for {league.label}.<br />
                Try another league or refresh later.
              </div>
            )}

            {!loading &&
              !error &&
              sorted.map((m) => (
                <MatchCard key={m.id} match={m} bankroll={bankroll} />
              ))}
          </>
        )}

        <div
          style={{
            marginTop: 24,
            padding: 10,
            textAlign: "center",
            fontSize: 10,
            color: "#1e2a38",
            ...MN,
            borderTop: "1px solid rgba(255,255,255,.03)",
            lineHeight: 1.8,
          }}
        >
          ⚠ Educational purposes only · Soccer only · Bet responsibly · Never
          bet what you can't afford to lose
        </div>
      </div>
    </div>
  );
}
