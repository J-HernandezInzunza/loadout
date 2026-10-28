// What a Finder-launched bundle can find (architecture.md §5.3).
//
// launchd starts a bundle with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so Homebrew's git and gh are
// invisible, and shell exports such as CLAUDE_CONFIG_DIR are missing. Before any plugin starts,
// ask the user's login shell once (bounded by a timeout) and repair the process environment.

use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Marks the probe's output line among whatever the profile prints (banners, fortunes).
const MARKER: &str = "__loadout_env__";

/// A profile slower than this does not hold up the window; the fallbacks still apply. Heavy but
/// ordinary profiles (nvm, jenv, cloud SDKs) took 2-3 s in the M0 spike, so 3 s was too tight.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Where git and gh land under the common installers, for when the probe returns nothing.
const FALLBACKS: &[&str] = &["/opt/homebrew/bin", "/usr/local/bin", "~/.local/bin"];

/// What the login shell reported.
#[derive(Debug, Default, PartialEq)]
pub struct ShellEnv {
    pub path: Vec<String>,
    pub claude_config_dir: Option<String>,
}

/// Give the process the PATH a terminal would have, and adopt CLAUDE_CONFIG_DIR when the process
/// does not already have it. Call once, before the builder.
pub fn repair_env() {
    let probed = probe_login_shell(PROBE_TIMEOUT).unwrap_or_default();
    let home = std::env::var("HOME").ok();
    let fallbacks: Vec<String> = FALLBACKS.iter().map(|dir| expand_home(dir, home.as_deref())).collect();

    let current = std::env::var("PATH").unwrap_or_default();
    let widened = widened_path(&current, &probed.path, &fallbacks);
    if widened != current {
        std::env::set_var("PATH", widened);
    }
    if std::env::var_os("CLAUDE_CONFIG_DIR").is_none() {
        if let Some(dir) = probed.claude_config_dir {
            std::env::set_var("CLAUDE_CONFIG_DIR", dir);
        }
    }
}

/// `-i` as well as `-l`: zsh reads .zshrc only when interactive, and that is where most PATH
/// edits live. stdin is closed so a profile that prompts fails instead of waiting.
fn probe_login_shell(timeout: Duration) -> Option<ShellEnv> {
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty())?;
    let script = format!("printf '\\n{MARKER}%s\\t%s\\n' \"$PATH\" \"${{CLAUDE_CONFIG_DIR-}}\"");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    // Read on a thread so a chatty profile cannot fill the pipe while we wait on the deadline.
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        out
    });
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    reader.join().ok().map(|out| parse_marked(&out))
}

/// The last marked line wins: a profile that echoes commands would otherwise match first.
fn parse_marked(stdout: &str) -> ShellEnv {
    let Some(line) = stdout.lines().rev().find_map(|l| l.strip_prefix(MARKER)) else {
        return ShellEnv::default();
    };
    let (path, config_dir) = line.split_once('\t').unwrap_or((line, ""));
    ShellEnv {
        path: split(path),
        claude_config_dir: Some(config_dir.to_string()).filter(|d| !d.is_empty()),
    }
}

/// `~` is the shell's expansion, not exec's, so a literal `~/...` would never resolve.
fn expand_home(dir: &str, home: Option<&str>) -> String {
    match (dir.strip_prefix("~/"), home) {
        (Some(rest), Some(home)) if !home.is_empty() => PathBuf::from(home).join(rest).display().to_string(),
        _ => dir.to_string(),
    }
}

fn split(path: &str) -> Vec<String> {
    path.split(':').filter(|d| !d.is_empty()).map(str::to_string).collect()
}

/// The login shell's PATH first, in its own order, then what the process had, then the fallbacks;
/// each directory once. Shell order must lead: launchd's /usr/bin holds the Xcode git stub, which
/// would otherwise shadow Homebrew's git and prompt to install the Command Line Tools
/// (docs/spec/spikes.md, S2). A terminal launch already has the shell's PATH, so it is unchanged.
fn widened_path(current: &str, shell: &[String], fallbacks: &[String]) -> String {
    let mut dirs: Vec<String> = Vec::new();
    for dir in shell.iter().cloned().chain(split(current)).chain(fallbacks.iter().cloned()) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs.join(":")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_marked_line_among_profile_chatter() {
        let out = format!("Welcome!\n{MARKER}/a:/b\t/cfg\nbye\n");
        assert_eq!(
            parse_marked(&out),
            ShellEnv { path: vec!["/a".into(), "/b".into()], claude_config_dir: Some("/cfg".into()) }
        );
    }

    #[test]
    fn the_last_marked_line_wins_and_an_empty_config_dir_is_none() {
        let out = format!("{MARKER}/echoed\t/x\n{MARKER}/real:\t\n");
        assert_eq!(parse_marked(&out), ShellEnv { path: vec!["/real".into()], claude_config_dir: None });
    }

    #[test]
    fn no_marker_means_nothing_learned() {
        assert_eq!(parse_marked("just a banner\n"), ShellEnv::default());
    }

    #[test]
    fn the_shell_path_leads_so_homebrew_git_beats_the_xcode_stub() {
        // Finder launch: launchd's minimal PATH, then the login shell's.
        let shell = vec!["/opt/homebrew/bin".to_string(), "/usr/bin".to_string(), "/bin".to_string()];
        let fallbacks = vec!["/usr/local/bin".to_string(), "/opt/homebrew/bin".to_string()];
        assert_eq!(
            widened_path("/usr/bin:/bin:/usr/sbin:/sbin", &shell, &fallbacks),
            "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin"
        );
    }

    #[test]
    fn a_terminal_launch_with_the_same_path_is_unchanged() {
        let shell = vec!["/a".to_string(), "/b".to_string()];
        assert_eq!(widened_path("/a:/b", &shell, &[]), "/a:/b");
        assert_eq!(widened_path("", &[], &["/c".to_string()]), "/c");
    }

    #[test]
    fn expand_home_only_touches_a_leading_tilde_slash() {
        assert_eq!(expand_home("~/.local/bin", Some("/Users/x")), "/Users/x/.local/bin");
        assert_eq!(expand_home("~/.local/bin", None), "~/.local/bin");
        assert_eq!(expand_home("/opt/homebrew/bin", Some("/Users/x")), "/opt/homebrew/bin");
    }

    #[test]
    fn the_probe_gives_up_on_a_shell_that_never_exits() {
        // SHELL is process-global; this test is the only one that reads it.
        let saved = std::env::var_os("SHELL");
        let dir = std::env::temp_dir().join(format!("loadout-probe-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let hang = dir.join("hang.sh");
        std::fs::write(&hang, "#!/bin/sh\nsleep 30\n").unwrap();
        std::process::Command::new("chmod").args(["+x", hang.to_str().unwrap()]).status().unwrap();
        std::env::set_var("SHELL", &hang);
        let started = Instant::now();
        assert_eq!(probe_login_shell(Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(2));
        match saved {
            Some(v) => std::env::set_var("SHELL", v),
            None => std::env::remove_var("SHELL"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
