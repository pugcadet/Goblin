mod config;
mod downloads;
mod error;
mod host;
mod media_tools;
mod naming;
mod state;
mod updater;

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

pub fn run() {
    let app = tauri::Builder::default()
        // Must come first: a second start (or a goblin:// link on Windows) goes to the window that's already open.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            let _ = app.emit("goblin-focus", ());
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            let state = state::AppState::new(dir)?;
            // Leftovers from a crash or a forced quit.
            let _ = std::fs::remove_dir_all(host::tmp_root(&state));
            app.manage(state);

            // goblin://add?url=… from the bookmarklet.
            #[cfg(windows)]
            {
                let _ = app.deep_link().register_all();
            }
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls: Vec<String> = event.urls().iter().map(|u| u.to_string()).collect();
                host::incoming_links(&handle, urls);
            });
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                host::incoming_links(app.handle(), urls.iter().map(|u| u.to_string()).collect());
            }
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
            host::host_info,
            host::proc_run,
            host::proc_kill,
            host::http_request,
            host::http_download,
            host::work_dir,
            host::work_clear,
            host::fs_list,
            host::fs_exists,
            host::fs_size,
            host::fs_move,
            host::fs_mkdirs,
            host::fs_trash,
            host::fs_audio_files,
            host::reveal,
            host::open_url,
            host::store_read,
            host::store_write,
            host::store_delete,
            host::pick_paths,
            host::pick_image,
            host::cookies_info,
            host::cookies_load,
            host::cookies_delete,
            host::mp3_add_lyrics,
            host::links_take,
            updater::check_update,
            updater::install_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Goblin");
    app.run(|_app, event| {
        // Quit means quit: no download keeps running after the window is gone.
        if let tauri::RunEvent::Exit = event {
            downloads::kill_all();
            host::kill_all();
        }
    });
}
