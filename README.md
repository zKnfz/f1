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

## Notes
- Data comes from Formula 1's public live timing feed and the circuit outlines from
  the MultiViewer API. Either could change or be restricted at any time.
- Lap history only covers what was recorded while the page or relay was running,
  because F1's archive of past sessions needs a login.
- This is an unofficial fan project, not affiliated with Formula 1.
