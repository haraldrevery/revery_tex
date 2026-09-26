// Revery TeX — Tauri shell.
//
// A deliberately small filesystem surface: open a folder, list it, read files,
// write files atomically, and keep crash backups. Revery Notebook's equivalent
// is ~40 commands; a LaTeX editor needs these.
//
// Everything the renderer sends is untrusted. Every path crosses safe_path_inside
// before it touches the disk, and the project root is held here rather than in
// the renderer so it cannot be widened from JS.
//
// safe_path_inside, atomic_write_file and is_cross_device_err are copied from
// revery_notebook_reference/tauri/src/main.rs (Apache-2.0, same author) together
// with their tests. They are subtle and already proven; reimplementing them to
// save a copy-paste would be a bad trade.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

// Running the user's own TeX installation. Kept in its own module because it is
// the only code here that starts a process, and that boundary is worth seeing.
mod tex_run;

/// The single open project root. Owned by the backend: the renderer may ask for
/// it to change, but only through a command that vets the answer — the OS folder
/// dialog (open_folder_dialog) or a remembered path (open_folder_path). Both, and
/// the launch seed in main(), go through the same vetting.
struct RootPath(Mutex<Option<PathBuf>>);

#[derive(Serialize)]
struct DirEntry {
    name: String,
    path: String,
    #[serde(rename = "type")]
    kind: &'static str, // "file" | "dir"
}

/* ── path safety ─────────────────────────────────────────────────────── */

fn safe_path(raw: &str) -> Result<PathBuf, String> {
    if raw.is_empty() {
        return Err("Path must not be empty".into());
    }
    if raw.contains('\0') {
        return Err("Path contains null byte".into());
    }
    Ok(PathBuf::from(raw))
}

/// Resolve `raw` and prove it is inside `root`.
///
/// Existing paths are canonicalised outright, which resolves symlinks and `..`.
/// Paths that do not exist yet cannot be canonicalised (ENOENT), so we walk up
/// to the deepest existing ancestor, canonicalise *that*, then re-attach the
/// non-existent tail. That keeps symlink-escape protection for creates, which is
/// exactly the case a naive implementation gets wrong.
fn safe_path_inside(raw: &str, root: &Path) -> Result<PathBuf, String> {
    let p = safe_path(raw)?;
    let canonical_root = root
        .canonicalize()
        .map_err(|e| format!("Cannot resolve root: {e}"))?;

    let check = if p.exists() {
        p.canonicalize()
            .map_err(|e| format!("Cannot resolve path: {e}"))?
    } else {
        let mut existing = p.clone();
        let mut tail: Vec<std::ffi::OsString> = Vec::new();
        loop {
            if existing.exists() {
                break;
            }
            let name = existing
                .file_name()
                .ok_or_else(|| format!("Cannot resolve ancestor of: {}", p.display()))?
                .to_owned();
            tail.push(name);
            existing = existing
                .parent()
                .ok_or_else(|| format!("Path has no resolvable ancestor: {}", p.display()))?
                .to_path_buf();
        }
        let mut resolved = existing
            .canonicalize()
            .map_err(|e| format!("Cannot resolve ancestor: {e}"))?;
        for component in tail.into_iter().rev() {
            resolved.push(component);
        }
        resolved
    };

    if !check.starts_with(&canonical_root) {
        return Err(format!("Path escapes project root: {}", check.display()));
    }
    Ok(check)
}

fn get_root(state: &State<'_, RootPath>) -> Result<PathBuf, String> {
    let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
    guard
        .clone()
        .ok_or_else(|| "No project folder is open. Open a folder first.".to_string())
}

/* ── atomic write ────────────────────────────────────────────────────── */

/// Should a failed rename fall back to copy-then-delete?
///
/// Gated per OS, because `raw_os_error()` is an errno on Unix and a Win32 code
/// on Windows and the two ranges collide. Ungated, this matched 17 and 32 on
/// Linux as well — where they are `EEXIST` and `EPIPE`, not the Windows codes
/// intended — so a rename refused because the destination was a non-empty
/// directory was routed into the snapshot-and-copy fallback and surfaced as a
/// misleading "cannot create backup".
///
/// The sets are also chosen to *mean* the same thing as the Electron twin's
/// (`EXDEV || EBUSY || EPERM` in fs_core.js) rather than merely to overlap with
/// it: Node maps ERROR_SHARING_VIOLATION to EBUSY and ERROR_ACCESS_DENIED to
/// EPERM, so each arm below is that condition spelled in the local dialect.
/// Falling back to a copy is safe in all of them because tmp and dest are always
/// on the same filesystem.
#[cfg(unix)]
fn is_cross_device_err(e: &std::io::Error) -> bool {
    // EXDEV(18), EBUSY(16) — a mountpoint or a busy target, EPERM(1).
    matches!(e.raw_os_error(), Some(18) | Some(16) | Some(1))
}

#[cfg(windows)]
fn is_cross_device_err(e: &std::io::Error) -> bool {
    // ERROR_NOT_SAME_DEVICE(17), ERROR_SHARING_VIOLATION(32) — antivirus or a
    // sync agent briefly holding the destination — and ERROR_ACCESS_DENIED(5).
    matches!(e.raw_os_error(), Some(17) | Some(32) | Some(5))
}

#[inline]
fn sync_parent_dir(file_path: &Path) {
    // A rename is only durable once the *directory* entry is flushed. Without
    // this a power loss can leave the file missing despite a successful write.
    #[cfg(unix)]
    if let Some(dir) = file_path.parent() {
        if let Ok(d) = fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    #[cfg(not(unix))]
    let _ = file_path;
}

/// Write `content` to `dest` atomically: temp file, fsync, rename.
fn atomic_write_file(tmp: &Path, dest: &Path, content: &[u8]) -> Result<(), String> {
    {
        let mut f = fs::File::create(tmp).map_err(|e| format!("Cannot create temp file: {e}"))?;
        f.write_all(content).map_err(|e| {
            let _ = fs::remove_file(tmp);
            format!("Write failed: {e}")
        })?;
        // Flush to physical disk before the rename, or a power loss can leave a
        // 0-byte file where a complete one used to be.
        f.sync_data().map_err(|e| {
            let _ = fs::remove_file(tmp);
            format!("Sync failed: {e}")
        })?;
    }

    match fs::rename(tmp, dest) {
        Ok(_) => {
            sync_parent_dir(dest);
            return Ok(());
        }
        Err(ref e) if is_cross_device_err(e) => { /* fall through */ }
        Err(e) => {
            let _ = fs::remove_file(tmp);
            return Err(format!("Rename failed: {e}"));
        }
    }

    // EXDEV fallback: snapshot dest first, because an interrupted copy would
    // otherwise leave it truncated with no way back.
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let bak = dest.with_file_name(format!(
        "{}.{}.revery_bak",
        dest.file_name().unwrap_or_default().to_string_lossy(),
        now
    ));
    let has_bak = dest.exists();
    if has_bak {
        if let Err(e) = fs::copy(dest, &bak) {
            let _ = fs::remove_file(tmp);
            return Err(format!("EXDEV fallback aborted: cannot create backup: {e}"));
        }
    }

    if let Err(copy_err) = fs::copy(tmp, dest) {
        let mut restored = false;
        if has_bak {
            restored = fs::copy(&bak, dest).is_ok();
            if restored {
                let _ = fs::remove_file(&bak);
            }
        }
        let _ = fs::remove_file(tmp);
        if has_bak && !restored {
            return Err(format!(
                "Cross-device write failed during copy (EXDEV): {copy_err}. The file may be \
                 incomplete. A snapshot of the previous content was kept at \"{}\" — rename it \
                 over the original to recover.",
                bak.display()
            ));
        }
        return Err(format!("Cross-device write failed during copy (EXDEV): {copy_err}"));
    }

    if let Ok(f) = fs::File::open(dest) {
        let _ = f.sync_data();
    }
    let _ = fs::remove_file(tmp);
    if has_bak {
        let _ = fs::remove_file(&bak);
    }
    sync_parent_dir(dest);
    Ok(())
}

/// The scratch file an atomic write builds before renaming it over `dest`.
///
/// Unique per call, not just per destination. `<dest>.revery_tmp` assumed one
/// process per project, and this app can have two on the same folder — the
/// Tauri and Electron shells, or two instances of either. Both would build
/// their scratch file at the same path, and the loser's half-written bytes
/// could be renamed over the file by the winner.
///
/// The pid distinguishes processes and the counter distinguishes writes within
/// one, so two saves racing in the same millisecond still cannot collide.
fn tmp_for(dest: &Path) -> PathBuf {
    use std::sync::atomic::AtomicU64;
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    dest.with_file_name(format!(
        "{}.{}.{}.revery_tmp",
        dest.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        n
    ))
}

/* ── commands ────────────────────────────────────────────────────────── */
//
// **Anything that touches the filesystem or starts a process is
// `#[tauri::command(async)]`; the window commands are not.** That is the whole
// rule, and it is a rule rather than a case-by-case judgement so a command
// added later inherits the right answer.
//
// Why it matters: a plain `#[tauri::command]` on a non-async fn is
// `ExecutionContext::Blocking`, and the IPC arrives through WebKitGTK's custom
// URI scheme handler — which runs on the GTK main loop. So the body executes on
// the thread that paints the window. `run_tex` alone is up to 180 s per pass and
// runs up to five of them; `detect_tex` spawns six processes with a 10 s
// `--version` leash each and is called unawaited during boot. Both froze the
// window solid, and the second one did it at launch. `(async)` on a sync fn
// routes the same body through `respond_async_serialized`, which spawns it on
// the async runtime — off the main thread, with the body unchanged.
//
// The window commands stay blocking on purpose: they are microseconds of work
// against the event loop, and `close_window` in particular stores AGREED_CLOSE
// for the `CloseRequested` handler to read. A thread hop there buys nothing and
// adds an ordering question that does not currently exist.
//
// **What this changes: commands can now overlap.** Nothing here assumed they
// could not. `tmp_for` was already unique per call by pid and atomic counter
// (see its doc), the close-guard flags are atomics, and every command takes one
// `get_root()` snapshot and validates every path against *that* snapshot — so a
// root that moves mid-command cannot widen what an in-flight command may reach.

/// Parented to the window, so the dialog is modal. Unparented it was not: the
/// editor stayed live behind it, and anything typed while it was open belonged
/// to a project the app was about to leave.
///
/// Vetted like a recents row, so a folder that opens here is one the frontend
/// can also reopen by path — which is how it goes back when the folder turns out
/// not to be a project. Unvetted, `$HOME` opened here and then could not be
/// returned to.
#[tauri::command]
async fn open_folder_dialog(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    state: State<'_, RootPath>,
) -> Result<Option<String>, String> {
    let picked = app.dialog().file().set_parent(&window).blocking_pick_folder();
    let Some(folder) = picked else { return Ok(None) };
    let path = folder
        .into_path()
        .map_err(|e| format!("Cannot resolve chosen folder: {e}"))?;
    let canonical = vet_project_dir(&path, home_dir().as_deref())?;

    *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(canonical.clone());
    Ok(Some(canonical.to_string_lossy().to_string()))
}

/// The home directory, canonicalised, for the vetting below — which compares
/// real paths, so a home reached through a symlink would never match.
fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
}

#[tauri::command]
fn current_root(state: State<'_, RootPath>) -> Option<String> {
    state
        .0
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .as_ref()
        .map(|p| p.to_string_lossy().to_string())
}

/// Vet a folder the renderer asks to reopen.
///
/// Split from the command below for the reason containing_dir is split from the
/// launch: the deciding half is a pure function a test can reach, and the half
/// that mutates process state is thin enough to read at a glance.
///
/// This is the one place the renderer gets to *name* a root. Until recents
/// existed, only the OS folder dialog could set one, and that difference is
/// worth being explicit about:
///
///   - `canonicalize` resolves symlinks, so the stored root is the real path.
///     safe_path_inside canonicalises everything it checks against this root, so
///     a root that were itself a symlink would make every later comparison
///     compare the wrong two paths.
///   - It must be a directory that exists. A recents entry for a folder since
///     deleted is refused here and pruned by the caller.
///   - **A filesystem root and the home directory itself are refused.** The root
///     is not only what the file commands are allowed to reach — it is also the
///     working directory tex_run compiles in. `/` or `$HOME` as a project root
///     would be a materially larger surface than any folder a user picks in a
///     dialog, and no real project is either of them.
fn vet_project_root(raw: &str, home: Option<&Path>) -> Result<PathBuf, String> {
    if raw.trim().is_empty() {
        return Err("No folder given.".to_string());
    }
    vet_project_dir(Path::new(raw), home)
}

/// The same vetting for a path that did not arrive as a string — the folder
/// dialog's answer and the launch argument. Kept as a path so a folder name that
/// is not valid Unicode is vetted as itself rather than as a lossy copy of it.
fn vet_project_dir(dir: &Path, home: Option<&Path>) -> Result<PathBuf, String> {
    let canonical = dir
        .canonicalize()
        .map_err(|e| format!("Cannot open that folder: {e}"))?;
    if !canonical.is_dir() {
        return Err(format!("Not a folder: {}", canonical.display()));
    }
    if canonical.parent().is_none() {
        return Err("That is a filesystem root, not a project folder.".to_string());
    }
    if home.map(|h| h == canonical).unwrap_or(false) {
        return Err("That is your home directory, not a project folder.".to_string());
    }
    Ok(canonical)
}

/// Reopen a folder the frontend remembered, without the OS dialog.
///
/// The recents list itself lives in the frontend — see recent_projects.js for
/// why it is not persisted separately here and in Electron.
#[tauri::command(async)]
fn open_folder_path(path: String, state: State<'_, RootPath>) -> Result<String, String> {
    let canonical = vet_project_root(&path, home_dir().as_deref())?;
    *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(canonical.clone());
    Ok(canonical.to_string_lossy().to_string())
}

/// Recursive listing, relative to the root. Symlinks are skipped: following them
/// is how a listing walks out of the project.
#[tauri::command(async)]
fn read_directory(state: State<'_, RootPath>) -> Result<Vec<DirEntry>, String> {
    let root = get_root(&state)?;
    let mut out = Vec::new();
    walk(&root, &root, &mut out, 0)?;
    Ok(out)
}

fn walk(dir: &Path, root: &Path, out: &mut Vec<DirEntry>, depth: usize) -> Result<(), String> {
    if depth > 16 {
        return Ok(()); // pathological nesting; also a symlink-loop backstop
    }
    let entries = fs::read_dir(dir).map_err(|e| format!("Cannot read {}: {e}", dir.display()))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map_err(|_| "Path escaped root during walk".to_string())?
            .to_string_lossy()
            .replace('\\', "/");

        if meta.is_dir() {
            out.push(DirEntry { name, path: rel, kind: "dir" });
            walk(&path, root, out, depth + 1)?;
        } else if meta.is_file() {
            out.push(DirEntry { name, path: rel, kind: "file" });
        }
    }
    Ok(())
}

/* The command bodies below delegate to plain functions taking an explicit root.
   That is what makes the real read/write paths testable: a #[tauri::command]
   needs a live State and an AppHandle, so anything left inside one is only ever
   exercised by hand. What remains untested is Tauri's own IPC serialisation. */

/// Identity of a file at a point in time. Compared before a write to detect an
/// edit made outside the app; mtime alone is not enough, because a same-second
/// write of the same length is exactly the case a coarse filesystem hides.
#[derive(Serialize, Clone, Debug)]
struct FileStamp {
    mtime_ms: u64,
    size: u64,
}

#[derive(Serialize, Debug)]
struct FileRead {
    content: String,
    stamp: FileStamp,
}

fn stamp_from(m: &fs::Metadata) -> FileStamp {
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    FileStamp { mtime_ms, size: m.len() }
}

fn stamp_of(abs: &Path) -> Result<FileStamp, String> {
    let m = fs::metadata(abs).map_err(|e| format!("Cannot stat: {e}"))?;
    Ok(stamp_from(&m))
}

/// How many times a file that changes under the read is read again.
const STABLE_READ_TRIES: usize = 3;

/// The bytes of `abs` and the stamp that describes exactly those bytes.
///
/// Stat, read, stat — on one file handle — and read again if the two stats
/// differ. It used to read the file and *then* stat the path, so a write landing
/// in between returned the old text with the new file's stamp; the next save
/// matched that stamp and overwrote the other program's work with no conflict.
/// One handle rather than the path, so a file replaced by rename mid-read is
/// still described consistently: bytes and stamp are both the old file's, and
/// the next save is a conflict, as it should be. The twin is readStable in
/// electron/fs_core.js.
///
/// `read` is the read itself, a parameter only so a test can land a write in
/// the middle of it.
fn read_stable_with(
    abs: &Path,
    mut read: impl FnMut(&mut fs::File) -> std::io::Result<Vec<u8>>,
) -> Result<(Vec<u8>, FileStamp), String> {
    for _ in 0..STABLE_READ_TRIES {
        let mut f = fs::File::open(abs).map_err(|e| e.to_string())?;
        let before = stamp_from(&f.metadata().map_err(|e| e.to_string())?);
        let bytes = read(&mut f).map_err(|e| e.to_string())?;
        let after = stamp_from(&f.metadata().map_err(|e| e.to_string())?);
        if before.mtime_ms == after.mtime_ms && before.size == after.size && bytes.len() as u64 == after.size {
            return Ok((bytes, after));
        }
    }
    Err("it kept changing while it was being read".to_string())
}

fn read_stable(abs: &Path) -> Result<(Vec<u8>, FileStamp), String> {
    read_stable_with(abs, |f| {
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok(buf)
    })
}

/// UTF-8, strictly, and a byte-order mark stays in the text. A file that is not
/// UTF-8 is refused, never decoded into U+FFFD — the loader keeps it as bytes
/// instead (project_store.js), and nothing can then write it back mangled.
fn read_text_impl(path: &str, root: &Path) -> Result<FileRead, String> {
    let abs = safe_path_inside(&root.join(path).to_string_lossy(), root)?;
    let (bytes, stamp) = read_stable(&abs).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let content = String::from_utf8(bytes)
        .map_err(|_| format!("Cannot read {path}: stream did not contain valid UTF-8"))?;
    Ok(FileRead { content, stamp })
}

/// The marker that makes a refused write recognisable once it reaches the page.
///
/// Must stay equal to `CONFLICT_PREFIX` in
/// `www/jvscrpt_and_css_extra/conflict_rule.js`, which owns this wording for all
/// four backends. This file cannot import it — the renderer's modules are ESM
/// and this is Rust — so `test/conflict_rule.test.js` compares both this literal
/// and the sentence below against the message that module builds, the same way
/// `test/backup_staleness.test.js` holds the four backends to the backup rule.
///
/// A Tauri command is `Result<T, String>`, so nothing structured survives the
/// boundary: the sentinel has to be inside the message text. See conflict_rule.js.
const CONFLICT_PREFIX: &str = "CONFLICT:";

/// Write, refusing if the file changed on disk since it was read.
///
/// `expect` is the stamp taken at read time; None forces the write (the user
/// chose "overwrite" after being told). The error is prefixed CONFLICT: so the
/// caller can distinguish it from an IO failure and offer a real choice rather
/// than a generic failure toast.
/// Refuse if the file at `abs` is no longer the one `expect` describes.
///
/// One check, for a write and for a rename: both act on a file the app read
/// earlier, and both must not treat it as that file once something else has
/// changed it. The twin is checkStamp in electron/fs_core.js.
fn check_stamp(abs: &Path, path: &str, expect: Option<&FileStamp>) -> Result<(), String> {
    let Some(want) = expect else { return Ok(()) };
    if !abs.exists() {
        return Ok(());
    }
    let now = stamp_of(abs)?;
    if now.mtime_ms != want.mtime_ms || now.size != want.size {
        // One line, deliberately: this is read aloud in a dialog, and a
        // wrapped literal put twenty spaces mid-sentence here — so the
        // desktop prompt read differently from the Electron and browser
        // ones the tests hold to the same wording.
        return Err(format!(
            "{CONFLICT_PREFIX}{path} changed on disk since it was opened \
             (was {} bytes, now {} bytes)",
            want.size, now.size
        ));
    }
    Ok(())
}

fn write_file_impl(
    path: &str,
    content: &str,
    root: &Path,
    expect: Option<&FileStamp>,
) -> Result<FileStamp, String> {
    let abs = safe_path_inside(&root.join(path).to_string_lossy(), root)?;
    check_stamp(&abs, path, expect)?;

    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    atomic_write_file(&tmp_for(&abs), &abs, content.as_bytes())?;
    stamp_of(&abs)
}

#[tauri::command(async)]
fn read_text_file(path: String, state: State<'_, RootPath>) -> Result<FileRead, String> {
    read_text_impl(&path, &get_root(&state)?)
}

/// Base64 so binary assets (images, fonts) survive the IPC boundary intact.
#[tauri::command(async)]
fn read_binary_file(path: String, state: State<'_, RootPath>) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&path).to_string_lossy(), &root)?;
    let bytes = fs::read(&abs).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

#[derive(serde::Deserialize)]
struct ExpectStamp { mtime_ms: u64, size: u64 }

#[tauri::command(async)]
fn write_file(
    path: String,
    content: String,
    expect: Option<ExpectStamp>,
    state: State<'_, RootPath>,
) -> Result<FileStamp, String> {
    let want = expect.map(|e| FileStamp { mtime_ms: e.mtime_ms, size: e.size });
    write_file_impl(&path, &content, &get_root(&state)?, want.as_ref())
}

/// Write bytes rather than text — an image or a font dropped into the project.
///
/// Base64 in, mirroring `read_binary_file` in the other direction, and a
/// separate command rather than a mode on `write_file`: every existing caller
/// passes UTF-8, and one function guessing which it was handed is how a figure
/// gets a mangled re-encode written over it.
///
/// No `expect` stamp. These come from a drop, not from an editor buffer, so
/// there is no read-time identity that could have gone stale — the caller
/// refuses a path that already exists instead of racing it.
///
/// Same containment as every other write: `safe_path_inside` against the
/// canonicalised root, parents created, atomic replace.
fn write_binary_impl(path: &str, b64: &str, root: &Path) -> Result<FileStamp, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let abs = safe_path_inside(&root.join(path).to_string_lossy(), root)?;
    let bytes = STANDARD
        .decode(b64.as_bytes())
        .map_err(|e| format!("Cannot decode {path}: {e}"))?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    atomic_write_file(&tmp_for(&abs), &abs, &bytes)?;
    stamp_of(&abs)
}

#[tauri::command(async)]
fn write_binary_file(
    path: String,
    content: String,
    state: State<'_, RootPath>,
) -> Result<FileStamp, String> {
    write_binary_impl(&path, &content, &get_root(&state)?)
}

/* ── delete and rename ───────────────────────────────────────────────── */
//
// The first operations here that destroy something. Every rule they follow is
// the one the write path already follows — same `safe_path_inside`, same
// refusal to touch anything outside the project root — because a second place
// that decides what is reachable is a second place to get it wrong.
//
// Neither recurses. Deleting a folder means deleting the files the UI is
// showing inside it, one call each, so there is no "remove this whole tree"
// primitive that a wrong path could point at.

fn delete_file_impl(path: &str, root: &Path) -> Result<(), String> {
    let abs = safe_path_inside(&root.join(path).to_string_lossy(), root)?;
    let meta = fs::symlink_metadata(&abs).map_err(|e| format!("Cannot delete {path}: {e}"))?;
    if meta.is_dir() {
        // Only an empty one, and only after its files have gone individually.
        fs::remove_dir(&abs).map_err(|e| format!("Cannot remove {path}: {e}"))?;
    } else {
        fs::remove_file(&abs).map_err(|e| format!("Cannot delete {path}: {e}"))?;
    }
    sync_parent_dir(&abs);
    Ok(())
}

/// Move a file, and say what it is now.
///
/// `expect` is the stamp the app read the file with; a file that no longer
/// matches it is refused with the same CONFLICT a write gets, before anything
/// moves. The stamp returned is the destination's. See renameFile in
/// electron/fs_core.js for why the app adopts it, and why re-stamping the
/// destination without the check would be wrong.
fn rename_file_impl(
    from: &str,
    to: &str,
    root: &Path,
    expect: Option<&FileStamp>,
) -> Result<FileStamp, String> {
    let src = safe_path_inside(&root.join(from).to_string_lossy(), root)?;
    let dest = safe_path_inside(&root.join(to).to_string_lossy(), root)?;
    if !src.exists() {
        return Err(format!("Cannot rename {from}: it does not exist"));
    }
    // Never silently replace something. The caller has the project listing and
    // can ask; the backend refusing is what makes that not merely advisory.
    if dest.exists() {
        return Err(format!("Cannot rename to {to}: that already exists"));
    }
    check_stamp(&src, from, expect)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    fs::rename(&src, &dest).map_err(|e| format!("Cannot rename {from}: {e}"))?;
    sync_parent_dir(&src);
    sync_parent_dir(&dest);
    stamp_of(&dest)
}

#[tauri::command(async)]
fn delete_file(path: String, state: State<'_, RootPath>) -> Result<(), String> {
    delete_file_impl(&path, &get_root(&state)?)
}

/* ── showing a folder to the user ────────────────────────────────────── */
//
// The second place in this binary that starts a process, and deliberately not
// governed by tex_run.rs's allowlist — see the note in CLAUDE.md. The two are
// different problems: tex_run runs compilers *on a directory the user may have
// downloaded*, so what it may run is the whole question. This runs one fixed
// program named below, on one absolute path this file computed, and reads
// nothing back from it. Nothing here is reachable from a document.

/// The folder to open for `raw`: itself if it is a directory, else its parent.
///
/// Split from the launch so the deciding half is a pure function. Handing a
/// path to a file manager is the one thing the test suite cannot exercise — it
/// would open a window on whatever machine ran it — so every refusal lives here,
/// where a test can reach it.
///
/// safe_path_inside canonicalises, so a symlink pointing out of the project is
/// refused exactly as it is for a write, and the result is absolute — which is
/// also what stops it being read as an option by the program launched below.
fn containing_dir(raw: &str, root: &Path) -> Result<PathBuf, String> {
    let abs = safe_path_inside(&root.join(raw).to_string_lossy(), root)?;
    if abs.is_dir() {
        return Ok(abs);
    }
    // A path that no longer exists resolves to its parent, which is the useful
    // answer for a file deleted out from under the tree rather than an error.
    abs.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| format!("No containing folder for: {}", abs.display()))
}

/// Hand one absolute directory to the platform's file manager.
///
/// No shell, and the program is a literal in this file rather than anything
/// resolved from the environment or named by the caller.
fn launch_file_manager(dir: &Path) -> Result<(), String> {
    // explorer.exe returns exit code 1 even when it succeeds, and a file manager
    // can take seconds to appear, so nothing here waits for or reads a status.
    // Failing to *launch* — no such program — is the only reportable failure.
    #[cfg(target_os = "windows")]
    let program = "explorer.exe";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let program = "xdg-open";

    let child = std::process::Command::new(program)
        .arg(dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!("Cannot open the file manager ({program}): {e}"))?;

    // Reaped on a thread of its own. Dropping the Child without waiting leaves a
    // zombie for the life of the app, and waiting here would block the webview
    // until the user closed their file manager.
    std::thread::spawn(move || {
        let mut child = child;
        let _ = child.wait();
    });
    Ok(())
}

#[tauri::command(async)]
fn open_containing_folder(path: String, state: State<'_, RootPath>) -> Result<(), String> {
    let dir = containing_dir(&path, &get_root(&state)?)?;
    launch_file_manager(&dir)
}

#[tauri::command(async)]
fn rename_file(
    from: String,
    to: String,
    expect: Option<ExpectStamp>,
    state: State<'_, RootPath>,
) -> Result<FileStamp, String> {
    let want = expect.map(|e| FileStamp { mtime_ms: e.mtime_ms, size: e.size });
    rename_file_impl(&from, &to, &get_root(&state)?, want.as_ref())
}

/* ── crash backups ───────────────────────────────────────────────────── */
//
// Outside the project, so a crash-recovery file never appears in the user's git
// status or gets swept into a compile — and in the app's *data* directory. They
// were in its cache directory, which is the one place cleanup tools and storage
// pressure are entitled to empty without asking, and a crash net a disk cleaner
// can remove is not one. Electron keeps them in userData, the same kind of place.
//
// The cache directory is still read, and still swept on discard, so backups an
// older build wrote there are neither stranded nor impossible to dismiss.
//
// The commands only find the directories and the root; the work is in the
// `_in` functions below, which take paths, so tests can reach them.

/// Where backups are written, and where builds before the move wrote them.
fn backup_dirs(app: &tauri::AppHandle) -> Result<(PathBuf, Option<PathBuf>), String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No data dir: {e}"))?
        .join("backups");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create backup dir: {e}"))?;
    let legacy = app.path().app_cache_dir().ok().map(|d| d.join("backups"));
    Ok((dir, legacy))
}

/// Both, in the order they are read: the current one first.
fn backup_search_path(app: &tauri::AppHandle) -> Result<Vec<PathBuf>, String> {
    let (dir, legacy) = backup_dirs(app)?;
    Ok(std::iter::once(dir).chain(legacy).collect())
}

/// Absolute path hashed to a flat filename: project paths are arbitrarily long
/// and contain separators, neither of which survives as a filename.
///
/// SHA-256, truncated to 16 hex characters — the Electron twin's
/// `createHash('sha256').digest('hex').slice(0, 16)`, spelled the same way. This
/// was `DefaultHasher`, whose algorithm std documents as **not** stable across
/// releases: a toolchain upgrade would have silently re-keyed every backup, so
/// nothing written before it could be discarded again and the same unsaved work
/// would be offered on every open with no way to dismiss it. Nothing about a
/// filename needs a cryptographic hash; it needs a *fixed* one.
///
/// `discard_backup` below therefore sweeps by the record's own `abs` as well,
/// which is what clears anything a previous build keyed differently.
fn backup_key(abs: &Path) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(abs.to_string_lossy().as_bytes());
    digest[..8].iter().map(|b| format!("{b:02x}")).collect()
}

fn write_backup_in(dir: &Path, path: &str, abs: &Path, content: &str) -> Result<(), String> {
    let payload = serde_json::json!({
        "path": path,
        "abs": abs.to_string_lossy(),
        "saved": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        "content": content,
    })
    .to_string();

    let dest = dir.join(format!("{}.json", backup_key(abs)));
    atomic_write_file(&tmp_for(&dest), &dest, payload.as_bytes())
}

#[tauri::command(async)]
fn write_backup(
    app: tauri::AppHandle,
    path: String,
    content: String,
    state: State<'_, RootPath>,
) -> Result<(), String> {
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&path).to_string_lossy(), &root)?;
    let (dir, _) = backup_dirs(&app)?;
    write_backup_in(&dir, &path, &abs, &content)
}

/// Backups whose content differs from what is on disk — i.e. unsaved work from
/// a session that did not exit cleanly — across every directory in `dirs`.
fn list_stale_backups_in(dirs: &[PathBuf], root: &Path) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    for dir in dirs {
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let Ok(text) = fs::read_to_string(e.path()) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            let Some(abs) = v.get("abs").and_then(|x| x.as_str()) else { continue };
            // Only offer recovery for the project that is actually open.
            if !Path::new(abs).starts_with(root) {
                continue;
            }
            let backup_content = v.get("content").and_then(|x| x.as_str()).unwrap_or("");
            let on_disk = fs::read_to_string(abs).unwrap_or_default();
            if on_disk != backup_content {
                out.push(v);
            }
        }
    }

    // One offer per file, newest wins. A record keyed by an older build's
    // `backup_key` — or left in the old directory — sits beside the current one
    // for the same path, and two dialogs about the same file, one of them
    // holding superseded text, is a way to restore the wrong copy.
    out.sort_by_key(|v| std::cmp::Reverse(v.get("saved").and_then(|x| x.as_u64()).unwrap_or(0)));
    let mut seen = std::collections::HashSet::new();
    out.retain(|v| seen.insert(v.get("abs").and_then(|x| x.as_str()).unwrap_or("").to_string()));
    out
}

#[tauri::command(async)]
fn list_stale_backups(app: tauri::AppHandle, state: State<'_, RootPath>) -> Result<Vec<serde_json::Value>, String> {
    let root = get_root(&state)?;
    Ok(list_stale_backups_in(&backup_search_path(&app)?, &root))
}

/// Discard by *identity*, not only by current key, in every directory.
///
/// The keyed filename is removed first — that is the whole job in the normal
/// case. The sweep after it exists because a record's identity is its `abs`,
/// while its filename is only however `backup_key` happened to hash that path
/// in the build that wrote it. Without the sweep, changing the key scheme (as
/// this tree did, off `DefaultHasher`) leaves a file that Discard cannot reach
/// and the listing keeps finding, so the dialog returns on every open and the
/// button that is supposed to end it does nothing. The same goes for a record
/// left in the old directory.
fn discard_backup_in(dirs: &[PathBuf], abs: &Path) {
    let target = abs.to_string_lossy();
    for dir in dirs {
        let _ = fs::remove_file(dir.join(format!("{}.json", backup_key(abs))));
        let Ok(entries) = fs::read_dir(dir) else { continue };
        for e in entries.flatten() {
            let Ok(text) = fs::read_to_string(e.path()) else { continue };
            let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
            if v.get("abs").and_then(|x| x.as_str()) == Some(target.as_ref()) {
                let _ = fs::remove_file(e.path());
            }
        }
    }
}

#[tauri::command(async)]
fn discard_backup(app: tauri::AppHandle, path: String, state: State<'_, RootPath>) -> Result<(), String> {
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&path).to_string_lossy(), &root)?;
    discard_backup_in(&backup_search_path(&app)?, &abs);
    Ok(())
}

/* ── closing the window ──────────────────────────────────────────────── */

use std::sync::atomic::{AtomicBool, Ordering};

/// Close for real, after the frontend has decided it is safe to.
///
/// The `CloseRequested` handler below cancels a close and asks the webview
/// instead; this is how the answer comes back. `AGREED_CLOSE` is what stops that
/// from being a loop — the handler lets a close through when the flag is set,
/// which is only ever set here.
static AGREED_CLOSE: AtomicBool = AtomicBool::new(false);

/// Whether the frontend has said it is listening for the close question.
///
/// **A close is only ever cancelled once this is set.** The failure being
/// designed against is a window that cannot be closed at all: if the listener is
/// never registered — a boot failure, a renderer that threw before it got that
/// far, a future build without the global Tauri API — then cancelling every close
/// would trap the user inside the app with no way out, which is a great deal
/// worse than the missing warning this exists to add. Unarmed, the window closes
/// exactly as it did before any of this.
static GUARD_ARMED: AtomicBool = AtomicBool::new(false);

/// The frontend has registered its listener and will answer the close question.
#[tauri::command]
fn arm_close_guard() {
    GUARD_ARMED.store(true, Ordering::SeqCst);
}

#[tauri::command]
fn close_window(window: tauri::Window) -> Result<(), String> {
    AGREED_CLOSE.store(true, Ordering::SeqCst);
    window.close().map_err(|e| e.to_string())
}

/* ── frameless window controls ───────────────────────────────────────── */
// `decorations` is false in tauri.conf.json, so the window has no OS title bar
// and the page draws its own Minimize, Maximize and Close. These back them.
//
// Own commands rather than the `core:window` permissions for the same calls:
// each is one named action on this app's own window, which is a smaller grant
// than opening the window plugin to the frontend. The one permission the
// capability manifest does add is `core:window:allow-start-dragging`, which
// Tauri's own drag script needs for the drag region on #topbar — and
// double-click-to-maximize rides on that same script, through
// `internal-toggle-maximize`, which `core:default` already grants.

/// Minimize to the taskbar.
#[tauri::command]
fn minimize_window(window: tauri::Window) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

/// Toggle between maximized and restored — what the middle button does.
#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) -> Result<(), String> {
    if window.is_maximized().map_err(|e| e.to_string())? {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

/// Enter or leave real fullscreen. Bound to F11 in window_chrome.js.
#[tauri::command]
fn set_fullscreen(window: tauri::Window, fullscreen: bool) -> Result<(), String> {
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())
}

/// Whether the window is already fullscreen, so the frontend can seed its flag
/// from the truth rather than assuming it started windowed.
#[tauri::command]
fn is_fullscreen(window: tauri::Window) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}

/* ── system TeX ──────────────────────────────────────────────────────── */

/// What the user has installed. Cheap enough to call on demand, and it must be
/// re-checked rather than cached: people install TeX Live while the app is open.
#[tauri::command(async)]
fn detect_tex() -> Vec<tex_run::ToolInfo> {
    tex_run::detect()
}

/// Run one TeX tool over the open project.
///
/// The frontend chooses a tool by name and a main file; it never supplies
/// arguments. `tex_run` builds argv, and the path here is validated against the
/// project root exactly as a read or a write would be — a compile is not a
/// reason to relax containment.
#[tauri::command(async)]
fn run_tex(
    tool: String,
    main_file: String,
    timeout_secs: Option<u64>,
    state: State<'_, RootPath>,
) -> Result<tex_run::RunResult, String> {
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&main_file).to_string_lossy(), &root)?;
    if !abs.exists() {
        return Err(format!("{main_file} does not exist in the project"));
    }
    tex_run::run_tool(&tool, &main_file, &root, timeout_secs)
}

fn main() {
    // Seed the root from the environment or argv, so the app can be launched
    // straight into a project. Also what makes the desktop path testable without
    // driving a native folder dialog. Vetted like every other way a root is set
    // (see vet_project_dir); everything after this still goes through
    // safe_path_inside.
    let seed = std::env::var_os("REVERY_TEX_OPEN")
        .or_else(|| std::env::args_os().nth(1))
        .and_then(|p| vet_project_dir(Path::new(&p), home_dir().as_deref()).ok());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RootPath(Mutex::new(seed)))
        .invoke_handler(tauri::generate_handler![
            open_folder_dialog,
            current_root,
            open_folder_path,
            read_directory,
            read_text_file,
            read_binary_file,
            write_file,
            write_binary_file,
            delete_file,
            rename_file,
            open_containing_folder,
            write_backup,
            list_stale_backups,
            discard_backup,
            detect_tex,
            run_tex,
            arm_close_guard,
            close_window,
            minimize_window,
            toggle_maximize_window,
            set_fullscreen,
            is_fullscreen,
        ])
        // `beforeunload` does not run when a native window is closed — the
        // webview is torn down rather than navigated — so the unsaved-changes
        // warning the browser build has was doing nothing at all here. Closing
        // the window discarded every dirty buffer without a word.
        //
        // Every close is cancelled and handed to the frontend, which already
        // knows what is unsaved and already has the wording (`unsavedWarning`).
        // It asks, and calls `close_window` if the answer is yes. Asking in the
        // webview rather than with a native dialog also keeps the capability
        // manifest as it is: `dialog:allow-open` is granted for the folder
        // picker, and a message dialog would mean widening it.
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Both conditions fail open: an agreed close goes through, and so
                // does one arriving before the frontend armed the guard.
                if AGREED_CLOSE.load(Ordering::SeqCst) || !GUARD_ARMED.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                if window.emit("revery-tex://close-requested", ()).is_err() {
                    AGREED_CLOSE.store(true, Ordering::SeqCst);
                    let _ = window.close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Revery TeX");
}

/* ── tests ───────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    /// Scratch files left behind in `dir`.
    ///
    /// Asserted by scanning rather than by name: tmp_for is unique per call, so
    /// rebuilding the name in a test would check a path that never existed and
    /// pass whatever happened.
    fn leftover_scratch(dir: &Path) -> Vec<String> {
        fs::read_dir(dir).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("revery_tmp") || n.contains("revery_bak"))
            .collect()
    }

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "revery-tex-test-{tag}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// The key is pinned to a literal, because that is the whole point of it.
    ///
    /// This replaces `backup_key_is_stable_and_distinct`, which asserted only
    /// `backup_key(a) == backup_key(a)` — true of every hash ever written,
    /// including the unstable one it was guarding. "Stable" across a *process*
    /// was never the property at risk.
    ///
    /// A hash that changes when the toolchain changes strands every backup
    /// written before the upgrade. std says DefaultHasher may do exactly that,
    /// so this asserts the *value*, not merely that hashing happens — a test
    /// that recomputed the hash would agree with any algorithm at all.
    ///
    /// The two literals are what `crypto.createHash('sha256').update(abs)
    /// .digest('hex').slice(0, 16)` returns in the Electron twin for the same
    /// paths, so the shells are also spelled the same way.
    #[test]
    fn backup_key_is_stable_and_matches_the_electron_twin() {
        assert_eq!(backup_key(Path::new("/home/u/proj/main.tex")), "60f470bd4075a790");
        assert_eq!(backup_key(Path::new("/tmp/a.tex")), "2e820f753d4209a3");
        assert_eq!(backup_key(Path::new("/tmp/a.tex")).len(), 16);
        assert_ne!(
            backup_key(Path::new("/tmp/a.tex")),
            backup_key(Path::new("/tmp/b.tex")),
            "two paths must not share a filename"
        );
    }

    #[test]
    fn safe_path_rejects_empty_and_null() {
        assert!(safe_path("").is_err());
        assert!(safe_path("a\0b").is_err());
        assert!(safe_path("ok.tex").is_ok());
    }

    #[test]
    fn rejects_parent_traversal() {
        let root = tmpdir("traverse");
        fs::write(root.join("in.tex"), b"x").unwrap();
        assert!(safe_path_inside(&root.join("in.tex").to_string_lossy(), &root).is_ok());

        let escape = root.join("../../etc/passwd");
        assert!(safe_path_inside(&escape.to_string_lossy(), &root).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let root = tmpdir("symlink");
        let outside = tmpdir("symlink-outside");
        fs::write(outside.join("secret.txt"), b"secret").unwrap();
        std::os::unix::fs::symlink(outside.join("secret.txt"), root.join("link.txt")).unwrap();

        // The link resolves outside the root, so it must be refused even though
        // the path itself sits inside.
        assert!(safe_path_inside(&root.join("link.txt").to_string_lossy(), &root).is_err());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /* ── the folder handed to a file manager ─────────────────────────── */
    //
    // Only the deciding half is tested here. launch_file_manager is the one
    // function in this binary a test cannot call: it would open a file manager
    // window on whatever machine ran the suite. That is precisely why the
    // decision lives in containing_dir, where it can be reached.

    #[test]
    #[ignore = "opens a real file manager window; run explicitly with --ignored"]
    fn launch_file_manager_actually_launches() {
        let root = tmpdir("launch");
        fs::create_dir(root.join("figures")).unwrap();
        let dir = containing_dir("figures", &root).unwrap();
        launch_file_manager(&dir).expect("should launch");
        // Give the reaper thread a moment; a zombie would show as a defunct
        // child of this test process.
        std::thread::sleep(std::time::Duration::from_millis(1500));
        fs::remove_dir_all(&root).ok();
    }

    /* ── vet_project_root ────────────────────────────────────────────
       The renderer names this path, so every refusal is worth a test. */

    #[test]
    fn vet_project_root_accepts_a_real_folder_and_canonicalises_it() {
        let d = tmpdir("vet-ok");
        let sub = d.join("thesis");
        fs::create_dir_all(&sub).unwrap();
        // A path with a `.` segment must come back resolved, because
        // safe_path_inside compares canonical paths against whatever is stored.
        let scruffy = format!("{}/./thesis", d.to_string_lossy());
        let got = vet_project_root(&scruffy, None).unwrap();
        assert_eq!(got, sub.canonicalize().unwrap());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn vet_project_root_refuses_a_path_that_is_gone() {
        let d = tmpdir("vet-gone");
        let missing = d.join("never-existed");
        assert!(vet_project_root(&missing.to_string_lossy(), None).is_err());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn vet_project_root_refuses_a_file() {
        let d = tmpdir("vet-file");
        let f = d.join("main.tex");
        fs::write(&f, "x").unwrap();
        assert!(vet_project_root(&f.to_string_lossy(), None).is_err());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn vet_project_root_refuses_empty() {
        assert!(vet_project_root("", None).is_err());
        assert!(vet_project_root("   ", None).is_err());
    }

    /// The root is also tex_run's working directory, so this is not tidiness.
    #[test]
    fn vet_project_root_refuses_a_filesystem_root() {
        let root = if cfg!(windows) { "C:\\" } else { "/" };
        assert!(vet_project_root(root, None).is_err());
    }

    #[test]
    fn vet_project_root_refuses_the_home_directory_itself() {
        let d = tmpdir("vet-home");
        let home = d.canonicalize().unwrap();
        assert!(vet_project_root(&home.to_string_lossy(), Some(&home)).is_err());
        // A project *inside* home is the normal case and must still pass.
        let sub = home.join("thesis");
        fs::create_dir_all(&sub).unwrap();
        assert!(vet_project_root(&sub.to_string_lossy(), Some(&home)).is_ok());
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn containing_dir_gives_a_dir_itself_and_a_file_its_parent() {
        let root = tmpdir("containing");
        fs::create_dir(root.join("chapters")).unwrap();
        fs::write(root.join("chapters/one.tex"), b"x").unwrap();
        fs::write(root.join("main.tex"), b"x").unwrap();
        let real = root.canonicalize().unwrap();

        assert_eq!(containing_dir("chapters", &root).unwrap(), real.join("chapters"));
        assert_eq!(
            containing_dir("chapters/one.tex", &root).unwrap(),
            real.join("chapters")
        );
        assert_eq!(containing_dir("main.tex", &root).unwrap(), real);
        fs::remove_dir_all(&root).ok();
    }

    /// A file deleted out from under the tree still has a folder worth opening,
    /// which is more useful than refusing.
    #[test]
    fn containing_dir_resolves_a_missing_path_to_its_parent() {
        let root = tmpdir("containing-gone");
        fs::create_dir(root.join("figures")).unwrap();
        assert_eq!(
            containing_dir("figures/gone.png", &root).unwrap(),
            root.canonicalize().unwrap().join("figures")
        );
        fs::remove_dir_all(&root).ok();
    }

    /// Showing a folder is a small power, but the path still came from the
    /// renderer, so it is held to the same containment as a write.
    #[test]
    fn containing_dir_refuses_to_leave_the_project() {
        let root = tmpdir("containing-escape");
        fs::write(root.join("in.tex"), b"x").unwrap();
        assert!(containing_dir("../../etc/passwd", &root).is_err());
        assert!(containing_dir("/etc", &root).is_err());
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn containing_dir_refuses_a_symlink_out_of_the_project() {
        let root = tmpdir("containing-symlink");
        let outside = tmpdir("containing-symlink-outside");
        fs::write(outside.join("figure.png"), b"x").unwrap();
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();

        // Refused before anything is launched — both the link itself and a path
        // reached through it.
        assert!(containing_dir("out", &root).is_err());
        assert!(containing_dir("out/figure.png", &root).is_err());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn allows_creating_nonexistent_nested_path() {
        let root = tmpdir("create");
        let target = root.join("chapters/new/file.tex");
        // Does not exist yet, and neither does its parent.
        assert!(safe_path_inside(&target.to_string_lossy(), &root).is_ok());
        fs::remove_dir_all(&root).ok();
    }

    #[cfg(unix)]
    #[test]
    fn rejects_creating_through_an_escaping_symlink() {
        let root = tmpdir("create-escape");
        let outside = tmpdir("create-escape-outside");
        std::os::unix::fs::symlink(&outside, root.join("out")).unwrap();

        // The file does not exist, but its ancestor is a symlink out of the
        // project. This is the case the deepest-existing-ancestor walk exists for.
        let target = root.join("out/evil.tex");
        assert!(safe_path_inside(&target.to_string_lossy(), &root).is_err());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    /// `raw_os_error()` is an errno on Unix and a Win32 code on Windows, and the
    /// two ranges collide. Ungated, this function matched 17 and 32 on Linux —
    /// EEXIST and EPIPE — because those are the Windows codes it wanted. A
    /// rename refused because the destination was a non-empty directory was then
    /// routed into the snapshot-and-copy fallback and reported as a confusing
    /// "cannot create backup".
    #[cfg(unix)]
    #[test]
    fn cross_device_check_does_not_claim_unix_errnos_it_did_not_mean() {
        use std::io::{Error, ErrorKind};
        let err = |n| Error::from_raw_os_error(n);

        assert!(is_cross_device_err(&err(18)), "EXDEV is the whole point");
        assert!(is_cross_device_err(&err(16)), "EBUSY, as the Electron twin accepts");
        assert!(is_cross_device_err(&err(1)), "EPERM, likewise");

        // The regression: these are the Windows codes, and mean something else here.
        assert!(!is_cross_device_err(&err(17)), "EEXIST is not a cross-device rename");
        assert!(!is_cross_device_err(&err(32)), "EPIPE is not a cross-device rename");

        assert!(!is_cross_device_err(&err(2)), "ENOENT");
        assert!(!is_cross_device_err(&err(13)), "EACCES");
        // An error carrying no OS code at all must not fall into the fallback.
        assert!(!is_cross_device_err(&Error::new(ErrorKind::Other, "no errno")));
    }

    #[test]
    fn atomic_write_overwrites_and_cleans_up() {
        let root = tmpdir("atomic");
        let dest = root.join("main.tex");
        fs::write(&dest, b"old").unwrap();

        atomic_write_file(&tmp_for(&dest), &dest, b"new content").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new content");
        assert!(leftover_scratch(&root).is_empty(), "temp file must not survive");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn atomic_write_creates_new_file() {
        let root = tmpdir("atomic-new");
        let dest = root.join("fresh.tex");
        atomic_write_file(&tmp_for(&dest), &dest, b"hello").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "hello");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn cross_device_detection() {
        let exdev = std::io::Error::from_raw_os_error(18);
        assert!(is_cross_device_err(&exdev));
        let enoent = std::io::Error::from_raw_os_error(2);
        assert!(!is_cross_device_err(&enoent));
    }

    // ── the save path a Ctrl+S actually takes ──────────────────────────
    #[test]
    fn write_then_read_round_trips() {
        let root = tmpdir("save");
        fs::write(root.join("main.tex"), b"original").unwrap();

        write_file_impl("main.tex", "edited by the user", &root, None).unwrap();
        assert_eq!(read_text_impl("main.tex", &root).unwrap().content, "edited by the user");
        // Bytes on disk, not just what we read back through our own code.
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "edited by the user");
        assert!(leftover_scratch(&root).is_empty(), "temp must not survive");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_creates_missing_subdirectories() {
        let root = tmpdir("save-nested");
        write_file_impl("chapters/new/intro.tex", "hello", &root, None).unwrap();
        assert_eq!(fs::read_to_string(root.join("chapters/new/intro.tex")).unwrap(), "hello");
        fs::remove_dir_all(&root).ok();
    }

    // The binary write. Mirrors the Node cases in test/fs_core.test.js — a
    // containment rule enforced on one write path and not the other is not
    // enforced, and this is a second way to put bytes on a user's disk.
    #[test]
    fn binary_write_round_trips_bytes_untouched() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let root = tmpdir("binwrite");
        // A PNG header: the 0x0D 0x0A pair a text round-trip mangles, and a
        // 0x00 that would truncate a C string.
        let png: [u8; 10] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff];
        write_binary_impl("fig/logo.png", &STANDARD.encode(png), &root).unwrap();
        assert_eq!(fs::read(root.join("fig/logo.png")).unwrap(), png);
        assert!(leftover_scratch(&root.join("fig")).is_empty(), "temp must not survive");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn binary_write_refuses_to_escape_the_root() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let root = tmpdir("bin-escape");
        let outside = tmpdir("bin-escape-outside");
        fs::write(outside.join("victim.png"), b"do not touch").unwrap();

        let rel = format!("../{}/victim.png", outside.file_name().unwrap().to_string_lossy());
        assert!(write_binary_impl(&rel, &STANDARD.encode(b"pwned"), &root).is_err());
        assert_eq!(fs::read_to_string(outside.join("victim.png")).unwrap(), "do not touch");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn binary_write_rejects_malformed_base64_rather_than_writing_rubbish() {
        let root = tmpdir("bin-b64");
        assert!(write_binary_impl("x.png", "not!valid!base64", &root).is_err());
        assert!(!root.join("x.png").exists(), "nothing may be left behind");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn delete_removes_a_file_and_refuses_to_escape() {
        let root = tmpdir("delete");
        let outside = tmpdir("delete-outside");
        fs::write(outside.join("victim.tex"), b"do not touch").unwrap();
        fs::write(root.join("gone.tex"), b"x").unwrap();

        delete_file_impl("gone.tex", &root).unwrap();
        assert!(!root.join("gone.tex").exists());

        // The first destructive operation in the app: the containment rule has
        // to hold here exactly as it does for writes.
        let rel = format!("../{}/victim.tex", outside.file_name().unwrap().to_string_lossy());
        assert!(delete_file_impl(&rel, &root).is_err());
        assert!(outside.join("victim.tex").exists());

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn delete_will_not_empty_a_directory_for_you() {
        // No recursion, deliberately: the caller deletes the files it is
        // showing, one at a time, so there is no "remove this tree" primitive.
        let root = tmpdir("delete-dir");
        fs::create_dir_all(root.join("ch")).unwrap();
        fs::write(root.join("ch/a.tex"), b"x").unwrap();
        assert!(delete_file_impl("ch", &root).is_err());
        assert!(root.join("ch/a.tex").exists());

        delete_file_impl("ch/a.tex", &root).unwrap();
        delete_file_impl("ch", &root).unwrap();
        assert!(!root.join("ch").exists());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_moves_and_never_overwrites() {
        let root = tmpdir("rename");
        fs::write(root.join("a.tex"), b"content").unwrap();
        fs::write(root.join("taken.tex"), b"someone else's work").unwrap();

        rename_file_impl("a.tex", "ch/b.tex", &root, None).unwrap();
        assert_eq!(fs::read_to_string(root.join("ch/b.tex")).unwrap(), "content");
        assert!(!root.join("a.tex").exists());

        // Renaming onto an existing file would destroy it with no warning.
        assert!(rename_file_impl("ch/b.tex", "taken.tex", &root, None).is_err());
        assert_eq!(fs::read_to_string(root.join("taken.tex")).unwrap(), "someone else's work");
        assert!(rename_file_impl("nothing.tex", "x.tex", &root, None).is_err());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_refuses_to_escape_the_root() {
        let root = tmpdir("rename-escape");
        let outside = tmpdir("rename-escape-outside");
        fs::write(root.join("a.tex"), b"x").unwrap();

        let rel = format!("../{}/stolen.tex", outside.file_name().unwrap().to_string_lossy());
        assert!(rename_file_impl("a.tex", &rel, &root, None).is_err());
        assert!(!outside.join("stolen.tex").exists());
        assert!(root.join("a.tex").exists(), "the source must survive a refused rename");

        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn write_refuses_to_escape_the_root() {
        let root = tmpdir("save-escape");
        let outside = tmpdir("save-escape-outside");
        fs::write(outside.join("victim.tex"), b"do not touch").unwrap();

        let rel = format!("../{}/victim.tex", outside.file_name().unwrap().to_string_lossy());
        assert!(write_file_impl(&rel, "pwned", &root, None).is_err());
        assert_eq!(fs::read_to_string(outside.join("victim.tex")).unwrap(), "do not touch");
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn read_refuses_to_escape_the_root() {
        let root = tmpdir("read-escape");
        let outside = tmpdir("read-escape-outside");
        fs::write(outside.join("secret.tex"), b"secret").unwrap();
        let rel = format!("../{}/secret.tex", outside.file_name().unwrap().to_string_lossy());
        assert!(read_text_impl(&rel, &root).is_err());
        fs::remove_dir_all(&root).ok();
        fs::remove_dir_all(&outside).ok();
    }

    #[test]
    fn repeated_saves_keep_the_last_write() {
        let root = tmpdir("save-repeat");
        for i in 0..5 {
            write_file_impl("main.tex", &format!("revision {i}"), &root, None).unwrap();
        }
        assert_eq!(read_text_impl("main.tex", &root).unwrap().content, "revision 4");
        // No .revery_tmp or .revery_bak left lying around after five writes.
        let junk = leftover_scratch(&root);
        assert!(junk.is_empty(), "left behind: {junk:?}");
        fs::remove_dir_all(&root).ok();
    }

    // ── conflict detection ─────────────────────────────────────────────
    #[test]
    fn write_with_matching_stamp_succeeds() {
        let root = tmpdir("stamp-ok");
        fs::write(root.join("main.tex"), b"original").unwrap();
        let r = read_text_impl("main.tex", &root).unwrap();
        write_file_impl("main.tex", "mine", &root, Some(&r.stamp)).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "mine");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_refuses_when_the_file_changed_underneath() {
        let root = tmpdir("stamp-conflict");
        fs::write(root.join("main.tex"), b"original").unwrap();
        let r = read_text_impl("main.tex", &root).unwrap();

        // Someone else edits it — another editor, a git checkout, a sync client.
        std::thread::sleep(std::time::Duration::from_millis(15));
        fs::write(root.join("main.tex"), b"their much longer edit").unwrap();

        let err = write_file_impl("main.tex", "mine", &root, Some(&r.stamp)).unwrap_err();
        assert!(err.starts_with(CONFLICT_PREFIX), "got: {err}");
        // Their work must survive the refusal.
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "their much longer edit");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_with_no_stamp_forces_the_overwrite() {
        let root = tmpdir("stamp-force");
        fs::write(root.join("main.tex"), b"original").unwrap();
        let r = read_text_impl("main.tex", &root).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        fs::write(root.join("main.tex"), b"theirs").unwrap();

        // None = the user was shown the conflict and chose to overwrite.
        write_file_impl("main.tex", "mine", &root, None).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "mine");
        let _ = r;
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn same_size_edit_is_still_caught() {
        let root = tmpdir("stamp-samesize");
        fs::write(root.join("main.tex"), b"aaaa").unwrap();
        let r = read_text_impl("main.tex", &root).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(15));
        fs::write(root.join("main.tex"), b"bbbb").unwrap();   // same length
        let err = write_file_impl("main.tex", "cccc", &root, Some(&r.stamp)).unwrap_err();
        assert!(err.starts_with(CONFLICT_PREFIX), "size alone would have missed this");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn write_returns_a_stamp_usable_for_the_next_save() {
        let root = tmpdir("stamp-chain");
        let s1 = write_file_impl("main.tex", "one", &root, None).unwrap();
        // The returned stamp must satisfy the next write, or every second save
        // would report a false conflict.
        write_file_impl("main.tex", "two", &root, Some(&s1)).unwrap();
        assert_eq!(fs::read_to_string(root.join("main.tex")).unwrap(), "two");
        fs::remove_dir_all(&root).ok();
    }

    // ── the bytes a read hands back are the bytes a write puts down ────────
    // Mirrors the cases in test/fs_core.test.js. The encoding and line-ending
    // fixes (Phases 2 and 5) are built on these holding in both shells.

    /// Refusing is the contract, not an accident: the loader will fall back to
    /// bytes when a text read is refused. Electron currently decodes instead —
    /// the known bug the Node twin of this test marks.
    #[test]
    fn a_file_that_is_not_utf8_is_refused_as_text() {
        let root = tmpdir("latin1");
        fs::write(root.join("latin1.tex"), [0x43, 0x61, 0x66, 0xe9, 0x0a]).unwrap();
        assert!(read_text_impl("latin1.tex", &root).is_err(),
            "non-UTF-8 text must be refused, never decoded into U+FFFD");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn crlf_survives_a_read_and_an_unchanged_write() {
        let root = tmpdir("crlf");
        let bytes = b"\\documentclass{article}\r\n\\begin{document}\r\nx\r\n\\end{document}\r\n";
        fs::write(root.join("win.tex"), bytes).unwrap();
        let r = read_text_impl("win.tex", &root).unwrap();
        write_file_impl("win.tex", &r.content, &root, Some(&r.stamp)).unwrap();
        assert_eq!(fs::read(root.join("win.tex")).unwrap(), bytes.to_vec());
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_byte_order_mark_survives_a_read_and_an_unchanged_write() {
        let root = tmpdir("bom");
        let bytes = [&[0xefu8, 0xbb, 0xbf][..], "Caf\u{e9}\n".as_bytes()].concat();
        fs::write(root.join("bom.tex"), &bytes).unwrap();
        let r = read_text_impl("bom.tex", &root).unwrap();
        write_file_impl("bom.tex", &r.content, &root, Some(&r.stamp)).unwrap();
        assert_eq!(fs::read(root.join("bom.tex")).unwrap(), bytes);
        fs::remove_dir_all(&root).ok();
    }

    /// The read race, landed deterministically through read_stable_with's seam.
    /// Two outcomes are right — the other program's text is in what was read,
    /// or the save is a conflict. The bug was the third: old text, new stamp,
    /// and a save that silently dropped the other program's write.
    #[test]
    fn a_write_that_lands_during_the_read_is_never_hidden() {
        let root = tmpdir("read-race");
        let target = root.join("main.tex");
        fs::write(&target, "original\n").unwrap();
        let mut raced = false;
        let (bytes, stamp) = read_stable_with(&target, |f| {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            if !raced {
                raced = true;
                fs::write(&target, "written by another program in between\n")?;
            }
            Ok(buf)
        })
        .unwrap();
        assert!(raced, "the injected write never ran");
        let content = String::from_utf8(bytes).unwrap();
        let hidden = match write_file_impl("main.tex", &format!("{content}mine\n"), &root, Some(&stamp)) {
            Ok(_) => !fs::read_to_string(&target).unwrap().contains("written by another program"),
            Err(e) => {
                assert!(e.starts_with(CONFLICT_PREFIX), "{e}");
                false
            }
        };
        assert!(!hidden, "a stamp taken after the read hid an external write");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_file_that_keeps_changing_is_refused_rather_than_misdescribed() {
        let root = tmpdir("read-churn");
        let target = root.join("main.tex");
        fs::write(&target, "0").unwrap();
        let mut n = 0;
        let r = read_stable_with(&target, |f| {
            let mut buf = Vec::new();
            f.read_to_end(&mut buf)?;
            n += 1;
            fs::write(&target, "x".repeat(n + 1))?;
            Ok(buf)
        });
        assert!(r.is_err(), "a read that never settled must not return a stamp");
        assert_eq!(n, STABLE_READ_TRIES);
        fs::remove_dir_all(&root).ok();
    }

    /// A rename checks the file it moves against the stamp it was read with,
    /// and hands back the destination's stamp — which a save then checks.
    #[test]
    fn a_rename_carries_the_stamp_and_a_later_change_is_still_a_conflict() {
        let root = tmpdir("rename-stamp");
        fs::write(root.join("a.tex"), "text\n").unwrap();
        let read = read_text_impl("a.tex", &root).unwrap();
        let moved = rename_file_impl("a.tex", "ch/b.tex", &root, Some(&read.stamp)).unwrap();
        // Changed by another program after the move, to a different length so
        // the size half of the stamp carries it whatever the mtime resolution.
        fs::write(root.join("ch/b.tex"), "changed by another program\n").unwrap();
        let e = write_file_impl("ch/b.tex", "mine\n", &root, Some(&moved)).unwrap_err();
        assert!(e.starts_with(CONFLICT_PREFIX), "{e}");
        assert_eq!(fs::read_to_string(root.join("ch/b.tex")).unwrap(), "changed by another program\n");
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn a_rename_of_a_file_changed_since_it_was_read_is_refused_and_moves_nothing() {
        let root = tmpdir("rename-conflict");
        fs::write(root.join("a.tex"), "text\n").unwrap();
        let read = read_text_impl("a.tex", &root).unwrap();
        fs::write(root.join("a.tex"), "changed outside\n").unwrap();
        let e = rename_file_impl("a.tex", "b.tex", &root, Some(&read.stamp)).unwrap_err();
        assert!(e.starts_with(CONFLICT_PREFIX), "{e}");
        assert!(root.join("a.tex").exists() && !root.join("b.tex").exists());
        fs::remove_dir_all(&root).ok();
    }

    /// Backups moved from the cache directory to the data directory. One an
    /// older build left in the cache must still be offered, and still be
    /// dismissable, or the move strands it — or makes its dialog permanent.
    #[test]
    fn a_backup_left_in_the_old_directory_is_offered_and_discarded() {
        let root = tmpdir("backup-dirs-root");
        let data = tmpdir("backup-dirs-data");
        let cache = tmpdir("backup-dirs-cache");
        let abs = root.canonicalize().unwrap().join("main.tex");
        fs::write(&abs, "on disk\n").unwrap();
        write_backup_in(&cache, "main.tex", &abs, "from an older build\n").unwrap();
        let dirs = vec![data.clone(), cache.clone()];

        let offered = list_stale_backups_in(&dirs, &root.canonicalize().unwrap());
        assert_eq!(offered.len(), 1, "{offered:?}");
        assert_eq!(offered[0]["content"], "from an older build\n");

        // A newer one in the current directory wins — one offer per file.
        write_backup_in(&data, "main.tex", &abs, "from this build\n").unwrap();
        let offered = list_stale_backups_in(&dirs, &root.canonicalize().unwrap());
        assert_eq!(offered.len(), 1, "{offered:?}");

        discard_backup_in(&dirs, &abs);
        assert!(list_stale_backups_in(&dirs, &root.canonicalize().unwrap()).is_empty());
        assert_eq!(fs::read_dir(&cache).unwrap().count(), 0, "the old directory still holds it");
        for d in [root, data, cache] {
            fs::remove_dir_all(d).ok();
        }
    }

    #[test]
    fn an_undisturbed_read_is_the_file_and_its_stamp() {
        let root = tmpdir("read-stable");
        fs::write(root.join("a.tex"), "hello\n").unwrap();
        let r = read_text_impl("a.tex", &root).unwrap();
        assert_eq!(r.content, "hello\n");
        let now = stamp_of(&root.join("a.tex")).unwrap();
        assert_eq!((r.stamp.mtime_ms, r.stamp.size), (now.mtime_ms, now.size));
        fs::remove_dir_all(&root).ok();
    }

}
