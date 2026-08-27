#!/usr/bin/env node
/**
 * Builds Slither audit reports for CI (VOTAR-351).
 * Reads SLITHER_REPORT (checklist Markdown) from the environment and writes:
 *   - reports/slither-report.md
 *   - reports/slither-report.json  (merges native Slither JSON if present)
 *   - reports/slither-report.html
 */
const fs = require("fs");
const path = require("path");

const markdown = process.env.SLITHER_REPORT ?? "";
const outDir = path.join(process.cwd(), "reports");
const mdFile = path.join(outDir, "slither-report.md");
const jsonFile = path.join(outDir, "slither-report.json");
const htmlFile = path.join(outDir, "slither-report.html");
const nativeJsonFile = path.join(outDir, "slither-native.json");

const repo = process.env.GITHUB_REPOSITORY ?? "";
const sha = process.env.GITHUB_SHA ?? "";
const runId = process.env.GITHUB_RUN_ID ?? "";
const generatedAt = new Date().toISOString();

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortLinkLabel(url) {
  try {
    const parsed = new URL(url);
    const match = /\/blob\/[^/]+\/(.+?)(?:#L(\d+)(?:-L(\d+))?)?$/.exec(
      parsed.pathname + parsed.hash
    );
    if (match) {
      const file = match[1].split("/").pop();
      if (match[2] && match[3]) return `${file}:L${match[2]}–L${match[3]}`;
      if (match[2]) return `${file}:L${match[2]}`;
      return file;
    }
    return parsed.hostname + parsed.pathname.slice(0, 40);
  } catch {
    return url.slice(0, 48);
  }
}

function inlineMarkdown(text) {
  let result = escapeHtml(text);
  // [label](url)
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (_, label, url) =>
      `<a class="src-link" href="${escapeHtml(url)}" rel="noopener noreferrer" title="${escapeHtml(url)}">${inlineMarkdownLite(label)}</a>`
  );
  // bare URLs (common in Slither first_markdown_element)
  result = result.replace(
    /(^|[\s(])(https?:\/\/[^\s)<]+)/g,
    (_, prefix, url) =>
      `${prefix}<a class="src-link" href="${escapeHtml(url)}" rel="noopener noreferrer" title="${escapeHtml(url)}">${escapeHtml(shortLinkLabel(url))}</a>`
  );
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return result;
}

function inlineMarkdownLite(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

function impactClass(impact) {
  const key = String(impact || "").toLowerCase();
  if (key.includes("high") || key.includes("critical")) return "impact-high";
  if (key.includes("medium")) return "impact-medium";
  if (key.includes("low")) return "impact-low";
  if (key.includes("informational") || key.includes("optimization")) {
    return "impact-info";
  }
  return "impact-unknown";
}

function parseChecklist(md) {
  if (!md.trim()) {
    return { preamble: [], summary: [], detectors: [] };
  }

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const preamble = [];
  const summary = [];
  const detectors = [];
  let i = 0;
  let inSummary = false;
  let current = null;
  let currentFinding = null;

  const pushFinding = () => {
    if (current && currentFinding) {
      current.findings.push(currentFinding);
      currentFinding = null;
    }
  };

  const pushDetector = () => {
    pushFinding();
    if (current) {
      detectors.push(current);
      current = null;
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    const heading = /^##\s+(.+)$/.exec(trimmed);
    if (heading) {
      pushDetector();
      inSummary = false;
      current = {
        id: heading[1].trim(),
        impact: "",
        confidence: "",
        findings: [],
      };
      i += 1;
      continue;
    }

    if (/^summary\s*$/i.test(trimmed)) {
      inSummary = true;
      i += 1;
      continue;
    }

    if (current) {
      const impact = /^Impact:\s*(.+)$/i.exec(trimmed);
      if (impact) {
        current.impact = impact[1].trim();
        i += 1;
        continue;
      }
      const confidence = /^Confidence:\s*(.+)$/i.exec(trimmed);
      if (confidence) {
        current.confidence = confidence[1].trim();
        i += 1;
        continue;
      }

      const findingStart = /^[-*]\s+\[\s*[xX ]\s*\]\s+(ID-\d+)\s*$/i.exec(
        trimmed
      );
      if (findingStart) {
        pushFinding();
        currentFinding = { id: findingStart[1], lines: [] };
        i += 1;
        continue;
      }

      if (currentFinding) {
        if (trimmed !== "" || currentFinding.lines.length > 0) {
          currentFinding.lines.push(trimmed);
        }
        i += 1;
        continue;
      }

      i += 1;
      continue;
    }

    if (inSummary) {
      const linked =
        /^[-*]\s+\[([^\]]+)\]\(([^)]+)\)\s+\((\d+)\s+results?\)\s+\(([^)]+)\)\s*$/i.exec(
          trimmed
        );
      const plain =
        /^[-*]\s+`?([^`(]+?)`?\s+\((\d+)\s+results?\)\s+\(([^)]+)\)\s*$/i.exec(
          trimmed
        );
      if (linked) {
        summary.push({
          check: linked[1].trim(),
          anchor: linked[2].replace(/^#/, ""),
          count: Number(linked[3]),
          impact: linked[4].trim(),
        });
        i += 1;
        continue;
      }
      if (plain) {
        summary.push({
          check: plain[1].trim(),
          anchor: plain[1].trim(),
          count: Number(plain[2]),
          impact: plain[3].trim(),
        });
        i += 1;
        continue;
      }
      if (trimmed === "") {
        inSummary = false;
      }
      i += 1;
      continue;
    }

    if (trimmed !== "") {
      preamble.push(trimmed);
    }
    i += 1;
  }

  pushDetector();
  return { preamble, summary, detectors };
}

function renderFindingBody(lines) {
  const cleaned = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      cleaned.push("");
      continue;
    }
    cleaned.push(trimmed);
  }

  while (cleaned.length && cleaned[0] === "") cleaned.shift();
  while (cleaned.length && cleaned[cleaned.length - 1] === "") cleaned.pop();

  if (cleaned.length === 0) {
    return "<p class='muted'>Sin detalle adicional.</p>";
  }

  const blocks = [];
  let paragraph = [];
  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  for (const line of cleaned) {
    if (line === "") {
      flush();
      continue;
    }
    // Standalone source URL line → chip
    if (/^https?:\/\/\S+$/.test(line)) {
      flush();
      blocks.push(
        `<p><a class="src-chip" href="${escapeHtml(line)}" rel="noopener noreferrer">${escapeHtml(shortLinkLabel(line))}</a></p>`
      );
      continue;
    }
    paragraph.push(line);
  }
  flush();
  return blocks.join("\n");
}

function renderReportHtml(parsed) {
  const { preamble, summary, detectors } = parsed;

  const preambleHtml = preamble
    .map((line) => {
      if (/THIS CHECKLIST IS NOT COMPLETE/i.test(line)) {
        return `<div class="banner warn">${inlineMarkdown(line)}</div>`;
      }
      return `<p class="preamble">${inlineMarkdown(line)}</p>`;
    })
    .join("\n");

  const totalFindings = summary.reduce((n, s) => n + s.count, 0);
  const summaryRows =
    summary.length === 0
      ? `<tr><td colspan="3" class="muted">Sin hallazgos en el checklist.</td></tr>`
      : summary
          .map(
            (s) => `<tr>
      <td><a href="#${escapeHtml(s.anchor)}"><code>${escapeHtml(s.check)}</code></a></td>
      <td class="num">${s.count}</td>
      <td><span class="badge ${impactClass(s.impact)}">${escapeHtml(s.impact)}</span></td>
    </tr>`
          )
          .join("\n");

  const detectorsHtml =
    detectors.length === 0
      ? `<p class="muted">No hay secciones de detectores en la salida de Slither.</p>`
      : detectors
          .map((det) => {
            const findingsHtml = det.findings
              .map(
                (f) => `<article class="finding">
        <header class="finding-head">
          <span class="finding-id">${escapeHtml(f.id)}</span>
        </header>
        <div class="finding-body">
          ${renderFindingBody(f.lines)}
        </div>
      </article>`
              )
              .join("\n");

            return `<section class="detector" id="${escapeHtml(det.id)}">
      <div class="detector-head">
        <h2><code>${escapeHtml(det.id)}</code></h2>
        <div class="badges">
          ${
            det.impact
              ? `<span class="badge ${impactClass(det.impact)}">Impact: ${escapeHtml(det.impact)}</span>`
              : ""
          }
          ${
            det.confidence
              ? `<span class="badge badge-conf">Confidence: ${escapeHtml(det.confidence)}</span>`
              : ""
          }
          <span class="badge badge-count">${det.findings.length} finding${det.findings.length === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div class="findings">
        ${findingsHtml || "<p class='muted'>Sin findings listados.</p>"}
      </div>
    </section>`;
          })
          .join("\n");

  return `${preambleHtml}

<section class="summary-panel">
  <div class="summary-title">
    <h2>Resumen</h2>
    <span class="badge badge-count">${totalFindings} hallazgo${totalFindings === 1 ? "" : "s"} · ${summary.length} detector${summary.length === 1 ? "" : "es"}</span>
  </div>
  <table class="summary-table">
    <thead>
      <tr><th>Detector</th><th>Cant.</th><th>Impacto</th></tr>
    </thead>
    <tbody>
      ${summaryRows}
    </tbody>
  </table>
</section>

${detectorsHtml}`;
}

function loadNativeSlitherJson() {
  const candidates = [nativeJsonFile, jsonFile];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
      // Prefer raw Slither payload, not our envelope.
      if (parsed?.results?.detectors) return parsed;
      if (parsed?.slither?.results?.detectors) return parsed.slither;
      if (candidate === nativeJsonFile) return parsed;
    } catch {
      // Keep going; we still emit a metadata envelope.
    }
  }
  return null;
}

function summarizeFindings(native) {
  const detectors = native?.results?.detectors;
  if (!Array.isArray(detectors)) {
    return { findingCount: null, byImpact: null };
  }
  const byImpact = {};
  for (const finding of detectors) {
    const impact = finding.impact ?? "Unknown";
    byImpact[impact] = (byImpact[impact] ?? 0) + 1;
  }
  return { findingCount: detectors.length, byImpact };
}

function loadGateConfig() {
  const configPath = path.join(process.cwd(), "slither.config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

fs.mkdirSync(outDir, { recursive: true });

const mdBody = markdown.trim()
  ? markdown
  : "_No se capturó salida de Slither (checklist vacío)._";

const mdDocument = `# Reporte Slither

- Generado: ${generatedAt}
${repo ? `- Repositorio: ${repo}\n` : ""}${sha ? `- Commit: ${sha}\n` : ""}${
  runId ? `- GitHub Actions run: ${runId}\n` : ""
}
---

${mdBody}
`;

fs.writeFileSync(mdFile, mdDocument, "utf8");

const gateConfig = loadGateConfig();
const native = loadNativeSlitherJson();
const { findingCount, byImpact } = summarizeFindings(native);

const jsonDocument = {
  tool: "slither",
  generatedAt,
  repository: repo || null,
  commit: sha || null,
  runId: runId || null,
  qualityGate: {
    configFile: "slither.config.json",
    failOn: gateConfig.fail_on ?? "medium",
    triageDatabase: gateConfig.triage_database ?? "slither.db.json",
    detectorsToExclude: gateConfig.detectors_to_exclude ?? "",
  },
  summary: {
    findingCount,
    byImpact,
    checklistCaptured: Boolean(markdown.trim()),
  },
  checklistMarkdown: markdown,
  slither: native,
};

fs.writeFileSync(jsonFile, `${JSON.stringify(jsonDocument, null, 2)}\n`, "utf8");

const parsed = parseChecklist(markdown);
const body = markdown.trim()
  ? renderReportHtml(parsed)
  : "<p><em>No se capturó salida de Slither.</em></p>";

const htmlDocument = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Slither — reporte de auditoría</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #eef2f0;
      --surface: #ffffff;
      --ink: #14201b;
      --muted: #5b6b63;
      --accent: #0f766e;
      --accent-soft: #ccfbf1;
      --border: #d5ddd8;
      --code-bg: #f0f4f2;
      --high: #b91c1c;
      --high-bg: #fee2e2;
      --medium: #b45309;
      --medium-bg: #ffedd5;
      --low: #1d4ed8;
      --low-bg: #dbeafe;
      --info: #475569;
      --info-bg: #e2e8f0;
      --warn-bg: #fff7ed;
      --warn-border: #fdba74;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "IBM Plex Sans", "Segoe UI", "Helvetica Neue", sans-serif;
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.10), transparent 42%),
        linear-gradient(180deg, #f7faf8 0%, var(--bg) 40%);
      color: var(--ink);
      line-height: 1.55;
    }
    header.app-header {
      padding: 1.75rem clamp(1rem, 4vw, 3rem) 1.25rem;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface) 92%, transparent);
      backdrop-filter: blur(6px);
    }
    header.app-header h1 {
      margin: 0 0 0.4rem;
      font-size: clamp(1.45rem, 2.6vw, 1.9rem);
      letter-spacing: -0.02em;
    }
    .meta {
      color: var(--muted);
      font-size: 0.92rem;
      display: flex;
      flex-wrap: wrap;
      gap: 0.35rem 1.25rem;
    }
    .meta strong { color: var(--ink); font-weight: 600; }
    main {
      max-width: 58rem;
      margin: 0 auto;
      padding: 1.25rem clamp(1rem, 4vw, 3rem) 3rem;
      display: grid;
      gap: 1rem;
    }
    .preamble {
      margin: 0;
      color: var(--muted);
      font-size: 0.92rem;
    }
    .banner.warn {
      background: var(--warn-bg);
      border: 1px solid var(--warn-border);
      border-radius: 10px;
      padding: 0.75rem 1rem;
      font-size: 0.92rem;
    }
    .summary-panel, .detector {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      padding: 1rem 1.15rem 1.15rem;
      box-shadow: 0 1px 0 rgba(20, 32, 27, 0.03);
    }
    .summary-title, .detector-head {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 0.6rem 1rem;
      margin-bottom: 0.85rem;
    }
    .summary-title h2, .detector-head h2 {
      margin: 0;
      font-size: 1.15rem;
      letter-spacing: -0.01em;
    }
    .badges { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .badge {
      display: inline-flex;
      align-items: center;
      font-size: 0.75rem;
      font-weight: 650;
      letter-spacing: 0.01em;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      border: 1px solid transparent;
      text-transform: capitalize;
    }
    .impact-high { color: var(--high); background: var(--high-bg); border-color: #fecaca; }
    .impact-medium { color: var(--medium); background: var(--medium-bg); border-color: #fed7aa; }
    .impact-low { color: var(--low); background: var(--low-bg); border-color: #bfdbfe; }
    .impact-info, .impact-unknown { color: var(--info); background: var(--info-bg); border-color: #cbd5e1; }
    .badge-conf { color: #0f766e; background: var(--accent-soft); border-color: #99f6e4; text-transform: none; }
    .badge-count { color: var(--muted); background: #f8faf9; border-color: var(--border); text-transform: none; }
    .summary-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.95rem;
    }
    .summary-table th, .summary-table td {
      text-align: left;
      padding: 0.55rem 0.4rem;
      border-bottom: 1px solid var(--border);
      vertical-align: middle;
    }
    .summary-table th {
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      font-weight: 650;
    }
    .summary-table tr:last-child td { border-bottom: 0; }
    .summary-table .num { width: 4rem; font-variant-numeric: tabular-nums; }
    .findings { display: grid; gap: 0.75rem; }
    .finding {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #fbfcfc;
      overflow: hidden;
    }
    .finding-head {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.45rem 0.75rem;
      background: #f3f6f4;
      border-bottom: 1px solid var(--border);
    }
    .finding-id {
      font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.82rem;
      font-weight: 650;
      color: var(--accent);
    }
    .finding-body { padding: 0.75rem 0.85rem 0.9rem; }
    .finding-body p { margin: 0 0 0.65rem; }
    .finding-body p:last-child { margin-bottom: 0; }
    a { color: var(--accent); }
    a.src-link, a.src-chip {
      font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.86em;
      text-decoration: none;
      border-bottom: 1px dashed color-mix(in srgb, var(--accent) 45%, transparent);
    }
    a.src-chip {
      display: inline-block;
      background: var(--code-bg);
      border: 1px solid var(--border);
      border-bottom-style: solid;
      border-radius: 6px;
      padding: 0.15rem 0.45rem;
    }
    a.src-link:hover, a.src-chip:hover { border-bottom-style: solid; }
    code {
      font-family: "IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace;
      font-size: 0.88em;
      background: var(--code-bg);
      padding: 0.1em 0.35em;
      border-radius: 4px;
    }
    .muted { color: var(--muted); }
    @media (max-width: 640px) {
      .summary-table th:nth-child(2),
      .summary-table td:nth-child(2) { display: none; }
    }
  </style>
</head>
<body>
  <header class="app-header">
    <h1>Reporte Slither</h1>
    <div class="meta">
      <div><strong>Generado</strong> ${escapeHtml(generatedAt)}</div>
      ${repo ? `<div><strong>Repo</strong> ${escapeHtml(repo)}</div>` : ""}
      ${sha ? `<div><strong>Commit</strong> <code>${escapeHtml(sha.slice(0, 12))}</code></div>` : ""}
      ${runId ? `<div><strong>Run</strong> ${escapeHtml(runId)}</div>` : ""}
    </div>
  </header>
  <main>
${body}
  </main>
</body>
</html>
`;

fs.writeFileSync(htmlFile, htmlDocument, "utf8");

console.log(`Wrote ${mdFile}`);
console.log(`Wrote ${jsonFile}`);
console.log(`Wrote ${htmlFile}`);
