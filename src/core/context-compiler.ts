import type { RecallStore } from "./store.js";
import type { RecallNode } from "./types.js";

export interface ContextCompileOptions {
  task: string;
  budgetWords: number;
  includeConflicts?: boolean;
  includeStaleWarnings?: boolean;
  includeNextActions?: boolean;
}

export interface ContextPacket {
  objective: string;
  relevantMemory: string[];
  activeBeliefs: string[];
  conflicts: string[];
  risks: string[];
  tasks: string[];
  staleOrLowTrust: string[];
  suggestedNextActions: string[];
  expansionHandles: string[];
  wordCount: number;
}

export function compileContext(store: RecallStore, options: ContextCompileOptions): ContextPacket {
  const budget = Math.max(80, options.budgetWords);
  const nodes = store.search(options.task, 30);

  const packet: ContextPacket = {
    objective: trimWords(options.task, 40),
    relevantMemory: [],
    activeBeliefs: [],
    conflicts: [],
    risks: [],
    tasks: [],
    staleOrLowTrust: [],
    suggestedNextActions: [],
    expansionHandles: [],
    wordCount: 0
  };

  for (const node of nodes) {
    placeNode(packet, node);
    packet.expansionHandles.push(node.cellAddress);
    packet.wordCount = countPacketWords(packet);
    if (packet.wordCount >= budget) {
      break;
    }
  }

  if (options.includeNextActions !== false && packet.suggestedNextActions.length === 0) {
    packet.suggestedNextActions.push("Use recall search or expansion handles for more evidence before making durable claims.");
  }

  trimPacket(packet, budget);
  return packet;
}

export function formatContextPacket(packet: ContextPacket): string {
  return [
    `objective:\n${packet.objective}`,
    section("relevant_memory", packet.relevantMemory),
    section("active_beliefs", packet.activeBeliefs),
    section("conflicts", packet.conflicts),
    section("risks", packet.risks),
    section("tasks", packet.tasks),
    section("stale_or_low_trust", packet.staleOrLowTrust),
    section("suggested_next_actions", packet.suggestedNextActions),
    section("expansion_handles", packet.expansionHandles)
  ].join("\n\n");
}

function placeNode(packet: ContextPacket, node: RecallNode): void {
  const line = `${node.title}: ${node.summary ?? node.body} [${node.kind}:${node.id}]`;
  if (node.kind === "belief") {
    packet.activeBeliefs.push(line);
  } else if (node.kind === "contradiction") {
    packet.conflicts.push(line);
  } else if (node.kind === "risk") {
    packet.risks.push(line);
  } else if (node.kind === "task" || node.kind === "objective") {
    packet.tasks.push(line);
  } else {
    packet.relevantMemory.push(line);
  }

  const confidence = node.data.confidence as { source_quality?: string; stability?: string } | undefined;
  if (confidence?.source_quality === "unknown" || confidence?.stability === "ephemeral") {
    packet.staleOrLowTrust.push(`${node.title} has weak or temporary support [${node.kind}:${node.id}]`);
  }
}

function section(name: string, lines: string[]): string {
  return `${name}:\n${lines.length === 0 ? "- none" : lines.map((line) => `- ${line}`).join("\n")}`;
}

function trimPacket(packet: ContextPacket, budget: number): void {
  const sections: (keyof Pick<
    ContextPacket,
    | "relevantMemory"
    | "activeBeliefs"
    | "conflicts"
    | "risks"
    | "tasks"
    | "staleOrLowTrust"
    | "suggestedNextActions"
    | "expansionHandles"
  >)[] = [
    "relevantMemory",
    "activeBeliefs",
    "conflicts",
    "risks",
    "tasks",
    "staleOrLowTrust",
    "suggestedNextActions",
    "expansionHandles"
  ];

  while (countPacketWords(packet) > budget) {
    const sectionToTrim = sections.find((key) => packet[key].length > 1);
    if (!sectionToTrim) {
      break;
    }
    packet[sectionToTrim].pop();
  }
  packet.wordCount = countPacketWords(packet);
}

function countPacketWords(packet: ContextPacket): number {
  return [
    packet.objective,
    ...packet.relevantMemory,
    ...packet.activeBeliefs,
    ...packet.conflicts,
    ...packet.risks,
    ...packet.tasks,
    ...packet.staleOrLowTrust,
    ...packet.suggestedNextActions,
    ...packet.expansionHandles
  ].reduce((total, text) => total + countWords(text), 0);
}

function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

function trimWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return `${words.slice(0, maxWords).join(" ")}...`;
}
