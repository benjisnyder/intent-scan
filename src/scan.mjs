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
        mtime: stat.mtimeMs,
        preview: body.slice(0, 600),
        body: body.slice(0, 12000),
        bodyTruncated: body.length > 12000,
        links: [...body.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1].trim()),
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

function snippetAround(body, linkText) {
  const needle = "[[" + linkText + "]]";
  const i = (body || "").indexOf(needle);
  if (i < 0) return "";
  const start = Math.max(0, i - 100), end = Math.min(body.length, i + needle.length + 100);
  const s = body.slice(start, end).replace(/\[\[([^\]]+)\]\]/g, "$1").replace(/\s+/g, " ").trim();
  return (start > 0 ? "… " : "") + s + (end < body.length ? " …" : "");
}

function resolveRelationships(artifacts) {
  // Turn authored [[wiki-links]] into real edges, keeping the sentence each link sits in.
  const byBase = new Map();
  for (const a of artifacts) byBase.set(a.name.replace(/\.md$/, "").toLowerCase(), a);
  for (const a of artifacts) { a.related = []; a.refs = []; a.refBy = []; }
  let edges = 0;
  for (const a of artifacts) {
    const seen = new Set();
    for (const link of a.links || []) {
      const t = byBase.get(link.replace(/\.md$/, "").toLowerCase());
      if (!t || t === a || seen.has(t.id)) continue;
      seen.add(t.id);
      const snippet = snippetAround(a.body, link);
      a.related.push(t.id);
      a.refs.push({ id: t.id, snippet });
      t.refBy.push({ id: a.id, snippet });
      edges++;
    }
  }
  return edges;
}

// Fallback for projects whose notes don't cross-reference each other: connect
// notes by the meaningful words they share in their names (rarer words weigh
// more), capped to each note's few strongest links so it stays a clean map.
function assignTopicalRelationships(artifacts) {
  const toks = new Map(), freq = {};
  for (const a of artifacts) {
    const t = new Set(subjectTokens(a.name));
    toks.set(a.id, t);
    for (const x of t) freq[x] = (freq[x] || 0) + 1;
  }
  const n = artifacts.length;
  const cap = Math.max(4, Math.round(n * 0.4)); // ignore near-ubiquitous words
  const byNode = artifacts.map(() => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const A = toks.get(artifacts[i].id), B = toks.get(artifacts[j].id);
      let w = 0;
      for (const x of A) if (B.has(x) && freq[x] >= 2 && freq[x] <= cap) w += 1 / Math.log2(freq[x] + 1);
      if (w > 0) { byNode[i].push([j, w]); byNode[j].push([i, w]); }
    }
  }
  for (const a of artifacts) { a.related = []; a.refs = []; a.refBy = []; }
  const K = 4, eset = new Set();
  let edges = 0;
  byNode.forEach((arr, i) => {
    arr.sort((a, b) => b[1] - a[1]);
    for (const [j] of arr.slice(0, K)) {
      const key = Math.min(i, j) + "|" + Math.max(i, j);
      if (eset.has(key)) continue;
      eset.add(key);
      edges++;
      if (!artifacts[i].related.includes(artifacts[j].id)) artifacts[i].related.push(artifacts[j].id);
      if (!artifacts[j].related.includes(artifacts[i].id)) artifacts[j].related.push(artifacts[i].id);
    }
  });
  return edges;
}

function computeTimeline(artifacts) {
  const buckets = {};
  for (const a of artifacts) {
    const d = new Date(a.mtime);
    const key = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
    buckets[key] = (buckets[key] || 0) + 1;
  }
  const keys = Object.keys(buckets).sort();
  if (!keys.length) return [];
  const out = [];
  let [y, m] = keys[0].split("-").map(Number);
  const [ly, lm] = keys[keys.length - 1].split("-").map(Number);
  while (y < ly || (y === ly && m <= lm)) {
    const key = y + "-" + String(m).padStart(2, "0");
    out.push({ month: key, count: buckets[key] || 0 });
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

function mdLite(text) {
  const e = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => e(s).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\[\[([^\]]+)\]\]/g, '<span class="wl">$1</span>');
  let html = "", inList = false, inCode = false;
  for (const raw of String(text).split("\n")) {
    if (/^```/.test(raw)) { html += inCode ? "</pre>" : "<pre class='code'>"; inCode = !inCode; continue; }
    if (inCode) { html += e(raw) + "\n"; continue; }
    if (/^\s*[-*]\s+/.test(raw)) { if (!inList) { html += "<ul>"; inList = true; } html += "<li>" + inline(raw.replace(/^\s*[-*]\s+/, "")) + "</li>"; continue; }
    if (inList) { html += "</ul>"; inList = false; }
    const h = raw.match(/^(#{1,4})\s+(.*)/);
    if (h) { const n = Math.min(6, h[1].length + 2); html += `<h${n}>${inline(h[2])}</h${n}>`; continue; }
    if (raw.trim()) html += "<p>" + inline(raw) + "</p>";
  }
  if (inList) html += "</ul>";
  if (inCode) html += "</pre>";
  return html;
}

// Force-directed layout computed at generation time, so the graph is a static
// (but clickable) SVG with no client-side physics.
function computeGraphLayout(artifacts) {
  const referenced = new Set();
  for (const a of artifacts) for (const r of a.related || []) referenced.add(r);
  const nodes = artifacts.filter((a) => (a.related && a.related.length) || referenced.has(a.id));
  const idx = new Map(nodes.map((a, i) => [a.id, i]));
  const eset = new Set();
  const E = [];
  for (const a of nodes)
    for (const r of a.related || []) {
      if (!idx.has(r)) continue;
      let i = idx.get(a.id), j = idx.get(r);
      if (i === j) continue;
      if (i > j) { const t = i; i = j; j = t; }
      const k = i + "-" + j;
      if (!eset.has(k)) { eset.add(k); E.push([i, j]); }
    }
  const n = nodes.length;
  if (!n) return { nodes: [], edges: [] };
  const pos = nodes.map((_, i) => ({ x: Math.cos((2 * Math.PI * i) / n), y: Math.sin((2 * Math.PI * i) / n) }));
  const deg = nodes.map(() => 0);
  for (const [i, j] of E) { deg[i]++; deg[j]++; }
  for (let it = 0; it < 300; it++) {
    const disp = pos.map(() => ({ x: 0, y: 0 }));
    for (let i = 0; i < n; i++)
      for (let j = i + 1; j < n; j++) {
        const dx = pos[i].x - pos[j].x, dy = pos[i].y - pos[j].y, d2 = dx * dx + dy * dy + 0.01, f = 0.06 / d2;
        disp[i].x += dx * f; disp[i].y += dy * f; disp[j].x -= dx * f; disp[j].y -= dy * f;
      }
    for (const [i, j] of E) {
      const dx = pos[j].x - pos[i].x, dy = pos[j].y - pos[i].y, d = Math.sqrt(dx * dx + dy * dy) + 0.01, f = ((d - 0.5) * 0.12) / d;
      disp[i].x += dx * f; disp[i].y += dy * f; disp[j].x -= dx * f; disp[j].y -= dy * f;
    }
    const cool = 1 - it / 300, lim = 0.1;
    for (let i = 0; i < n; i++) {
      disp[i].x -= pos[i].x * 0.015; disp[i].y -= pos[i].y * 0.015;
      pos[i].x += Math.max(-lim, Math.min(lim, disp[i].x)) * cool * 3;
      pos[i].y += Math.max(-lim, Math.min(lim, disp[i].y)) * cool * 3;
    }
  }
  return { nodes: nodes.map((a, i) => ({ id: a.id, title: a.title, kind: a.kind, x: pos[i].x, y: pos[i].y, deg: deg[i] })), edges: E };
}

function renderGraphSvg(graph) {
  if (!graph.nodes.length) return "";
  const KCOL = { perspective: "#3d6b3d", canon: "#6b4a8a", plan: "#4a6488", reference: "#7a6a4a", noise: "#999" };
  const xs = graph.nodes.map((n) => n.x), ys = graph.nodes.map((n) => n.y);
  const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
  const W = 920, H = 560, pad = 46;
  const sx = (x) => pad + (maxx > minx ? (x - minx) / (maxx - minx) : 0.5) * (W - 2 * pad);
  const sy = (y) => pad + (maxy > miny ? (y - miny) / (maxy - miny) : 0.5) * (H - 2 * pad);
  const P = graph.nodes.map((n) => ({ x: sx(n.x), y: sy(n.y) }));
  const edges = graph.edges.map(([i, j]) => `<line x1="${P[i].x.toFixed(1)}" y1="${P[i].y.toFixed(1)}" x2="${P[j].x.toFixed(1)}" y2="${P[j].y.toFixed(1)}" stroke="#c9c3b8" stroke-width="0.8" opacity="0.6"/>`).join("");
  const rOf = (n) => 3 + Math.min(9, n.deg * 0.9);
  // circles first, then all labels, so labels always sit on top of every dot.
  const circles = graph.nodes.map((n, i) => `<circle class="gnode" cx="${P[i].x.toFixed(1)}" cy="${P[i].y.toFixed(1)}" r="${rOf(n).toFixed(1)}" fill="${KCOL[n.kind] || "#999"}" onclick="openModal('${n.id}')"><title>${esc(n.title)}</title></circle>`).join("");
  // font-size/stroke-width are unitless (user units), so labels scale with the
  // viewBox zoom. data-r is the viewBox width at/below which this label reveals:
  // larger for more-connected nodes, so hubs appear first, leaves last.
  const order = graph.nodes.map((_, i) => i).sort((a, b) => graph.nodes[b].deg - graph.nodes[a].deg);
  const rank = new Array(graph.nodes.length);
  order.forEach((idx, r) => (rank[idx] = r));
  const N = graph.nodes.length;
  const revealW = (i) => Math.max(140, Math.round(1000 - rank[i] * (860 / Math.max(1, N - 1))));
  const labels = graph.nodes.map((n, i) => `<text class="lbl" data-r="${revealW(i)}" x="${P[i].x.toFixed(1)}" y="${(P[i].y - rOf(n) - 4).toFixed(1)}" font-size="9" stroke-width="2.4">${esc(n.title).slice(0, 26)}</text>`).join("");
  return `<svg id="gsvg" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">${edges}${circles}${labels}</svg>`;
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
  const small = model.counts.total < 15;

  const KIND = {
    perspective: ["Perspective", "Durable knowledge or a viewpoint worth keeping.", "What you want every AI tool to consistently understand about this project."],
    canon: ["Canon", "A decision or rule you have pinned.", "Your calls. They should be honored everywhere, not rediscovered or contradicted."],
    plan: ["Plan", "A transient working note, status, or investigation.", "Operational and expected to age out, so it is set aside from your durable intent."],
    reference: ["Reference", "A lookup table or inventory.", "Handy facts, kept for reference."],
  };

  const idTitle = Object.fromEntries(model.artifacts.map((a) => [a.id, a.title]));
  const badge = (kind) => `<span class="badge ${kind}">${kind}</span>`;
  const relChips = (a, inModal) =>
    (a.related || [])
      .map((id) => `<span class="rel" onclick="${inModal ? "" : "event.stopPropagation();"}openModal('${id}')">${esc(idTitle[id] || id)}</span>`)
      .join("");
  const card = (a) => {
    const rels = relChips(a, false);
    const dq = esc((a.title + " " + a.summary + " " + a.subject + " " + a.kind).toLowerCase());
    return `<div class="card" id="a-${esc(a.id)}" data-q="${dq}" onclick="openModal('${esc(a.id)}')"><div class="card-h">${badge(a.kind)}<span class="title">${esc(a.title)}</span>${a.stale ? `<span class="stale">stale ${a.ageDays}d</span>` : ""}</div><div class="summary">${esc(a.summary)}</div>${rels ? `<div class="rels"><span class="rl">Related:</span> ${rels}</div>` : ""}</div>`;
  };
  const connRow = (r) => `<div class="conn" onclick="openModal('${r.id}')"><div class="conn-t">${esc(idTitle[r.id] || r.id)}</div>${r.snippet ? `<div class="conn-s">${esc(r.snippet)}</div>` : ""}</div>`;
  const connections = (a) => {
    if ((a.refs && a.refs.length) || (a.refBy && a.refBy.length)) {
      const out = a.refs && a.refs.length ? `<div class="m-conn"><h3>References (${a.refs.length})</h3>${a.refs.map(connRow).join("")}</div>` : "";
      const inc = a.refBy && a.refBy.length ? `<div class="m-conn"><h3>Referenced by (${a.refBy.length})</h3>${a.refBy.map(connRow).join("")}</div>` : "";
      return out + inc;
    }
    if (a.related && a.related.length) {
      return `<div class="m-conn"><h3>Related by topic (${a.related.length})</h3>${a.related.map((id) => connRow({ id })).join("")}</div>`;
    }
    return "";
  };
  const modalSrc = (a) => {
    return `<div class="msrc" id="src-${esc(a.id)}"><div class="m-head">${badge(a.kind)}<h2>${esc(a.title)}</h2></div><div class="m-meta">${esc(a.subject)} · ${esc(path.basename(a.source.path))}${a.stale ? ` · stale ${a.ageDays}d` : ""}</div><div class="m-sum">${esc(a.summary)}</div>${connections(a)}<div class="m-src-title">Source</div><div class="md">${mdLite(a.body || "")}${a.bodyTruncated ? '<p class="trunc">… truncated</p>' : ""}</div></div>`;
  };
  const modalSrcs = model.artifacts.map(modalSrc).join("");
  const graph = computeGraphLayout(model.artifacts);
  const relBlurb = model.relationshipMode === "topics"
    ? `${model.relationshipCount} topical connections. Your notes don't cross-reference each other, so this maps them by the subjects they share`
    : `${model.relationshipCount} links your own notes drew between each other`;
  // Only worth a graph section when there's a real web to show.
  const showGraph = graph.nodes.length >= 5 && model.relationshipCount >= 4;
  const graphHtml = showGraph
    ? `<div class="section-title">How your intent connects</div><div class="graph"><div class="gzoom"><button onclick="gZoom(0.7)" title="Zoom in">+</button><button onclick="gZoom(1.45)" title="Zoom out">−</button><button onclick="gReset()" title="Reset view">⤢</button></div>${renderGraphSvg(graph)}</div><div class="ghint">${relBlurb}. Zoom with the buttons or scroll, drag to pan, hover a dot for its name, click to open it. Labels appear as you zoom in.</div>`
    : "";

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
    ...(model.relationshipCount ? [didCard(model.relationshipCount, "connected", "links your own notes drew to each other, now navigable.")] : []),
    didCard(flagged, "flagged", "worth a look: stale intent, conflicts, and cleanup opportunities (below)."),
  ].join("");

  const tl = model.timeline || [];
  const tlMax = Math.max(1, ...tl.map((t) => t.count));
  const timelineHtml = tl.length > 1
    ? `<div class="section-title">When this intent was built</div><div class="timeline">${tl.map((t) => `<div class="tl-col" title="${t.month}: ${t.count}"><div class="tl-bar" style="height:${Math.round(4 + (t.count / tlMax) * 54)}px"></div><div class="tl-lbl">${t.month.slice(2)}</div></div>`).join("")}</div><div class="tl-note">${tl.length} months of accumulated intent. Bar height is how much was created or last touched that month.</div>`
    : "";
  const searchHtml = `<input id="q" class="search" placeholder="Filter ${model.counts.total} items by keyword…" oninput="filterCards(this.value)">`;

  const attn = [];
  if (conflicts.length) {
    attn.push(`<div class="ab warn"><h4>${conflicts.length} possible conflict${conflicts.length > 1 ? "s" : ""} between your decisions</h4><p class="why">Two pinned decisions appear to clash. Left unresolved, your AI gets different guidance depending on which one it happens to read.</p>${conflicts.map((c) => `<div class="pair"><span class="ptag">${esc(c.type)}</span> <b>${esc(c.a)}</b> vs <b>${esc(c.b)}</b><div class="pnote">${esc(c.note)}</div></div>`).join("")}</div>`);
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

  // Order adapts to size. Large projects: overview + graph on top, then the big
  // card list (burying the graph under 130 cards reads badly). Small projects:
  // lead with the few memories so the meta doesn't drown them.
  const stripHtml = small ? `<div class="strip">${ins.surfaced} surfaced · ${ins.durable} worth keeping · ${plural(ins.subjectsOut, "area")}${model.relationshipCount ? ` · ${model.relationshipCount} connected` : ""}${ins.staleCount ? ` · ${ins.staleCount} stale` : ""}</div>` : "";
  const byAreaSection = `<div class="section-title">The intent, by area</div>${searchHtml}${subjectSections}`;
  const analysisSection = `${small ? "" : `<div class="section-title">What intent-scan did</div><div class="did">${did}</div>`}${graphHtml}${(model.timeline || []).length >= 3 ? timelineHtml : ""}<div class="section-title">What these are, and why they matter</div><div class="legend">${legend}</div>${attn.length ? `<div class="section-title">Worth your attention</div><div class="attn">${attn.join("")}</div>` : ""}`;
  const bodyMain = small ? `${byAreaSection}<hr class="divider">${analysisSection}` : `${analysisSection}<hr class="divider">${byAreaSection}`;

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
.strip{font-size:14px;color:#666;margin:2px 0 6px}
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
.timeline{display:flex;gap:3px;align-items:flex-end;overflow-x:auto;padding:8px 0 2px}
.tl-col{display:flex;flex-direction:column;align-items:center;min-width:20px}
.tl-bar{width:13px;background:var(--accent);border-radius:3px 3px 0 0;opacity:.85}
.tl-lbl{font-size:9px;color:var(--mut);margin-top:4px;white-space:nowrap}
.tl-note{font-size:12.5px;color:var(--mut);margin-top:6px}
.search{width:100%;padding:10px 14px;border:1px solid var(--line);border-radius:9px;font-size:14px;background:#fff;margin:0 0 16px}
.rels{font-size:12px;color:var(--mut);margin-top:8px}
.rels .rel{color:var(--accent);text-decoration:none;margin-right:10px;white-space:nowrap}.rels .rel:hover{text-decoration:underline}
.drill{margin-top:10px;border-top:1px solid var(--line);padding-top:8px}
.drill summary{cursor:pointer;font-size:12px;color:var(--mut);font-family:ui-monospace,Menlo,monospace}
.md{font-size:13px;color:#333;margin-top:10px;max-height:420px;overflow:auto;padding-right:6px}
.md h3,.md h4,.md h5,.md h6{margin:10px 0 4px;font-size:14px}.md p{margin:6px 0}.md ul{margin:6px 0;padding-left:20px}.md li{margin:2px 0}
.md pre.code{background:#f2efe9;padding:8px 10px;border-radius:6px;overflow-x:auto;font-size:12px}
.md code{background:#f0ede6;padding:1px 4px;border-radius:3px}.md .wl{color:var(--accent);font-weight:600}
.trunc{color:var(--mut);font-style:italic}
.rels{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:baseline;font-size:12px;margin-top:8px}
.rels .rl{color:var(--mut)}
.rel{cursor:pointer;color:var(--accent);white-space:nowrap}.rel:hover{text-decoration:underline}
.card{cursor:pointer;transition:border-color .1s}.card:hover{border-color:var(--accent)}
.graph{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:8px;overflow:auto}
.graph svg{display:block;width:100%;height:auto}
.gnode{cursor:pointer}.gnode:hover{stroke:#1a1a1a;stroke-width:1.2}
.modal{position:fixed;inset:0;background:rgba(20,18,15,.5);display:none;z-index:100;overflow:auto}
.modal.open{display:block}
.modal-box{max-width:820px;margin:32px auto;background:var(--card);border-radius:14px;padding:26px 32px;position:relative;box-shadow:0 24px 70px rgba(0,0,0,.3)}
.modal-x{position:absolute;top:12px;right:16px;border:0;background:none;font-size:28px;line-height:1;cursor:pointer;color:var(--mut)}
.m-head{display:flex;align-items:center;gap:10px;padding-right:30px}.m-head h2{margin:0;font-size:22px}
.m-meta{color:var(--mut);font-size:12.5px;font-family:ui-monospace,Menlo,monospace;margin:8px 0}
.m-sum{font-size:15px;color:#333;margin:6px 0 14px}
.modal .md{max-height:none}
.graph{height:600px;overflow:hidden;position:relative;padding:0}
.graph svg{width:100%;height:100%;cursor:grab;touch-action:none}
.graph svg:active{cursor:grabbing}
.ghint{font-size:12.5px;color:var(--mut);margin-top:8px}
.gzoom{position:absolute;top:10px;right:10px;display:flex;flex-direction:column;gap:5px;z-index:2}
.gzoom button{width:30px;height:30px;border:1px solid var(--line);background:#fff;border-radius:7px;font-size:17px;cursor:pointer;color:#333;line-height:1;display:flex;align-items:center;justify-content:center}
.gzoom button:hover{border-color:var(--accent)}
.lbl{fill:#2a2a2a;stroke:#faf9f6;paint-order:stroke;text-anchor:middle;pointer-events:none}
.m-conn{margin:14px 0}
.m-conn h3{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--accent);margin:0 0 6px}
.conn{border:1px solid var(--line);border-radius:8px;padding:9px 12px;margin-bottom:6px;cursor:pointer;background:#faf9f6}
.conn:hover{border-color:var(--accent)}
.conn-t{font-weight:600;font-size:13.5px}
.conn-s{font-size:12.5px;color:#666;margin-top:3px;line-height:1.45}
.m-src-title{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:var(--mut);margin:18px 0 0;border-top:1px solid var(--line);padding-top:12px}
</style></head><body><div class="wrap">
<h1>${esc(model.project)}</h1>
<div class="sub">Your project's AI intent, made visible.</div>
<p class="intro">As you built <b>${esc(model.project)}</b> with AI, it quietly accumulated <b>${ins.surfaced}</b> pieces of "intent": decisions you made, rules you set, and knowledge you taught it. Almost none of it was visible. It lived in Claude Code's local memory, not your repo. Below is what was there, each item cited to the exact file it came from. Click any tile to read the full note.</p>
${stripHtml}
${bodyMain}

<footer>
Every item above is cited to the source file it came from, so nothing is invented. Pass: <b>${esc(model.mode)}</b>${ranLLM ? "" : " (run with <code>--llm</code> for sharper summaries and a conflict scan)"}. Compiled into a portable <code>.intent/</code> folder plus a generated <code>projected/CLAUDE.md</code>, so any tool can read the same intent. Everything stayed on your machine.
</footer>
<div style="display:none">${modalSrcs}</div>
<div id="modal" class="modal"><div class="modal-box"><button class="modal-x" onclick="closeModal()" aria-label="Close">×</button><div id="modal-body"></div></div></div>
<script>
function filterCards(q){q=(q||"").toLowerCase().trim();document.querySelectorAll(".card").forEach(function(c){c.style.display=(!q||(c.dataset.q||"").indexOf(q)>=0)?"":"none";});document.querySelectorAll(".subject").forEach(function(s){var any=Array.prototype.some.call(s.querySelectorAll(".card"),function(c){return c.style.display!=="none";});s.style.display=any?"":"none";});}
function openModal(id){var s=document.getElementById("src-"+id);if(!s)return;document.getElementById("modal-body").innerHTML=s.innerHTML;var m=document.getElementById("modal");m.classList.add("open");m.scrollTop=0;}
function closeModal(){document.getElementById("modal").classList.remove("open");}
document.addEventListener("keydown",function(e){if(e.key==="Escape")closeModal();});
document.getElementById("modal").addEventListener("click",function(e){if(e.target.id==="modal")closeModal();});
var GVB={x:0,y:0,w:920,h:560},GLABELS=null,GSW=0;
function gApply(){var svg=document.getElementById("gsvg");if(!svg)return;svg.setAttribute("viewBox",GVB.x+" "+GVB.y+" "+GVB.w+" "+GVB.h);if(!GLABELS)GLABELS=svg.querySelectorAll(".lbl");if(!GSW)GSW=svg.getBoundingClientRect().width||1000;var fs=(13*GVB.w/GSW),sk=(3.2*GVB.w/GSW);for(var i=0;i<GLABELS.length;i++){var L=GLABELS[i];if(GVB.w<=+L.getAttribute("data-r")){L.style.display="";L.setAttribute("font-size",fs.toFixed(2));L.setAttribute("stroke-width",sk.toFixed(2));}else{L.style.display="none";}}}
function gZoomAt(cx,cy,k){var nw=Math.max(80,Math.min(2200,GVB.w*k));var nh=nw*(560/920);GVB.x=cx-(cx-GVB.x)*(nw/GVB.w);GVB.y=cy-(cy-GVB.y)*(nh/GVB.h);GVB.w=nw;GVB.h=nh;gApply();}
function gZoom(k){gZoomAt(GVB.x+GVB.w/2,GVB.y+GVB.h/2,k);}
function gReset(){GVB={x:0,y:0,w:920,h:560};gApply();}
(function(){var svg=document.getElementById("gsvg");if(!svg)return;svg.addEventListener("wheel",function(e){e.preventDefault();var r=svg.getBoundingClientRect();var mx=GVB.x+(e.clientX-r.left)/r.width*GVB.w;var my=GVB.y+(e.clientY-r.top)/r.height*GVB.h;var dy=Math.max(-50,Math.min(50,e.deltaY));gZoomAt(mx,my,Math.exp(dy*0.002));},{passive:false});var start=null,last=null,moved=false;svg.addEventListener("mousedown",function(e){start={x:e.clientX,y:e.clientY};last=start;moved=false;});window.addEventListener("mousemove",function(e){if(!last)return;if(Math.abs(e.clientX-start.x)+Math.abs(e.clientY-start.y)>4)moved=true;var r=svg.getBoundingClientRect();GVB.x-=(e.clientX-last.x)/r.width*GVB.w;GVB.y-=(e.clientY-last.y)/r.height*GVB.h;last={x:e.clientX,y:e.clientY};gApply();});window.addEventListener("mouseup",function(){last=null;});svg.addEventListener("click",function(e){if(moved){e.stopPropagation();e.preventDefault();moved=false;}},true);window.addEventListener("resize",function(){GSW=0;gApply();});gApply();})();
</script>
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
  let relationshipMode = "links";
  let relationshipCount = resolveRelationships(artifacts);
  if (relationshipCount === 0) { relationshipCount = assignTopicalRelationships(artifacts); relationshipMode = "topics"; }

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
    relationshipCount,
    relationshipMode,
    timeline: computeTimeline(artifacts),
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
