use crate::config::{self, Settings};
use crate::error::{Error, Result};
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard};

pub struct AppState {
    /// The app's own data folder (settings, its copy of yt-dlp).
    pub dir: PathBuf,
    settings: Mutex<Settings>,
}

fn lock<T>(m: &Mutex<T>) -> Result<MutexGuard<'_, T>> {
    m.lock().map_err(|_| Error::msg("Internal error: please restart the app."))
}

impl AppState {
    pub fn new(dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&dir)?;
        let mut settings = config::load(&dir);
        // First start: save to Downloads/Goblin, so downloading works right away.
        if settings.download_dir.is_none() {
            if let Some(d) = config::default_download_dir() {
                if std::fs::create_dir_all(&d).is_ok() {
                    settings.download_dir = Some(d.to_string_lossy().into_owned());
                    let _ = config::save(&dir, &settings);
                }
            }
        }
        Ok(AppState { dir, settings: Mutex::new(settings) })
    }

    pub fn settings(&self) -> Result<Settings> {
        Ok(lock(&self.settings)?.clone())
    }

    pub fn update_settings(&self, f: impl FnOnce(&mut Settings)) -> Result<()> {
        let mut s = lock(&self.settings)?;
        f(&mut s);
        config::save(&self.dir, &s)
    }
}
