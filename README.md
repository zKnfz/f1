# Pitwall Live Timing

A Formula 1 live timing page with a race engineer panel. It works for every
session: practice, qualifying, sprint and race.

- **Timing table:** positions, gaps, intervals, lap and sector times
  (purple/green/yellow), mini-sectors, tyres, pit stops and top speed.
- **Track map** of the real circuit. Car dots are estimated from sector
  progress, since live GPS needs an F1 TV login.
- **Race control messages, weather, track status** and a session clock.
- **Delay meter:** how far behind F1's own timing the screen is.
- **Race engineer panel.** The tabs change with the session:
  - Race: driver focus, pit window ("if they pit this lap"), battles with
    closing rates and DRS estimates, lap time chart, tyre strategy.
  - Qualifying: driver focus with a live projected lap, knockout watch with
    the cut-off line, lap time chart.
  - Practice: driver focus, long-run pace and tyre wear, lap time chart, tyre usage.
- **Simulator** (`sim.html`): a made-up race to try it out when no session is on.

## Two ways to run it

### 1. Hosted (GitHub Pages): nothing to install
Open the page and your browser connects straight to F1's live timing feed.
Lap history for the engineer panel is saved in your browser while the page is open.

### 2. Local relay: for race weekends on your own computer
Needs [Node.js](https://nodejs.org) 22 or newer.

```bash
node server.mjs
```

Then open http://127.0.0.1:8765. The relay records lap history even when
the page is closed and saves it in `data/`. Start it before a session begins
to get the full history.

Options: `FEEDS=3` (how many connections race each other for the fastest
update) and `PORT=8765`. In the browser, `?mode=direct` or `?mode=relay`
forces a mode, and `?feeds=3` sets the connection count in direct mode.

## Self-tuning and the session recorder

The lap projections tune themselves: after every lap the page compares what it projected with
the real lap time and adjusts. Each browser learns on its own while the page is open.

To learn from sessions when nobody has the page open, and to share the result with every
visitor, run the recorder on a computer with a normal home connection:

```bash
tools/record-and-share.sh
```

It checks the F1 schedule, and if a session is on (or starts within 25 minutes) it opens the
page in a headless Chrome for the whole session (`tools/record.mjs`), then commits what the
page learned to `learned/` and pushes it. Every visitor's browser loads those files when they
hold more than the browser has learned itself. It needs Google Chrome and Node 18 or newer.

This cannot run as a GitHub Actions job: Formula 1's network refuses connections from
GitHub's servers (HTTP 403).

## Race call (winner, top 3, top 5, top 10)

In a race the first tab, **Race call**, gives each driver's chance to win, finish in the top 3, the top 5
and the top 10. `racesim.js` plays out the rest of the race a few thousand times from
the real gaps, using each driver's recent race pace (corrected for tyre age), tyre wear, the
pit stops still to make, the chance of a safety car and of retiring, and a margin needed to
overtake a car on the same strategy. Before the race has its own laps it leans on grid order
and qualifying pace, which the site saves during qualifying (`pitwall-qpace-<meeting>`).

Its settings were tuned on the 2025 races and checked on 2024 races they had not seen (the same settings came out best for each season alone and both together):

```
node tools/fetch-races.mjs 2025      # download lap-by-lap history from the Jolpica API into data/races/
node tools/race-backtest.mjs         # test the race call at 0/25/50/75/90% distance of each race
node tools/race-tune.mjs             # try settings and print the best (slow)
```

Each call is also logged during a live race and checked against the result; the record shows
on the card.

## Notes
- Data comes from Formula 1's public live timing feed and the circuit outlines from
  the MultiViewer API. Either could change or be restricted at any time.
- Lap history only covers what was recorded while the page or relay was running,
  because F1's archive of past sessions needs a login.
- This is an unofficial fan project, not affiliated with Formula 1.
