# Loadout

A Mac app for the skills, agents and prompts you use with Claude Code. Your team keeps them in a
catalog (a git repository with a `library.yaml`); Loadout installs them into `~/.claude`, turns them on
and off, keeps them up to date, and sends your edits back to the catalog as a pull request.

Needs an Apple Silicon Mac with macOS 14 (Sonoma) or later, and `git` (run `xcode-select --install`
if you don't have it).

## Install

### With Homebrew

```sh
brew install --cask j-hernandezinzunza/tap/loadout
xattr -dr com.apple.quarantine /Applications/Loadout.app
```

The full name (`j-hernandezinzunza/tap/loadout`) taps this repository's tap and trusts only the
Loadout cask in it. The second line is explained [below](#why-the-xattr-step).

### Without Homebrew

1. From the [latest release](https://github.com/J-HernandezInzunza/loadout/releases/latest), download
   `Loadout_<version>_aarch64.dmg` and `Loadout_<version>_aarch64.dmg.sha256` into the same folder.
2. Check the download. In that folder:

   ```sh
   shasum -a 256 -c Loadout_<version>_aarch64.dmg.sha256
   ```

   It should print `Loadout_<version>_aarch64.dmg: OK`. Anything else: don't open it, download again.
3. Open the `.dmg` and drag Loadout to Applications.
4. Run `xattr -dr com.apple.quarantine /Applications/Loadout.app`.

A copy installed this way doesn't update itself. To hear about new versions, watch this repository
for releases (Watch → Custom → Releases).

### Why the xattr step

Loadout isn't notarized by Apple yet (that takes a paid Apple Developer ID), so macOS blocks a
downloaded copy the first time it opens and offers only to move it to the Trash. The command removes
the "downloaded from the internet" flag (`com.apple.quarantine`) from Loadout.app, and from nothing
else, so it opens normally. Each upgrade is a new download with the flag set again, and each build is
signed afresh, so run the command again after every upgrade.

### Moving from a `.dmg` install to Homebrew

If the Loadout in Applications is the latest release:

```sh
brew install --cask --adopt j-hernandezinzunza/tap/loadout
```

`--adopt` takes over an app only when it is identical to the one Homebrew would install. If yours is
older, quit Loadout, move it to the Trash and install with Homebrew as above. Your catalogs, settings
and sign-ins stay: they live in `~/Library/Application Support` and the keychain, not in the app.

## Upgrade

```sh
brew upgrade --cask loadout
xattr -dr com.apple.quarantine /Applications/Loadout.app
```

From a `.dmg`: download the new one, replace Loadout in Applications, and run the `xattr` command.

## Sign in

Connecting your GitHub and Bitbucket accounts lets Loadout list your team's catalogs and open pull
requests for you. In Loadout, the sidebar's **Accounts** → **Sign in to GitHub** (or Bitbucket); you
sign in and grant access in your browser. Tokens are kept in your macOS keychain. Without an account,
`git` uses the SSH keys or credentials you already have.

## Uninstall

```sh
brew uninstall --cask loadout          # the app only
brew uninstall --cask --zap loadout    # the app and its data
```

`--zap` also moves Loadout's own data to the Trash: its settings and catalog clones in
`~/Library/Application Support/com.jhernandezinzunza.loadout`, and its caches, preferences and web
storage. It never touches `~/.claude`: the skills, agents and prompts Loadout installed stay where they
are (remove them in Loadout first if you want them gone). To remove the sign-in tokens from your
keychain, **Disconnect** each account in Accounts before uninstalling.

Installed from a `.dmg`: move Loadout to the Trash (and that folder too, for its data).

## Report a bug

[Open a bug report](https://github.com/J-HernandezInzunza/loadout/issues/new?template=bug_report.yml).
It asks for your Loadout version (at the foot of the sidebar) and Doctor's output (**Catalogs** →
**Check catalog health**).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, the `npm run check` gate, CI and the release runbook.
