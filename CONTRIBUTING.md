# Contributing

Two plugins live in this repository, one package each:

| Package | Directory |
| --- | --- |
| [`gentle-quick-peek`](packages/quick-peek) | `packages/quick-peek` |
| [`gentle-image-preview`](packages/image-preview) | `packages/image-preview` |

## Issues come first

**Every pull request must reference an issue, and an issue must exist before the work starts.**

1. Open an issue describing the problem or the change. For a bug, say what you ran, what you expected and what you saw.
2. Wait for the issue to be accepted. A maintainer will say so in the issue. Work on an unaccepted issue may be closed without review.
3. Open the pull request with `Closes #<issue>` in the description. A pull request without a linked, accepted issue is closed.

## Who merges

Only the repository owner merges. Contributors — including anyone who opened the pull request — never merge, never push to `main`, and never force-push a shared branch. Merging is not implied by an approved review, a green CI run, or a maintainer saying "looks good".

## Workflow

```bash
git clone git@github.com:efolchmontiel/gentle-preview.git
cd gentle-preview
git switch -c feat/<short-name>      # or fix/<short-name>, docs/<short-name>
npm install
```

Branch from `main`, keep the branch focused on one issue, and open the pull request against `main`.

## Checks your pull request must pass

```bash
npm test           # every package suite
npm run typecheck  # tsc --noEmit
npm run pack:check # npm pack --dry-run in each package
```

One package only:

```bash
npm test -- packages/quick-peek/tests
```

CI runs the same three commands on Linux, Windows and macOS. A pull request whose CI is red is not reviewed.

## Rules this repository holds to

- **No new runtime dependencies.** Both packages ship zero dependencies and use Node builtins only. A dependency needs a discussion in the issue first.
- **Tests come with the behavior.** Tests use `node:test` and `node:assert/strict`, and must be deterministic: no network, no real clipboard, no real terminal. A temporary directory goes under `os.tmpdir()` and starts with `gentle-preview-`, which is the prefix the runner cleans up.
- **Cross-platform or it does not count.** Anything touching paths, commands or clipboard handling works on Linux, macOS, Windows and WSL. Platform-dependent code takes an injected platform or environment so it can be tested everywhere.
- **Never spawn a shell.** Use `spawn` with an argv array: no `shell: true`, no string-built commands.
- **Keyboard first.** Mouse hover and click are additions that only exist in Pi's fullscreen mode; every interaction keeps a keyboard path.
- **Keep host packages as peers.** `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` stay in `peerDependencies` and are never bundled.
- **Conventional Commits.** `feat(quick-peek): …`, `fix(image-preview): …`, `docs: …`, `ci: …`. Keep tests and documentation in the same commit as the behavior they describe.
- **Reviewable size.** Aim for a change a person can review in one sitting. Large work goes into several pull requests.

## Attribution

The ideas for both plugins come from [midudev/better-claude](https://github.com/midudev/better-claude) (MIT), which implements them for Claude Code. This repository is an independent port to the Pi extension API, not a copy: see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
