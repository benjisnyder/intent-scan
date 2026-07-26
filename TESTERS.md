# intent-scan (early preview)

Thanks for trying this. It takes about two minutes.

## What it does

It surfaces the AI "intent" your project has quietly accumulated (the decisions,
rules, and domain knowledge that guide how AI tools work on your code) and
compiles it into a portable `.intent/` folder plus a visual report. Most of this
lives in Claude Code's local memory, invisible and not in your repo.

## Run it

From the root of a project you have built with Claude Code (the folder where you
run Claude):

```sh
npx github:benjisnyder/intent-scan .
```

It asks for consent, then opens an HTML report in your browser.

## Privacy

- Local-first. It reads your repo and Claude Code's local memory on your machine.
- Nothing is uploaded. There is no account and no telemetry.
- Optional `--llm` adds better summaries using YOUR Anthropic key, and only then
  are short file previews sent to Anthropic (never to us). It is off by default.

## Options

```sh
npx github:benjisnyder/intent-scan .            # local, deterministic, nothing leaves your machine
npx github:benjisnyder/intent-scan . --llm      # better summaries, uses your ANTHROPIC_API_KEY
npx github:benjisnyder/intent-scan . --commit   # also place the .intent/ folder in your repo
npx github:benjisnyder/intent-scan . --redact   # mask passwords/keys, for a report you can share
```

Heads up: your notes can contain real credentials (a password or API key you
told the AI once). The report flags those and, on any project, `--redact` masks
them so the report is safe to send back.

## Keep it in sync (optional)

So it comes to you instead of you remembering to run it:

```sh
npx github:benjisnyder/intent-scan . --watch          # re-scan as your memory changes, print what changed
npx github:benjisnyder/intent-scan . --install-hook    # refresh + show a diff after every git commit
npx github:benjisnyder/intent-scan . --uninstall-hook  # remove that hook
```

On the second and later runs, the report opens with a "Since your last scan"
summary of what was added, changed, or removed.

By default the report and `.intent/` folder are written under `~/.otent/scans/`,
not into your repo, so nothing is touched unless you pass `--commit`.

## What I would love back

Nothing formal. Just react honestly:

- Did anything surprise you? (most people are surprised by the "canon" list)
- Is any of it useful, and is any of it junk?
- If you had this, what would you do with it?

That is it. Thanks again.
