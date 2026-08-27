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
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inlineMarkdown(text) {
  let result = escapeHtml(text);
  result = result.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a href="$2" rel="noopener noreferrer">$1</a>'
  );
  result = result.replace(/`([^`]+)`/g, "<code>$1</code>");
  result = result.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return result;
}

function markdownToHtml(md) {
  if (!md.trim()) {
    return "<p><em>No se capturó salida de Slither.</em></p>";
  }

  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let inList = false;
  let inCode = false;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${inlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!inList) return;
    html.push("</ul>");
    inList = false;
  };

  for (const line of lines) {
    if (line.startsWith("```")) {
      flushParagraph();
      closeList();
      if (inCode) {
        html.push("</code></pre>");
        inCode = false;
      } else {
        html.push("<pre><code>");
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      html.push(`${escapeHtml(line)}\n`);
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = /^[-*]\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      if (!inList) {
        html.push("<ul>");
        inList = true;
      }
      html.push(`<li>${inlineMarkdown(listItem[1])}</li>`);
      continue;
    }

    if (line.trim() === "") {
      flushParagraph();
      closeList();
      continue;
    }

    closeList();
    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();
  if (inCode) {
    html.push("</code></pre>");
  }

  return html.join("\n");
}

function loadNativeSlitherJson() {
  const candidates = [nativeJsonFile, jsonFile];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      return JSON.parse(fs.readFileSync(candidate, "utf8"));
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

function loadGateConfig() {
  const configPath = path.join(process.cwd(), "slither.config.json");
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

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

const body = markdownToHtml(markdown);
const htmlDocument = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Slither — reporte de auditoría</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ef;
      --surface: #ffffff;
      --ink: #1c1917;
      --muted: #57534e;
      --accent: #0f766e;
      --border: #e7e5e4;
      --code-bg: #f5f5f4;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", "Helvetica Neue", Arial, sans-serif;
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.08), transparent 40%),
        var(--bg);
      color: var(--ink);
      line-height: 1.55;
    }
    header {
      padding: 2rem clamp(1rem, 4vw, 3rem) 1rem;
      border-bottom: 1px solid var(--border);
      background: color-mix(in srgb, var(--surface) 88%, transparent);
    }
    h1 {
      margin: 0 0 0.35rem;
      font-size: clamp(1.5rem, 3vw, 2rem);
      letter-spacing: -0.02em;
    }
    .meta {
      color: var(--muted);
      font-size: 0.95rem;
      display: grid;
      gap: 0.25rem;
    }
    main {
      max-width: 56rem;
      margin: 0 auto;
      padding: 1.5rem clamp(1rem, 4vw, 3rem) 3rem;
    }
    .report {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 1.25rem 1.5rem;
    }
    h2, h3 { margin-top: 1.5rem; }
    a { color: var(--accent); }
    code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 0.9em;
      background: var(--code-bg);
      padding: 0.1em 0.35em;
      border-radius: 4px;
    }
    pre {
      overflow-x: auto;
      background: var(--code-bg);
      padding: 1rem;
      border-radius: 8px;
    }
    pre code {
      padding: 0;
      background: transparent;
    }
    ul { padding-left: 1.25rem; }
    li { margin: 0.35rem 0; }
  </style>
</head>
<body>
  <header>
    <h1>Reporte Slither</h1>
    <div class="meta">
      <div>Generado: ${escapeHtml(generatedAt)}</div>
      ${repo ? `<div>Repositorio: ${escapeHtml(repo)}</div>` : ""}
      ${sha ? `<div>Commit: ${escapeHtml(sha.slice(0, 12))}</div>` : ""}
      ${runId ? `<div>GitHub Actions run: ${escapeHtml(runId)}</div>` : ""}
    </div>
  </header>
  <main>
    <article class="report">
${body}
    </article>
  </main>
</body>
</html>
`;

fs.writeFileSync(htmlFile, htmlDocument, "utf8");

console.log(`Wrote ${mdFile}`);
console.log(`Wrote ${jsonFile}`);
console.log(`Wrote ${htmlFile}`);
