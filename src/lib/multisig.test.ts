import { describe, expect, test } from 'vitest';
import {
  IMPLEMENTATION,
  batchCalldata,
  domainSeparator,
  erc20Transfer,
  ethTransfer,
  identify,
  transactionHash,
  typedData,
} from './multisig';
import { describeWait, importTicket, TICKET_VERSION, type RecoveryTicket } from './ticket';

/**
 * Vectors from `cast`, against Multisig.sol's own definitions.
 *
 * Re-pinned here rather than imported from the wallet or from `airgap`. If this
 * page computes the digest even slightly differently, a guardian signs
 * something the contract has never heard of — the signature verifies against
 * nothing, the recovery fails, and there is no way to tell that apart from "the
 * guardian isn't an owner". It has to disagree with the contract or with
 * nothing at all.
 */

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const TARGET = '0x2222222222222222222222222222222222222222';

describe('digest', () => {
  test('domain separator matches the contract', () => {
    expect(domainSeparator(ACCOUNT, 1)).toBe(
      '0x9df08b203f1e2531344bb5276bac60ef424f6fcdc30d6aa4b89b8bdbf5953c11',
    );
  });

  test('transaction hash matches the contract', () => {
    expect(
      transactionHash({
        account: ACCOUNT, chainId: 1, target: TARGET,
        value: 1000000000000000000n, data: '0xdeadbeef', nonce: 7,
      }),
    ).toBe('0x2c971cefeb2af4cb3bfc3c819bbc5384bfc0e3481affaa00ee2bb79ea16a121f');
  });

  /// The nonce is in the digest, which is the whole reason a queued recovery
  /// has to be finished with the exact arguments it was queued with.
  test('is bound to chain, account and nonce', () => {
    const base = {
      account: ACCOUNT as `0x${string}`, chainId: 1, target: TARGET as `0x${string}`,
      value: 0n, data: '0x' as `0x${string}`, nonce: 0,
    };
    const hash = transactionHash(base);
    expect(transactionHash({ ...base, chainId: 8453 })).not.toBe(hash);
    expect(transactionHash({ ...base, nonce: 1 })).not.toBe(hash);
    expect(transactionHash({ ...base, account: '0x3333333333333333333333333333333333333333' }))
      .not.toBe(hash);
  });

  /// The wallet renders this, and the contract verifies the hash above. If the
  /// two ever described different transactions, the guardian would be approving
  /// one thing and signing another.
  test('typed data describes the same transaction as the digest', () => {
    const params = {
      account: ACCOUNT as `0x${string}`, chainId: 1, target: TARGET as `0x${string}`,
      value: 5n, data: '0xabcdef' as `0x${string}`, nonce: 3,
    };
    const typed = typedData(params);
    expect(typed.domain.verifyingContract).toBe(params.account);
    expect(typed.domain.chainId).toBe(params.chainId);
    expect(typed.message.target).toBe(params.target);
    expect(typed.message.value).toBe('5');
    expect(typed.message.data).toBe(params.data);
    expect(typed.message.nonce).toBe(params.nonce);
  });
});

describe('identify', () => {
  test('reads an account upgraded in place', () => {
    const identity = identify(`0xef0100${IMPLEMENTATION.slice(2).toLowerCase()}`);
    expect(identity.kind).toBe('delegated');
    if (identity.kind !== 'delegated') return;
    expect(identity.canonical).toBe(true);
  });

  test('reads a factory clone', () => {
    // Runtime bytes of a multisig actually deployed by MultisigFactory.
    const code = '0x5f5f365f5f37365f736d71dd9ef2979f022e121203f644145caf4153e45af43d5f5f3e6029573d5ffd5b3d5ff3';
    const identity = identify(code);
    expect(identity.kind).toBe('clone');
    if (identity.kind !== 'clone') return;
    // A different implementation, and the page must say so rather than assume.
    expect(identity.canonical).toBe(false);
  });

  test('refuses anything else', () => {
    expect(identify('0x').kind).toBe('empty');
    expect(identify(undefined).kind).toBe('empty');
    expect(identify('0x6080604052348015600f57600080fd5b50').kind).toBe('foreign');
  });
});

describe('sweep', () => {
  /// The indirection that makes a one-signature sweep possible: `batch` is
  /// onlySelf, so it is reached through `execute(self, …)`, where the inner
  /// call arrives with msg.sender == the account.
  test('batches transfers into one call', () => {
    const calls = [
      ethTransfer('0x4444444444444444444444444444444444444444', 10n),
      erc20Transfer(
        '0x5555555555555555555555555555555555555555',
        '0x4444444444444444444444444444444444444444',
        25n,
      ),
    ];
    const data = batchCalldata(calls);
    expect(data.startsWith('0xde24dce2')).toBe(true); // batch(address[],uint256[],bytes[])
    // Both destinations appear in the encoding.
    expect(data.toLowerCase()).toContain('4444444444444444444444444444444444444444');
    expect(data.toLowerCase()).toContain('5555555555555555555555555555555555555555');
  });

  test('an ETH transfer carries value and no calldata', () => {
    const call = ethTransfer('0x4444444444444444444444444444444444444444', 7n);
    expect(call.value).toBe(7n);
    expect(call.data).toBe('0x');
  });
});

describe('tickets', () => {
  const ticket: RecoveryTicket = {
    version: TICKET_VERSION,
    chainId: 8453,
    account: ACCOUNT,
    data: '0xdeadbeef',
    nonce: 4,
    destination: TARGET,
    hash: '0xabc',
    eta: 0,
    createdAt: 0,
  };

  test('round-trips through export and import', () => {
    expect(importTicket(JSON.stringify(ticket))).toEqual(ticket);
  });

  test('refuses malformed or wrong-version tickets', () => {
    expect(importTicket('not json')).toBeNull();
    expect(importTicket(JSON.stringify({ ...ticket, version: 99 }))).toBeNull();
    expect(importTicket(JSON.stringify({ ...ticket, account: 'nope' }))).toBeNull();
    expect(importTicket(JSON.stringify({ ...ticket, nonce: 'four' }))).toBeNull();
  });

  test('describes the wait in units a person can act on', () => {
    const now = 1_000_000;
    expect(describeWait(0, now)).toBe('ready');
    expect(describeWait(now - 10, now)).toBe('ready now');
    expect(describeWait(now + 86_400 * 2 + 3_600 * 3, now)).toBe('2d 3h');
    expect(describeWait(now + 3_600 * 5, now)).toBe('5h 0m');
    expect(describeWait(now + 120, now)).toBe('2m');
  });
});
