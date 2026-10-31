# Questions

Decisions the loop needs from the owner. A task marked `Blocked: (Qn)` in `docs/PLAN.md` waits on
the question with that number. Answer under **Answer**, then remove the task's `Blocked` line.

## Q1. Approve the splice deviations (resolved 2026-10-28: approved; M1.08–M1.11 unblocked)

Your answers to Q4, A11, A12 and A13 make Loadout write 269 of the 896 golden splice cases
differently from `library.py`. `tools/golden/rebuild_ref.py` turns behaviors.md §0.1 D1–D4 into
those expectations. The report shows each one as a diff, grouped by rule:
https://claude.ai/artifact/6sSVLzzWD9DqoxErYrzAPN (regenerate with
`python3 tools/golden/report.py`).

Approve as is, or name the cards to change (e.g. "D3.4: keep the blank line above").

**Answer:** look good, approved.

## Q2. `gh pr create` reports the PR already exists (resolved 2026-10-28: A; M3.06 unblocked)

When the same branch is pushed twice, `gh pr create` exits 1 with `a pull request for branch "…"
into branch "…" already exists:` and the existing PR's URL (spikes.md S5). WRITE-11 would surface
the last stderr line, a bare URL, as an error.

- [x] A. Treat it as success and return the existing PR's URL (recommended: a retried write
      becomes idempotent)
- [ ] B. Keep WRITE-11: report it as a `gh` failure warning with the compare URL

**Answer:**

Follow-up (2026-10-28): Loadout no longer uses `gh` (architecture.md §5.5). The same answer applies
to the REST APIs: when a PR for the branch already exists, return its URL as success.

## Q3. Deny more credential stores in the fs scope (resolved 2026-10-28: A, applied)

With dot-directories now inside the fs scope (spikes.md S3a), the webview can read
`~/.config/gh/hosts.yml` (gh's token), `~/.aws`, `~/.netrc`, `~/.docker/config.json` and `~/.kube`.
The webview only loads bundled code with a strict CSP, so this is defence in depth.

- [x] A. Add those five to `deny` (recommended; cheap)
- [ ] B. Keep R3's three denies

**Answer:**

## Q4. Startup wait for the login-shell probe (resolved 2026-10-28: cache, in M4)

A Finder launch waits 2–3 s on your shell before the window opens (spikes.md S2). Recommended for
M4: cache the probed PATH in app data, use it at once, refresh it in the background.

**Answer: cache sounds good**

## Q5. Who registers the OAuth apps? (resolved 2026-10-29: the owner registered both; M4.12–M4.15 unblocked)

Browser sign-in (architecture.md §5.5) needs two registrations outside the code:

1. **Bitbucket OAuth consumer**, in a Bitbucket workspace (the team's workspace, so teammates
   recognise it), by a workspace admin. Scopes: account read, repository read/write, pull requests
   write. Users still sign in and grant access themselves; the consumer's secret only identifies
   the app. Bitbucket's token exchange requires it and Atlassian documents no PKCE, so it is kept
   out of the repo as a GitHub Actions secret and injected into release builds, which means it is
   inside every installed copy and can be extracted (architecture.md §10 risk 13: no access on its
   own, a phishing risk; rotate if leaked). Is that acceptable to whoever owns the workspace, or do
   you prefer a small token-exchange service that holds it instead?
2. **GitHub OAuth app** (or GitHub App): under your account or the team's org. Device flow needs no
   secret.

M2 and M3 test with injected tokens, so nothing waits on this until M4.

**Answer: I will register it, but need a walkthrough of scopes/permissions to define**

Follow-up (2026-10-29), what to register:

- **GitHub OAuth app** (Settings → Developer settings → OAuth Apps → New OAuth App): name Loadout;
  any homepage URL; callback URL required but unused by device flow (`http://127.0.0.1/`);
  **Enable Device Flow** on; **Expire user access tokens** off (refreshing a GitHub token needs the
  client secret, which device flow avoids). Scopes are requested at sign-in, not registered:
  `repo` (private sources and catalogs: clone, push, PRs). Under an org with OAuth app access
  restrictions, an owner must approve the app before its tokens reach org repos.
- **Bitbucket OAuth consumer** (workspace settings → OAuth consumers → Add consumer): name Loadout;
  callback URL `loadout://oauth/bitbucket` for now (editable; M4.12 decides between it and a
  loopback URL); **This is a private consumer** off; permissions **Account: Read**,
  **Repositories: Write**, **Pull requests: Write** (it implies repository write), nothing else.
  Keep the key and secret out of the repo and chat; M4.12 reads them from environment variables.
- Decided 2026-10-29: the Bitbucket secret ships in builds (a CI secret, injected at build time); no
  token-exchange service. Alone it grants nothing (the consumer isn't private, so no
  client-credentials grant); it lets someone pose as Loadout and redeem an authorization code they
  manage to intercept, so M4.12 prefers the redirect that is hardest to intercept and M4.14 sends
  and checks a `state` value. Rotate it if it is abused.
- Both apps registered 2026-10-29 (spikes.md S12).

## Q6. A fourth Rust command for `realPath` (resolved 2026-10-29: A confirmed)

`HostFs.realPath` resolves symlinks, and the core uses it in six places (local catalog keys, the
`~/.claude/settings.json` symlink, the import's `~/.claude/skills/library` link, fetch, suggest,
remove-catalog). `tauri-plugin-fs` has no `realpath` or `readlink`, so the webview cannot compute it.
architecture.md §2.4 allows no `#[tauri::command]` but the three Keychain ones.

- [x] A. Add `real_path` (`std::fs::canonicalize`, ~3 lines of glue), granted through an app manifest
      in `build.rs` so it is denied unless `capabilities/default.json` lists `allow-real-path`
      (recommended; applied). It reveals where a path resolves, never file content, so it has no fs
      scope of its own.
- [ ] B. Same command, but checking input and result against the fs scope's allow and deny globs in
      Rust (the capability's `fs:scope` isn't reachable from an app command, so the globs would be
      duplicated).
- [ ] C. No command: treat `realPath` as identity on the Tauri host. Breaks the symlinked
      `settings.json` case (arch §4.5) and catalog identity through symlinks.

**Answer: confirmed**
