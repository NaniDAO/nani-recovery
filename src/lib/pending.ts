import { decodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from 'viem';
import { readQueued, transactionHash, type Chain } from './multisig';

/**
 * What is queued against an account, according to the chain.
 *
 * Local storage only knows what *this browser* started. A guardian who began a
 * recovery on their laptop and came back on a phone would see nothing; so would
 * an account holder wanting to check whether anyone has queued something
 * against them. Both of those are the same question, and the chain can answer
 * it either way.
 *
 * `Queued(bytes32 indexed txHash, uint256 nonce, uint256 eta)` carries no
 * payload, so finding out *what* was queued means pulling the calldata from the
 * transaction that queued it and re-deriving the digest. That calldata is
 * whatever a third party chose to submit, so a payload that doesn't hash to the
 * queued entry is reported as unverified rather than rendered as fact.
 */

const QUEUED_TOPIC = '0x51c73878bb39c9c6a51d06575b2b5c9a834b0d19fdabcafffd35907ee6fdcf39';

const EXECUTE = parseAbi([
  'function execute(address target, uint256 value, bytes data, bytes sigs) payable',
]);

const BLOCKSCOUT: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  10: 'https://optimism.blockscout.com',
};

export interface PendingRecovery {
  hash: Hex;
  /** Seconds since epoch when it becomes runnable. */
  eta: number;
  nonce: number;
  /** The `batch(...)` payload, when it could be recovered and verified. */
  data: Hex | null;
  /** True when the recovered payload hashes to the queued entry. */
  verified: boolean;
  /** The transaction that queued it, for a link out. */
  queuedBy: Hex | null;
}

interface LogRow {
  topics?: (string | null)[];
  data?: string;
  transaction_hash?: string;
}

/** Log lookup through a keyless indexer — public RPCs cap `eth_getLogs` ranges. */
async function fetchQueuedLogs(chain: Chain, account: Address): Promise<LogRow[]> {
  const base = BLOCKSCOUT[chain.id];
  if (!base) return [];
  try {
    const response = await fetch(`${base}/api/v2/addresses/${account}/logs`);
    if (!response.ok) return [];
    const body = (await response.json()) as { items?: LogRow[] };
    return (body.items ?? []).filter(
      (row) => row.topics?.[0]?.toLowerCase() === QUEUED_TOPIC,
    );
  } catch {
    return [];
  }
}

/** First 32-byte word of a log's data — the `nonce` in `Queued`. */
function firstWord(data: string | undefined): number {
  if (!data) return 0;
  const hex = data.startsWith('0x') ? data.slice(2) : data;
  if (hex.length < 64) return 0;
  return Number(BigInt(`0x${hex.slice(0, 64)}`));
}

export async function findPending(
  client: PublicClient, chain: Chain, account: Address,
): Promise<PendingRecovery[]> {
  const logs = await fetchQueuedLogs(chain, account);
  const seen = new Set<string>();
  const out: PendingRecovery[] = [];

  for (const log of logs) {
    const hash = log.topics?.[1]?.toLowerCase() as Hex | undefined;
    if (!hash || seen.has(hash)) continue;
    seen.add(hash);

    // The event fires when something is queued and never again, so only a fresh
    // read distinguishes still-pending from cancelled or already run.
    let eta: bigint;
    try {
      eta = await readQueued(client, account, hash);
    } catch {
      continue;
    }
    if (eta === 0n) continue;

    const nonce = firstWord(log.data);
    let data: Hex | null = null;
    let verified = false;

    if (log.transaction_hash) {
      try {
        const tx = await client.getTransaction({ hash: log.transaction_hash as Hex });
        const decoded = decodeFunctionData({ abi: EXECUTE, data: tx.input });
        if (decoded.functionName === 'execute') {
          const [target, value, payload] = decoded.args as [Address, bigint, Hex, Hex];
          const recomputed = transactionHash({
            account, chainId: chain.id, target, value, data: payload, nonce,
          });
          data = payload;
          verified = recomputed.toLowerCase() === hash;
        }
      } catch {
        // Leave it unverified — the entry is real either way, and saying so is
        // more honest than hiding a queued recovery we couldn't fully read.
      }
    }

    out.push({
      hash, eta: Number(eta), nonce, data, verified,
      queuedBy: (log.transaction_hash as Hex) ?? null,
    });
  }

  return out.sort((a, b) => a.eta - b.eta);
}
