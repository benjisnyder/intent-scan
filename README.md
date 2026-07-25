# intent-scan (prototype)

Point it at a project. It surfaces the project's durable AI intent (the
perspectives, decisions, and knowledge that guide how AI works on it),
wherever that intent currently lives, and compiles it into a portable
`.intent/` folder plus a visual report.

This is a throwaway validation prototype for one question: does making a
project's scattered, invisible AI intent visible produce a genuine "now I
finally get what this project knows" reaction. Nothing here is product code.

## What it reads

1. The project's hidden Claude memory directory
   (`~/.claude/projects/<encoded-path>/memory/`) plus its `MEMORY.md` index.
   This is usually where the gold is, and it is not in the repo.
2. Committed dev-facing agent guidance in the repo (`CLAUDE.md`, `AGENTS.md`).

It does NOT read raw conversation transcripts yet (a later, heavier bet), and
it does NOT touch product runtime AI (e.g. an in-app assistant) or the repo's
source. It is read-only over your project and writes only into `./output/`.

## What it produces

For a project named `foo`:

```
output/foo/
  report.html                  the visual: clusters, canon, freshness, gaps
  .intent/
    intent.json                the model (every artifact, classified, cited)
    README.md                  human overview
    perspectives/<subject>.md  scattered knowledge, compiled per subject area
    canon.md                   the pinned decisions / rules, in one place
```

The `.intent/` folder is the point: a portable, version-controllable home for
the intent that today is trapped in a vendor's hidden cache.

## Run it

```sh
node src/scan.mjs ~/Documents/ridecave
open output/ride-cave/report.html
```

Zero dependencies and zero auth required for the deterministic pass.

### Optional: LLM semantic pass

With an Anthropic key available (`ANTHROPIC_API_KEY`, or an `ant auth login`
profile) and the SDK installed (`npm install`), the scan adds a semantic layer:
better classification, real per-subject summaries, and synthesized perspectives.

```sh
npm install
ANTHROPIC_API_KEY=sk-... node src/scan.mjs ~/Documents/ridecave --llm
```

Uses `claude-opus-4-8` by default; swap to Haiku for cost (it runs often).
