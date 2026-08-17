import type { Address, Hex } from 'viem';

/**
 * The thing a guardian has to keep between the two halves of a recovery.
 *
 * A recovery on an account with a waiting period does not execute — it queues.
 * The contract stores only `keccak(target, value, keccak(data), nonce)`, so
 * finishing it days later means presenting those four values again, byte for
 * byte. Recompute the batch with one token in a different order, or against a
 * nonce that has since moved, and the hash is different and the chain has never
 * heard of it. The funds are not lost, but nobody can prove what was queued.
 *
 * So the payload is saved rather than rebuilt: to `localStorage` for the common
 * case, and as copyable JSON for the case that actually matters — the guardian
 * comes back on a different machine, in a different browser, after clearing
 * their history, on the day it finally becomes executable.
 */

export const TICKET_VERSION = 1;

export interface RecoveryTicket {
  version: number;
  chainId: number;
  /** The lost account — both the verifying contract and the call target. */
  account: Address;
  /** `batch(...)` calldata: the sweep itself. */
  data: Hex;
  /** Baked into the digest; the recovery is void if the account's nonce moves past it. */
  nonce: number;
  /** Where the assets were sent, kept for display so the guardian can check it. */
  destination: Address;
  /** The digest the contract stores. */
  hash: Hex;
  /** Unix seconds when `executeQueued` becomes callable, or 0 if it ran immediately. */
  eta: number;
  /** When this ticket was created, for display. */
  createdAt: number;
}

const KEY = 'nani.recovery.tickets.v1';

export function loadTickets(): RecoveryTicket[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecoveryTicket[];
    return Array.isArray(parsed) ? parsed.filter((t) => t.version === TICKET_VERSION) : [];
  } catch {
    return [];
  }
}

export function saveTicket(ticket: RecoveryTicket): void {
  const existing = loadTickets().filter((t) => t.hash !== ticket.hash);
  localStorage.setItem(KEY, JSON.stringify([ticket, ...existing].slice(0, 20)));
}

export function forgetTicket(hash: Hex): void {
  localStorage.setItem(KEY, JSON.stringify(loadTickets().filter((t) => t.hash !== hash)));
}

/** Human-readable export — what the guardian copies somewhere safe. */
export function exportTicket(ticket: RecoveryTicket): string {
  return JSON.stringify(ticket, null, 2);
}

/**
 * Read a ticket back, checking only what makes it usable.
 *
 * Deliberately not trusted beyond its shape: the hash is recomputed from the
 * fields before anything is submitted, so a tampered ticket produces a digest
 * the contract has no record of and simply fails, rather than sweeping to an
 * address the guardian did not choose.
 */
export function importTicket(text: string): RecoveryTicket | null {
  try {
    const parsed = JSON.parse(text) as RecoveryTicket;
    if (parsed.version !== TICKET_VERSION) return null;
    if (typeof parsed.chainId !== 'number' || typeof parsed.nonce !== 'number') return null;
    for (const field of ['account', 'data', 'destination', 'hash'] as const) {
      if (typeof parsed[field] !== 'string' || !parsed[field].startsWith('0x')) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function describeWait(eta: number, now = Math.floor(Date.now() / 1000)): string {
  if (eta === 0) return 'ready';
  const remaining = eta - now;
  if (remaining <= 0) return 'ready now';
  const days = Math.floor(remaining / 86_400);
  const hours = Math.floor((remaining % 86_400) / 3_600);
  const minutes = Math.floor((remaining % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
