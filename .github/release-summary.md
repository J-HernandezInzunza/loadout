## Install

With Homebrew:

```sh
brew install --cask j-hernandezinzunza/tap/loadout
```

Without Homebrew: download `Loadout___VERSION___aarch64.dmg` from the assets below, open it and drag
Loadout to Applications. If you use Terminal, you can check the download against its `.sha256`:

```sh
shasum -a 256 -c Loadout___VERSION___aarch64.dmg.sha256
```

A `.dmg` install doesn't update itself: watch this repository's Releases for the next version.

## Open it the first time

Loadout isn't notarized by Apple yet, so the first time it opens macOS says **"Loadout" Not Opened**.
That's expected: click **Done**, not Move to Trash, then either:

- **System Settings:** Privacy & Security → scroll to Security → **Open Anyway**, then **Open**
  (enter your password if asked).
- **Terminal:** `xattr -dr com.apple.quarantine /Applications/Loadout.app`, then open Loadout.

macOS sometimes asks again after an upgrade. If it does, do this again.

## Upgrade

```sh
brew upgrade --cask loadout
```

If macOS blocks it again, open it the first time again, as above.

## Known issues

- Apple Silicon Macs only, macOS 14 (Sonoma) or later.
