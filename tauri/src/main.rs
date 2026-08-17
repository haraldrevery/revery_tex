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
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

// Running the user's own TeX installation. Kept in its own module because it is
// the only code here that starts a process, and that boundary is worth seeing.
mod tex_run;

/// The single open project root. Owned by the backend: the renderer can ask to
/// change it via open_folder_dialog, but cannot set it to an arbitrary path.
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

fn is_cross_device_err(e: &std::io::Error) -> bool {
    // 18 = EXDEV (Unix). 17 = ERROR_NOT_SAME_DEVICE (Windows).
    // 32 = ERROR_SHARING_VIOLATION (Windows: antivirus or a sync agent briefly
    //      holding the destination). Safe to fall back to a copy here because
    //      tmp and dest are always on the same filesystem.
    matches!(e.raw_os_error(), Some(18) | Some(17) | Some(32))
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

fn tmp_for(dest: &Path) -> PathBuf {
    dest.with_file_name(format!(
        "{}.revery_tmp",
        dest.file_name().unwrap_or_default().to_string_lossy()
    ))
}

/* ── commands ────────────────────────────────────────────────────────── */

#[tauri::command]
async fn open_folder_dialog(app: tauri::AppHandle, state: State<'_, RootPath>) -> Result<Option<String>, String> {
    let picked = app.dialog().file().blocking_pick_folder();
    let Some(folder) = picked else { return Ok(None) };
    let path = folder
        .into_path()
        .map_err(|e| format!("Cannot resolve chosen folder: {e}"))?;
    let canonical = path
        .canonicalize()
        .map_err(|e| format!("Cannot resolve chosen folder: {e}"))?;

    *state.0.lock().unwrap_or_else(|p| p.into_inner()) = Some(canonical.clone());
    Ok(Some(canonical.to_string_lossy().to_string()))
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

/// Recursive listing, relative to the root. Symlinks are skipped: following them
/// is how a listing walks out of the project.
#[tauri::command]
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

fn stamp_of(abs: &Path) -> Result<FileStamp, String> {
    let m = fs::metadata(abs).map_err(|e| format!("Cannot stat: {e}"))?;
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileStamp { mtime_ms, size: m.len() })
}

fn read_text_impl(path: &str, root: &Path) -> Result<FileRead, String> {
    let abs = safe_path_inside(&root.join(path).to_string_lossy(), root)?;
    let content = fs::read_to_string(&abs).map_err(|e| format!("Cannot read {path}: {e}"))?;
    let stamp = stamp_of(&abs)?;
    Ok(FileRead { content, stamp })
}

/// Write, refusing if the file changed on disk since it was read.
///
/// `expect` is the stamp taken at read time; None forces the write (the user
/// chose "overwrite" after being told). The error is prefixed CONFLICT: so the
/// caller can distinguish it from an IO failure and offer a real choice rather
/// than a generic failure toast.
fn write_file_impl(
    path: &str,
    content: &str,
    root: &Path,
    expect: Option<&FileStamp>,
) -> Result<FileStamp, String> {
    let abs = safe_path_inside(&root.join(path).to_string_lossy(), root)?;

    if let Some(want) = expect {
        if abs.exists() {
            let now = stamp_of(&abs)?;
            if now.mtime_ms != want.mtime_ms || now.size != want.size {
                // One line, deliberately: this is read aloud in a dialog, and a
                // wrapped literal put twenty spaces mid-sentence here — so the
                // desktop prompt read differently from the Electron and browser
                // ones the tests hold to the same wording.
                return Err(format!(
                    "CONFLICT:{path} changed on disk since it was opened \
                     (was {} bytes, now {} bytes)",
                    want.size, now.size
                ));
            }
        }
    }

    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    atomic_write_file(&tmp_for(&abs), &abs, content.as_bytes())?;
    stamp_of(&abs)
}

#[tauri::command]
fn read_text_file(path: String, state: State<'_, RootPath>) -> Result<FileRead, String> {
    read_text_impl(&path, &get_root(&state)?)
}

/// Base64 so binary assets (images, fonts) survive the IPC boundary intact.
#[tauri::command]
fn read_binary_file(path: String, state: State<'_, RootPath>) -> Result<String, String> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&path).to_string_lossy(), &root)?;
    let bytes = fs::read(&abs).map_err(|e| format!("Cannot read {path}: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

#[derive(serde::Deserialize)]
struct ExpectStamp { mtime_ms: u64, size: u64 }

#[tauri::command]
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

#[tauri::command]
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

fn rename_file_impl(from: &str, to: &str, root: &Path) -> Result<(), String> {
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
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    fs::rename(&src, &dest).map_err(|e| format!("Cannot rename {from}: {e}"))?;
    sync_parent_dir(&src);
    sync_parent_dir(&dest);
    Ok(())
}

#[tauri::command]
fn delete_file(path: String, state: State<'_, RootPath>) -> Result<(), String> {
    delete_file_impl(&path, &get_root(&state)?)
}

#[tauri::command]
fn rename_file(from: String, to: String, state: State<'_, RootPath>) -> Result<(), String> {
    rename_file_impl(&from, &to, &get_root(&state)?)
}

/* ── crash backups ───────────────────────────────────────────────────── */
//
// Backups live outside the project, in the app cache dir, so a crash-recovery
// file never appears in the user's git status or gets swept into a compile.

fn backup_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("No cache dir: {e}"))?
        .join("backups");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create backup dir: {e}"))?;
    Ok(dir)
}

/// Absolute path hashed to a flat filename: project paths are arbitrarily long
/// and contain separators, neither of which survives as a filename.
fn backup_key(abs: &Path) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    abs.to_string_lossy().hash(&mut h);
    format!("{:016x}", h.finish())
}

#[tauri::command]
fn write_backup(
    app: tauri::AppHandle,
    path: String,
    content: String,
    state: State<'_, RootPath>,
) -> Result<(), String> {
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&path).to_string_lossy(), &root)?;
    let dir = backup_dir(&app)?;
    let key = backup_key(&abs);

    let payload = serde_json::json!({
        "path": path,
        "abs": abs.to_string_lossy(),
        "saved": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        "content": content,
    })
    .to_string();

    let dest = dir.join(format!("{key}.json"));
    atomic_write_file(&tmp_for(&dest), &dest, payload.as_bytes())
}

/// Backups whose content differs from what is on disk — i.e. unsaved work from
/// a session that did not exit cleanly.
#[tauri::command]
fn list_stale_backups(app: tauri::AppHandle, state: State<'_, RootPath>) -> Result<Vec<serde_json::Value>, String> {
    let root = get_root(&state)?;
    let dir = backup_dir(&app)?;
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else { return Ok(out) };

    for e in entries.flatten() {
        let Ok(text) = fs::read_to_string(e.path()) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let Some(abs) = v.get("abs").and_then(|x| x.as_str()) else { continue };
        // Only offer recovery for the project that is actually open.
        if !Path::new(abs).starts_with(&root) {
            continue;
        }
        let backup_content = v.get("content").and_then(|x| x.as_str()).unwrap_or("");
        let on_disk = fs::read_to_string(abs).unwrap_or_default();
        if on_disk != backup_content {
            out.push(v);
        }
    }
    Ok(out)
}

#[tauri::command]
fn discard_backup(app: tauri::AppHandle, path: String, state: State<'_, RootPath>) -> Result<(), String> {
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&path).to_string_lossy(), &root)?;
    let dest = backup_dir(&app)?.join(format!("{}.json", backup_key(&abs)));
    let _ = fs::remove_file(dest);
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
#[tauri::command]
fn detect_tex() -> Vec<tex_run::ToolInfo> {
    tex_run::detect()
}

/// Run one TeX tool over the open project.
///
/// The frontend chooses a tool by name and a main file; it never supplies
/// arguments. `tex_run` builds argv, and the path here is validated against the
/// project root exactly as a read or a write would be — a compile is not a
/// reason to relax containment.
#[tauri::command]
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
    // driving a native folder dialog. Canonicalised and required to be a real
    // directory; everything after this still goes through safe_path_inside.
    let seed = std::env::var("REVERY_TEX_OPEN")
        .ok()
        .or_else(|| std::env::args().nth(1))
        .and_then(|p| PathBuf::from(p).canonicalize().ok())
        .filter(|p| p.is_dir());

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RootPath(Mutex::new(seed)))
        .invoke_handler(tauri::generate_handler![
            open_folder_dialog,
            current_root,
            read_directory,
            read_text_file,
            read_binary_file,
            write_file,
            write_binary_file,
            delete_file,
            rename_file,
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

    #[test]
    fn atomic_write_overwrites_and_cleans_up() {
        let root = tmpdir("atomic");
        let dest = root.join("main.tex");
        fs::write(&dest, b"old").unwrap();

        atomic_write_file(&tmp_for(&dest), &dest, b"new content").unwrap();
        assert_eq!(fs::read_to_string(&dest).unwrap(), "new content");
        assert!(!tmp_for(&dest).exists(), "temp file must not survive");
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
        assert!(!root.join("main.tex.revery_tmp").exists(), "temp must not survive");
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
        assert!(!root.join("fig/logo.png.revery_tmp").exists(), "temp must not survive");
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

        rename_file_impl("a.tex", "ch/b.tex", &root).unwrap();
        assert_eq!(fs::read_to_string(root.join("ch/b.tex")).unwrap(), "content");
        assert!(!root.join("a.tex").exists());

        // Renaming onto an existing file would destroy it with no warning.
        assert!(rename_file_impl("ch/b.tex", "taken.tex", &root).is_err());
        assert_eq!(fs::read_to_string(root.join("taken.tex")).unwrap(), "someone else's work");
        assert!(rename_file_impl("nothing.tex", "x.tex", &root).is_err());

        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn rename_refuses_to_escape_the_root() {
        let root = tmpdir("rename-escape");
        let outside = tmpdir("rename-escape-outside");
        fs::write(root.join("a.tex"), b"x").unwrap();

        let rel = format!("../{}/stolen.tex", outside.file_name().unwrap().to_string_lossy());
        assert!(rename_file_impl("a.tex", &rel, &root).is_err());
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
        let junk: Vec<_> = fs::read_dir(&root).unwrap().flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.contains("revery_tmp") || n.contains("revery_bak"))
            .collect();
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
        assert!(err.starts_with("CONFLICT:"), "got: {err}");
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
        assert!(err.starts_with("CONFLICT:"), "size alone would have missed this");
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

    #[test]
    fn backup_key_is_stable_and_distinct() {
        let a = Path::new("/tmp/p/main.tex");
        let b = Path::new("/tmp/p/other.tex");
        assert_eq!(backup_key(a), backup_key(a));
        assert_ne!(backup_key(a), backup_key(b));
    }
}
