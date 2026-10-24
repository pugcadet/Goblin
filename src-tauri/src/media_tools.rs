//! Finding a system ffmpeg (Goblin normally uses the one inside the app; see downloads.rs).

use std::path::PathBuf;

/// The path chosen by hand, then the usual install places. (Apps started from the Dock or
/// Start menu do not see the shell's PATH, so common Homebrew / winget locations are checked by name.)
pub fn locate_ffmpeg(custom: Option<&str>) -> Option<PathBuf> {
    if let Some(c) = custom.map(PathBuf::from).filter(|p| p.is_file()) {
        return Some(c);
    }
    let exe = if cfg!(windows) { "ffmpeg.exe" } else { "ffmpeg" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"].map(PathBuf::from));
    }
    if cfg!(windows) {
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            dirs.push(PathBuf::from(&local).join("Microsoft").join("WinGet").join("Links"));
        }
        dirs.extend([r"C:\ffmpeg\bin", r"C:\Program Files\ffmpeg\bin"].map(PathBuf::from));
        if let Some(home) = std::env::var_os("USERPROFILE") {
            dirs.push(PathBuf::from(home).join("scoop").join("shims"));
        }
    }
    dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file())
}
