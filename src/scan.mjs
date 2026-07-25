#!/usr/bin/env node
// intent-scan (prototype)
// Surface a project's durable AI intent from where it already lives (today:
// the hidden Claude memory cache + repo agent-guidance), classify it into the
// Open Intent ontology, and compile it into a portable .intent/ folder plus a
// visual report. Deterministic pass needs no deps and no auth; an optional
// --llm pass adds semantic classification + summaries.
//
// Usage:  node src/scan.mjs <project-path> [--llm]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import readline from "node:readline";
import { exec } from "node:child_process";

const HOME = os.homedir();
const args = process.argv.slice(2);
const USE_LLM = args.includes("--llm");
const AUTO_YES = args.includes("--yes") || args.includes("-y");
const DO_COMMIT = args.includes("--commit");
const projectPath = path.resolve(args.find((a) => !a.startsWith("--")) || process.cwd());
const projectName = path.basename(projectPath);
const slug = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const projectSlug = slug(projectName);

// Hidden Claude memory dir: /Users/x/Documents/ridecave -> -Users-x-Documents-ridecave
const encoded = projectPath.replace(/\//g, "-");
const memoryDir = path.join(HOME, ".claude", "projects", encoded, "memory");
const outDir = path.join(HOME, ".otent", "scans", projectSlug);
const intentDir = path.join(outDir, ".intent");

const NOW = Date.now();
const DAY = 1000 * 60 * 60 * 24;
const STALE_DAYS = 90;

// ---------- parsing helpers ----------

function parseIndex(memoryIndexPath) {
  // MEMORY.md lines: - [Title](file.md) — hook
  const map = {};
  if (!fs.existsSync(memoryIndexPath)) return map;
  const raw = fs.readFileSync(memoryIndexPath, "utf8");
  const re = /^\s*[-*]\s*\[(.+?)\]\(([^)]+?)\)\s*(?:[—–-]\s*)?(.*)$/;
  for (const line of raw.split("\n")) {
    const m = line.match(re);
    if (m) map[path.basename(m[2])] = { title: m[1].trim(), hook: m[3].trim() };
  }
  return map;
}

function parseFrontmatter(raw) {
  const data = {};
  let body = raw;
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end !== -1) {
      const block = raw.slice(3, end);
      body = raw.slice(end + 4);
      const grab = (k) => {
        const m = block.match(new RegExp(`^\\s*${k}:\\s*(.+)$`, "m"));
        return m ? m[1].trim().replace(/^["']|["']$/g, "") : null;
      };
      data.name = grab("name");
      data.description = grab("description");
      data.type = grab("type");
    }
  }
  return { data, body };
}

function titleFromName(name) {
  const s = name.replace(/\.md$/, "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function firstMeaningfulLine(body) {
  for (let line of body.split("\n")) {
    line = line.trim();
    if (!line || line === "---") continue;
    line = line.replace(/^#+\s*/, "").replace(/^\*\*(.+?)\*\*:?\s*/, "$1: ");
    if (line) return line.slice(0, 180);
  }
  return "";
}

// ---------- classification (heuristic) ----------

function classifyKind(name) {
  const n = name.replace(/\.md$/, "");
  if (/^feedback_/.test(n) || n === "security-rules") return "canon";
  if (/^reference_/.test(n)) return "reference";
  if (
    /(^|[-_])(plan|status|backlog|triage|followup|follow-up|next-steps|deploy|deployment|review|fixes|inventory|investigation|gotchas|hardening|synthesis|hammer-test|strategy-review|profile|props|revival|issues|cleanup|deferred|coverage|skew|trap|flakes|followup)([-_]|$)/.test(
      n,
    )
  )
    return "plan";
  return "perspective";
}

const SUBJECT_RULES = [
  [/(route3d|track-?3d|procedural-3d|route-rendering|first-person|fpv|camera|iso-color|player-skin|track-view|track-baseline|3d)/, "3D & Track Rendering"],
  [/(auto-train|workout|plan-completion|text-workout|just-ride|laps|hr-based|hr-fit|erg|complication)/, "Auto Train & Workouts"],
  [/(group-racing|group-race|presence|world-live|cave-crew|challenges|multiplayer|race-room|virtual-shifting|gearing)/, "Multiplayer & Racing"],
  [/(pricing|feature-access|paywall|tier|duplicate.signup)/, "Pricing & Access"],
  [/(^ios|android|desktop|windows|linux|mobile|native-auth|expo|webview)/, "Platforms & Builds"],
  [/(garmin|strava|intervals|integration|import|rich-external|webhook|token-auth|ble|device|sensor|trainer|cadence|qdomyos|reconnect)/, "Devices & Integrations"],
  [/(physiolog|adaptive-training|fitness-streak|nutrition|fueling|route-physics|training-status|periodization|bike-mass)/, "Training Science"],
  [/(architecture|data-model|ui-patterns|routes-and-maps|blog-system|mini-apps|home-dashboard|diagnostic|admin-analytics|player-system|history-hot-cold)/, "Architecture & Foundations"],
  [/(^ci-|^test-|vitest|build-commands|dev.environment|construction-time)/, "Dev & CI"],
];

function subjectOf(name) {
  const n = name.toLowerCase();
  if (/^feedback_/.test(n) || n === "security-rules.md") return "Canon (pinned rules)";
  if (/^reference_/.test(n)) return "Reference";
  for (const [re, label] of SUBJECT_RULES) if (re.test(n)) return label;
  return "Other";
}

// ---------- read sources ----------

function readMemory() {
  if (!fs.existsSync(memoryDir)) return [];
  const index = parseIndex(path.join(memoryDir, "MEMORY.md"));
  return fs
    .readdirSync(memoryDir)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .map((name) => {
      const full = path.join(memoryDir, name);
      const stat = fs.statSync(full);
      const raw = fs.readFileSync(full, "utf8");
      const { data, body } = parseFrontmatter(raw);
      const idx = index[name] || {};
      const ageDays = Math.floor((NOW - stat.mtimeMs) / DAY);
      return {
        id: slug(name.replace(/\.md$/, "")),
        name,
        title: idx.title || data.name || titleFromName(name),
        summary: idx.hook || data.description || firstMeaningfulLine(body) || "(no summary found)",
        kind: data.type === "feedback" ? "canon" : data.type === "reference" ? "reference" : classifyKind(name),
        subject: subjectOf(name),
        confidence: "observed",
        source: { tool: "claude", kind: "memory", path: full },
        ageDays,
        stale: ageDays > STALE_DAYS,
        preview: body.slice(0, 600),
      };
    });
}

function readRepoGuidance() {
  const out = [];
  for (const rel of ["CLAUDE.md", "AGENTS.md", "ride-mobile/CLAUDE.md", "ride-mobile/AGENTS.md"]) {
    const full = path.join(projectPath, rel);
    if (fs.existsSync(full)) {
      const stat = fs.statSync(full);
      out.push({ rel, path: full, size: stat.size, ageDays: Math.floor((NOW - stat.mtimeMs) / DAY) });
    }
  }
  return out;
}

// ---------- optional LLM pass ----------

async function llmClassify(artifacts) {
  let Anthropic;
  try {
    ({ default: Anthropic } = await import("@anthropic-ai/sdk"));
  } catch {
    console.warn("  --llm requested but @anthropic-ai/sdk not installed; run `npm install`. Falling back to heuristics.");
    return artifacts;
  }
  const client = new Anthropic();

  // Phase A: derive one tight canonical taxonomy from all the titles, so
  // subjects converge instead of fragmenting into near-duplicate singletons.
  let taxonomy = [];
  try {
    const taxSchema = {
      type: "object", additionalProperties: false, required: ["subjects"],
      properties: { subjects: { type: "array", items: { type: "string" } } },
    };
    const titles = artifacts.map((a) => `- ${a.title}`).join("\n");
    const taxResp = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2000,
      output_config: { format: { type: "json_schema", schema: taxSchema } },
      messages: [{ role: "user", content: `Below are titles of memory files from ONE software project. Produce a canonical taxonomy of 10 to 14 subject areas that together cover all of them. Merge near-duplicates aggressively (e.g. "Route Physics", "Routes & Maps", and "eRoutes" collapse into one "Routes & World"). Prefer broad, durable areas over narrow ones. Return only the list of subject names.\n\n${titles}` }],
    });
    taxonomy = JSON.parse(taxResp.content.find((b) => b.type === "text")?.text || "{}").subjects || [];
    console.log(`  taxonomy (${taxonomy.length}): ${taxonomy.join(", ")}`);
  } catch (e) {
    console.warn("  taxonomy pass failed (" + (e?.message || e) + "); subjects will be free-form.");
  }

  // Phase B: classify each file; constrain subject to the taxonomy so it can't drift.
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "kind", "subject", "title", "summary"],
          properties: {
            name: { type: "string" },
            kind: { type: "string", enum: ["perspective", "canon", "plan", "reference", "noise"] },
            subject: taxonomy.length ? { type: "string", enum: taxonomy } : { type: "string" },
            title: { type: "string" },
            summary: { type: "string" },
          },
        },
      },
    },
  };
  const listing = artifacts
    .map((a) => `### ${a.name}\n${a.preview.replace(/\n+/g, " ").slice(0, 500)}`)
    .join("\n\n");
  const prompt = `You are compiling a project's durable AI intent. For each memory file below, classify its kind, write a one-sentence summary, and assign a canonical subject.

Kinds:
- perspective: durable domain knowledge or a grounded viewpoint that should persist (physiology, architecture, a data model, a design principle).
- canon: a pinned decision or rule ("always do X", "never do Y"). Immutable guidance.
- plan: a working note, status, backlog, or investigation. Operational, not durable knowledge.
- reference: an inventory or lookup table.
- noise: transient, not worth keeping.

Assign each file's subject to EXACTLY ONE of these canonical areas: ${taxonomy.join(" | ") || "(choose one concise area, reusing labels across files)"}.

Files:
${listing}`;

  try {
    const resp = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 16000,
      output_config: { format: { type: "json_schema", schema } },
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content.find((b) => b.type === "text")?.text || "{}";
    const parsed = JSON.parse(text);
    const byName = new Map(parsed.items.map((i) => [i.name, i]));
    for (const a of artifacts) {
      const g = byName.get(a.name);
      if (g) {
        a.kind = g.kind;
        a.subject = g.subject;
        a.title = g.title || a.title;
        a.summary = g.summary || a.summary;
        a.confidence = "strong";
      }
    }
    console.log("  LLM classification complete (claude-opus-4-8).");
  } catch (e) {
    console.warn("  LLM classify failed (" + (e?.message || e) + "). Keeping heuristics.");
  }
  return artifacts;
}

// ---------- output writers ----------

const esc = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function writeIntentFolder(model) {
  // Rebuild the folder each run so subject renames don't leave orphan files.
  fs.rmSync(intentDir, { recursive: true, force: true });
  ensureDir(path.join(intentDir, "perspectives"));
  fs.writeFileSync(path.join(intentDir, "intent.json"), JSON.stringify(model, null, 2));

  // canon.md
  const canon = model.artifacts.filter((a) => a.kind === "canon");
  const canonMd =
    `# Canon\n\nPinned decisions and rules, compiled from where they were scattered. Each is immutable; changes are supersessions.\n\n` +
    canon
      .map((a) => `## ${a.title}\n\n${a.summary}\n\n> source: ${a.source.tool} memory \`${path.basename(a.source.path)}\`${a.stale ? " (stale: " + a.ageDays + "d)" : ""}\n`)
      .join("\n") +
    (canon.length ? "" : "_No canon found yet._\n");
  fs.writeFileSync(path.join(intentDir, "canon.md"), canonMd);

  // perspective files hold only durable knowledge; plans live separately.
  const bySubject = {};
  for (const a of model.artifacts) {
    if (a.kind !== "perspective") continue;
    (bySubject[a.subject] ||= []).push(a);
  }
  for (const [subject, items] of Object.entries(bySubject)) {
    const md =
      `---\nsubject: ${subject}\nartifacts: ${items.length}\ncompiled_from: claude-memory\n---\n\n# ${subject}\n\n` +
      `Compiled from ${items.length} scattered memory file(s). This is the durable knowledge for this area, made portable.\n\n` +
      items
        .map((a) => `## ${a.title}\n\n${a.summary}\n\n> ${a.kind} · source \`${path.basename(a.source.path)}\`${a.stale ? " · stale " + a.ageDays + "d" : ""}\n`)
        .join("\n");
    fs.writeFileSync(path.join(intentDir, "perspectives", slug(subject) + ".md"), md);
  }

  // plans.md: operational notes, kept separate from durable intent.
  const plans = model.artifacts.filter((a) => a.kind === "plan");
  fs.writeFileSync(
    path.join(intentDir, "plans.md"),
    `# Plans & working notes\n\nOperational notes, backlogs, and investigations. Not durable intent; expected to age out. Kept so nothing is lost during curation.\n\n` +
      (plans.length
        ? plans.map((a) => `- **${a.title}** — ${a.summary} \`${path.basename(a.source.path)}\`${a.stale ? " (stale " + a.ageDays + "d)" : ""}`).join("\n") + "\n"
        : "_none_\n"),
  );

  // README.md
  fs.writeFileSync(
    path.join(intentDir, "README.md"),
    `# .intent for ${model.project}\n\nA portable, version-controllable home for this project's durable AI intent: the perspectives (knowledge) and canon (decisions) that should guide any AI tool working here.\n\n- \`canon.md\`: pinned decisions/rules.\n- \`perspectives/\`: durable knowledge, compiled by subject area.\n- \`intent.json\`: the machine-readable model.\n\nBootstrapped by interrogating this project's hidden Claude memory (${model.counts.total} artifacts). Curate freely; add net-new perspectives directly. Project this folder into any tool's native format (CLAUDE.md, .cursor/rules, AGENTS.md) so every tool reads the same intent.\n`,
  );
}

function writeProjection(model) {
  // Demonstrates the loop: intent -> a file Claude Code reads natively.
  ensureDir(path.join(outDir, "projected"));
  const canon = model.artifacts.filter((a) => a.kind === "canon");
  const subjects = [...new Set(model.artifacts.filter((a) => a.kind !== "canon" && a.kind !== "reference").map((a) => a.subject))];
  const md =
    `# Project intent (generated from .intent/ — do not edit here)\n\n` +
    `This file is a projection of .intent/ into a format Claude Code reads natively.\n` +
    `Regenerate it whenever .intent/ changes. Same intent projects into .cursor/rules and AGENTS.md.\n\n` +
    `## Canon (always apply)\n\n` +
    (canon.length ? canon.map((a) => `- ${a.summary}`).join("\n") : "_none yet_") +
    `\n\n## Perspectives (consult when relevant)\n\n` +
    subjects.map((s) => `@.intent/perspectives/${slug(s)}.md`).join("\n") +
    "\n";
  fs.writeFileSync(path.join(outDir, "projected", "CLAUDE.md"), md);
}

function writeReport(model) {
  const kinds = model.counts.byKind;
  const bySubject = {};
  for (const a of model.artifacts) (bySubject[a.subject] ||= []).push(a);
  const orderedSubjects = Object.entries(bySubject).sort((a, b) => b[1].length - a[1].length);
  const staleCount = model.artifacts.filter((a) => a.stale).length;
  const gaps = orderedSubjects
    .filter(([, items]) => items.some((i) => i.kind === "plan") && !items.some((i) => i.kind === "perspective"))
    .map(([s]) => s);

  const badge = (kind) => `<span class="badge ${kind}">${kind}</span>`;
  const card = (a) =>
    `<div class="card"><div class="card-h">${badge(a.kind)}<span class="title">${esc(a.title)}</span>${a.stale ? `<span class="stale">stale ${a.ageDays}d</span>` : ""}</div><div class="summary">${esc(a.summary)}</div><div class="src">${esc(a.source.tool)} · ${esc(path.basename(a.source.path))}</div></div>`;

  const subjectSections = orderedSubjects
    .map(
      ([subject, items]) =>
        `<section class="subject"><h2>${esc(subject)} <span class="count">${items.length}</span></h2><div class="grid">${items.sort((x, y) => x.ageDays - y.ageDays).map(card).join("")}</div></section>`,
    )
    .join("");

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intent · ${esc(model.project)}</title>
<style>
:root{--bg:#faf9f6;--fg:#1a1a1a;--mut:#6b6b6b;--line:#e6e3dc;--accent:#9a6a4a;--card:#fff}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
.wrap{max-width:1040px;margin:0 auto;padding:48px 24px 96px}
header h1{font-size:28px;margin:0 0 4px;font-weight:650}
header .sub{color:var(--mut);margin-bottom:24px}
.stats{display:flex;gap:24px;flex-wrap:wrap;padding:16px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);margin-bottom:8px}
.stat{display:flex;flex-direction:column}.stat b{font-size:22px;font-weight:650}.stat span{color:var(--mut);font-size:13px}
.attention{background:#fdf6ee;border:1px solid #eaddc9;border-radius:10px;padding:14px 18px;margin:24px 0}
.attention h3{margin:0 0 6px;font-size:14px;letter-spacing:.02em;text-transform:uppercase;color:var(--accent)}
.attention ul{margin:0;padding-left:18px;color:#5a4a3a}.attention li{margin:2px 0}
.subject{margin:36px 0}.subject h2{font-size:19px;font-weight:640;margin:0 0 14px;display:flex;align-items:center;gap:10px}
.subject .count{font-size:13px;color:var(--mut);font-weight:400;background:var(--line);border-radius:20px;padding:1px 9px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card-h{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.title{font-weight:600}.summary{color:#3a3a3a;font-size:14px}.src{color:var(--mut);font-size:12px;margin-top:8px;font-family:ui-monospace,Menlo,monospace}
.badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:5px;text-transform:uppercase;letter-spacing:.03em}
.badge.perspective{background:#e8f0e8;color:#3d6b3d}.badge.canon{background:#efe6f5;color:#6b4a8a}
.badge.plan{background:#eef1f5;color:#4a6488}.badge.reference{background:#f0ece3;color:#7a6a4a}.badge.noise{background:#eee;color:#888}
.stale{font-size:11px;color:#a5602a;background:#f8ecdd;border-radius:5px;padding:1px 6px}
footer{margin-top:56px;padding-top:20px;border-top:1px solid var(--line);color:var(--mut);font-size:13px}
code{font-family:ui-monospace,Menlo,monospace;background:#f0ede6;padding:1px 5px;border-radius:4px}
</style></head><body><div class="wrap">
<header>
<h1>${esc(model.project)}</h1>
<div class="sub">Everything this project's AI knows and decides, made visible. Pass: <b>${model.mode}</b>.</div>
</header>
<div class="stats">
<div class="stat"><b>${model.counts.total}</b><span>artifacts surfaced</span></div>
<div class="stat"><b>${kinds.perspective || 0}</b><span>perspectives</span></div>
<div class="stat"><b>${kinds.canon || 0}</b><span>canon (pinned rules)</span></div>
<div class="stat"><b>${kinds.plan || 0}</b><span>plans / working notes</span></div>
<div class="stat"><b>${orderedSubjects.length}</b><span>subject areas</span></div>
<div class="stat"><b>${staleCount}</b><span>stale (&gt;${STALE_DAYS}d)</span></div>
</div>
<div class="attention">
<h3>Attention</h3>
<ul>
<li><b>${model.counts.total}</b> intent artifacts were invisible: they live in Claude's hidden cache at <code>~/.claude/projects/…/memory</code>, not in your repo.</li>
${staleCount ? `<li><b>${staleCount}</b> are stale (not touched in ${STALE_DAYS}+ days) and may no longer reflect the project.</li>` : ""}
${gaps.length ? `<li>Subject areas with active plans but no codified perspective (candidates to compile): ${gaps.map((g) => "<b>" + esc(g) + "</b>").join(", ")}.</li>` : ""}
<li>Compiled into a portable <code>.intent/</code> folder + a generated <code>projected/CLAUDE.md</code> so any tool can read the same intent.</li>
</ul>
</div>
${subjectSections}
<footer>
Generated by intent-scan (prototype) from ${esc(model.sources.map((s) => s.tool + ":" + s.kind).join(", "))}. Deterministic pass; run with <code>--llm</code> for semantic synthesis. This report visualizes <code>output/${projectSlug}/.intent/</code>.
</footer>
</div></body></html>`;
  fs.writeFileSync(path.join(outDir, "report.html"), html);
}

// ---------- main ----------

function loadEnvFile() {
  // Let the key live in a gitignored .env next to package.json.
  const envPath = path.join(process.cwd(), ".env");
  if (!process.env.ANTHROPIC_API_KEY && fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

function consent() {
  return new Promise((resolve) => {
    if (AUTO_YES) return resolve(true);
    if (!process.stdin.isTTY) {
      console.log("\n  Non-interactive shell. Re-run with --yes to confirm.\n");
      return resolve(false);
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("  Continue? [y/N] ", (a) => {
      rl.close();
      resolve(/^y(es)?$/i.test(a.trim()));
    });
  });
}

function openFile(f) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? 'start ""' : "xdg-open";
  exec(`${cmd} "${f}"`, () => {});
}

async function main() {
  loadEnvFile();

  console.log(`\n  Otent · intent-scan (preview)\n`);
  console.log(`  Project:  ${projectPath}`);
  console.log(`  This reads two things on THIS machine, and nothing else:`);
  console.log(`    1. this project's repo (CLAUDE.md, AGENTS.md, docs)`);
  console.log(`    2. Claude Code's local memory for it`);
  console.log(`  Everything stays on your machine. Nothing is uploaded. No telemetry.`);
  if (USE_LLM) console.log(`  NOTE: --llm is on, so file previews are sent to Anthropic on YOUR key to summarize.`);

  if (!fs.existsSync(memoryDir)) {
    console.log(`\n  No Claude Code memory found for this project at:`);
    console.log(`    ${memoryDir}`);
    console.log(`  This preview surfaces intent from Claude Code. If you use Cursor/Codex only, there is nothing here yet.`);
    console.log(`  Tip: run this from the same folder where you run Claude Code.\n`);
    return;
  }

  if (!(await consent())) {
    console.log("  Aborted. Nothing was read or written.\n");
    return;
  }

  let artifacts = readMemory();
  const repoGuidance = readRepoGuidance();
  console.log(`\n  Found ${artifacts.length} memory artifacts and ${repoGuidance.length} repo guidance file(s).`);

  if (!artifacts.length) {
    console.log("  Nothing to surface here yet.\n");
    return;
  }

  if (USE_LLM) {
    console.log("  running LLM semantic pass...");
    artifacts = await llmClassify(artifacts);
  }

  const byKind = {};
  for (const a of artifacts) byKind[a.kind] = (byKind[a.kind] || 0) + 1;

  const model = {
    project: projectName,
    projectPath,
    generatedAt: new Date().toISOString(),
    mode: USE_LLM ? "llm + heuristic" : "heuristic (deterministic)",
    sources: [
      { tool: "claude", kind: "memory", path: memoryDir, fileCount: artifacts.length },
      ...(repoGuidance.length ? [{ tool: "repo", kind: "agent-guidance", paths: repoGuidance.map((r) => r.rel) }] : []),
    ],
    counts: { total: artifacts.length, byKind },
    repoGuidance,
    artifacts,
  };

  ensureDir(outDir);
  writeIntentFolder(model);
  writeProjection(model);
  writeReport(model);

  const reportPath = path.join(outDir, "report.html");
  const k = model.counts.byKind;

  console.log(`\n  ── What you're looking at ──`);
  console.log(`  ${model.counts.total} pieces of AI intent this project accumulated invisibly, now surfaced:`);
  console.log(`  ${k.perspective || 0} perspectives · ${k.canon || 0} canon (pinned decisions) · ${k.plan || 0} plans · ${new Set(artifacts.map((a) => a.subject)).size} subjects`);
  console.log(`  Compiled into a portable .intent/ folder, every item cited to its source. Yours, local, nothing uploaded.`);
  console.log(`\n  Today this is a one-shot snapshot. The product keeps it in sync as you work,`);
  console.log(`  lets you curate it (promote, pin, merge, retire), and projects it into your tools.`);

  if (DO_COMMIT) {
    const dest = path.join(projectPath, ".intent");
    fs.cpSync(intentDir, dest, { recursive: true });
    console.log(`\n  Wrote .intent/ into your repo:  ${dest}`);
  } else {
    console.log(`\n  Folder (kept out of your repo):  ${intentDir}`);
    console.log(`  To place it in your repo instead, re-run with:  --commit`);
  }

  console.log(`\n  Opening the report:  ${reportPath}`);
  openFile(reportPath);

  console.log(`\n  Feedback wanted: what surprised you, what is useful, what is junk.`);
  console.log(`  Reply to whoever sent you this. Thank you.\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
