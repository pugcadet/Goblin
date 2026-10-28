//! Settings kept on this computer (settings.json in the app's data folder).

use crate::error::{Error, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// Where downloads are saved.
    pub download_dir: Option<String>,
    /// ffmpeg chosen by hand. Normally empty: the one inside the app is used.
    pub ffmpeg_path: Option<String>,
    /// Browser to borrow YouTube sign-in cookies from ("firefox", ...). Empty = none.
    pub cookies_browser: Option<String>,
    /// Name of the cookies.txt you loaded (Goblin keeps its own copy as cookies.txt).
    pub cookies_name: Option<String>,
    /// Folders and files you picked in a dialog: Goblin may work in them (presets' folders, Fix music).
    pub granted: Vec<String>,
}

fn path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

pub fn load(dir: &Path) -> Settings {
    std::fs::read(path(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(dir: &Path, s: &Settings) -> Result<()> {
    let tmp = dir.join("settings.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(s).map_err(|e| Error::msg(e.to_string()))?)?;
    std::fs::rename(tmp, path(dir))?;
    Ok(())
}

/// The folder suggested on first start: Downloads/Goblin in the user's home folder.
pub fn default_download_dir() -> Option<PathBuf> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })?;
    Some(PathBuf::from(home).join("Downloads").join("Goblin"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saves_and_loads() {
        let dir = std::env::temp_dir().join(format!("goblin-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let s = Settings { download_dir: Some("/x".into()), cookies_browser: Some("firefox".into()), ..Settings::default() };
        save(&dir, &s).unwrap();
        let back = load(&dir);
        assert_eq!(back.download_dir.as_deref(), Some("/x"));
        assert_eq!(back.cookies_browser.as_deref(), Some("firefox"));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn unknown_or_missing_fields_are_fine() {
        let s: Settings = serde_json::from_str(r#"{"something_old": 1}"#).unwrap();
        assert!(s.download_dir.is_none());
    }
}
