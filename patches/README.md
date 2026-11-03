# NPC transport lifecycle patches

These version-scoped Bun patches cover `npubcash-sdk@0.3.2` and
`coco-cashu-plugin-npc@2.4.1`. `bun install --frozen-lockfile` applies them;
re-evaluate/remove them when upgrading either dependency. Both distributed
ESM and CommonJS entry points are patched, together with their declarations.
No global fetch replacement or application access to private SDK fields is used.

- SDK constructors accept optional `NPCRequestOptions` (`requestTimeoutMs`,
  `signal`). Every SDK HTTP request defaults to a 10-second deadline. The timer
  remains active through body consumption, including non-success responses;
  the response is buffered before existing JSON/error handling runs. Successful
  authentication, headers, pagination, and retry behavior stay unchanged.
- The plugin supplies one lifetime abort signal to both its JWT provider and
  API client, and aborts it before awaiting its sync runner during shutdown.
  Authentication and quote fetches already in progress are canceled; subsequent
  page requests cannot start network work. `requestTimeoutMs` is available on
  plugin options, primarily to test cancellation independently of the deadline.

The deadline is **per HTTP request**, not per complete sync: a large paginated
history may legitimately take longer than 10 seconds. Shutdown cancellation
applies across all those pages (pagination's existing 200ms sleep is not canceled).
This does not bound external signers or mint-service imports. The daemon signer
is local; an in-flight Cashu mint operation still follows the wallet/core's
existing recovery and shutdown contracts. This patch must not be represented as
an unconditional 30-second bound on every possible wallet operation.

`src/daemon/wallet/npc-transport.test.ts` uses loopback HTTP, real SDK requests,
and both real plugin builds. It covers authentication and quote stalls before
headers and during bodies, deadline recovery, body-stream cancellation,
shutdown cancellation independent of the deadline, and successful pagination.
The separate mocked wallet integration test explicitly holds recovery and
verifies that disposal prevents a startup catch-up; it does not test transport.
