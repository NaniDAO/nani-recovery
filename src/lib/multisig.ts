import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';

/**
 * Everything this page needs to know about a nani account.
 *
 * Written fresh rather than imported from the wallet or from `airgap`, and the
 * golden vectors are re-pinned here. A recovery page that shares a build with
 * anything else inherits that thing's outages, and one that trusts another
 * repo's digest has no way to notice when the two drift apart. The vectors come
 * from `cast` against Multisig.sol, so this file disagrees with the contract or
 * with nothing.
 */

/** Canonical Multisig implementation — identical on every supported chain. */
export const IMPLEMENTATION = '0xD54cb65224410F3Ff97a8E72f363f224419f4FB0' as Address;

const CLONE_PREFIX = '5f5f365f5f37365f73';
const CLONE_SUFFIX = '5af43d5f5f3e6029573d5ffd5b3d5ff3';
const DELEGATION_PREFIX = 'ef0100';

export interface Chain {
  id: number;
  name: string;
  rpc: string;
  explorer: string;
}

/**
 * Public endpoints, because a recovery page cannot ask its user for an RPC URL.
 *
 * The person reaching this page has lost a device and is trying to move funds
 * before something else does; "paste a JSON-RPC endpoint" is not a step they
 * can complete. These are read-only and carry no key — the guardian's own
 * wallet broadcasts, so nothing here ever sees a signature.
 */
export const CHAINS: Chain[] = [
  { id: 1, name: 'Ethereum', rpc: 'https://ethereum-rpc.publicnode.com', explorer: 'https://etherscan.io' },
  { id: 8453, name: 'Base', rpc: 'https://base-rpc.publicnode.com', explorer: 'https://basescan.org' },
  { id: 42161, name: 'Arbitrum', rpc: 'https://arbitrum-one-rpc.publicnode.com', explorer: 'https://arbiscan.io' },
  { id: 10, name: 'Optimism', rpc: 'https://optimism-rpc.publicnode.com', explorer: 'https://optimistic.etherscan.io' },
];

export function chainByID(id: number): Chain | undefined {
  return CHAINS.find((chain) => chain.id === id);
}

// MARK: - Is this actually a nani account?

export type Identity =
  | { kind: 'delegated'; implementation: Address; canonical: boolean }
  | { kind: 'clone'; implementation: Address; canonical: boolean }
  | { kind: 'foreign' }
  | { kind: 'empty' };

/**
 * An account upgraded in place carries `ef0100 ‖ impl`; one deployed by the
 * factory is a PUSH0 minimal proxy. Either way the implementation falls out,
 * and whether it is the canonical one is reported rather than assumed.
 */
export function identify(code: Hex | undefined): Identity {
  const hex = (code ?? '0x').slice(2).toLowerCase();
  if (hex.length === 0) return { kind: 'empty' };

  const isCanonical = (impl: string) =>
    getAddress(`0x${impl}`).toLowerCase() === IMPLEMENTATION.toLowerCase();

  if (hex.length === DELEGATION_PREFIX.length + 40 && hex.startsWith(DELEGATION_PREFIX)) {
    const impl = hex.slice(DELEGATION_PREFIX.length);
    return { kind: 'delegated', implementation: getAddress(`0x${impl}`), canonical: isCanonical(impl) };
  }
  if (
    hex.length === CLONE_PREFIX.length + 40 + CLONE_SUFFIX.length &&
    hex.startsWith(CLONE_PREFIX) &&
    hex.endsWith(CLONE_SUFFIX)
  ) {
    const impl = hex.slice(CLONE_PREFIX.length, CLONE_PREFIX.length + 40);
    return { kind: 'clone', implementation: getAddress(`0x${impl}`), canonical: isCanonical(impl) };
  }
  return { kind: 'foreign' };
}

// MARK: - Reads

export interface VaultState {
  owners: Address[];
  threshold: number;
  /** Seconds a non-owner-executor transaction waits before it can run. */
  delaySeconds: number;
  /** The nonce the next `execute` will consume. */
  nonce: number;
}

const ABI = parseAbi([
  'function getOwners() view returns (address[])',
  'function threshold() view returns (uint16)',
  'function delay() view returns (uint32)',
  'function nonce() view returns (uint32)',
  'function queued(bytes32) view returns (uint256)',
  'function execute(address target, uint256 value, bytes data, bytes sigs) payable',
  'function executeQueued(address target, uint256 value, bytes data, uint32 nonce) payable',
  'function batch(address[] targets, uint256[] values, bytes[] datas) payable',
]);

export async function readVault(client: PublicClient, account: Address): Promise<VaultState> {
  const [owners, threshold, delaySeconds, nonce] = await Promise.all([
    client.readContract({ address: account, abi: ABI, functionName: 'getOwners' }),
    client.readContract({ address: account, abi: ABI, functionName: 'threshold' }),
    client.readContract({ address: account, abi: ABI, functionName: 'delay' }),
    client.readContract({ address: account, abi: ABI, functionName: 'nonce' }),
  ]);
  return {
    owners: [...owners],
    threshold: Number(threshold),
    delaySeconds: Number(delaySeconds),
    nonce: Number(nonce),
  };
}

/** ETA of a queued transaction, or 0 if it isn't queued (or has been run). */
export async function readQueued(
  client: PublicClient, account: Address, hash: Hex,
): Promise<bigint> {
  return client.readContract({ address: account, abi: ABI, functionName: 'queued', args: [hash] });
}

// MARK: - The sweep

export interface Call {
  to: Address;
  value: bigint;
  data: Hex;
}

const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);

export function erc20Transfer(token: Address, to: Address, amount: bigint): Call {
  return { to: token, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [to, amount] }) };
}

export function ethTransfer(to: Address, amount: bigint): Call {
  return { to, value: amount, data: '0x' };
}

/**
 * Wrap a sweep as a single self-call.
 *
 * `batch` is `onlySelf`, and the guardian is not the account — so the guardian
 * cannot call it directly. But `execute` performs `target.call(data)`, so when
 * `target` is the account itself the inner call arrives with
 * `msg.sender == address(this)` and `onlySelf` passes. That indirection is what
 * lets one owner signature move every asset atomically instead of one
 * transaction per token.
 */
export function batchCalldata(calls: Call[]): Hex {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'batch',
    args: [calls.map((c) => c.to), calls.map((c) => c.value), calls.map((c) => c.data)],
  });
}

export function executeCalldata(account: Address, data: Hex, sigs: Hex): Hex {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'execute',
    args: [account, 0n, data, sigs],
  });
}

export function executeQueuedCalldata(account: Address, data: Hex, nonce: number): Hex {
  return encodeFunctionData({
    abi: ABI,
    functionName: 'executeQueued',
    args: [account, 0n, data, nonce],
  });
}

// MARK: - The digest

const DOMAIN_TYPEHASH = '0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f';
const NAME_HASH = '0xcd4046335c6490bc800b62dfe4e32b5bbe64545e84e866aba69afbf5ce39f2df';
const VERSION_HASH = '0xc89efdaa54c0f20c7adf612882df0950f5a951637e0307cdcb4c672f298b8bc6';
const EXECUTE_TYPEHASH = '0x9a087970b2c60bbc3491f9085dd8670d3d21eff87c2e286d7ad7c6af41cfbc29';

export function domainSeparator(account: Address, chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, BigInt(chainId), account],
    ),
  );
}

/**
 * `getTransactionHash(target, value, data, nonce)`, computed here.
 *
 * The nonce is baked in, which is why a queued recovery must be completed with
 * byte-identical arguments: change one and the hash changes, and the contract
 * has no record of the new one.
 */
export function transactionHash(params: {
  account: Address; chainId: number; target: Address; value: bigint; data: Hex; nonce: number;
}): Hex {
  const structHash = keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint32' }],
      [EXECUTE_TYPEHASH, params.target, params.value, keccak256(params.data), params.nonce],
    ),
  );
  return keccak256(concatHex(['0x1901', domainSeparator(params.account, params.chainId), structHash]));
}

/** EIP-712 payload for `eth_signTypedData_v4`, so the wallet renders the fields itself. */
export function typedData(params: {
  account: Address; chainId: number; target: Address; value: bigint; data: Hex; nonce: number;
}) {
  return {
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
      Execute: [
        { name: 'target', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'nonce', type: 'uint32' },
      ],
    },
    primaryType: 'Execute',
    domain: {
      name: 'Multisig',
      version: '1',
      chainId: params.chainId,
      verifyingContract: params.account,
    },
    message: {
      target: params.target,
      value: params.value.toString(),
      data: params.data,
      nonce: params.nonce,
    },
  };
}
