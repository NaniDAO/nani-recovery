import { formatUnits, parseAbi, type Address, type PublicClient } from 'viem';
import type { Chain } from './multisig';

/**
 * What the account still holds.
 *
 * Blockscout has keyless public instances for every chain here, which matters:
 * a recovery page cannot ask for an API key, and the person using it may not be
 * the person who set the account up. Everything it returns is then **re-read on
 * chain** before being offered — an indexer is a convenience for *finding*
 * tokens and is never trusted for balances, since the number it reports is the
 * number that ends up in a transfer.
 *
 * If the indexer is down the page still works; the guardian adds token
 * addresses by hand and those are read the same way.
 */

export interface Holding {
  token: Address | null; // null = native ETH
  symbol: string;
  decimals: number;
  /** Verified on chain, never the indexer's figure. */
  balance: bigint;
  /** True when the guardian typed the address rather than the indexer finding it. */
  manual: boolean;
}

const BLOCKSCOUT: Record<number, string> = {
  1: 'https://eth.blockscout.com',
  8453: 'https://base.blockscout.com',
  42161: 'https://arbitrum.blockscout.com',
  10: 'https://optimism.blockscout.com',
};

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
]);

/** Candidate token addresses, from the indexer. Balances are not taken on faith. */
async function discoverTokens(chainId: number, account: Address): Promise<Address[]> {
  const base = BLOCKSCOUT[chainId];
  if (!base) return [];
  try {
    const response = await fetch(`${base}/api/v2/addresses/${account}/token-balances`);
    if (!response.ok) return [];
    const rows = (await response.json()) as { token?: { address?: string; type?: string } }[];
    if (!Array.isArray(rows)) return [];
    return rows
      .filter((row) => row.token?.type === 'ERC-20' && row.token.address)
      .map((row) => row.token!.address as Address)
      .slice(0, 40);
  } catch {
    return [];
  }
}

async function readToken(
  client: PublicClient, token: Address, account: Address, manual: boolean,
): Promise<Holding | null> {
  try {
    const [balance, decimals, symbol] = await Promise.all([
      client.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [account] }),
      client.readContract({ address: token, abi: ERC20, functionName: 'decimals' }),
      client.readContract({ address: token, abi: ERC20, functionName: 'symbol' }),
    ]);
    if (balance === 0n) return null;
    return { token, symbol, decimals: Number(decimals), balance, manual };
  } catch {
    return null;
  }
}

export async function findHoldings(
  client: PublicClient, chain: Chain, account: Address, extraTokens: Address[] = [],
): Promise<Holding[]> {
  const out: Holding[] = [];

  const eth = await client.getBalance({ address: account });
  if (eth > 0n) {
    out.push({ token: null, symbol: 'ETH', decimals: 18, balance: eth, manual: false });
  }

  const discovered = await discoverTokens(chain.id, account);
  const manualSet = new Set(extraTokens.map((t) => t.toLowerCase()));
  const candidates = [
    ...extraTokens,
    ...discovered.filter((t) => !manualSet.has(t.toLowerCase())),
  ];

  const results = await Promise.all(
    candidates.map((token) => readToken(client, token, account, manualSet.has(token.toLowerCase()))),
  );
  for (const holding of results) if (holding) out.push(holding);
  return out;
}

export function formatHolding(holding: Holding): string {
  return `${formatUnits(holding.balance, holding.decimals)} ${holding.symbol}`;
}

/**
 * Native ETH held back to pay for the second half.
 *
 * Sweeping the last wei of ETH is the obvious thing to want and the wrong thing
 * to do on a delayed recovery: `executeQueued` still has to be called days
 * later, and while anyone may call it, the person who will is the guardian, and
 * they will need this account to be reachable. More practically, a batch that
 * empties the account can leave nothing for a retry if one leg fails.
 */
export const ETH_RESERVE = 2_000_000_000_000_000n; // 0.002 ETH
