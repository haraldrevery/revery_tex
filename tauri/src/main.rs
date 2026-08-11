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
use tauri::{Manager, State};
use tauri_plugin_dialog::DialogExt;

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

#[tauri::command]
fn read_text_file(path: String, state: State<'_, RootPath>) -> Result<String, String> {
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&path).to_string_lossy(), &root)?;
    fs::read_to_string(&abs).map_err(|e| format!("Cannot read {path}: {e}"))
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

#[tauri::command]
fn write_file(path: String, content: String, state: State<'_, RootPath>) -> Result<(), String> {
    let root = get_root(&state)?;
    let abs = safe_path_inside(&root.join(&path).to_string_lossy(), &root)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    atomic_write_file(&tmp_for(&abs), &abs, content.as_bytes())
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

/* ── entry point ─────────────────────────────────────────────────────── */

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
            write_backup,
            list_stale_backups,
            discard_backup,
        ])
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

    #[test]
    fn backup_key_is_stable_and_distinct() {
        let a = Path::new("/tmp/p/main.tex");
        let b = Path::new("/tmp/p/other.tex");
        assert_eq!(backup_key(a), backup_key(a));
        assert_ne!(backup_key(a), backup_key(b));
    }
}
