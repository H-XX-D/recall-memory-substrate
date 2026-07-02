/**
 * Parse a `recall compile` text packet into the two things the harness needs at
 * UserPromptSubmit: the flagged ids (to arm the dig via TurnState.beginTurn) and
 * the push text (to return as additionalContext).
 *
 * Ids may be bare (project scope) or graph-prefixed (home/union scope under
 * model-A, e.g. `home:1750a919-...`). The flagging must match the 8-hex core
 * regardless of an optional `graph:` prefix, or the whole dig mechanism silently
 * dies at home scope. This is the TS twin of the Python build_mini_index.
 */

export interface ParsedPush {
  flaggedIds: string[];
  push: string;
}

const HEADER =
  "[Recall mini-index for THIS prompt (ids + titles only). You now know what exists, so do not ask or assert blind:]";
const DIG_LINE =
  'DIG REQUIRED: a row above is marked [SUPERSEDED?] or [STALE]; its title may be out of date. ' +
  'Run recall compile "<task>" and recall cell show <id> on it BEFORE you act on it.';

export function parseCompilePacket(packet: string): ParsedPush {
  const secs = sliceSections(packet, ["relevant_memory", "conflicts", "stale_or_low_trust"]);
  const rel = secs["relevant_memory"] ?? [];
  if (rel.length === 0) return { flaggedIds: [], push: "" };

  // 8-hex cores, matched regardless of an optional graph: prefix (model-A).
  const challenged = collectIds((secs["conflicts"] ?? []).join(" "), /->(?:[a-z0-9_-]+:)*([0-9a-f]{8})/g);
  const stale = collectIds((secs["stale_or_low_trust"] ?? []).join(" "), /stale:(?:[a-z0-9_-]+:)*([0-9a-f]{8})/g);

  const flaggedIds: string[] = [];
  const indexLines: string[] = [];
  let anyFlag = false;
  for (const ln of rel.slice(0, 5)) {
    const m = /\[([a-z_]+):((?:[a-z0-9_-]+:)*[0-9a-f]{8}[0-9a-f-]*)\]\s*$/.exec(ln);
    const fullId = m ? m[2] : "";
    const core = fullId ? /[0-9a-f]{8}/.exec(fullId.split(":").pop() ?? "") : null;
    const short = core ? core[0] : "";
    const cid = m ? `${m[1]}:${fullId}` : "";
    const body = ln.replace(/\s*\[[a-z_]+:[a-z0-9_:-]+\]\s*$/, "").replace(/^[-\s]+/, "").trim();
    let tag = "";
    if (short && stale.has(short)) {
      tag = "  [STALE]";
      anyFlag = true;
      flaggedIds.push(short);
    } else if (short && challenged.has(short)) {
      tag = "  [SUPERSEDED?]";
      anyFlag = true;
      flaggedIds.push(short);
    }
    indexLines.push(`- ${clip(body, 110)}` + (cid ? `  [${cid}]` : "") + tag);
  }

  const parts = [HEADER, ...indexLines];
  if (anyFlag) parts.push(DIG_LINE);
  return { flaggedIds, push: parts.join("\n") };
}

// Slice top-level `name:` sections out of a compile packet, dropping blanks and
// the literal "- none" placeholder. Mirrors the Python _sections helper.
function sliceSections(packet: string, names: string[]): Record<string, string[]> {
  const lines = packet.split("\n");
  const headers: Array<[number, string]> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([a-z_]+):\s*$/.exec(lines[i]);
    if (m) headers.push([i, m[1]]);
  }
  const out: Record<string, string[]> = {};
  for (let idx = 0; idx < headers.length; idx++) {
    const [i, name] = headers[idx];
    if (!names.includes(name)) continue;
    const end = idx + 1 < headers.length ? headers[idx + 1][0] : lines.length;
    out[name] = lines.slice(i + 1, end).filter((l) => l.trim() && l.trim() !== "- none");
  }
  return out;
}

function collectIds(text: string, re: RegExp): Set<string> {
  const out = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1]);
  return out;
}

function clip(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
