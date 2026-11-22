# Fast Static Site Generator

A faster drop-in for makefun-site 1.0.0: `solve.js` builds the same output tree
for a site — front matter, Markdown subset, template dialect, slugs and the
build report, byte for byte — with a one-pass renderer and templates compiled
to plain JavaScript functions. `main.ts` reads every case from
`/input/cases.json`, answers each with `run`, and writes `/output/answers.json`.

Entry for the make.fun bounty: https://make.fun/bounty/site-generator-speed-01-run-20261122
