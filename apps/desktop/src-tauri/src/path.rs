// What a Finder-launched bundle can find (architecture.md §5.3).
//
// launchd starts a bundle with PATH=/usr/bin:/bin:/usr/sbin:/sbin, so Homebrew's git and gh are
// invisible, and shell exports such as CLAUDE_CONFIG_DIR are missing. Before any plugin starts, repair
// the process environment from what the user's login shell reports. A profile can take seconds
// (spikes.md S2), so its answer is cached in app data and used at once; the shell is asked again in
// the background for the next launch, and inline only when there is no cache yet (QUESTIONS.md Q4).

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Marks the probe's output line among whatever the profile prints (banners, fortunes).
const MARKER: &str = "__loadout_env__";

/// A profile slower than this does not hold up the window; the fallbacks still apply. Heavy but
/// ordinary profiles (nvm, jenv, cloud SDKs) took 2-3 s in the M0 spike, so 3 s was too tight.
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Tauri's app data dir for this identifier, known before the builder runs.
const APP_DATA: &str = "Library/Application Support/com.jhernandezinzunza.loadout";
const CACHE_FILE: &str = "shell-env.json";

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
    let home = std::env::var("HOME").ok().filter(|h| !h.is_empty());
    let shell = std::env::var("SHELL").ok().filter(|s| !s.is_empty());
    let cache = home.as_deref().map(|h| Path::new(h).join(APP_DATA).join(CACHE_FILE));
    let (probed, cached) = match &cache {
        Some(cache) => shell_env(cache, shell.as_deref(), PROBE_TIMEOUT),
        None => (shell.as_deref().and_then(|s| probe_login_shell(s, PROBE_TIMEOUT)).unwrap_or_default(), false),
    };
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
    // Only now: spawning reads the environment, which set_var must not be changing meanwhile.
    if let (true, Some(cache), Some(shell)) = (cached, cache, shell) {
        refresh_cache(cache, shell, PROBE_TIMEOUT);
    }
}

/// What to use now, and whether it came from the cache. With no usable cache the shell is probed
/// inline and the answer cached; a probe that finds no PATH is never cached.
fn shell_env(cache: &Path, shell: Option<&str>, timeout: Duration) -> (ShellEnv, bool) {
    if let Some(cached) = read_cache(cache) {
        return (cached, true);
    }
    let probed = shell.and_then(|s| probe_login_shell(s, timeout)).unwrap_or_default();
    if !probed.path.is_empty() {
        write_cache(cache, &probed);
    }
    (probed, false)
}

/// Probes in the background and rewrites the cache for the next launch; the handle is for tests.
fn refresh_cache(cache: PathBuf, shell: String, timeout: Duration) -> JoinHandle<()> {
    std::thread::spawn(move || {
        if let Some(env) = probe_login_shell(&shell, timeout).filter(|e| !e.path.is_empty()) {
            write_cache(&cache, &env);
        }
    })
}

/// None when the file is missing, unreadable, or not what write_cache wrote.
fn read_cache(file: &Path) -> Option<ShellEnv> {
    let value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(file).ok()?).ok()?;
    let path: Vec<String> = value.get("path")?.as_array()?.iter().map(|d| d.as_str().map(str::to_string)).collect::<Option<_>>()?;
    let claude_config_dir = match value.get("claudeConfigDir")? {
        serde_json::Value::Null => None,
        dir => Some(dir.as_str()?.to_string()),
    };
    Some(ShellEnv { path, claude_config_dir }).filter(|e| !e.path.is_empty())
}

/// Best effort: temp file + rename, so a reader never sees half a file; a failure only costs the
/// next launch a probe.
fn write_cache(file: &Path, env: &ShellEnv) {
    let json = serde_json::json!({ "path": env.path, "claudeConfigDir": env.claude_config_dir });
    let tmp = file.with_extension(format!("{}.tmp", std::process::id()));
    let written = file.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::write(&tmp, json.to_string()));
    if written.and_then(|()| std::fs::rename(&tmp, file)).is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
}

/// `-i` as well as `-l`: zsh reads .zshrc only when interactive, and that is where most PATH
/// edits live. stdin is closed so a profile that prompts fails instead of waiting.
fn probe_login_shell(shell: &str, timeout: Duration) -> Option<ShellEnv> {
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

    /// A temp dir per test, with a fake login shell: it ignores its arguments and runs `body`.
    struct Scratch(PathBuf);

    impl Scratch {
        fn new(name: &str) -> Scratch {
            let dir = std::env::temp_dir().join(format!("loadout-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Scratch(dir)
        }

        fn shell(&self, body: &str) -> String {
            let script = self.0.join("shell.sh");
            std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::process::Command::new("chmod").args(["+x", script.to_str().unwrap()]).status().unwrap();
            script.display().to_string()
        }

        fn cache(&self) -> PathBuf {
            self.0.join("app/shell-env.json")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const HANG: &str = "sleep 30";

    fn answers(path: &str, config_dir: &str) -> String {
        format!("printf '\\n{MARKER}{path}\\t{config_dir}\\n'")
    }

    fn env(path: &[&str], config_dir: Option<&str>) -> ShellEnv {
        ShellEnv { path: path.iter().map(|d| d.to_string()).collect(), claude_config_dir: config_dir.map(str::to_string) }
    }

    #[test]
    fn the_probe_gives_up_on_a_shell_that_never_exits() {
        let scratch = Scratch::new("probe-hang");
        let started = Instant::now();
        assert_eq!(probe_login_shell(&scratch.shell(HANG), Duration::from_millis(300)), None);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn a_cache_miss_probes_inline_and_caches_the_answer() {
        let scratch = Scratch::new("cache-miss");
        let (got, cached) = shell_env(&scratch.cache(), Some(&scratch.shell(&answers("/opt/homebrew/bin:/usr/bin", "/cfg"))), PROBE_TIMEOUT);
        assert_eq!(got, env(&["/opt/homebrew/bin", "/usr/bin"], Some("/cfg")));
        assert!(!cached);
        assert_eq!(read_cache(&scratch.cache()), Some(got));
    }

    #[test]
    fn a_cache_hit_returns_at_once_and_refreshes_the_cache_in_the_background() {
        let scratch = Scratch::new("cache-hit");
        write_cache(&scratch.cache(), &env(&["/old/bin"], None));
        let shell = scratch.shell(&format!("sleep 1\n{}", answers("/new/bin", "/cfg")));
        let started = Instant::now();
        let (got, cached) = shell_env(&scratch.cache(), Some(&shell), PROBE_TIMEOUT);
        assert!(started.elapsed() < Duration::from_millis(500), "a warm launch waited on the shell");
        assert_eq!(got, env(&["/old/bin"], None));
        assert!(cached);
        refresh_cache(scratch.cache(), shell, PROBE_TIMEOUT).join().unwrap();
        assert_eq!(read_cache(&scratch.cache()), Some(env(&["/new/bin"], Some("/cfg"))));
    }

    #[test]
    fn a_probe_that_times_out_leaves_the_cache_alone_and_a_miss_gets_nothing() {
        let scratch = Scratch::new("cache-timeout");
        let hang = scratch.shell(HANG);
        let (got, _) = shell_env(&scratch.cache(), Some(&hang), Duration::from_millis(300));
        assert_eq!(got, ShellEnv::default());
        assert!(!scratch.cache().exists());

        write_cache(&scratch.cache(), &env(&["/old/bin"], None));
        refresh_cache(scratch.cache(), hang, Duration::from_millis(300)).join().unwrap();
        assert_eq!(read_cache(&scratch.cache()), Some(env(&["/old/bin"], None)));
    }

    #[test]
    fn a_corrupt_cache_is_a_miss_and_is_replaced() {
        let scratch = Scratch::new("cache-corrupt");
        for junk in ["{not json", "{\"path\": \"/bin\"}", "{\"path\": [1], \"claudeConfigDir\": null}", "{\"path\": [], \"claudeConfigDir\": null}"] {
            std::fs::create_dir_all(scratch.cache().parent().unwrap()).unwrap();
            std::fs::write(scratch.cache(), junk).unwrap();
            assert_eq!(read_cache(&scratch.cache()), None, "{junk}");
            let (got, cached) = shell_env(&scratch.cache(), Some(&scratch.shell(&answers("/bin", ""))), PROBE_TIMEOUT);
            assert_eq!(got, env(&["/bin"], None));
            assert!(!cached);
            assert_eq!(read_cache(&scratch.cache()), Some(env(&["/bin"], None)));
        }
    }
}
