mod config;
mod downloads;
mod error;
mod media_tools;
mod naming;
mod state;

use tauri::Manager;

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let state = state::AppState::new(dir)?;
            app.manage(state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            downloads::ytdlp_info,
            downloads::ytdlp_install,
            downloads::pick_download_folder,
            downloads::dl_set_cookies,
            downloads::dl_probe,
            downloads::dl_search,
            downloads::dl_start,
            downloads::dl_cancel,
            downloads::dl_reveal,
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Goblin");
    app.run(|_app, event| {
        // Quit means quit: no download keeps running after the window is gone.
        if let tauri::RunEvent::Exit = event {
            downloads::kill_all();
        }
    });
}
