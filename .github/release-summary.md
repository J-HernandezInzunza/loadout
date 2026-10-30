## Install

With Homebrew:

```sh
brew install --cask j-hernandezinzunza/tap/loadout
xattr -dr com.apple.quarantine /Applications/Loadout.app
```

Without Homebrew: download `Loadout___VERSION___aarch64.dmg` and its `.sha256` from the assets below, check
the download, open the `.dmg` and drag Loadout to Applications, then run the same `xattr` command.

```sh
shasum -a 256 -c Loadout___VERSION___aarch64.dmg.sha256
```

A `.dmg` install doesn't update itself: watch this repository's Releases for the next version.

## Upgrade

```sh
brew upgrade --cask loadout
xattr -dr com.apple.quarantine /Applications/Loadout.app
```

## Why the `xattr` step

Loadout isn't notarized by Apple yet, so macOS blocks a downloaded copy the first time it opens. The
command removes the "downloaded from the internet" flag from Loadout.app and nothing else. Each build
is signed afresh, so macOS can ask again after an upgrade: run the command again.

## Known issues

- Apple Silicon Macs only, macOS 14 (Sonoma) or later.
