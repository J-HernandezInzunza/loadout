# Questions

Decisions the loop needs from the owner. A task marked `Blocked: (Qn)` in `docs/PLAN.md` waits on
the question with that number. Answer under **Answer**, then remove the task's `Blocked` line.

## Q1. Approve the splice deviations (blocks M1.08–M1.11)

Your answers to Q4, A11, A12 and A13 make Loadout write 269 of the 896 golden splice cases
differently from `library.py`. `tools/golden/rebuild_ref.py` turns behaviors.md §0.1 D1–D4 into
those expectations. The report shows each one as a diff, grouped by rule:
https://claude.ai/artifact/6sSVLzzWD9DqoxErYrzAPN (regenerate with
`python3 tools/golden/report.py`).

Approve as is, or name the cards to change (e.g. "D3.4: keep the blank line above").

**Answer:**

## Q2. `gh pr create` reports the PR already exists (blocks M3.06)

When the same branch is pushed twice, `gh pr create` exits 1 with `a pull request for branch "…"
into branch "…" already exists:` and the existing PR's URL (spikes.md S5). WRITE-11 would surface
the last stderr line, a bare URL, as an error.

- [ ] A. Treat it as success and return the existing PR's URL (recommended: a retried write
      becomes idempotent)
- [ ] B. Keep WRITE-11: report it as a `gh` failure warning with the compare URL

**Answer:**

## Q3. Deny more credential stores in the fs scope (not blocking; capability file)

With dot-directories now inside the fs scope (spikes.md S3a), the webview can read
`~/.config/gh/hosts.yml` (gh's token), `~/.aws`, `~/.netrc`, `~/.docker/config.json` and `~/.kube`.
The webview only loads bundled code with a strict CSP, so this is defence in depth.

- [ ] A. Add those five to `deny` (recommended; cheap)
- [ ] B. Keep R3's three denies

**Answer:**

## Q4. Startup wait for the login-shell probe (not blocking; M4)

A Finder launch waits 2–3 s on your shell before the window opens (spikes.md S2). Recommended for
M4: cache the probed PATH in app data, use it at once, refresh it in the background.

**Answer:**
