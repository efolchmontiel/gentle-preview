# Third-party notices

This repository is an independent implementation for the [Pi Coding Agent](https://pi.dev) and Gentle Shell. Nothing here is copied from another project's source code; the tables below record what inspired the work and what it runs on.

## Ideas and behaviour

| Project | Licence | What it contributed |
| --- | --- | --- |
| [midudev/better-claude](https://github.com/midudev/better-claude) — `plugins/quick-peek` | MIT © Miguel Ángel Durán (midudev) | The idea of turning the file paths of a session into previews: a hover window with the file's first lines coloured, the named line lit, name, kind, size and age, and a click that reveals the file in the system file manager. |
| [midudev/better-claude](https://github.com/midudev/better-claude) — `plugins/image-preview` | MIT © Miguel Ángel Durán (midudev) | The idea of previewing a pasted image next to its placeholder, in a window of its own or drawn in the terminal, with a click that opens the system viewer. |

Both plugins in this repository were rebuilt against the Pi extension API rather than ported line by line. The differences are not cosmetic and are documented in each package README:

- Pi exposes no render hook over a built-in assistant or user message, so `quick-peek` acts through its own overlay instead of rewriting how a reply is drawn.
- Pi stores a pasted clipboard image as a file and inserts its path, so `image-preview` numbers that file as `[Image #N]` inside the prompt draft and appends an `[Image refs]` block so the model can resolve each token.
- Pi routes mouse input to extensions only in fullscreen mode, so every interaction keeps a keyboard path.

No source file, asset or test from better-claude is included in this repository or in the published packages.

## Host APIs

These packages are declared as `peerDependencies` with a `*` range and are never bundled. They are provided by the Pi runtime:

| Package | Licence |
| --- | --- |
| [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) | MIT |
| [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui) | MIT |

## Development-only dependencies

Used to typecheck and test the packages; not shipped to users:

| Package | Licence |
| --- | --- |
| `typescript` | Apache-2.0 |
| `@types/node` | MIT |

## Runtime dependencies

None. Both published packages run on Node builtins only. Checked by `npm run pack:check` and by the `dependencies` field being absent in each `package.json`.
