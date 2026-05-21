import type { ProposalScope, ProposalTags, WriteProposal } from "./types.js";

export const CELL_ADDRESS_PREFIX = "recall://cell";

export interface CellAddressParts {
  project: string;
  category: string;
  type: string;
  subject: string;
  idea: string;
  timestamp: string;
  id: string;
}

export function deriveCellAddress(proposal: WriteProposal, id: string): string {
  return makeCellAddress({
    project: first(proposal.tags.project) ?? proposal.scope.project,
    category: first(proposal.tags.category) ?? first(proposal.tags.topics) ?? "uncategorized",
    type: first(proposal.tags.type) ?? proposal.intent.kind,
    subject: first(proposal.tags.subject) ?? slug(proposal.content.title),
    idea: first(proposal.tags.idea) ?? "general",
    timestamp: first(proposal.tags.timestamp) ?? proposal.provenance.created_at.slice(0, 10),
    id
  });
}

export function makeCellAddress(parts: CellAddressParts): string {
  return [
    CELL_ADDRESS_PREFIX,
    encode(parts.project),
    encode(parts.category),
    encode(parts.type),
    encode(parts.subject),
    encode(parts.idea),
    encode(parts.timestamp),
    encode(parts.id)
  ].join("/");
}

export function parseCellAddress(address: string): CellAddressParts {
  const prefix = `${CELL_ADDRESS_PREFIX}/`;
  if (!address.startsWith(prefix)) {
    throw new Error(`Invalid cell address prefix: ${address}`);
  }
  const parts = address.slice(prefix.length).split("/");
  if (parts.length !== 7 || parts.some((part) => part.trim() === "")) {
    throw new Error(`Invalid cell address shape: ${address}`);
  }
  const [project, category, type, subject, idea, timestamp, id] = parts.map(decode);
  return { project, category, type, subject, idea, timestamp, id };
}

export function facetsFromAddress(address: string): Pick<ProposalTags, "category" | "type" | "subject" | "project" | "idea" | "timestamp"> {
  const parts = parseCellAddress(address);
  return {
    category: [parts.category],
    type: [parts.type],
    subject: [parts.subject],
    project: [parts.project],
    idea: [parts.idea],
    timestamp: [parts.timestamp]
  };
}

export function scopeFromAddress(address: string): Pick<ProposalScope, "project"> {
  return { project: parseCellAddress(address).project };
}

function first(values: string[] | undefined): string | undefined {
  return values?.find((value) => value.trim() !== "");
}

function encode(value: string): string {
  return encodeURIComponent(slug(value));
}

function decode(value: string): string {
  return decodeURIComponent(value);
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "unnamed";
}

