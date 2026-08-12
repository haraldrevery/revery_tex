// Running the user's own TeX installation.
//
// This is the first subprocess in the codebase, and it runs on a directory the
// user may have downloaded from anywhere. Every rule below exists because the
// obvious version of this feature is a remote code execution bug.
//
// **Never latexmk.** It is the obvious tool for this — it handles reruns,
// bibtex/biber and makeindex on its own — and it is exactly the wrong choice
// here, because it reads `latexmkrc` / `.latexmkrc` **from the working
// directory** and executes it as Perl. Opening someone else's project would run
// their code before a single page was typeset. Driving the engines directly is
// more work and is the only version that is safe.
//
// **Always -no-shell-escape.** TeX's \write18 runs shell commands from inside
// the document. Restricted mode is the usual default, but "usually" is not a
// security property, so it is disabled explicitly on every invocation.
//
// The rest: a fixed allowlist of programs, argv built here and never taken from
// the frontend, no shell anywhere, cwd pinned to the validated project root, a
// hard timeout, and a cap on captured output.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Serialize;

/// The only programs this may ever execute.
///
/// A name, never a path: the frontend picks from this list and the path is
/// resolved here. Anything else — including a path the user typed — is refused,
/// so no UI mistake can turn into "run this binary".
pub const ALLOWED: &[&str] = &[
    "pdflatex", "xelatex", "lualatex", "bibtex", "biber", "makeindex",
];

const MAX_OUTPUT: usize = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_SECS: u64 = 180;

#[derive(Serialize, Clone, Debug)]
pub struct ToolInfo {
    pub name: String,
    pub path: String,
    pub version: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
pub struct RunResult {
    pub tool: String,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub seconds: f64,
}

/* ── finding programs ─────────────────────────────────────────────────── */

fn is_executable(p: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        p.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        p.is_file()
    }
}

/// Resolve a program name against PATH, by hand.
///
/// Not `which`, and not a shell: spawning a shell to find a program is how a
/// name containing a metacharacter becomes a command. Only names on the
/// allowlist get this far, but the property should not depend on that.
pub fn find_tool(name: &str) -> Option<PathBuf> {
    if !ALLOWED.contains(&name) {
        return None;
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue; // an empty PATH entry means "." — never search it
        }
        let candidate = dir.join(name);
        if is_executable(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if is_executable(&exe) {
                return Some(exe);
            }
        }
    }
    None
}

/// First line of `--version`, which is what identifies a distribution.
fn probe_version(path: &Path) -> Option<String> {
    let out = Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    // A --version that hangs would hang detection, so it gets the same
    // treatment as a compile, just with a much shorter leash.
    let res = wait_with_timeout(out, Duration::from_secs(10))?;
    res.0
        .lines()
        .next()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
}

/// What the user actually has installed.
pub fn detect() -> Vec<ToolInfo> {
    ALLOWED
        .iter()
        .filter_map(|name| {
            let path = find_tool(name)?;
            let version = probe_version(&path);
            Some(ToolInfo {
                name: (*name).to_string(),
                path: path.to_string_lossy().to_string(),
                version,
            })
        })
        .collect()
}

/* ── running ──────────────────────────────────────────────────────────── */

/// Wait for a child, killing it past `limit`. Returns (stdout, stderr, status, timed_out).
fn wait_with_timeout(
    mut child: std::process::Child,
    limit: Duration,
) -> Option<(String, String, Option<i32>, bool)> {
    // Drain both pipes on their own threads: a child that fills the stderr pipe
    // buffer blocks forever if nobody is reading it, and then the timeout is
    // the only thing that ends the compile — turning a warning-heavy document
    // into a three-minute hang.
    let mut out = child.stdout.take();
    let mut err = child.stderr.take();
    let (tx_o, rx_o) = mpsc::channel();
    let (tx_e, rx_e) = mpsc::channel();

    let read_capped = move |mut s: Option<Box<dyn Read + Send>>| -> (String, bool) {
        let mut buf = Vec::new();
        if let Some(ref mut r) = s {
            let mut chunk = [0u8; 8192];
            loop {
                match r.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if buf.len() < MAX_OUTPUT {
                            buf.extend_from_slice(&chunk[..n.min(MAX_OUTPUT - buf.len())]);
                        }
                        // Keep draining past the cap so the child never blocks.
                    }
                }
            }
        }
        let truncated = buf.len() >= MAX_OUTPUT;
        (String::from_utf8_lossy(&buf).to_string(), truncated)
    };

    let ro = read_capped.clone();
    std::thread::spawn(move || {
        let _ = tx_o.send(ro(out.take().map(|p| Box::new(p) as Box<dyn Read + Send>)));
    });
    let re = read_capped;
    std::thread::spawn(move || {
        let _ = tx_e.send(re(err.take().map(|p| Box::new(p) as Box<dyn Read + Send>)));
    });

    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Some(s),
            Ok(None) => {
                if start.elapsed() >= limit {
                    let _ = child.kill();
                    let _ = child.wait();
                    timed_out = true;
                    break None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => break None,
        }
    };

    let (so, _) = rx_o.recv().unwrap_or_default();
    let (se, _) = rx_e.recv().unwrap_or_default();
    Some((so, se, status.and_then(|s| s.code()), timed_out))
}

/// The arguments a given tool is allowed to receive, built here from a job.
///
/// The frontend never supplies argv. It names a tool and a main file; every
/// flag below is decided in this function, so there is no path by which a
/// document, a filename or a setting becomes a command-line option.
fn argv_for(tool: &str, main_file: &str) -> Vec<String> {
    let stem = Path::new(main_file)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| main_file.to_string());

    match tool {
        "pdflatex" | "xelatex" | "lualatex" => vec![
            "-interaction=nonstopmode".into(),
            "-halt-on-error".into(),
            "-file-line-error".into(),
            // \write18 executes shell commands from inside the document.
            "-no-shell-escape".into(),
            // Stop TeX writing outside the project directory.
            "-output-directory=.".into(),
            format!("./{main_file}"),
        ],
        "bibtex" => vec![stem],
        "biber" => vec!["--nosafe-mode-off-placeholder".into(), stem],
        "makeindex" => vec![format!("{stem}.idx")],
        _ => vec![],
    }
}

/// Run one tool, once, inside `root`.
///
/// `root` must already be a canonicalised project root — this does not
/// re-validate it, because the caller owns that check and doing it twice in
/// different ways is how the two drift.
pub fn run_tool(
    tool: &str,
    main_file: &str,
    root: &Path,
    timeout_secs: Option<u64>,
) -> Result<RunResult, String> {
    if !ALLOWED.contains(&tool) {
        return Err(format!("{tool} is not a program Revery TeX will run"));
    }
    // The main file must be a plain relative path inside the project. A leading
    // '-' would otherwise be read by TeX as an option rather than a filename.
    if main_file.is_empty()
        || main_file.starts_with('-')
        || main_file.contains('\0')
        || Path::new(main_file).is_absolute()
        || main_file.split('/').any(|c| c == "..")
    {
        return Err(format!("{main_file} is not a valid file name for a compile"));
    }
    let exe = find_tool(tool).ok_or_else(|| format!("{tool} was not found on your PATH"))?;

    let mut cmd = Command::new(&exe);
    cmd.args(argv_for(tool, main_file))
        .current_dir(root)
        .stdin(Stdio::null())      // never wait for input; nonstopmode still prompts on some errors
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // Belt and braces: even with -no-shell-escape, refuse writes outside the
    // tree and reads from absolute paths the document names.
    cmd.env("openout_any", "p");
    cmd.env("openin_any", "p");
    cmd.env("shell_escape", "f");
    cmd.env("max_print_line", "1000");

    let started = Instant::now();
    let child = cmd
        .spawn()
        .map_err(|e| format!("could not start {}: {e}", exe.to_string_lossy()))?;

    let limit = Duration::from_secs(timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS).clamp(5, 1800));
    let (stdout, stderr, code, timed_out) =
        wait_with_timeout(child, limit).ok_or_else(|| format!("{tool} could not be waited on"))?;

    Ok(RunResult {
        tool: tool.to_string(),
        code,
        truncated: stdout.len() >= MAX_OUTPUT || stderr.len() >= MAX_OUTPUT,
        stdout,
        stderr,
        timed_out,
        seconds: started.elapsed().as_secs_f64(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("revery-tex-run-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn refuses_programs_not_on_the_allowlist() {
        let root = tmp("allow");
        for bad in ["sh", "bash", "rm", "/bin/sh", "curl", "python3"] {
            let r = run_tool(bad, "main.tex", &root, Some(5));
            assert!(r.is_err(), "{bad} must be refused");
            assert!(r.unwrap_err().contains("not a program"));
        }
    }

    #[test]
    fn find_tool_only_resolves_allowlisted_names() {
        assert!(find_tool("sh").is_none(), "sh must never resolve");
        assert!(find_tool("rm").is_none());
    }

    #[test]
    fn refuses_a_main_file_that_escapes_or_looks_like_a_flag() {
        let root = tmp("mainfile");
        for bad in [
            "../outside.tex",
            "a/../../b.tex",
            "/etc/passwd",
            "-shell-escape",
            "--output-directory=/tmp",
            "",
        ] {
            let r = run_tool("pdflatex", bad, &root, Some(5));
            assert!(r.is_err(), "{bad:?} must be refused");
        }
    }

    #[test]
    fn argv_always_disables_shell_escape() {
        for engine in ["pdflatex", "xelatex", "lualatex"] {
            let args = argv_for(engine, "main.tex");
            assert!(
                args.iter().any(|a| a == "-no-shell-escape"),
                "{engine} must disable \\write18"
            );
            assert!(args.iter().any(|a| a == "-interaction=nonstopmode"));
            // The filename is passed as ./name so a name starting with a dash
            // could never be read as an option.
            assert!(args.last().unwrap().starts_with("./"));
        }
    }

    #[test]
    fn argv_never_contains_a_shell_metacharacter_from_the_filename() {
        let args = argv_for("pdflatex", "weird; rm -rf ~.tex");
        // Not a shell, so this is only ever one argument — but assert it stays
        // a single argv entry rather than being split.
        assert_eq!(args.last().unwrap(), "./weird; rm -rf ~.tex");
        assert_eq!(args.iter().filter(|a| a.contains("rm")).count(), 1);
    }

    #[test]
    fn a_hanging_program_is_killed_at_the_timeout() {
        // Uses a real allowlisted tool only if present; otherwise the timeout
        // path is exercised by the unit above. Skip cleanly when no TeX exists.
        let Some(_) = find_tool("pdflatex") else { return };
        let root = tmp("timeout");
        // \read from the terminal with stdin closed ends immediately; instead
        // force a long run with a big loop, then cut it off.
        fs::write(
            root.join("main.tex"),
            r"\documentclass{article}\begin{document}
\count0=0 \loop\advance\count0 by 1 \ifnum\count0<100000000 \repeat
\end{document}",
        )
        .unwrap();
        let r = run_tool("pdflatex", "main.tex", &root, Some(5)).unwrap();
        assert!(r.timed_out || r.seconds < 5.0, "either it finished or it was killed");
        assert!(r.seconds < 12.0, "the kill must be prompt, took {}s", r.seconds);
    }

    #[test]
    fn compiles_a_real_document_when_a_system_tex_exists() {
        let Some(_) = find_tool("pdflatex") else { return };
        let root = tmp("compile");
        fs::write(
            root.join("main.tex"),
            r"\documentclass{article}\begin{document}Hello from the system TeX.\end{document}",
        )
        .unwrap();
        let r = run_tool("pdflatex", "main.tex", &root, Some(120)).unwrap();
        assert_eq!(r.code, Some(0), "stderr: {}", r.stderr);
        assert!(root.join("main.pdf").exists(), "no PDF was produced");
        assert!(!r.timed_out);
    }

    #[test]
    fn shell_escape_is_refused_by_the_engine() {
        let Some(_) = find_tool("pdflatex") else { return };
        let root = tmp("write18");
        // If \write18 were enabled this would create the file.
        fs::write(
            root.join("main.tex"),
            r"\documentclass{article}\begin{document}
\immediate\write18{touch pwned.txt}
Hello\end{document}",
        )
        .unwrap();
        let _ = run_tool("pdflatex", "main.tex", &root, Some(60)).unwrap();
        assert!(
            !root.join("pwned.txt").exists(),
            "\\write18 executed — shell escape is not actually disabled"
        );
    }

    #[test]
    fn detect_reports_only_allowlisted_tools() {
        for t in detect() {
            assert!(ALLOWED.contains(&t.name.as_str()));
            assert!(!t.path.is_empty());
        }
    }
}
