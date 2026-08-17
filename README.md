# nani-recovery

A single page that lets a guardian move funds out of a nani account nobody can
sign for any more.

Live at `recovery.nani.ooo`.

## What it's for

A nani account can have a **guardian**: a second owner, with a waiting period.
The guardian can't touch anything day to day — their transactions queue, and the
account holder can cancel during the wait. But if the account holder loses their
key, the guardian is the only way the funds move again.

That recovery has to happen somewhere the lost machine isn't. This is that
somewhere. It needs the guardian's wallet and nothing else: no recovery phrase,
no nani install, no account.

## How it works

The account is an EIP-7702 or factory-deployed [z0r0z/multisig][ms]. `execute`
is public and takes owner signatures, so the guardian signs an EIP-712 `Execute`
digest and submits it themselves, paying the gas.

The sweep is wrapped as one self-call: `batch(...)` is `onlySelf`, but
`execute` performs `target.call(data)`, so pointing `target` at the account
means the inner call arrives with `msg.sender == address(this)` and the guard
passes. One signature moves every asset atomically instead of one transaction
per token.

[ms]: https://github.com/z0r0z/multisig

## The waiting period

If the account has one — and it should — `execute` **queues** rather than runs.
The contract stores only `keccak(target, value, keccak(data), nonce)`, so
finishing days later means presenting those four values again, byte for byte.
Rebuild the batch with the tokens in a different order and the hash is
different; the chain has never heard of it.

So the payload is saved rather than rebuilt: to local storage, and as a copyable
JSON file for the case that matters — a different machine, weeks later, on the
day it finally becomes executable. Loading a file re-derives the digest before
trusting it.

`executeQueued` takes no signature. It checks only that the hash is queued and
its time has passed, so anyone can complete a recovery — the arguments *are* the
authorisation.

## What it doesn't touch

Keys. There is no server and no backend: chain reads go to public RPCs from your
browser, and your wallet broadcasts. Nothing is stored anywhere but your own
browser, and only the recovery payload.

## Running it

```
pnpm install
pnpm test     # 12 tests, digest vectors from `cast` against Multisig.sol
pnpm dev
pnpm build    # one self-contained dist/index.html
```

Vectors are re-pinned here rather than imported from the wallet or from
`airgap`. If this page computed the digest even slightly differently, a guardian
would sign something the contract has never heard of — and that failure is
indistinguishable from "you aren't an owner". It has to disagree with the
contract or with nothing.

## Deploying

`render.yaml` describes a Render static site on the free tier: no server,
because a recovery tool with a server is a recovery tool that can be down.

Publish the build's hash alongside it. `recovery.nani.ooo` is a mutable domain
and this is an obvious phishing target; a hash is something a panicking person
can be told to check.

```
shasum -a 256 dist/index.html
```
