/** Deterministic Markdown pages, sections, and note-to-note references. */
import { extname, posix } from "node:path";
import { contentHash } from "../util/id.js";
import { mintId, type ExtractResult, type RawEdge } from "./extract.js";
import type { NodeV1 } from "./types.js";

const MAX_BODY_CHARS = 5000;
const EXTENSIONS = [".md", ".markdown"] as const;

export function markdownExtensions(): string[] {
  return [...EXTENSIONS];
}

export function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export function markdownLabelOf(path: string): string | null {
  return isMarkdownPath(path) ? "markdown" : null;
}

interface Frontmatter {
  contentStart: number;
  values: string[];
}

interface Fence {
  marker: "`" | "~";
  length: number;
}

interface Heading {
  node: NodeV1;
  level: number;
  startLine: number;
  endLine: number;
}

interface LinkTarget {
  kind: "wikilink" | "relative";
  target: string;
  heading?: string;
}

function unquote(value: string): string {
  const text = value.trim();
  if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
    const inner = text.slice(1, -1);
    return text[0] === "'" ? inner.replace(/''/g, "'") : inner.replace(/\\([\\"])/g, "$1");
  }
  return text;
}

function splitYamlList(value: string): string[] {
  const text = value.trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return [unquote(text)];
  return text.slice(1, -1).split(",").map(unquote).filter(Boolean);
}

function readFrontmatter(lines: string[]): Frontmatter {
  if (lines[0]?.replace(/^\uFEFF/, "").trim() !== "---") return { contentStart: 0, values: [] };
  let close = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close < 0) return { contentStart: 0, values: [] };

  const values: string[] = [];
  let listKey: "aliases" | "tags" | null = null;
  for (let i = 1; i < close; i++) {
    const line = lines[i] ?? "";
    const field = /^([A-Za-z][\w-]*):(?:[ \t]*(.*))?$/.exec(line);
    if (field) {
      const key = field[1]!.toLowerCase();
      const value = field[2] ?? "";
      if (key === "title") {
        values.push(...splitYamlList(value));
        listKey = null;
      } else if (key === "aliases" || key === "tags") {
        if (value.trim()) values.push(...splitYamlList(value));
        listKey = key;
      } else {
        listKey = null;
      }
      continue;
    }
    const item = /^\s+-\s*(.*?)\s*$/.exec(line);
    if (item && listKey) values.push(unquote(item[1] ?? ""));
    else if (line.trim()) listKey = null;
  }
  return { contentStart: close + 1, values: values.filter(Boolean) };
}

function normalizedBody(lines: string[], start: number, end: number, prefix: string[] = []): string {
  let output = "";
  let pendingSpace = false;
  const consume = (part: string): boolean => {
    for (const character of part) {
      if (/\s/u.test(character)) {
        if (output.length > 0) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        output += " ";
        pendingSpace = false;
      }
      output += character;
      if (output.length >= MAX_BODY_CHARS) {
        output = output.slice(0, MAX_BODY_CHARS);
        return true;
      }
    }
    if (output.length > 0) pendingSpace = true;
    return false;
  };

  for (const value of prefix) if (consume(value)) return output;
  for (let i = start; i <= end && i < lines.length; i++) if (consume(lines[i] ?? "")) return output;
  return output;
}

function lineOffsets(source: string, lines: string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length;
    if (source.startsWith("\r\n", offset)) offset += 2;
    else if (offset < source.length) offset += 1;
  }
  return offsets;
}

function lineEnd(source: string, lines: string[], offsets: number[], index: number): number {
  const start = offsets[index] ?? source.length;
  const end = start + (lines[index]?.length ?? 0);
  return Math.min(end, source.length);
}

function fenceOf(line: string): Fence | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return { marker: match[1]![0] as Fence["marker"], length: match[1]!.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return !!match && match[1]![0] === fence.marker && match[1]!.length >= fence.length;
}

function runAt(line: string, start: number): number {
  let end = start;
  while (line[end] === "`") end++;
  return end - start;
}

function closingRun(line: string, from: number, length: number): number {
  for (let i = line.indexOf("`", from); i >= 0; i = line.indexOf("`", i + 1)) {
    const run = runAt(line, i);
    if (run === length) return i + run;
    i += run - 1;
  }
  return -1;
}

function maskInlineCode(line: string, activeRun: number | null): { line: string; activeRun: number | null } {
  const chars = line.split("");
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      i++;
      continue;
    }
    const run = runAt(line, i);
    if (activeRun === null) {
      const end = closingRun(line, i + run, run);
      if (end < 0) {
        for (let j = i; j < chars.length; j++) chars[j] = " ";
        return { line: chars.join(""), activeRun: run };
      }
      for (let j = i; j < end; j++) chars[j] = " ";
      i = end;
      continue;
    }
    if (run !== activeRun) {
      for (let j = i; j < i + run; j++) chars[j] = " ";
      i += run;
      continue;
    }
    for (let j = i; j < i + run; j++) chars[j] = " ";
    activeRun = null;
    i += run;
  }
  if (activeRun !== null) for (let j = 0; j < chars.length; j++) chars[j] = " ";
  return { line: chars.join(""), activeRun };
}

function headingOf(line: string): { level: number; name: string } | null {
  const match = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line);
  if (!match) return null;
  const name = (match[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
  return { level: match[1]!.length, name };
}

function eligibleLink(raw: string, kind: LinkTarget["kind"]): LinkTarget | null {
  const value = kind === "wikilink" ? raw.split("|", 1)[0]!.trim() : raw.trim();
  const hashAt = value.indexOf("#");
  const target = (hashAt < 0 ? value : value.slice(0, hashAt)).trim();
  const heading = hashAt < 0 ? undefined : value.slice(hashAt + 1).trim();
  if (!target || target.startsWith("//") || /^[A-Za-z][A-Za-z\d+.-]*:/.test(target)) return null;

  const path = target.split("?", 1)[0] ?? target;
  if (kind === "relative") {
    if (path.startsWith("/")) return null;
    const extension = extname(path).toLowerCase();
    if (!EXTENSIONS.includes(extension as (typeof EXTENSIONS)[number])) return null;
  } else {
    const extension = extname(path).toLowerCase();
    if (extension && !EXTENSIONS.includes(extension as (typeof EXTENSIONS)[number])) return null;
  }
  return { kind, target, ...(heading ? { heading } : {}) };
}

function collectLinks(line: string): LinkTarget[] {
  const links: LinkTarget[] = [];
  for (const match of line.matchAll(/!?\[\[([^\]]+)\]\]/g)) {
    const link = eligibleLink(match[1] ?? "", "wikilink");
    if (link) links.push(link);
  }
  for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+[^)]*)?\)/g)) {
    if (match[0]?.startsWith("!")) continue;
    const destination = (match[1] ?? "").replace(/^<|>$/g, "");
    const link = eligibleLink(destination, "relative");
    if (link) links.push(link);
  }
  const definition = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|[^\s]+)/.exec(line);
  if (definition) {
    const destination = (definition[1] ?? "").replace(/^<|>$/g, "");
    const link = eligibleLink(destination, "relative");
    if (link) links.push(link);
  }
  return links;
}

function nodeSpan(startLine: number, endLine: number): string {
  return `L${startLine + 1}-L${Math.max(startLine, endLine) + 1}`;
}

export function extractMarkdown(rel: string, source: string): ExtractResult {
  const lines = source.split(/\r\n|\n|\r/);
  const offsets = lineOffsets(source, lines);
  const frontmatter = readFrontmatter(lines);
  const fileNode: NodeV1 = {
    id: rel,
    name: posix.basename(rel),
    kind: "file",
    path: rel,
    span: nodeSpan(0, lines.length - 1),
    signature: null,
    exported: true,
    origin: "doc",
    body_hash: contentHash(source),
    chars: source.length,
    body_text: "",
    summary_state: "pending",
    summary: null,
    crux: null,
  };
  const nodes: NodeV1[] = [fileNode];
  const rawEdges: RawEdge[] = [];
  const minted = new Set<string>([rel]);
  const headings: Heading[] = [];
  const stack: Heading[] = [];
  let firstHeadingLine = lines.length;
  let fence: Fence | null = null;
  let inlineCodeRun: number | null = null;

  for (let i = frontmatter.contentStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      inlineCodeRun = null;
      continue;
    }
    const openingFence = fenceOf(line);
    if (openingFence) {
      fence = openingFence;
      inlineCodeRun = null;
      continue;
    }

    const heading = headingOf(line);
    if (heading) {
      firstHeadingLine = Math.min(firstHeadingLine, i);
      while (stack.length && stack[stack.length - 1]!.level >= heading.level) {
        stack[stack.length - 1]!.endLine = i - 1;
        stack.pop();
      }
      const parent = stack[stack.length - 1];
      const id = mintId(`${rel}#${heading.name}`, minted);
      const node: NodeV1 = {
        id,
        name: heading.name,
        kind: "section",
        path: rel,
        span: nodeSpan(i, i),
        signature: line,
        exported: true,
        origin: "doc",
        body_hash: "",
        body_text: "",
        summary_state: "pending",
        summary: null,
        crux: null,
      };
      const section: Heading = { node, level: heading.level, startLine: i, endLine: lines.length - 1 };
      headings.push(section);
      stack.push(section);
      nodes.push(node);
      rawEdges.push({ source: parent?.node.id ?? rel, targetId: id, relation: "contains", file: rel });
    }

    const masked = maskInlineCode(line, inlineCodeRun);
    inlineCodeRun = masked.activeRun;
    const sourceId = stack[stack.length - 1]?.node.id ?? rel;
    for (const link of collectLinks(masked.line)) {
      const edge: RawEdge = {
        source: sourceId,
        relation: "references",
        file: rel,
        markdownLink: { kind: link.kind, target: link.target, ...(link.heading ? { heading: link.heading } : {}) },
      };
      rawEdges.push(edge);
    }
  }

  for (const section of headings) {
    const { startLine, endLine, node } = section;
    node.span = nodeSpan(startLine, endLine);
    node.body_hash = contentHash(source.slice(offsets[startLine] ?? 0, lineEnd(source, lines, offsets, endLine)));
    node.body_text = normalizedBody(lines, startLine + 1, endLine);
  }
  fileNode.body_text = normalizedBody(lines, frontmatter.contentStart, firstHeadingLine - 1, frontmatter.values);
  return { nodes, rawEdges };
}
