# Release process

How to ship a new version of this plugin and keep the three listings in sync.

## Listings

| Where | Source of truth | How it updates |
| --- | --- | --- |
| GitHub | `main` + version tags | push |
| npm [`paseo-turn-speed`](https://www.npmjs.com/package/paseo-turn-speed) | `npm publish` | manual |
| Official [paseo.sh/plugins](https://paseo.sh/plugins) | npm artifact ([submission #475](https://github.com/getpaseo/plugins/issues/475), merged via PR #476) | bot opens a bump PR on each npm release; a reviewer merges |

Local development stays on the directory source (`paseo plugin install "$(pwd)"`);
public installs use `npm:paseo-turn-speed`.

## Cutting a release

1. Bump `version` in `package.json` (semver; the npm version is the update
   identity both registries track).
2. `npm run verify` (typecheck + unit tests + client-bundle check).
3. `git commit` then `git tag vX.Y.Z`.
4. `git push origin main --follow-tags` — tags are lightweight, so also run
   `git push origin vX.Y.Z` (`--follow-tags` only pushes annotated tags).
5. Publish (see npm gotchas below): `npm publish`.
6. Wait for the staged publish to finish: `npm view paseo-turn-speed@latest version`
   returns `0.0.0-stage` for a couple of minutes, then the new version.
7. Smoke-test both install sources and remove the temporary instances:
   ```bash
   paseo plugin add npm:paseo-turn-speed --id turn-speed-smoke   # expect: running
   paseo plugin remove turn-speed-smoke
   paseo plugin add github:Drenalol/paseo-turn-speed --id turn-speed-smoke-git
   paseo plugin remove turn-speed-smoke-git
   ```

## npm gotchas (learned the hard way)

- **Publishing requires 2FA.** The account uses a passkey. The passkey CLI flow
  only exists in npm 11+; the npm first in `PATH` (`~/.local/bin/npm`, hermes
  bundle) is 10.9.8 and fails with `EOTP`. Use `/usr/local/bin/npm publish`.
- The web session in `~/.npmrc` expires; then `npm publish` fails with a
  misleading `404 PUT` (not 401) before any prompt appears. Check with
  `npm whoami` and refresh via `npm login --auth-type=web` first. Both login
  and publish print their own one-time URL (`/login/cli/…`, `/auth/cli/…`)
  that needs a browser passkey confirmation within minutes — in a
  non-interactive shell, drive each via `expect` and scrape the URL from the
  expect `log_file`.
- npm is deprecating 2FA-bypassing automation tokens for direct publishing
  (banner: "npm tokens that bypass 2FA are being restricted"), so per-release
  web confirmation is the expected future flow, not a regression.
- The publish command prints `https://www.npmjs.com/auth/cli/<id>` and waits for
  the browser passkey confirmation. The CLI session expires in minutes — open
  the link promptly. Without a TTY, wrap it in a PTY (`expect`) so the
  "Press ENTER to open in the browser..." prompt gets answered.

## Registry conventions (history)

paseo.cafe — the community registry this plugin was listed on until it shut
down — had a security scanner that only allowed the top-level
`paseo-plugin.json` keys `id`, `description`, `requirements`, `build`. The
manifest is still trimmed to that allow-list: Paseo itself supports `name`,
`icon` and `media` (see `PluginManifestSchema` in `@getpaseo/server`) and
`assets/icon.png` is ready, but returning those fields to the manifest is
deliberately deferred until the official registry is checked with them.

Validation rules the registries enforce (worth keeping either way):

- `OVERVIEW.md` must not contain the strings `paseo plugin add`,
  `npm install`, `npm i` (registry docs belong in the README).
- The README keeps an `## Install` section and a `## Known limitations`
  section — the registries detect those headings and pull them into the
  listing — plus an `images/` folder for screenshots.

## History

- 2026-10-15 — v1.0.0 published; approved and merged in the official registry
  (PR getpaseo/plugins#476) the same day.
- v1.0.1 — manifest trimmed to the scanner allow-list; cafe admission passed
  after re-submission (paseo-cafe#380/#381 merged).
- 2026-10-23 — v1.1.0 published: subagent awareness (delegated-time exclusion,
  team badge, per-child popover via `paseo.parent-agent-id` labels). npm web
  session had expired — republished after `npm login --auth-type=web` plus a
  separate `/auth/cli/` confirmation for the publish itself (see gotchas).
  Registry bump PR is opened by the bot after the staged publish resolves;
  cafe re-scans automatically.
- 2026-10-25 — v1.2.0 published: thinking-token accounting (exclusion
  detection, reasoning-specific 3.7 chars/token estimate, per-model verdict
  with revocation rules), unattributed-token retention, open-step decode
  windows, plausibility-capped displayed rates. Same expired-session login
  flow as v1.1.0; both smoke installs passed.
- 2026-10-25 — v1.2.1 published (docs-only): README links the upstream
  `AgentUsage.reasoningTokens` request (getpaseo/paseo discussion #7863) from
  Known limitations, so registry listings carry the upvote target. Session
  still warm from v1.2.0; publish still required its own `/auth/cli/` passkey.
- 2026-11-02 — paseo.cafe shut down: community listing dropped from the
  release process and from the listings table; its scanner-specific manifest
  restrictions are kept only as history (see Registry conventions).
- 2026-11-02 — v1.3.0 published: prompt cache hit rate in the pill and
  popover (PR #1: `showCacheInPill` and `cacheCounting` preferences,
  auto/inclusive/separate detection), and turn-window reconciliation
  (PR #2: the clock anchors to the `turn_started` event timestamp, mid-turn
  attach seeds only after the subscription is ready, and a snapshot closes a
  turn whose terminal event was lost provisionally). Both PRs were external
  contributions; the combined tree verified at 98 tests.
