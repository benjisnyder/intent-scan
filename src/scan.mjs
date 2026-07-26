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

function titleCase(s) {
  return s.replace(/(^|\s)\w/g, (m) => m.toUpperCase());
}

// Project-agnostic subject clustering: group files by the meaningful filename
// tokens they share, so this works on any codebase, not just one domain.
const SUBJECT_STOP = new Set([
  "feedback", "reference", "plan", "plans", "status", "review", "fix", "fixes",
  "notes", "backlog", "followup", "investigation", "system", "app", "the", "and",
  "for", "with", "new", "old", "phase", "v1", "v2", "v3", "setup", "support",
  "project", "not", "using", "based", "guide", "core", "main", "redesign",
  "pivot", "master", "inventory", "hardening", "cleanup", "revamp", "refactor",
]);

function subjectTokens(name) {
  return name
    .replace(/\.md$/, "")
    .toLowerCase()
    .split(/[-_]+/)
    .filter((t) => t.length > 2 && !SUBJECT_STOP.has(t) && !/^\d+$/.test(t));
}

// Two-pass: count meaningful tokens across the project, then label each file
// by the most salient token it shares with others. Canon and reference get
// stable homes so pinned rules don't scatter.
function assignSubjects(artifacts) {
  const clusterable = artifacts.filter((a) => a.kind !== "canon" && a.kind !== "reference");
  const freq = {};
  for (const a of clusterable) for (const t of new Set(subjectTokens(a.name))) freq[t] = (freq[t] || 0) + 1;
  for (const a of artifacts) {
    if (a.kind === "canon") { a.subject = "Rules & Conventions"; continue; }
    if (a.kind === "reference") { a.subject = "Reference"; continue; }
    const ts = subjectTokens(a.name)
      .filter((t) => (freq[t] || 0) >= 2)
      .sort((x, y) => freq[y] - freq[x] || y.length - x.length);
    a.subject = ts.length ? titleCase(ts[0]) : "Other";
  }
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
        subject: "",
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
    return { artifacts, conflicts: [] };
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

  // Scan the pinned decisions for contradictions / overlaps / supersessions.
  let conflicts = [];
  const canon = artifacts.filter((a) => a.kind === "canon");
  if (canon.length > 1) {
    try {
      const cSchema = {
        type: "object", additionalProperties: false, required: ["conflicts"],
        properties: {
          conflicts: {
            type: "array",
            items: {
              type: "object", additionalProperties: false,
              required: ["a", "b", "type", "note"],
              properties: {
                a: { type: "string" },
                b: { type: "string" },
                type: { type: "string", enum: ["contradiction", "overlap", "supersession"] },
                note: { type: "string" },
              },
            },
          },
        },
      };
      const cList = canon.map((a) => `- ${a.title}: ${a.summary}`).join("\n");
      const cResp = await client.messages.create({
        model: "claude-opus-4-8",
        max_tokens: 4000,
        output_config: { format: { type: "json_schema", schema: cSchema } },
        messages: [{ role: "user", content: `These are pinned decisions ("canon") from ONE project. Find pairs that genuinely contradict each other, substantially overlap, or where one clearly supersedes another. Use the exact titles for a and b. Be conservative: only report real ones, and return an empty list if there are none.\n\n${cList}` }],
      });
      conflicts = JSON.parse(cResp.content.find((b) => b.type === "text")?.text || "{}").conflicts || [];
      console.log(`  conflict scan: ${conflicts.length} found among ${canon.length} decisions.`);
    } catch (e) {
      console.warn("  conflict scan failed (" + (e?.message || e) + ").");
    }
  }
  return { artifacts, conflicts };
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

function computeInsights(artifacts, byKind) {
  const durable = (byKind.perspective || 0) + (byKind.canon || 0);
  const transient = (byKind.plan || 0) + (byKind.noise || 0);
  const stale = artifacts.filter((a) => a.stale).sort((a, b) => b.ageDays - a.ageDays);
  const subjects = new Set(artifacts.map((a) => a.subject));
  const perspBySubject = {};
  for (const a of artifacts) if (a.kind === "perspective") (perspBySubject[a.subject] ||= []).push(a);
  const consolidations = Object.entries(perspBySubject)
    .filter(([, items]) => items.length >= 3)
    .map(([subject, items]) => ({ subject, count: items.length }))
    .sort((a, b) => b.count - a.count);
  return {
    surfaced: artifacts.length,
    durable,
    transient,
    subjectsOut: subjects.size,
    staleCount: stale.length,
    staleList: stale.map((a) => ({ title: a.title, ageDays: a.ageDays })),
    consolidations,
  };
}

function writeReport(model) {
  const kinds = model.counts.byKind;
  const ins = model.insights;
  const conflicts = model.conflicts || [];
  const ranLLM = /llm/.test(model.mode);
  const bySubject = {};
  for (const a of model.artifacts) (bySubject[a.subject] ||= []).push(a);
  const orderedSubjects = Object.entries(bySubject).sort((a, b) => b[1].length - a[1].length);
  const gaps = orderedSubjects
    .filter(([, items]) => items.some((i) => i.kind === "plan") && !items.some((i) => i.kind === "perspective"))
    .map(([s]) => s);
  const flagged = ins.staleCount + conflicts.length + ins.consolidations.length + gaps.length;

  const KIND = {
    perspective: ["Perspective", "Durable knowledge or a viewpoint worth keeping.", "What you want every AI tool to consistently understand about this project."],
    canon: ["Canon", "A decision or rule you have pinned.", "Your calls. They should be honored everywhere, not rediscovered or contradicted."],
    plan: ["Plan", "A transient working note, status, or investigation.", "Operational and expected to age out, so it is set aside from your durable intent."],
    reference: ["Reference", "A lookup table or inventory.", "Handy facts, kept for reference."],
  };

  const badge = (kind) => `<span class="badge ${kind}">${kind}</span>`;
  const card = (a) =>
    `<div class="card"><div class="card-h">${badge(a.kind)}<span class="title">${esc(a.title)}</span>${a.stale ? `<span class="stale">stale ${a.ageDays}d</span>` : ""}</div><div class="summary">${esc(a.summary)}</div><div class="src">${esc(path.basename(a.source.path))}</div></div>`;

  const subjectSections = orderedSubjects
    .map(([subject, items]) => `<section class="subject"><h2>${esc(subject)} <span class="count">${items.length}</span></h2><div class="grid">${items.slice().sort((x, y) => x.ageDays - y.ageDays).map(card).join("")}</div></section>`)
    .join("");

  const legend = Object.entries(KIND)
    .filter(([k]) => (kinds[k] || 0) > 0)
    .map(([k, [name, what, why]]) => `<div class="leg"><div class="leg-h">${badge(k)}<b>${name}</b><span class="leg-n">${kinds[k] || 0}</span></div><div class="leg-what">${what}</div><div class="leg-why">${why}</div></div>`)
    .join("");

  const refCount = kinds.reference || 0;
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const didCard = (n, label, sub) => `<div class="did-card"><b>${n}</b><div class="did-l">${label}</div><div class="did-s">${sub}</div></div>`;
  const did = [
    didCard(ins.surfaced, "surfaced", "pieces of intent that were invisible, living in Claude's local memory, not in your repo."),
    didCard(ins.durable, "worth keeping", `durable knowledge and decisions. ${plural(ins.transient, "transient note")} set aside${refCount ? `, ${plural(refCount, "reference")} kept` : ""}.`),
    didCard(ins.subjectsOut, ins.subjectsOut === 1 ? "area" : "areas", `${plural(model.counts.total, "scattered file")} organized into subject areas.`),
    didCard(flagged, "flagged", "worth a look: stale intent, conflicts, and cleanup opportunities (below)."),
  ].join("");

  const attn = [];
  if (ranLLM) {
    if (conflicts.length) {
      attn.push(`<div class="ab warn"><h4>${conflicts.length} possible conflict${conflicts.length > 1 ? "s" : ""} between your decisions</h4><p class="why">Two pinned decisions appear to clash. Left unresolved, your AI gets different guidance depending on which one it happens to read.</p>${conflicts.map((c) => `<div class="pair"><span class="ptag">${esc(c.type)}</span> <b>${esc(c.a)}</b> vs <b>${esc(c.b)}</b><div class="pnote">${esc(c.note)}</div></div>`).join("")}</div>`);
    } else {
      attn.push(`<div class="ab ok"><h4>No conflicts found</h4><p class="why">Your ${kinds.canon || 0} pinned decisions were checked against one another and none appear to contradict.</p></div>`);
    }
  } else {
    attn.push(`<div class="ab muted"><h4>Conflict scan not run</h4><p class="why">Re-run with <code>--llm</code> to check whether any of your pinned decisions contradict each other.</p></div>`);
  }
  if (ins.staleCount) {
    const top = ins.staleList.slice(0, 6);
    attn.push(`<div class="ab warn"><h4>${ins.staleCount} may be out of date</h4><p class="why">Not touched in ${STALE_DAYS}+ days. Intent drifts: a rule or fact set months ago may no longer match how the project actually works. Worth a review, or retire it.</p><ul class="mini">${top.map((s) => `<li>${esc(s.title)} <span class="age">${s.ageDays}d</span></li>`).join("")}${ins.staleCount > top.length ? `<li class="more">+ ${ins.staleCount - top.length} more</li>` : ""}</ul></div>`);
  }
  if (ins.consolidations.length) {
    attn.push(`<div class="ab info"><h4>${ins.consolidations.length} area${ins.consolidations.length > 1 ? "s" : ""} to unify</h4><p class="why">These subjects hold several overlapping perspectives that started life as separate files. Good candidates to consolidate into one cleaner source.</p><ul class="mini">${ins.consolidations.map((c) => `<li>${esc(c.subject)} <span class="age">${c.count} files</span></li>`).join("")}</ul></div>`);
  }
  if (gaps.length) {
    attn.push(`<div class="ab info"><h4>${gaps.length} area${gaps.length > 1 ? "s" : ""} with notes but no codified knowledge</h4><p class="why">Plenty of working notes here, but nothing promoted to durable knowledge yet. Candidates to compile into a perspective.</p><ul class="mini">${gaps.map((g) => `<li>${esc(g)}</li>`).join("")}</ul></div>`);
  }

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Intent · ${esc(model.project)}</title>
<style>
:root{--bg:#faf9f6;--fg:#1a1a1a;--mut:#6b6b6b;--line:#e6e3dc;--accent:#9a6a4a;--card:#fff}
*{box-sizing:border-box}body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg);background:var(--bg)}
.wrap{max-width:1060px;margin:0 auto;padding:52px 24px 96px}
h1{font-size:30px;margin:0 0 6px;font-weight:660;letter-spacing:-0.01em}
.sub{color:var(--mut);margin:0 0 20px}
.intro{font-size:16px;color:#333;max-width:70ch;margin:0 0 8px}
.intro b{color:#111}
.section-title{font-size:13px;font-weight:680;text-transform:uppercase;letter-spacing:.06em;color:var(--accent);margin:40px 0 14px}
.did{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px}
.did-card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px}
.did-card>b{font-size:26px;font-weight:680;display:block}.did-card .slash{font-size:14px;color:var(--mut);font-weight:400}
.did-l{font-size:12px;font-weight:680;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);margin:2px 0 6px}
.did-s{font-size:13px;color:#555;line-height:1.45}
.legend{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.leg{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:13px 15px}
.leg-h{display:flex;align-items:center;gap:8px;margin-bottom:5px}.leg-h b{font-size:15px}.leg-n{margin-left:auto;color:var(--mut);font-size:13px}
.leg-what{font-size:13.5px;color:#333}.leg-why{font-size:12.5px;color:var(--mut);margin-top:4px}
.attn{display:grid;gap:12px}
.ab{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--card)}
.ab h4{margin:0 0 4px;font-size:15px}.ab .why{margin:0;font-size:13.5px;color:#555;line-height:1.5}
.ab.warn{background:#fdf6ee;border-color:#ecd9bf}.ab.warn h4{color:#a5602a}
.ab.ok{background:#f0f6ef;border-color:#d5e4d2}.ab.ok h4{color:#3d6b3d}
.ab.info{background:#eef2f7;border-color:#d5dfeb}.ab.info h4{color:#3a5d88}
.ab.muted{background:#f5f3ee}.ab.muted h4{color:var(--mut)}
.pair{margin-top:10px;font-size:13.5px}.ptag{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;background:#e9dcc7;color:#8a5a2a;border-radius:4px;padding:1px 6px}
.pnote{color:#555;font-size:13px;margin-top:2px}
.mini{margin:10px 0 0;padding:0;list-style:none;columns:2;column-gap:24px}
.mini li{font-size:13px;margin:2px 0;break-inside:avoid}.mini .age{color:var(--mut);font-size:11.5px}.mini .more{color:var(--mut)}
.subject{margin:30px 0}.subject h2{font-size:19px;font-weight:640;margin:0 0 12px;display:flex;align-items:center;gap:10px}
.subject .count{font-size:13px;color:var(--mut);font-weight:400;background:var(--line);border-radius:20px;padding:1px 9px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.card-h{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.title{font-weight:600}.summary{color:#3a3a3a;font-size:14px}.src{color:var(--mut);font-size:12px;margin-top:8px;font-family:ui-monospace,Menlo,monospace}
.badge{font-size:11px;font-weight:600;padding:1px 7px;border-radius:5px;text-transform:uppercase;letter-spacing:.03em}
.badge.perspective{background:#e8f0e8;color:#3d6b3d}.badge.canon{background:#efe6f5;color:#6b4a8a}
.badge.plan{background:#eef1f5;color:#4a6488}.badge.reference{background:#f0ece3;color:#7a6a4a}.badge.noise{background:#eee;color:#888}
.stale{font-size:11px;color:#a5602a;background:#f8ecdd;border-radius:5px;padding:1px 6px}
.divider{border:0;border-top:1px solid var(--line);margin:40px 0 0}
footer{margin-top:44px;padding-top:20px;border-top:1px solid var(--line);color:var(--mut);font-size:13px;line-height:1.6}
code{font-family:ui-monospace,Menlo,monospace;background:#f0ede6;padding:1px 5px;border-radius:4px;font-size:.9em}
</style></head><body><div class="wrap">
<h1>${esc(model.project)}</h1>
<div class="sub">Your project's AI intent, made visible.</div>
<p class="intro">As you built <b>${esc(model.project)}</b> with AI, it quietly accumulated <b>${ins.surfaced}</b> pieces of "intent": decisions you made, rules you set, and knowledge you taught it. Almost none of it was visible. It lived in Claude Code's local memory, not your repo. Here is what was there, what it means, and what got done with it.</p>

<div class="section-title">What intent-scan did</div>
<div class="did">${did}</div>

<div class="section-title">What these are, and why they matter</div>
<div class="legend">${legend}</div>

<div class="section-title">Worth your attention</div>
<div class="attn">${attn.join("")}</div>

<hr class="divider">
<div class="section-title">The intent, by area</div>
${subjectSections}

<footer>
Every item above is cited to the source file it came from, so nothing is invented. Pass: <b>${esc(model.mode)}</b>${ranLLM ? "" : " (run with <code>--llm</code> for sharper summaries and a conflict scan)"}. Compiled into a portable <code>.intent/</code> folder plus a generated <code>projected/CLAUDE.md</code>, so any tool can read the same intent. Everything stayed on your machine.
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

  assignSubjects(artifacts); // deterministic clustering; the --llm pass refines it

  let conflicts = [];
  if (USE_LLM) {
    console.log("  running LLM semantic pass...");
    const r = await llmClassify(artifacts);
    artifacts = r.artifacts;
    conflicts = r.conflicts;
  }

  const byKind = {};
  for (const a of artifacts) byKind[a.kind] = (byKind[a.kind] || 0) + 1;

  const insights = computeInsights(artifacts, byKind);

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
    insights,
    conflicts,
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
