# NWC request timeouts

In `applesauce-wallet-connect@6.2.0`, encryption negotiation waits for a wallet-info event (kind 13194) before starting the response timeout. If a relay subscription stalls before that event arrives, the library request can remain pending indefinitely.

The wallet adapter adds an overall deadline: 15 seconds per read attempt and 45 seconds per payment. Reads can rebuild the relay connection and retry once. Payments are never automatically retried. The library still applies its own 30-second response timeout after negotiation; the 45-second deadline does not extend it.

Normal NIP-47 wallet errors do not rebuild the shared relay connection: a wallet error proves a response arrived, and rebuilding could interrupt unrelated payments. Transport failures and timeouts, including the library's own timeout, still trigger recovery.

CLI `/nwc/*` requests have a 120-second deadline covering headers and response-body consumption. Other daemon routes are not subject to this cap because mint payment operations may run longer and cannot be cancelled by aborting the CLI request.

A payment timeout is an **unknown outcome**, not proof that no payment occurred. Promise deadlines do not cancel the underlying operation. Check the mint quote, wallet transactions, and Cashu balance before creating and paying another invoice.

The auto-refill loop starts when static configuration or a dynamic configuration getter is supplied, even without an NWC connection at startup. It reads the current wallet and configuration each cycle, so a later connection can activate refills without restarting the daemon.
