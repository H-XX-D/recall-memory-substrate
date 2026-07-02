// R7 Codex integration helpers. Pure text/config transforms only; filesystem
// sync and CLI command wiring belong to R8.
import { mergeRecallDirective, recallDirectiveBlock, recallSlashPrompt } from "./agent-integration.js";

const MCP_NAME = "recall";

export function recallAgentsBlock(): string {
  return recallDirectiveBlock();
}

export function mergeAgentsMd(existing: string | undefined | null): { next: string; changed: boolean } {
  return mergeRecallDirective(existing);
}

export { recallSlashPrompt };

export function recallMcpToml(mcpCommand: string, recallDb?: string): string {
  let text = `[mcp_servers.${MCP_NAME}]\ncommand = ${JSON.stringify(mcpCommand)}\n`;
  if (recallDb) {
    text += `\n[mcp_servers.${MCP_NAME}.env]\nRECALL_DB = ${JSON.stringify(recallDb)}\n`;
  }
  return text;
}

export function upsertCodexMcpServer(
  tomlText: string | undefined | null,
  opts: { mcpCommand: string; recallDb?: string },
): { next: string; changed: boolean } {
  const prior = tomlText ?? "";
  const lines = prior.split("\n");
  const kept: string[] = [];
  let skippingRecallTable = false;
  let inTopLevel = true;

  for (const line of lines) {
    const header = tableHeaderPath(line);
    if (header) {
      if (ownsRecallPath(header)) {
        skippingRecallTable = true;
        continue;
      }
      skippingRecallTable = false;
      inTopLevel = false;
      kept.push(line);
      continue;
    }
    if (skippingRecallTable) continue;
    if (inTopLevel) {
      const eq = line.indexOf("=");
      if (eq >= 0 && ownsRecallPath(parseDottedPath(line.slice(0, eq)))) continue;
    }
    kept.push(line);
  }

  const body = kept.join("\n").replace(/\s+$/, "");
  const block = recallMcpToml(opts.mcpCommand, opts.recallDb);
  const next = body ? `${body}\n\n${block}` : block;
  return { next, changed: next !== prior };
}

function tableHeaderPath(line: string): string[] | null {
  const match = line.trim().match(/^\[([^\]]+)\]\s*(#.*)?$/);
  return match ? parseDottedPath(match[1] ?? "") : null;
}

function parseDottedPath(value: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const ch of value) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === ".") {
      if (current.trim()) out.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function ownsRecallPath(path: string[]): boolean {
  return path[0] === "mcp_servers" && path[1] === MCP_NAME;
}
