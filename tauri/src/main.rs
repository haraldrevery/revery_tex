// Revery TeX — Tauri shell.
//
// Phase A deliberately has no commands. The point is to establish whether the
// WASM LaTeX engine runs under WebKitGTK at all; adding a filesystem API before
// knowing that would be building on an unverified foundation.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running Revery TeX");
}
