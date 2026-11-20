import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ask } from "../src/ask/ask.js";
import { buildGraph, tierOf } from "../src/graph/build.js";
import { checkGraph } from "../src/graph/check.js";
import { ensureFreshGraph } from "../src/graph/refresh.js";
import { resolveEdges } from "../src/graph/resolve.js";
import { isClean, probeDrift } from "../src/graph/fingerprint.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { ExtractResult, RawEdge } from "../src/graph/extract.js";
import type { NodeV1 } from "../src/graph/types.js";
import { supportedExtensions, unsupportedExtensions } from "../src/graph/source-files.js";
import { runCli, tmpRepo } from "./helpers.js";

const markdownModulePath: string = "../src/graph/markdown.js";
const loadedMarkdown: unknown = await import(markdownModulePath).catch(() => null);

function markdownExtractor(value: unknown): value is { extractMarkdown: (rel: string, source: string) => ExtractResult } {
  return typeof value === "object" && value !== null
    && typeof (value as Record<string, unknown>).extractMarkdown === "function";
}

function extractMarkdown(rel: string, source: string): ExtractResult {
  if (!markdownExtractor(loadedMarkdown)) throw new Error("Markdown extractor is not available");
  return loadedMarkdown.extractMarkdown(rel, source);
}

function graphOf(files: Record<string, string>): { nodes: NodeV1[]; rawEdges: RawEdge[]; edges: ReturnType<typeof resolveEdges> } {
  const nodes: NodeV1[] = [];
  const rawEdges: RawEdge[] = [];
  for (const [path, source] of Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) {
    const extracted = extractMarkdown(path, source);
    nodes.push(...extracted.nodes);
    rawEdges.push(...extracted.rawEdges);
  }
  return { nodes, rawEdges, edges: resolveEdges(nodes, rawEdges) };
}

function references(graph: ReturnType<typeof graphOf>): Array<{ source: string; target: string; confidence: string }> {
  return graph.edges
    .filter((edge) => edge.relation === "references")
    .map(({ source, target, confidence }) => ({ source, target, confidence }))
    .sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

function filePaths(dir: string): string[] {
  const graph = readGraph(wiringPath(join(dir, "graft")));
  assert.ok(graph, "expected a built graph");
  return graph.nodes.filter((node) => node.kind === "file").map((node) => node.path).sort();
}

test("headings nest by level, keep bounded spans, and disambiguate duplicate ids", () => {
  const { nodes, rawEdges } = extractMarkdown("note.md", [
    "# Root",
    "Root intro.",
    "## Branch",
    "Branch body.",
    "#### Deep",
    "Deep body.",
    "## Branch",
    "Second body.",
    "# Last",
    "last body.",
  ].join("\n"));
  const sections = nodes.filter((node) => node.kind === "section");
  assert.equal(sections[0]?.origin, "doc");
  assert.deepEqual(sections.map((node) => node.id), [
    "note.md#Root", "note.md#Branch", "note.md#Deep", "note.md#Branch~2", "note.md#Last",
  ]);
  assert.equal(sections[0]?.span, "L1-L8");
  assert.equal(sections[1]?.span, "L3-L6");
  assert.equal(sections[2]?.span, "L5-L6");
  assert.equal(sections[3]?.span, "L7-L8");
  assert.equal(sections[1]?.signature, "## Branch");
  assert.equal(sections[2]?.body_text, "Deep body.");
  assert.deepEqual(rawEdges.filter((edge) => edge.relation === "contains").map((edge) => [edge.source, edge.targetId]), [
    ["note.md", "note.md#Root"],
    ["note.md#Root", "note.md#Branch"],
    ["note.md#Branch", "note.md#Deep"],
    ["note.md#Root", "note.md#Branch~2"],
    ["note.md", "note.md#Last"],
  ]);

  const long = extractMarkdown("long.md", `# Topic\n${"x".repeat(6000)}`);
  assert.equal(long.nodes.find((node) => node.kind === "section")?.body_text?.length, 5000);
  const longIntro = extractMarkdown("intro.md", "y".repeat(6000) + "\n# Topic");
  assert.equal(longIntro.nodes.find((node) => node.kind === "file")?.body_text?.length, 5000);
});

test("frontmatter and fenced code are excluded while metadata and introduction stay searchable", () => {
  const source = [
    "---",
    'title: "Recovery Guide"',
    "aliases:",
    "  - Salt Cycle",
    "  - Membrane Notes",
    "tags: [brine, thermal]",
    "---",
    "Introductory material stays on the page node.",
    "````text",
    "# Fenced backtick heading",
    "[[hidden]]",
    "```",
    "````",
    "~~~~~~text",
    "# Fenced tilde heading",
    "~~~~~~",
    "# Actual",
    "Visible section body.",
  ].join("\n");
  const result = extractMarkdown("guide.md", source);
  const file = result.nodes.find((node) => node.kind === "file");
  assert.ok(file?.body_text);
  for (const word of ["Recovery Guide", "Salt Cycle", "Membrane Notes", "brine", "thermal", "Introductory material"]) {
    assert.ok(file.body_text.includes(word), `file body should include ${word}`);
  }
  assert.ok(!file.body_text.includes("title:"));
  assert.deepEqual(result.nodes.filter((node) => node.kind === "section").map((node) => node.name), ["Actual"]);
  assert.equal(result.rawEdges.filter((edge) => edge.relation === "references").length, 0);
});

test("Obsidian links, embeds, relative links, anchors, and definitions resolve from their containing section", () => {
  const graph = graphOf({
    "guide/index.md": [
      "[[A]]",
      "## Links",
      "[[A|alias]]",
      "[[A#Heading]]",
      "![[folder/B]]",
      "[[folder/B#Target]]",
      "[relative](./A.md)",
      "[anchored](./A.md#Heading)",
      "[up](../shared/Guide.markdown#Overview)",
      "[definition]: ../shared/Guide.markdown",
    ].join("\n"),
    "guide/A.md": "# Heading\nA body.\n",
    "guide/folder/B.md": "# Target\nB body.\n",
    "shared/Guide.markdown": "# Overview\nShared body.\n",
  });
  assert.deepEqual(references(graph), [
    { source: "guide/index.md", target: "guide/A.md", confidence: "extracted" },
    { source: "guide/index.md#Links", target: "guide/A.md", confidence: "extracted" },
    { source: "guide/index.md#Links", target: "guide/A.md#Heading", confidence: "extracted" },
    { source: "guide/index.md#Links", target: "guide/folder/B.md", confidence: "extracted" },
    { source: "guide/index.md#Links", target: "guide/folder/B.md#Target", confidence: "extracted" },
    { source: "guide/index.md#Links", target: "shared/Guide.markdown", confidence: "extracted" },
    { source: "guide/index.md#Links", target: "shared/Guide.markdown#Overview", confidence: "extracted" },
  ]);
});

test("ambiguous bare wikilinks drop while a unique path suffix resolves", () => {
  const graph = graphOf({
    "index.md": "[[Same]] [[folder/Same]]",
    "left/Same.md": "Left page.",
    "right/folder/Same.markdown": "Right page.",
    "unique.md": "[[target]]",
    "other/Target.md": "Target page.",
  });
  assert.deepEqual(references(graph), [
    { source: "index.md", target: "right/folder/Same.markdown", confidence: "extracted" },
    { source: "unique.md", target: "other/Target.md", confidence: "extracted" },
  ]);
});

test("an ambiguous heading fragment falls back to its unique page", () => {
  const graph = graphOf({
    "index.md": "[[target#Part]]",
    "target.md": "## Part\nFirst.\n## Part\nSecond.",
  });
  assert.deepEqual(references(graph), [
    { source: "index.md", target: "target.md", confidence: "extracted" },
  ]);
});

test("external, in-page, fenced, inline-code, and attachment links are skipped", () => {
  const graph = graphOf({
    "index.md": [
      "# Links",
      "[web](https://example.test/target.md)",
      "[plain web](http://example.test/target.md)",
      "[mail](mailto:target@example.test)",
      "[anchor](#top)",
      "[[#Top]]",
      "`[inline](./target.md) [[Target]]`",
      String.fromCharCode(96),
      "[multiline code](./target.md) [[Target]]",
      String.fromCharCode(96),
      "````text",
      "[fenced](./target.md)",
      "[[Target]]",
      "````",
      "![[figure.png]]",
      "![[recording.pdf]]",
      "![image syntax](./target.md)",
    ].join("\n"),
    "target.md": "# Target\nTarget body.",
  });
  assert.deepEqual(references(graph), []);
});

test("Markdown stays opt-in, extension filters persist through check and freshness", async () => {
  const dir = tmpRepo("graph-markdown-extensions");
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const value = 1;\n");
  writeFileSync(join(dir, "README.md"), "# Notes\nA short page.\n");
  writeFileSync(join(dir, "extra.markdown"), "# Extra\nAnother page.\n");
  try {
    await buildGraph(dir);
    assert.deepEqual(filePaths(dir), ["src/a.ts"]);
    assert.ok(!readGraph(wiringPath(join(dir, "graft")))?.nodes.some((node) => node.kind === "section"));
    assert.ok(isClean(probeDrift(dir, join(dir, "graft"))!));
    assert.equal((await checkGraph(dir)).ok, true);

    await buildGraph(dir, { extensions: [".ts", ".md"] });
    assert.deepEqual(filePaths(dir), ["README.md", "src/a.ts"]);
    assert.deepEqual(readGraph(wiringPath(join(dir, "graft")))?.meta.extensions, [".md", ".ts"]);
    assert.ok(isClean(probeDrift(dir, join(dir, "graft"))!));
    assert.equal((await checkGraph(dir)).ok, true);

    const cli = runCli(["build", dir, "-e", ".md"]);
    assert.equal(cli.status, 0, cli.describe());
    assert.doesNotMatch(cli.stderr ?? "", /no parser registered|unsupported extension/i);
    assert.deepEqual(filePaths(dir), ["README.md"]);
    assert.deepEqual(readGraph(wiringPath(join(dir, "graft")))?.meta.extensions, [".md"]);
    assert.ok(isClean(probeDrift(dir, join(dir, "graft"))!));
    assert.equal((await checkGraph(dir)).ok, true);
    assert.equal((await ensureFreshGraph(dir)).refreshed, false);
    assert.deepEqual(filePaths(dir), ["README.md"]);

    await buildGraph(dir, { extensions: [".markdown"] });
    assert.deepEqual(filePaths(dir), ["extra.markdown"]);
    assert.equal((await checkGraph(dir)).ok, true);
    assert.ok(supportedExtensions().includes(".md"));
    assert.ok(supportedExtensions().includes(".markdown"));
    assert.equal(tierOf("note.md").markdown, true);
    assert.equal(tierOf("note.markdown").markdown, true);
    assert.equal(tierOf("src/a.ts").markdown, false);
    assert.deepEqual(unsupportedExtensions([".md", ".markdown"]), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lexical ask ranks a matching note section by its body text", async () => {
  const dir = tmpRepo("graph-markdown-ask");
  mkdirSync(join(dir, "notes"), { recursive: true });
  const notes: Record<string, string> = {
    "notes/measure.md": "# Field Record\n## Observations\nThe ceramic membrane delays salt crystallization during pressure cycling when brine cools slowly.\n",
    "notes/one.md": "# General Notes\n## Overview\nA concise record about routine maintenance and storage.\n",
    "notes/two.md": "# General Notes\n## Overview\nThe schedule covers inspection dates and spare parts.\n",
    "notes/three.md": "# General Notes\n## Overview\nThis page tracks assembly steps and ordinary cleaning.\n",
    "notes/four.md": "# General Notes\n## Overview\nThe inventory lists containers, seals, and basic tools.\n",
    "notes/five.md": "# General Notes\n## Overview\nA short summary of setup, handling, and daily checks.\n",
  };
  try {
    for (const [path, text] of Object.entries(notes)) writeFileSync(join(dir, path), text);
    await buildGraph(dir, { extensions: [".md"] });
    const result = ask(dir, "ceramic membrane salt crystallization pressure cycling", { limit: 10 });
    assert.ok(result.hits.length > 0, "the query should find an indexed note section");
    assert.equal(result.hits[0]?.pointer, "notes/measure.md:L2-L4");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
