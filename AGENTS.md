# Agent notes

## This repository's forge is Grasp (git over Nostr), not GitHub

`origin` is `nostr://npub1m5tu2t8fynfw46hcm779qtnltt74uc6fzmf6t0l2zxwsy5uutens6mxx2f/relay.ngit.dev/routstrd`
and it is canonical. Use [ngit](https://ngit.dev/install) (`ngit`, gitworkshop.dev)
for issues, pull requests, reviews and releases.

Before any of those tasks — including pushing a pull request branch — run
`ngit --help` and follow its workflow map. PR branches must be named `pr/<name>`.
If ngit is missing, install it from https://ngit.dev/install.

## GitHub is a mirror, used only as a CI and release runner

`github` (`git@github.com:Routstr/routstrd`) mirrors nostr. Never push to it
directly; `.github/workflows/sync-nostr-github.yml` keeps the two sides in step.

GitHub Actions is what builds and ships this project: `release.yml` produces the
four platform binaries, publishes to npm with provenance, and creates the GitHub
Release. Push to `origin` (nostr) and let sync run.

## Releasing

1. Bump `package.json` (and pin the matching `@routstr/sdk` if the SDK changed).
2. Commit and push `main` to `origin`, so sync forwards it to GitHub.
3. Tag, then push **the branch and the tag in one command**:

   ```sh
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

   Pushing them together guarantees the sync run sees both refs. Two separate
   pushes race: the `main` sync can finish before the tag exists.

4. `release.yml` runs validate → build (4 platforms) → npm → GitHub Release. It
   asserts the tag matches `package.json` and the compiled `--version` output.

Do **not** tag on GitHub. Tag syncing in the sync workflow is one-way,
nostr → GitHub: a tag created only on GitHub never reaches the canonical repo.
(ngit's own push does replicate to `github` directly, which is why a nostr tag
still triggers the release promptly.)

Re-running is safe: npm publishing skips a version that already exists.

Note that `bun test` needs writable temp space. On a small or full `/tmp` the
SQLite-backed tests fail with `SQLITE_IOERR`/`EDQUOT`; set `TMPDIR` to a
directory on real disk.
