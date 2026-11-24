# Candidate models (replay only)

Each file here is a small script that the replay harness loads into the real page before it runs
(`CANDIDATE=<name> node tools/replay-eval.mjs …`). It wraps a production function after the page
has loaded; the production code is never edited to try a candidate, and none of these ever runs on
the public site.

| File | What | Written by |
|---|---|---|
| `sigma-fit.js` | lap projection uncertainty × a per-stage scale | `tools/fit-quali.mjs` (fitted on training sessions) |
| `pole-temp.js` | pole / top-of-part chances sharpened or softened (p ∝ p^α) | `tools/fit-quali.mjs` |
| `ko-mc.js` | chance of being knocked out of Q1 / Q2 (new; production has none) | by hand, no fitted values |

A candidate replaces production only if it is better on held-out sessions (`tools/fit-quali.mjs`
for the split, `docs/QATAR-READINESS.md` for the results), and never during a race weekend.
