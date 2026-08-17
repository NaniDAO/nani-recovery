import './style.css';
import {
  createPublicClient,
  formatEther,
  getAddress,
  http,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  CHAINS,
  batchCalldata,
  chainByID,
  erc20Transfer,
  ethTransfer,
  executeCalldata,
  executeQueuedCalldata,
  identify,
  readQueued,
  readVault,
  transactionHash,
  typedData,
  type Call,
  type Chain,
  type VaultState,
} from './lib/multisig';
import { ETH_RESERVE, findHoldings, formatHolding, type Holding } from './lib/assets';
import {
  describeWait,
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
let guardian: Address | null = null;
let guardianProvider: Provider | null = null;
let prepared: { calls: Call[]; data: Hex; hash: Hex; nonce: number; destination: Address } | null = null;

const key = (h: Holding) => h.token ?? 'eth';

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
    const accounts = (await option.provider.request({ method: 'eth_requestAccounts' })) as string[];
    if (!accounts?.[0]) throw new Error('No account available.');
    guardian = getAddress(accounts[0]);
    guardianProvider = option.provider;

    const isOwner = vault?.owners.some((o) => o.toLowerCase() === guardian!.toLowerCase()) ?? false;
    if (!isOwner) {
      // Stated plainly rather than left to fail on chain. `execute` rejects a
      // non-owner signature, so without this the guardian would sign, pay gas,
      // and watch it revert with nothing to explain why.
      state.innerHTML =
        `<span class="banner banner--bad">${escape(guardian)} is not an owner of this account, so it cannot recover it. Connect the wallet you set as the guardian.</span>`;
      return;
    }

    const walletChain = Number((await option.provider.request({ method: 'eth_chainId' })) as Hex);
    state.innerHTML = walletChain === chain.id
      ? `<span class="banner banner--good">Connected as ${escape(guardian)} — an owner of this account.</span>`
      : `<span class="banner banner--warn">Connected as ${escape(guardian)}, an owner — but your wallet is on chain ${walletChain} and this account is on ${escape(chain.name)}. Switch networks before submitting.</span>`;

    markDone('2');
    unlock('3');
    void refreshHoldings();
  } catch (e) {
    error.textContent = (e as Error).message;
  }
}

// MARK: - 3 · What to move

async function refreshHoldings() {
  if (!client || !account) return;
  const container = $<HTMLElement>('holdings');
  container.innerHTML = '<p class="hint">Looking for assets…</p>';

  holdings = await findHoldings(client, chain, account, manualTokens);
  selected = new Set(holdings.map(key));

  if (holdings.length === 0) {
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

  const chosen = holdings.filter((h) => selected.has(key(h)));
  if (chosen.length === 0) { error.textContent = 'Select at least one asset to move.'; return; }

  // Tokens first, ETH last. A batch is atomic so order cannot change the
  // outcome, but if one leg is ever made non-atomic the valuable, harder-to-
  // re-acquire assets should already have moved.
  const calls: Call[] = [];
  for (const holding of chosen) {
    if (holding.token === null) continue;
    calls.push(erc20Transfer(holding.token, destination, holding.balance));
  }
  const eth = chosen.find((h) => h.token === null);
  if (eth) {
    const sweepable = eth.balance > ETH_RESERVE ? eth.balance - ETH_RESERVE : 0n;
    if (sweepable > 0n) calls.push(ethTransfer(destination, sweepable));
  }
  if (calls.length === 0) {
    error.textContent = 'Nothing to move — the ETH balance is below the amount kept back for the next step.';
    return;
  }

  const data = batchCalldata(calls);
  const hash = transactionHash({
    account, chainId: chain.id, target: account, value: 0n, data, nonce: vault.nonce,
  });
  prepared = { calls, data, hash, nonce: vault.nonce, destination };

  $<HTMLElement>('review-readout').innerHTML =
    row('From', account) +
    row('To', destination) +
    row('Moving', chosen.map(formatHolding).join('\n'), true) +
    row('Chain', chain.name, true) +
    row('Nonce', String(vault.nonce), true) +
    row('Digest', hash) +
    (vault.delaySeconds > 0
      ? `<div class="banner banner--warn">Signing queues this recovery. It becomes executable in about ${Math.round(vault.delaySeconds / 86_400 * 10) / 10} days, and you finish it from this page.</div>`
      : `<div class="banner banner--good">This account has no waiting period, so it executes as soon as the transaction confirms.</div>`);

  markDone('3');
  unlock('4');
  step('4').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});

// MARK: - 4 · Sign and submit

$<HTMLButtonElement>('submit').addEventListener('click', async () => {
  const error = $<HTMLElement>('submit-error');
  error.textContent = '';
  if (!prepared || !account || !vault || !guardian || !guardianProvider || !client) return;

  const button = $<HTMLButtonElement>('submit');
  button.disabled = true;
  try {
    // Typed data rather than a raw hash: the wallet renders target, value and
    // nonce itself, so the guardian compares what this page claims against what
    // their own wallet independently says it is signing.
    const signature = (await guardianProvider.request({
      method: 'eth_signTypedData_v4',
      params: [guardian, JSON.stringify(typedData({
        account, chainId: chain.id, target: account,
        value: 0n, data: prepared.data, nonce: prepared.nonce,
      }))],
    })) as Hex;

    const calldata = executeCalldata(account, prepared.data, signature);
    const txHash = (await guardianProvider.request({
      method: 'eth_sendTransaction',
      params: [{ from: guardian, to: account, data: calldata, value: '0x0' }],
    })) as Hex;

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
    error.textContent = (e as Error).message;
  } finally {
    button.disabled = false;
  }
});

// MARK: - Finishing a queued recovery

function renderTickets() {
  const container = $<HTMLElement>('tickets');
  const tickets = loadTickets();
  container.replaceChildren();

  for (const ticket of tickets) {
    const ticketChain = chainByID(ticket.chainId);
    const card = document.createElement('div');
    card.className = 'ticket';
    const ready = ticket.eta === 0 || ticket.eta <= Math.floor(Date.now() / 1000);

    card.innerHTML =
      row('Account', ticket.account) +
      row('To', ticket.destination) +
      row('Chain', ticketChain?.name ?? String(ticket.chainId), true) +
      `<div class="row"><dt>Executable</dt><dd class="plain"><span class="ticket__wait${ready ? ' is-ready' : ''}">${escape(describeWait(ticket.eta))}</span></dd></div>`;

    const actions = document.createElement('div');
    actions.className = 'actions';

    const finish = document.createElement('button');
    finish.className = 'button button--primary';
    finish.textContent = 'Finish it';
    finish.disabled = !ready;
    finish.addEventListener('click', () => void finishTicket(ticket));

    const drop = document.createElement('button');
    drop.className = 'button';
    drop.textContent = 'Forget';
    drop.addEventListener('click', () => { forgetTicket(ticket.hash); renderTickets(); });

    actions.append(finish, drop);
    card.append(actions);
    container.append(card);
  }
}

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

    if (!guardianProvider || !guardian) {
      error.textContent = 'Connect a wallet first — someone has to send this transaction and pay its gas.';
      return;
    }

    // No signature this time. `executeQueued` checks only that the hash is
    // queued and its time has passed, so anyone can call it — the arguments
    // are the authorisation, which is why they must match byte for byte.
    const calldata = executeQueuedCalldata(ticket.account, ticket.data, ticket.nonce);
    const txHash = (await guardianProvider.request({
      method: 'eth_sendTransaction',
      params: [{ from: guardian, to: ticket.account, data: calldata, value: '0x0' }],
    })) as Hex;

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
  renderTickets();
});

renderTickets();
