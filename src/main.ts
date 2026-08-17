import './style.css';
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatEther,
  getAddress,
  http,
  isAddress,
  UserRejectedRequestError,
  type Address,
  type Chain as ViemChain,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { arbitrum, base, mainnet, optimism } from 'viem/chains';
import {
  CHAINS,
  batchCalldata,
  chainByID,
  erc20Transfer,
  ethTransfer,
  executeCalldata,
  executeQueuedCalldata,
  identify,
  nftTransfer,
  takeOverCalls,
  readQueued,
  readVault,
  transactionHash,
  typedData,
  type Call,
  type Chain,
  type VaultState,
} from './lib/multisig';
import {
  ETH_RESERVE, findHoldings, findNFTs, formatHolding, formatNFT,
  type Holding, type NFT,
} from './lib/assets';
import { findPending, type PendingRecovery } from './lib/pending';
import {
  describeWait,
  describeWhen,
  forgetTicket,
  importTicket,
  loadTickets,
  saveTicket,
  TICKET_VERSION,
  type RecoveryTicket,
} from './lib/ticket';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const step = (n: string) => document.querySelector<HTMLElement>(`[data-step="${n}"]`)!;

interface Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
interface WalletOption { uuid: string; name: string; icon: string; provider: Provider }

declare global {
  interface Window { ethereum?: Provider }
}

// MARK: - State

let chain: Chain = CHAINS[0];
let account: Address | null = null;
let vault: VaultState | null = null;
let client: PublicClient | null = null;
let holdings: Holding[] = [];
let selected = new Set<string>();
let manualTokens: Address[] = [];
let nfts: NFT[] = [];
let pending: PendingRecovery[] = [];
let selectedNFTs = new Set<string>();
let guardian: Address | null = null;
/**
 * The guardian's wallet, through viem.
 *
 * EIP-6963 discovery below stays raw — it is a browser event handshake, not
 * something viem models — but everything after "we have a provider" goes
 * through a WalletClient. Hand-rolled `provider.request` calls meant
 * hand-serialising typed data, string-matching errors, and reimplementing the
 * chain check; all three are solved problems and none of them were ours to
 * solve.
 */
let guardianWallet: WalletClient | null = null;
let prepared: { calls: Call[]; data: Hex; hash: Hex; nonce: number; destination: Address } | null = null;

const key = (h: Holding) => h.token ?? 'eth';
const nftKey = (n: NFT) => `${n.collection}:${n.tokenId}`;

/**
 * viem's own chain objects, for the wallet side.
 *
 * The local `Chain` list carries an RPC and an explorer for reads; viem wants
 * the full definition so `sendTransaction` can check the wallet is where it
 * thinks it is, and `switchChain` can name the chain it is asking for.
 */
const VIEM_CHAINS: Record<number, ViemChain> = {
  1: mainnet, 8453: base, 42161: arbitrum, 10: optimism,
};

function readClient(target: Chain): PublicClient {
  return createPublicClient({ transport: http(target.rpc) });
}

function unlock(n: string) { step(n).classList.remove('is-locked'); }
function markDone(n: string) { step(n).classList.add('is-done'); }

function row(label: string, value: string, plain = false): string {
  const cls = plain ? ' class="plain"' : '';
  return `<div class="row"><dt>${label}</dt><dd${cls}>${escape(value)}</dd></div>`;
}

function escape(text: string): string {
  const node = document.createElement('div');
  node.textContent = text;
  return node.innerHTML;
}

// MARK: - 1 · Find the account

const chainSelect = $<HTMLSelectElement>('chain');
chainSelect.replaceChildren(
  ...CHAINS.map((c) => {
    const option = document.createElement('option');
    option.value = String(c.id);
    option.textContent = c.name;
    return option;
  }),
);
chainSelect.addEventListener('change', () => {
  chain = chainByID(Number(chainSelect.value)) ?? CHAINS[0];
});

$<HTMLButtonElement>('look-up').addEventListener('click', async () => {
  const error = $<HTMLElement>('lookup-error');
  const readout = $<HTMLElement>('account-readout');
  error.textContent = '';
  readout.classList.add('is-hidden');

  const raw = $<HTMLInputElement>('account').value.trim();
  if (!isAddress(raw)) { error.textContent = 'That is not a valid address.'; return; }
  account = getAddress(raw);
  client = readClient(chain);

  try {
    const code = await client.getCode({ address: account });
    const identity = identify(code);
    if (identity.kind === 'empty') {
      error.textContent =
        `Nothing is deployed at that address on ${chain.name}. If the account was upgraded on a different chain, pick it above.`;
      return;
    }
    if (identity.kind === 'foreign') {
      error.textContent = 'That address has code, but not a nani account. Recovery only works on accounts set up with a guardian.';
      return;
    }

    vault = await readVault(client, account);
    if (vault.threshold === 0) {
      error.textContent = 'That account was never initialised, so it has no owners and nothing here can act for it.';
      return;
    }

    const wait = vault.delaySeconds > 0
      ? `${Math.round(vault.delaySeconds / 86_400 * 10) / 10} days`
      : 'none';

    readout.innerHTML =
      row('Chain', chain.name, true) +
      row('Owners', vault.owners.join('\n')) +
      row('Threshold', `${vault.threshold} of ${vault.owners.length}`, true) +
      row('Waiting period', wait, true) +
      row('Next nonce', String(vault.nonce), true) +
      (identity.canonical ? '' :
        `<div class="banner banner--warn">This account runs code at ${escape(identity.implementation)}, which is not the implementation nani deploys. Everything below assumes the standard contract; check it before signing.</div>`) +
      (vault.delaySeconds > 0
        ? `<div class="banner banner--warn">This account has a waiting period. Your recovery will be <strong>queued</strong>, not executed — you come back after ${escape(wait)} to finish it. Save the recovery file at the end.</div>`
        : '');
    readout.classList.remove('is-hidden');
    markDone('1');
    unlock('2');

    // What the chain says is already queued against this account, whoever
    // started it. Local storage only knows about recoveries begun in this
    // browser, which is no help to a guardian on a second machine — or to an
    // account holder checking whether anyone has queued something against them.
    pending = await findPending(client, chain, account);
    if (pending.length > 0) {
      const rows = pending.map((entry) =>
        `<li><strong>${escape(describeWait(entry.eta))}</strong> — ${escape(describeWhen(entry.eta))}` +
        (entry.verified ? '' : ' <em>(payload could not be verified)</em>') +
        `</li>`).join('');
      readout.insertAdjacentHTML('beforeend',
        `<div class="banner banner--warn"><strong>${pending.length === 1
          ? 'A recovery is already queued against this account.'
          : `${pending.length} recoveries are already queued against this account.`}</strong>
         <ul class="pending-list">${rows}</ul>
         You can finish it at the bottom of this page once its wait is over. If you did not start it, whoever holds this account's key can cancel it from the wallet.</div>`);
      for (const entry of pending) {
        if (!entry.data || !entry.verified) continue;
        // Adopt it as a local ticket so the existing finish path can run it.
        // Only when the payload verifies: `executeQueued` needs the exact
        // arguments, and an unverified payload would revert.
        saveTicket({
          version: TICKET_VERSION,
          chainId: chain.id,
          account,
          data: entry.data,
          nonce: entry.nonce,
          destination: account,
          hash: entry.hash,
          eta: entry.eta,
          createdAt: Math.floor(Date.now() / 1000),
        });
      }
      void refreshTicketState();
    }
  } catch (e) {
    error.textContent = `Couldn't read that account: ${(e as Error).message}`;
  }
});

// MARK: - 2 · Connect the guardian

const discovered = new Map<string, WalletOption>();
window.addEventListener('eip6963:announceProvider', (event) => {
  const detail = (event as CustomEvent).detail as {
    info: { uuid: string; name: string; icon: string }; provider: Provider;
  };
  if (detail?.info?.uuid) {
    discovered.set(detail.info.uuid, { ...detail.info, provider: detail.provider });
  }
});
window.dispatchEvent(new Event('eip6963:requestProvider'));

$<HTMLButtonElement>('connect').addEventListener('click', () => {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const picker = $<HTMLElement>('wallet-picker');
  const options = [...discovered.values()];
  if (options.length === 0 && window.ethereum) {
    options.push({ uuid: 'injected', name: 'Browser wallet', icon: '', provider: window.ethereum });
  }
  picker.replaceChildren();

  if (options.length === 0) {
    $<HTMLElement>('connect-error').textContent =
      'No wallet found in this browser. Open this page in one that has the guardian wallet installed.';
    return;
  }

  for (const option of options) {
    const item = document.createElement('button');
    item.className = 'picker__item';
    item.type = 'button';
    if (option.icon) {
      const img = document.createElement('img');
      img.src = option.icon;
      img.alt = '';
      item.append(img);
    }
    item.append(document.createTextNode(option.name));
    item.addEventListener('click', () => void connect(option));
    picker.append(item);
  }
  picker.classList.toggle('is-hidden');
});

async function connect(option: WalletOption) {
  const error = $<HTMLElement>('connect-error');
  const state = $<HTMLElement>('connect-state');
  error.textContent = '';
  $<HTMLElement>('wallet-picker').classList.add('is-hidden');

  try {
    const wallet = createWalletClient({ transport: custom(option.provider) });
    const accounts = await wallet.requestAddresses();
    if (!accounts?.[0]) throw new Error('No account available.');
    guardian = getAddress(accounts[0]);
    guardianWallet = wallet;

    const isOwner = vault?.owners.some((o) => o.toLowerCase() === guardian!.toLowerCase()) ?? false;
    if (!isOwner) {
      // Stated plainly rather than left to fail on chain. `execute` rejects a
      // non-owner signature, so without this the guardian would sign, pay gas,
      // and watch it revert with nothing to explain why.
      state.innerHTML =
        `<span class="banner banner--bad">${escape(guardian)} is not an owner of this account, so it cannot recover it. Connect the wallet you set as the guardian.</span>`;
      return;
    }

    const walletChain = await wallet.getChainId();
    state.innerHTML = walletChain === chain.id
      ? `<span class="banner banner--good">Connected as ${escape(guardian)} — an owner of this account.</span>`
      : `<span class="banner banner--warn">Connected as ${escape(guardian)}, an owner — but your wallet is on chain ${walletChain} and this account is on ${escape(chain.name)}. Switch networks before submitting.</span>`;

    markDone('2');
    unlock('3');
    syncMode();
  } catch (e) {
    error.textContent = (e as Error).message;
  }
}

// MARK: - 3 · How to recover

/**
 * Which path the guardian is taking.
 *
 * Taking over is better whenever it is possible: nothing moves, so nothing that
 * points at the account is disturbed and there is no per-asset gas. It only
 * fails in one case, and it is the case worth naming out loud — an EIP-7702
 * account whose key was *stolen* rather than lost is still an EOA, and whoever
 * holds that key can sign ordinary transactions from it no matter who owns the
 * multisig. Then the assets have to leave.
 */
function currentMode(): 'takeover' | 'sweep' {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return checked?.value === 'sweep' ? 'sweep' : 'takeover';
}

function syncMode() {
  const sweep = currentMode() === 'sweep';
  $<HTMLElement>('sweep-only').classList.toggle('is-hidden', !sweep);
  $<HTMLElement>('destination-label').textContent = sweep ? 'Send everything to' : 'New owner address';
  $<HTMLElement>('destination-hint').textContent = sweep
    ? 'An address you control and can still sign for. This cannot be undone — check every character.'
    : 'An address you control and can still sign for. It becomes an owner of this account; the lost one is removed.';
  $<HTMLElement>('mode-note').innerHTML = sweep
    ? 'Use this if someone else has the key. On an account upgraded in place, a stolen key can still send ordinary transactions no matter who owns the multisig — so the assets have to leave.'
    : 'Right for a key that is lost rather than stolen. If someone else has the key, choose the other option: removing them as an owner does not stop them signing from the address.';
  if (sweep && holdings.length === 0) void refreshHoldings();
}

document.querySelectorAll('input[name="mode"]').forEach((input) =>
  input.addEventListener('change', syncMode));

// MARK: - What to move

async function refreshHoldings() {
  if (!client || !account) return;
  const container = $<HTMLElement>('holdings');
  container.innerHTML = '<p class="hint">Looking for assets…</p>';

  [holdings, nfts] = await Promise.all([
    findHoldings(client, chain, account, manualTokens),
    findNFTs(chain.id, account),
  ]);
  selected = new Set(holdings.map(key));
  selectedNFTs = new Set(nfts.map(nftKey));

  if (holdings.length === 0 && nfts.length === 0) {
    container.innerHTML = '<p class="hint">Nothing found on this chain. If you know a token is there, add it below.</p>';
    return;
  }

  container.replaceChildren(
    ...holdings.map((holding) => {
      const label = document.createElement('label');
      label.className = 'holding';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.addEventListener('change', () => {
        if (box.checked) selected.add(key(holding));
        else selected.delete(key(holding));
      });

      const amount = document.createElement('span');
      amount.className = 'holding__amount';
      amount.textContent = formatHolding(holding);

      label.append(box, amount);

      if (holding.token === null) {
        const note = document.createElement('span');
        note.className = 'holding__note';
        note.textContent = `keeps ${formatEther(ETH_RESERVE)} ETH for the next step`;
        label.append(note);
      } else if (holding.manual) {
        const note = document.createElement('span');
        note.className = 'holding__note';
        note.textContent = 'added by you';
        label.append(note);
      }
      return label;
    }),
    ...nfts.map((nft) => {
      const label = document.createElement('label');
      label.className = 'holding';

      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = true;
      box.addEventListener('change', () => {
        if (box.checked) selectedNFTs.add(nftKey(nft));
        else selectedNFTs.delete(nftKey(nft));
      });

      const name = document.createElement('span');
      name.className = 'holding__amount';
      name.textContent = formatNFT(nft);

      const note = document.createElement('span');
      note.className = 'holding__note';
      note.textContent = 'NFT';

      label.append(box, name, note);
      return label;
    }),
  );
}

$<HTMLButtonElement>('add-token').addEventListener('click', () => {
  const input = $<HTMLInputElement>('manual-token');
  const raw = input.value.trim();
  if (!isAddress(raw)) { $<HTMLElement>('build-error').textContent = 'That is not a valid token address.'; return; }
  manualTokens.push(getAddress(raw));
  input.value = '';
  $<HTMLElement>('build-error').textContent = '';
  void refreshHoldings();
});

/**
 * Tokens, then NFTs, then ETH last.
 *
 * A batch is atomic so order cannot change the outcome today. It is written this
 * way because the reserve calculation depends on ETH being considered after
 * everything else, and because if any of this is ever made non-atomic, the
 * assets that are hardest to re-acquire should already have moved.
 */
function buildSweep(
  chosen: Holding[], chosenNFTs: NFT[], from: Address, to: Address,
): Call[] {
  const calls: Call[] = [];
  for (const holding of chosen) {
    if (holding.token === null) continue;
    calls.push(erc20Transfer(holding.token, to, holding.balance));
  }
  for (const nft of chosenNFTs) {
    calls.push(nftTransfer(nft.collection, from, to, nft.tokenId));
  }
  const eth = chosen.find((h) => h.token === null);
  if (eth) {
    const sweepable = eth.balance > ETH_RESERVE ? eth.balance - ETH_RESERVE : 0n;
    if (sweepable > 0n) calls.push(ethTransfer(to, sweepable));
  }
  return calls;
}

$<HTMLButtonElement>('review').addEventListener('click', () => {
  const error = $<HTMLElement>('build-error');
  error.textContent = '';
  if (!account || !vault || !client) return;

  const raw = $<HTMLInputElement>('destination').value.trim();
  if (!isAddress(raw)) { error.textContent = 'Enter a valid destination address.'; return; }
  const destination = getAddress(raw);

  if (destination.toLowerCase() === account.toLowerCase()) {
    error.textContent = 'That is the account you are recovering from. Send to an address you can still sign for.';
    return;
  }

  const mode = currentMode();
  let calls: Call[];
  let summary: string;

  if (mode === 'takeover') {
    // The lost owner is whichever one is not the guardian. With more than two
    // owners we cannot tell which was lost, so we ask rather than guess — a
    // wrong removal is not recoverable by the same route.
    const others = vault.owners.filter(
      (o) => o.toLowerCase() !== guardian?.toLowerCase(),
    );
    if (others.length !== 1) {
      error.textContent = others.length === 0
        ? 'You are the only owner of this account, so there is nothing to take over.'
        : `This account has ${others.length} other owners, so it isn't clear which key was lost. Use "move everything out" instead.`;
      return;
    }
    const lost = others[0];
    if (destination.toLowerCase() === lost.toLowerCase()) {
      error.textContent = 'That is the address you are replacing.';
      return;
    }
    const built = takeOverCalls({
      account, newOwner: destination, lostOwner: lost, owners: vault.owners,
    });
    if (!built) { error.textContent = "Couldn't work out the owner list to change."; return; }
    calls = built;
    summary = `Add ${destination} as an owner, remove ${lost}`;
  } else {
    const chosen = holdings.filter((h) => selected.has(key(h)));
    const chosenNFTs = nfts.filter((n) => selectedNFTs.has(nftKey(n)));
    if (chosen.length === 0 && chosenNFTs.length === 0) {
      error.textContent = 'Select at least one asset to move.';
      return;
    }
    calls = buildSweep(chosen, chosenNFTs, account, destination);
    if (calls.length === 0) {
      error.textContent = 'Nothing to move — the ETH balance is below the amount kept back for the next step.';
      return;
    }
    summary = [...chosen.map(formatHolding), ...chosenNFTs.map(formatNFT)].join('\n');
  }

  const data = batchCalldata(calls);
  const hash = transactionHash({
    account, chainId: chain.id, target: account, value: 0n, data, nonce: vault.nonce,
  });
  prepared = { calls, data, hash, nonce: vault.nonce, destination };

  $<HTMLElement>('review-readout').innerHTML =
    row('Account', account) +
    row(mode === 'takeover' ? 'New owner' : 'To', destination) +
    row(mode === 'takeover' ? 'Change' : 'Moving', summary, true) +
    row('Chain', chain.name, true) +
    row('Nonce', String(vault.nonce), true) +
    row('Digest', hash) +
    (vault.delaySeconds > 0
      ? `<div class="banner banner--warn"><strong>This will be queued, not executed.</strong>
           The account has a ${escape(describeWait(Math.floor(Date.now() / 1000) + vault.delaySeconds))} waiting period, so nothing moves until
           <strong>${escape(describeWhen(Math.floor(Date.now() / 1000) + vault.delaySeconds))}</strong>.
           Come back here then and finish it — and save the file you'll be given, in case you return on another machine.</div>`
      : `<div class="banner banner--good">This account has no waiting period, so it runs as soon as the transaction confirms.</div>`);

  markDone('3');
  unlock('4');
  step('4').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// MARK: - 4 · Sign and submit

/**
 * A signature already collected for the payload currently on screen.
 *
 * Submitting takes *two* wallet interactions — sign the typed data, then send
 * the transaction carrying it — and the button's name promised one. A guardian
 * who approved the signature and then lost the second prompt (dismissed,
 * opened behind the window, or blocked by a wallet on the wrong chain) saw
 * "User rejected the request" for a request they had just approved, and lost
 * the signature along with it.
 *
 * Holding it means a failed *send* costs a retry, not another signature. The
 * signature is the part with the guardian's authority in it; broadcasting is
 * cheap, fallible, and worth retrying on its own.
 */
let signed: { signature: Hex; data: Hex; nonce: number } | null = null;

$<HTMLButtonElement>('submit').addEventListener('click', async () => {
  const error = $<HTMLElement>('submit-error');
  const state = $<HTMLElement>('submit-state');
  error.textContent = '';
  if (!prepared || !account || !vault || !guardian || !guardianWallet || !client) return;

  const button = $<HTMLButtonElement>('submit');
  button.disabled = true;
  try {
    // Typed data rather than a raw hash: the wallet renders target, value and
    // nonce itself, so the guardian compares what this page claims against what
    // their own wallet independently says it is signing.
    if (!signed || signed.data !== prepared.data || signed.nonce !== prepared.nonce) {
      state.textContent = 'Step 1 of 2 — approve the signature in your wallet. It may open in a separate window.';
      const signature = await guardianWallet.signTypedData({
        account: guardian,
        ...typedData({
          account, chainId: chain.id, target: account,
          value: 0n, data: prepared.data, nonce: prepared.nonce,
        }),
      });
      signed = { signature, data: prepared.data, nonce: prepared.nonce };
    }

    // Checked here rather than left to the send. A wallet on the wrong chain
    // fails somewhere inside `eth_sendTransaction`, and what surfaces is a
    // generic rejection that says nothing about chains.
    if ((await guardianWallet.getChainId()) !== chain.id) {
      state.textContent = `Your wallet is on the wrong network — approve the switch to ${chain.name}.`;
      await guardianWallet.switchChain({ id: chain.id });
    }

    state.textContent = 'Step 2 of 2 — signed. Now approve the transaction itself. This is a second, separate prompt.';
    const calldata = executeCalldata(account, prepared.data, signed.signature);
    const txHash = await guardianWallet.sendTransaction({
      account: guardian, to: account, data: calldata, value: 0n,
      chain: VIEM_CHAINS[chain.id] ?? null,
    });
    state.textContent = '';

    const eta = vault.delaySeconds > 0
      ? Math.floor(Date.now() / 1000) + vault.delaySeconds
      : 0;

    const ticket: RecoveryTicket = {
      version: TICKET_VERSION,
      chainId: chain.id,
      account,
      data: prepared.data,
      nonce: prepared.nonce,
      destination: prepared.destination,
      hash: prepared.hash,
      eta,
      createdAt: Math.floor(Date.now() / 1000),
    };
    saveTicket(ticket);
    void refreshTicketState();

    step('done').classList.remove('is-hidden');
    $<HTMLElement>('done-readout').innerHTML =
      row('Transaction', txHash) +
      `<div class="row"><dt>Explorer</dt><dd class="plain"><a href="${chain.explorer}/tx/${txHash}" target="_blank" rel="noopener">View it</a></dd></div>` +
      (eta === 0
        ? '<div class="banner banner--good">Done. Once this confirms, the assets are at the destination.</div>'
        : `<div class="banner banner--warn"><strong>Queued, not finished.</strong> It becomes executable in ${escape(describeWait(eta))}. Save the file below and come back — you will need it if you return on another machine.</div>
           <div class="row"><dt>Recovery file</dt><dd><textarea rows="6" readonly>${escape(JSON.stringify(ticket, null, 2))}</textarea></dd></div>`);
    renderTickets();
    step('done').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    state.textContent = '';
    const message = e instanceof UserRejectedRequestError
      ? 'You declined the request in your wallet.'
      : ((e as Error)?.message ?? String(e));
    if (signed) {
      // Naming which of the two steps failed, because "User rejected the
      // request" after approving a signature reads as the wallet lying.
      error.textContent =
        `Your signature was accepted and is saved — you do not need to sign again. Sending the transaction did not go through: ${message}`;
      button.textContent = 'Retry sending';
    } else {
      error.textContent = message;
    }
  } finally {
    button.disabled = false;
  }
});

// MARK: - Finishing a queued recovery

/**
 * Chain state per saved recovery, keyed by digest.
 *
 * The stored `eta` is what we computed at signing time from the delay we read
 * then. `queued(hash)` is what the contract actually holds — and it is the only
 * thing that knows whether the recovery is still standing. A ticket can be
 * cancelled by whoever holds the account key, or already completed by anyone,
 * and in both cases local storage would go on cheerfully counting down toward a
 * button that reverts.
 */
const chainETA = new Map<string, bigint | null>();

async function refreshTicketState() {
  const tickets = loadTickets();
  await Promise.all(tickets.map(async (ticket) => {
    const ticketChain = chainByID(ticket.chainId);
    if (!ticketChain) return;
    try {
      const eta = await readQueued(readClient(ticketChain), ticket.account, ticket.hash);
      chainETA.set(ticket.hash, eta);
    } catch {
      // Leave it unknown rather than claiming it is gone — an RPC hiccup must
      // not look like a cancelled recovery.
      chainETA.set(ticket.hash, null);
    }
  }));
  renderTickets();
}

function renderTickets() {
  const container = $<HTMLElement>('tickets');
  const tickets = loadTickets();
  container.replaceChildren();

  for (const ticket of tickets) {
    const ticketChain = chainByID(ticket.chainId);
    const known = chainETA.get(ticket.hash);
    // Prefer the chain's ETA over the one we stored.
    const eta = known != null && known > 0n ? Number(known) : ticket.eta;
    const gone = known === 0n;
    const ready = !gone && (eta === 0 || eta <= Math.floor(Date.now() / 1000));

    const card = document.createElement('div');
    card.className = 'ticket';

    let status: string;
    if (gone) {
      status = '<span class="banner banner--bad">No longer queued. It was either completed already, or cancelled by whoever holds the account key.</span>';
    } else if (known === undefined) {
      status = '<span class="ticket__wait">checking…</span>';
    } else if (ready) {
      status = '<span class="ticket__wait is-ready">ready now</span>';
    } else {
      status = `<span class="ticket__wait" data-eta="${eta}">${escape(describeWait(eta))}</span>`
        + `<span class="ticket__when">${escape(describeWhen(eta))}</span>`;
    }

    card.innerHTML =
      row('Account', ticket.account) +
      row('To', ticket.destination) +
      row('Chain', ticketChain?.name ?? String(ticket.chainId), true) +
      `<div class="row"><dt>Executable</dt><dd class="plain">${status}</dd></div>`;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const finish = document.createElement('button');
    finish.className = 'button button--primary';
    finish.textContent = 'Finish it';
    finish.disabled = !ready;
    finish.addEventListener('click', () => void finishTicket(ticket));

    const drop = document.createElement('button');
    drop.className = 'button';
    drop.textContent = gone ? 'Remove' : 'Forget';
    drop.addEventListener('click', () => { forgetTicket(ticket.hash); renderTickets(); });

    actions.append(finish, drop);
    card.append(actions);
    container.append(card);
  }
}

/**
 * Tick the countdowns in place.
 *
 * Only the text nodes carrying an `eta`, so the rest of the card — and any
 * button focus — survives. Re-rendering the whole list every second would fight
 * the user for the pointer.
 */
setInterval(() => {
  const now = Math.floor(Date.now() / 1000);
  let anyBecameReady = false;
  document.querySelectorAll<HTMLElement>('.ticket__wait[data-eta]').forEach((node) => {
    const eta = Number(node.dataset.eta);
    if (eta <= now) { anyBecameReady = true; return; }
    node.textContent = describeWait(eta, now);
  });
  // Crossing the line changes what the buttons do, so that one needs a redraw.
  if (anyBecameReady) renderTickets();
}, 1000);

async function finishTicket(ticket: RecoveryTicket) {
  const error = $<HTMLElement>('ticket-error');
  error.textContent = '';
  const ticketChain = chainByID(ticket.chainId);
  if (!ticketChain) { error.textContent = 'Unknown chain in that recovery.'; return; }

  try {
    // Confirm the chain still has it queued. A recovery that was cancelled — or
    // already run — must not send a transaction that reverts and costs gas to
    // discover.
    const reader = readClient(ticketChain);
    const eta = await readQueued(reader, ticket.account, ticket.hash);
    if (eta === 0n) {
      error.textContent =
        'The chain has no record of this recovery. It was either already completed, or cancelled by whoever holds the account key.';
      return;
    }

    if (!guardianWallet || !guardian) {
      error.textContent = 'Connect a wallet first — someone has to send this transaction and pay its gas.';
      return;
    }

    // A ticket carries its own chain, which need not be the one selected above
    // — someone finishing a recovery days later may have come back to a
    // different chain in the picker.
    if ((await guardianWallet.getChainId()) !== ticket.chainId) {
      await guardianWallet.switchChain({ id: ticket.chainId });
    }

    // No signature this time. `executeQueued` checks only that the hash is
    // queued and its time has passed, so anyone can call it — the arguments
    // are the authorisation, which is why they must match byte for byte.
    const calldata = executeQueuedCalldata(ticket.account, ticket.data, ticket.nonce);
    const txHash = await guardianWallet.sendTransaction({
      account: guardian, to: ticket.account, data: calldata, value: 0n,
      chain: VIEM_CHAINS[ticket.chainId] ?? null,
    });

    forgetTicket(ticket.hash);
    renderTickets();
    step('done').classList.remove('is-hidden');
    $<HTMLElement>('done-readout').innerHTML =
      row('Transaction', txHash) +
      `<div class="row"><dt>Explorer</dt><dd class="plain"><a href="${ticketChain.explorer}/tx/${txHash}" target="_blank" rel="noopener">View it</a></dd></div>` +
      '<div class="banner banner--good">Recovery completed. Once this confirms, the assets are at the destination.</div>';
  } catch (e) {
    error.textContent = (e as Error).message;
  }
}

$<HTMLButtonElement>('load-ticket').addEventListener('click', () => {
  const error = $<HTMLElement>('ticket-error');
  const ticket = importTicket($<HTMLTextAreaElement>('ticket-json').value);
  if (!ticket) { error.textContent = "That doesn't look like a recovery file."; return; }

  // Re-derive rather than trust. A tampered file produces a digest the contract
  // has no record of, so `executeQueued` would fail — but failing loudly here
  // is better than a confusing revert, and it also catches an honest mistake
  // like pasting the file for a different account.
  const recomputed = transactionHash({
    account: ticket.account, chainId: ticket.chainId, target: ticket.account,
    value: 0n, data: ticket.data, nonce: ticket.nonce,
  });
  if (recomputed.toLowerCase() !== ticket.hash.toLowerCase()) {
    error.textContent = "That file's contents don't match its own digest, so it has been altered or truncated.";
    return;
  }

  error.textContent = '';
  saveTicket(ticket);
  void refreshTicketState();
});

renderTickets();
void refreshTicketState();
