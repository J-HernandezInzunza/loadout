cask "loadout" do
  # Loadout's release workflow rewrites version and sha256 when a release is published.
  version "0.1.0"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"

  url "https://github.com/J-HernandezInzunza/loadout/releases/download/v#{version}/Loadout_#{version}_aarch64.dmg"
  name "Loadout"
  desc "Install and share skills, agents and prompts for AI coding agents"
  homepage "https://github.com/J-HernandezInzunza/loadout"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on arch: :arm64
  depends_on macos: :sonoma

  app "Loadout.app"

  # The app's own data only: the skills it installed into ~/.claude stay where they are.
  zap trash: [
    "~/Library/Application Support/com.jhernandezinzunza.loadout",
    "~/Library/Caches/com.jhernandezinzunza.loadout",
    "~/Library/Preferences/com.jhernandezinzunza.loadout.plist",
    "~/Library/WebKit/com.jhernandezinzunza.loadout",
  ]

  caveats <<~EOS
    Loadout is not notarized by Apple yet, so macOS blocks it the first time it opens.
    After installing, and again after each upgrade, run:
      xattr -dr com.apple.quarantine "#{appdir}/Loadout.app"
    Why: https://github.com/J-HernandezInzunza/loadout#why-the-xattr-step
  EOS
end
