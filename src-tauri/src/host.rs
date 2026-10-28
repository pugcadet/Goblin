//! The small, fixed set of things the Goblin window may ask this computer to do.
//! Everything clever (the queue, MusicBrainz/Deezer/YouTube Music matching, tagging, the album finder,
//! subscriptions, Fix music) lives in the window's TypeScript; this file only provides narrow, checked tools:
//!
//! - start yt-dlp, ffmpeg or ffprobe (never a shell), with dangerous yt-dlp options refused;
//! - web requests only to the music/metadata services Goblin uses (and redirects only between them);
//! - files: moves, folders, trash and "show in Finder/Explorer" only inside the library folder, Goblin's
//!   own data folder, and folders or files you picked yourself in a dialog;
//! - Goblin's own small JSON/text files (settings, presets, history, subscriptions);
//! - folder/file pickers, the cookies.txt file, links opened in your browser, goblin:// links.

use crate::error::{Error, Result};
use crate::state::AppState;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

// ------------------------------------------------------------------ helpers

fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

fn exe_name(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

/// A helper program shipped inside the app, next to its own executable.
fn beside_app(name: &str) -> Option<PathBuf> {
    let p = std::env::current_exe().ok()?.parent()?.join(exe_name(name));
    p.is_file().then_some(p)
}

fn on_path(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if cfg!(target_os = "macos") {
        dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(PathBuf::from));
    }
    let exe = exe_name(name);
    dirs.into_iter().map(|d| d.join(&exe)).find(|p| p.is_file())
}

fn ytdlp_asset() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else {
        "yt-dlp"
    }
}

/// The same lookup order as downloads.rs: Goblin's own (updatable) copy first, then a system one.
fn ytdlp(state: &AppState) -> Option<PathBuf> {
    let own = state.dir.join("bin").join(ytdlp_asset());
    if own.is_file() {
        return Some(own);
    }
    on_path("yt-dlp")
}

fn ffmpeg(state: &AppState, name: &str) -> Option<PathBuf> {
    if name == "ffmpeg" {
        if let Some(c) = state.settings().ok().and_then(|s| s.ffmpeg_path).map(PathBuf::from).filter(|p| p.is_file()) {
            return Some(c);
        }
    }
    beside_app(name).or_else(|| crate::media_tools::locate_ffmpeg(None).and_then(|f| {
        if name == "ffmpeg" {
            Some(f)
        } else {
            f.parent().map(|d| d.join(exe_name(name))).filter(|p| p.is_file())
        }
    }))
}

fn deno() -> Option<PathBuf> {
    beside_app("deno").or_else(|| on_path("deno"))
}

pub fn tmp_root(state: &AppState) -> PathBuf {
    state.dir.join("tmp")
}

fn cookies_file(state: &AppState) -> PathBuf {
    state.dir.join("cookies.txt")
}

/// `p` with "." removed; None when it contains ".." (never allowed) or is relative.
fn clean_abs(p: &Path) -> Option<PathBuf> {
    if !p.is_absolute() {
        return None;
    }
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => return None,
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    Some(out)
}

/// Resolves symlinks of the part that exists, so a link inside an allowed folder can't point outside it.
fn resolved(p: &Path) -> Option<PathBuf> {
    let p = clean_abs(p)?;
    let mut existing = p.clone();
    let mut rest: Vec<std::ffi::OsString> = Vec::new();
    while !existing.exists() {
        rest.push(existing.file_name()?.to_os_string());
        existing = existing.parent()?.to_path_buf();
    }
    let mut out = existing.canonicalize().ok()?;
    for r in rest.into_iter().rev() {
        out.push(r);
    }
    Some(out)
}

/// Every folder the window may write to or move files around in.
fn roots(state: &AppState) -> Vec<PathBuf> {
    let mut r = vec![state.dir.clone()];
    if let Ok(s) = state.settings() {
        r.extend(s.download_dir.iter().map(PathBuf::from));
        r.extend(s.granted.iter().map(PathBuf::from));
    }
    r.into_iter().filter_map(|p| resolved(&p)).collect()
}

/// Allowed when inside one of the roots (or exactly one of them).
pub fn allowed_path(state: &AppState, p: &Path) -> Result<PathBuf> {
    let r = resolved(p).ok_or_else(|| Error::msg("That path is not allowed."))?;
    if roots(state).iter().any(|root| r.starts_with(root)) {
        Ok(r)
    } else {
        Err(Error::msg("Goblin can only touch files in your library folder or in folders you picked."))
    }
}

fn grant(state: &AppState, p: &Path) -> Result<()> {
    let s = p.to_string_lossy().into_owned();
    state.update_settings(move |st| {
        if !st.granted.contains(&s) {
            st.granted.push(s);
            // Keep the list short: the newest 200 picks.
            if st.granted.len() > 200 {
                let extra = st.granted.len() - 200;
                st.granted.drain(0..extra);
            }
        }
    })
}

// ------------------------------------------------------------------ info

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInfo {
    data_dir: String,
    tmp_dir: String,
    library: Option<String>,
    platform: &'static str,
    home: String,
    ytdlp: Option<String>,
    ffmpeg: Option<String>,
    ffprobe: Option<String>,
    deno: Option<String>,
    cookies_file: bool,
    cookies_browser: Option<String>,
    version: &'static str,
}

#[tauri::command]
pub fn host_info(state: State<'_, AppState>) -> Result<HostInfo> {
    let s = state.settings()?;
    let show = |p: Option<PathBuf>| p.map(|p| p.to_string_lossy().into_owned());
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(|h| h.to_string_lossy().into_owned()).unwrap_or_default();
    Ok(HostInfo {
        data_dir: state.dir.to_string_lossy().into_owned(),
        tmp_dir: tmp_root(&state).to_string_lossy().into_owned(),
        library: s.download_dir,
        platform: if cfg!(windows) { "windows" } else if cfg!(target_os = "macos") { "mac" } else { "linux" },
        home,
        ytdlp: show(ytdlp(&state)),
        ffmpeg: show(ffmpeg(&state, "ffmpeg")),
        ffprobe: show(ffmpeg(&state, "ffprobe")),
        deno: show(deno()),
        cookies_file: cookies_file(&state).is_file(),
        cookies_browser: s.cookies_browser,
        version: env!("CARGO_PKG_VERSION"),
    })
}

// ------------------------------------------------------------------ processes

/// yt-dlp options the window may never pass: they run commands, load code or read/write files outside
/// Goblin's control. (The window adds cookies through `cookies: true`, never by path.)
const REFUSED: &[&str] = &[
    "--exec", "--exec-before-download", "--no-exec", "--netrc-cmd", "--external-downloader", "--external-downloader-args",
    "--downloader", "--downloader-args", "--plugin-dirs", "--no-plugin-dirs", "--config-location", "--config-locations",
    "--alias", "--use-postprocessor", "--print-to-file", "--cookies", "--cookies-from-browser", "--no-cookies",
    "--no-cookies-from-browser", "--update", "-U", "--update-to", "--netrc-location", "--ffmpeg-location", "--js-runtimes",
    "--remote-components", "--ignore-config", "--no-config", "--enable-file-urls",
];

pub fn check_ytdlp_args(args: &[String]) -> Result<()> {
    for a in args {
        if a == "--" {
            break; // everything after "--" is an address, never an option
        }
        let name = a.split('=').next().unwrap_or(a);
        if REFUSED.contains(&name) {
            return Err(Error::msg(format!("The yt-dlp option {name} is not allowed in Goblin.")));
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcReq {
    /// Chosen by the window, used to stop it (proc_kill) and to tag streamed lines.
    id: String,
    /// "yt-dlp" | "ffmpeg" | "ffprobe"
    tool: String,
    args: Vec<String>,
    /// Stop after this many seconds (0/none = never).
    timeout_sec: Option<u64>,
    /// Stop when it prints nothing for this long (downloads that hang).
    stall_sec: Option<u64>,
    /// Send every output line as a "proc-line" event while it runs (stdout is then not returned).
    stream: Option<bool>,
    /// yt-dlp only: use the cookies (Goblin's cookies.txt, else the browser chosen in Settings).
    cookies: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcOut {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
    stalled: bool,
    killed: bool,
}

#[derive(Clone, Serialize)]
struct ProcLine<'a> {
    id: &'a str,
    err: bool,
    line: &'a str,
}

fn procs() -> &'static Mutex<HashMap<String, Arc<Mutex<Child>>>> {
    static P: OnceLock<Mutex<HashMap<String, Arc<Mutex<Child>>>>> = OnceLock::new();
    P.get_or_init(|| Mutex::new(HashMap::new()))
}

fn killed_ids() -> &'static Mutex<HashSet<String>> {
    static K: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    K.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Stops a process and everything it started (yt-dlp's own helper process, ffmpeg, ...).
fn kill_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(unix)]
    {
        let _ = Command::new("kill").args(["-TERM", &format!("-{pid}")]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    #[cfg(windows)]
    {
        let mut c = Command::new("taskkill");
        c.args(["/PID", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut c);
        let _ = c.status();
    }
    let _ = child.kill();
}

/// Everything still running stops when Goblin quits.
pub fn kill_all() {
    let all: Vec<_> = procs().lock().map(|mut p| p.drain().map(|(_, c)| c).collect()).unwrap_or_default();
    for c in all {
        if let Ok(mut c) = c.lock() {
            kill_tree(&mut c);
        }
    }
}

fn valid_id(id: &str) -> bool {
    (1..=80).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

fn command_for(state: &AppState, req: &ProcReq) -> Result<(PathBuf, Vec<String>)> {
    match req.tool.as_str() {
        "yt-dlp" => {
            check_ytdlp_args(&req.args)?;
            let bin = ytdlp(state).ok_or_else(|| Error::msg("yt-dlp is not installed yet."))?;
            let mut a: Vec<String> = [
                "--ignore-config", "--no-colors", "--encoding", "utf-8", "--no-remote-components",
                "--socket-timeout", "20", "--retries", "5", "--fragment-retries", "10",
            ]
            .map(String::from)
            .to_vec();
            a.push("--cache-dir".into());
            a.push(state.dir.join("cache").join("yt-dlp").to_string_lossy().into_owned());
            if let Some(f) = ffmpeg(state, "ffmpeg") {
                a.extend(["--ffmpeg-location".into(), f.to_string_lossy().into_owned()]);
            }
            if let Some(d) = deno() {
                a.extend(["--no-js-runtimes".into(), "--js-runtimes".into(), format!("deno:{}", d.to_string_lossy())]);
            }
            if req.cookies == Some(true) {
                let file = cookies_file(state);
                if file.is_file() {
                    a.extend(["--cookies".into(), file.to_string_lossy().into_owned()]);
                } else if let Some(b) = state.settings()?.cookies_browser.filter(|b| crate::downloads::COOKIE_BROWSERS.contains(&b.as_str())) {
                    a.extend(["--cookies-from-browser".into(), b]);
                } else {
                    return Err(Error::msg("No YouTube sign-in is set up (Settings → YouTube sign-in)."));
                }
            }
            a.extend(req.args.iter().cloned());
            Ok((bin, a))
        }
        "ffmpeg" | "ffprobe" => {
            let bin = ffmpeg(state, &req.tool).ok_or_else(|| Error::msg(format!("{} is missing. Reinstall Goblin to get it back.", req.tool)))?;
            Ok((bin, req.args.clone()))
        }
        _ => Err(Error::msg("Unknown tool.")),
    }
}

/// Keeps the last `max` bytes of a growing text.
fn push_tail(buf: &mut String, line: &str, max: usize) {
    buf.push_str(line);
    buf.push('\n');
    if buf.len() > max {
        let mut cut = buf.len() - max;
        while !buf.is_char_boundary(cut) {
            cut += 1;
        }
        buf.drain(..cut);
    }
}

#[tauri::command]
pub async fn proc_run(app: AppHandle, req: ProcReq) -> Result<ProcOut> {
    if !valid_id(&req.id) {
        return Err(Error::msg("Bad process id."));
    }
    let (bin, args) = {
        let state = app.state::<AppState>();
        command_for(&state, &req)?
    };
    tauri::async_runtime::spawn_blocking(move || run_blocking(app, bin, args, req))
        .await
        .map_err(|e| Error::msg(e.to_string()))?
}

fn run_blocking(app: AppHandle, bin: PathBuf, args: Vec<String>, req: ProcReq) -> Result<ProcOut> {
    let mut cmd = Command::new(&bin);
    cmd.args(&args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.env("PYTHONIOENCODING", "utf-8").env("PYTHONUTF8", "1");
    hide_window(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| Error::msg(format!("Could not start {}: {e}", req.tool)))?;
    let stdout = child.stdout.take().ok_or_else(|| Error::msg("no output"))?;
    let stderr = child.stderr.take().ok_or_else(|| Error::msg("no output"))?;
    let child = Arc::new(Mutex::new(child));
    if let Ok(mut k) = killed_ids().lock() {
        k.remove(&req.id);
    }
    procs().lock().map_err(|_| Error::msg("internal error"))?.insert(req.id.clone(), child.clone());

    let stream = req.stream == Some(true);
    let last_output = Arc::new(Mutex::new(Instant::now()));

    let (app_o, id_o, seen_o) = (app.clone(), req.id.clone(), last_output.clone());
    let out_reader = std::thread::spawn(move || -> String {
        let mut tail = String::new();
        if stream {
            for line in BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
                if let Ok(mut t) = seen_o.lock() {
                    *t = Instant::now();
                }
                let _ = app_o.emit("proc-line", ProcLine { id: &id_o, err: false, line: &line });
                push_tail(&mut tail, &line, 64 * 1024);
            }
            tail
        } else {
            // Whole stdout (yt-dlp -J, ffprobe JSON), capped at 256 MB.
            let mut bytes = Vec::new();
            let _ = stdout.take(256 * 1024 * 1024).read_to_end(&mut bytes);
            String::from_utf8_lossy(&bytes).into_owned()
        }
    });
    let (app_e, id_e, seen_e) = (app.clone(), req.id.clone(), last_output.clone());
    let err_reader = std::thread::spawn(move || -> String {
        let mut tail = String::new();
        for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
            if let Ok(mut t) = seen_e.lock() {
                *t = Instant::now();
            }
            if stream {
                let _ = app_e.emit("proc-line", ProcLine { id: &id_e, err: true, line: &line });
            }
            push_tail(&mut tail, &line, 48 * 1024);
        }
        tail
    });

    let started = Instant::now();
    let timeout = req.timeout_sec.filter(|t| *t > 0).map(Duration::from_secs);
    let stall = req.stall_sec.filter(|t| *t > 0).map(Duration::from_secs);
    let (mut timed_out, mut stalled) = (false, false);
    let status = loop {
        let done = child.lock().map_err(|_| Error::msg("internal error"))?.try_wait()?;
        if let Some(s) = done {
            break Some(s);
        }
        if !procs().lock().map(|p| p.contains_key(&req.id)).unwrap_or(true) {
            // proc_kill already stopped it; wait for it to go away.
            break child.lock().ok().and_then(|mut c| c.wait().ok());
        }
        let quiet = last_output.lock().map(|t| t.elapsed()).unwrap_or_default();
        let over = timeout.map(|t| started.elapsed() > t).unwrap_or(false);
        let hung = stall.map(|s| quiet > s).unwrap_or(false);
        if over || hung {
            timed_out = over;
            stalled = hung && !over;
            if let Ok(mut c) = child.lock() {
                kill_tree(&mut c);
            }
            break child.lock().ok().and_then(|mut c| c.wait().ok());
        }
        std::thread::sleep(Duration::from_millis(80));
    };
    let stdout_text = out_reader.join().unwrap_or_default();
    let stderr_text = err_reader.join().unwrap_or_default();
    if let Ok(mut p) = procs().lock() {
        p.remove(&req.id);
    }
    let killed = killed_ids().lock().map(|mut k| k.remove(&req.id)).unwrap_or(false);
    Ok(ProcOut {
        code: status.and_then(|s| s.code()),
        stdout: stdout_text,
        stderr: stderr_text,
        timed_out,
        stalled,
        killed,
    })
}

#[tauri::command]
pub fn proc_kill(id: String) -> Result<()> {
    let job = procs().lock().map_err(|_| Error::msg("internal error"))?.remove(&id);
    if let Some(c) = job {
        if let Ok(mut k) = killed_ids().lock() {
            k.insert(id);
        }
        if let Ok(mut c) = c.lock() {
            kill_tree(&mut c);
        }
    }
    Ok(())
}

// ------------------------------------------------------------------ web requests

/// The only places Goblin talks to (besides yt-dlp itself and GitHub for updates).
const HOSTS: &[&str] = &[
    "musicbrainz.org", "coverartarchive.org", "archive.org", "lrclib.net", "api.deezer.com", "dzcdn.net",
    "itunes.apple.com", "mzstatic.com", "music.youtube.com", "ytimg.com", "googleusercontent.com", "ggpht.com",
];

pub fn allowed_url(raw: &str) -> Option<url::Url> {
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "https" || !u.username().is_empty() || u.password().is_some() || u.port().is_some() {
        return None;
    }
    let host = u.host_str()?.to_lowercase();
    HOSTS.iter().any(|h| host == *h || host.ends_with(&format!(".{h}"))).then_some(u)
}

fn web() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(45))
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                if attempt.previous().len() < 6 && allowed_url(attempt.url().as_str()).is_some() {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .expect("http client")
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpReq {
    method: Option<String>,
    url: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
}

#[derive(Serialize)]
pub struct HttpOut {
    status: u16,
    body: String,
}

const MAX_TEXT: usize = 24 * 1024 * 1024;
const MAX_FILE: usize = 40 * 1024 * 1024;

#[tauri::command]
pub async fn http_request(req: HttpReq) -> Result<HttpOut> {
    let url = allowed_url(&req.url).ok_or_else(|| Error::msg("Goblin doesn't talk to that website."))?;
    let mut r = match req.method.as_deref().unwrap_or("GET") {
        "POST" => web().post(url),
        "GET" => web().get(url),
        _ => return Err(Error::msg("Unsupported request.")),
    };
    r = r.header("User-Agent", concat!("Goblin/", env!("CARGO_PKG_VERSION"), " ( https://github.com/pugcadet/goblin )"));
    for (k, v) in req.headers.unwrap_or_default() {
        let lk = k.to_ascii_lowercase();
        if ["cookie", "authorization", "host"].contains(&lk.as_str()) {
            continue;
        }
        r = r.header(k, v);
    }
    if let Some(b) = req.body {
        r = r.body(b);
    }
    let resp = r.send().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    let status = resp.status().as_u16();
    let bytes = resp.bytes().await.map_err(|e| Error::Network(e.without_url().to_string()))?;
    if bytes.len() > MAX_TEXT {
        return Err(Error::msg("Unexpectedly large answer; stopped."));
    }
    Ok(HttpOut { status, body: String::from_utf8_lossy(&bytes).into_owned() })
}

/// Downloads a picture (cover art) into Goblin's temporary folder.
#[tauri::command]
pub async fn http_download(app: AppHandle, url: String, dest: String) -> Result<bool> {
    let tmp = {
        let state = app.state::<AppState>();
        resolved(&tmp_root(&state)).ok_or_else(|| Error::msg("internal error"))?
    };
    let target = resolved(Path::new(&dest)).filter(|d| d.starts_with(&tmp)).ok_or_else(|| Error::msg("Downloads go to Goblin's temporary folder only."))?;
    let Some(u) = allowed_url(&url) else { return Ok(false) };
    let resp = match web().get(u).header("User-Agent", concat!("Goblin/", env!("CARGO_PKG_VERSION"))).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return Ok(false),
    };
    let Ok(bytes) = resp.bytes().await else { return Ok(false) };
    if bytes.is_empty() || bytes.len() > MAX_FILE {
        return Ok(false);
    }
    if let Some(p) = target.parent() {
        std::fs::create_dir_all(p)?;
    }
    std::fs::write(&target, &bytes)?;
    Ok(true)
}

// ------------------------------------------------------------------ files

#[tauri::command]
pub fn work_dir(state: State<'_, AppState>, id: String) -> Result<String> {
    if !valid_id(&id) {
        return Err(Error::msg("Bad id."));
    }
    let d = tmp_root(&state).join(id);
    std::fs::create_dir_all(&d)?;
    Ok(d.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn work_clear(state: State<'_, AppState>, id: String) -> Result<()> {
    if !valid_id(&id) {
        return Err(Error::msg("Bad id."));
    }
    let _ = std::fs::remove_dir_all(tmp_root(&state).join(id));
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    path: String,
    name: String,
    dir: bool,
    size: u64,
}

/// What is in a work folder (the files yt-dlp just made).
#[tauri::command]
pub fn fs_list(state: State<'_, AppState>, path: String) -> Result<Vec<Entry>> {
    let p = allowed_path(&state, Path::new(&path))?;
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(&p) {
        for e in rd.flatten() {
            let md = e.metadata().ok();
            out.push(Entry {
                path: e.path().to_string_lossy().into_owned(),
                name: e.file_name().to_string_lossy().into_owned(),
                dir: md.as_ref().map(|m| m.is_dir()).unwrap_or(false),
                size: md.map(|m| m.len()).unwrap_or(0),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[tauri::command]
pub fn fs_exists(state: State<'_, AppState>, path: String) -> Result<bool> {
    let p = allowed_path(&state, Path::new(&path))?;
    Ok(p.exists())
}

#[tauri::command]
pub fn fs_size(state: State<'_, AppState>, path: String) -> Result<u64> {
    let p = allowed_path(&state, Path::new(&path))?;
    Ok(std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
}

/// "Name (2).ext" when the name is taken: nothing is ever overwritten.
pub fn unique(dst: &Path) -> PathBuf {
    if !dst.exists() {
        return dst.to_path_buf();
    }
    let stem = dst.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = dst.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    let dir = dst.parent().map(Path::to_path_buf).unwrap_or_default();
    (2..10_000).map(|n| dir.join(format!("{stem} ({n}){ext}"))).find(|p| !p.exists()).unwrap_or_else(|| dst.to_path_buf())
}

/// Moves a file into place (creating folders); returns where it ended up.
#[tauri::command]
pub fn fs_move(state: State<'_, AppState>, src: String, dst: String) -> Result<String> {
    let s = allowed_path(&state, Path::new(&src))?;
    let d = allowed_path(&state, Path::new(&dst))?;
    if let Some(parent) = d.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let target = unique(&d);
    if std::fs::rename(&s, &target).is_err() {
        // Across drives (or to a NAS share) a rename can fail: copy, then remove the original.
        if s.is_dir() {
            return Err(Error::msg("Could not move that folder."));
        }
        std::fs::copy(&s, &target)?;
        let _ = std::fs::remove_file(&s);
    }
    Ok(target.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn fs_mkdirs(state: State<'_, AppState>, path: String) -> Result<()> {
    let p = allowed_path(&state, Path::new(&path))?;
    std::fs::create_dir_all(p)?;
    Ok(())
}

/// To the Trash / Recycle Bin, never deleted outright.
#[tauri::command]
pub fn fs_trash(state: State<'_, AppState>, path: String) -> Result<()> {
    let p = allowed_path(&state, Path::new(&path))?;
    if roots(&state).iter().any(|r| *r == p) {
        return Err(Error::msg("Goblin won't trash a whole library folder."));
    }
    if p.exists() {
        trash::delete(&p).map_err(|e| Error::msg(format!("Could not move it to the Trash: {e}")))?;
    }
    Ok(())
}

const AUDIO: &[&str] = &["mp3", "m4a", "flac", "opus", "ogg", "wav", "aac", "alac"];

/// Every audio file in the given files/folders (Fix music, Find missing tracks), sorted, at most `limit`.
#[tauri::command]
pub fn fs_audio_files(state: State<'_, AppState>, paths: Vec<String>, limit: Option<usize>) -> Result<Vec<String>> {
    let limit = limit.unwrap_or(1000).min(20_000);
    let mut out = Vec::new();
    let mut stack: Vec<PathBuf> = Vec::new();
    for p in paths {
        stack.push(allowed_path(&state, Path::new(&p))?);
    }
    while let Some(p) = stack.pop() {
        if out.len() >= limit {
            break;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            if let Ok(rd) = std::fs::read_dir(&p) {
                stack.extend(rd.flatten().map(|e| e.path()));
            }
        } else if p.extension().map(|e| AUDIO.contains(&e.to_string_lossy().to_lowercase().as_str())).unwrap_or(false) {
            out.push(p.to_string_lossy().into_owned());
        }
    }
    out.sort();
    Ok(out)
}

/// Shows a file (or opens a folder) in Finder / Explorer.
#[tauri::command]
pub fn reveal(state: State<'_, AppState>, path: String) -> Result<()> {
    let p = allowed_path(&state, Path::new(&path))?;
    let select = p.is_file();
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        if select {
            c.arg("-R");
        }
        let _ = c.arg(&p).spawn();
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let s = p.to_string_lossy();
        let s = s.strip_prefix(r"\\?\").unwrap_or(&*s).to_string();
        let mut c = Command::new("explorer");
        if select {
            c.raw_arg(format!("/select,\"{s}\""));
        } else {
            c.arg(&s);
        }
        let _ = c.spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = if select { p.parent().map(Path::to_path_buf).unwrap_or(p.clone()) } else { p.clone() };
        let _ = Command::new("xdg-open").arg(dir).spawn();
        let _ = select;
    }
    Ok(())
}

/// Opens a web page in your browser (https only).
#[tauri::command]
pub fn open_url(url: String) -> Result<()> {
    let u = url::Url::parse(&url).map_err(|_| Error::msg("Not a web address."))?;
    if u.scheme() != "https" {
        return Err(Error::msg("Only https links are opened."));
    }
    let s = u.as_str().to_string();
    #[cfg(target_os = "macos")]
    let _ = Command::new("open").arg(&s).spawn();
    #[cfg(windows)]
    {
        let mut c = Command::new("explorer");
        c.arg(&s);
        let _ = c.spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    let _ = Command::new("xdg-open").arg(&s).spawn();
    Ok(())
}

// ------------------------------------------------------------------ Goblin's own files

fn store_name_ok(name: &str) -> bool {
    let ok_chars = (1..=80).contains(&name.len()) && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_' || c == '.');
    ok_chars && !name.starts_with('.') && (name.ends_with(".json") || name.ends_with(".txt")) && name != "settings.json"
}

#[tauri::command]
pub fn store_read(state: State<'_, AppState>, name: String) -> Result<Option<String>> {
    if !store_name_ok(&name) {
        return Err(Error::msg("Bad file name."));
    }
    Ok(std::fs::read_to_string(state.dir.join("data").join(name)).ok())
}

#[tauri::command]
pub fn store_write(state: State<'_, AppState>, name: String, text: String) -> Result<()> {
    if !store_name_ok(&name) {
        return Err(Error::msg("Bad file name."));
    }
    if text.len() > 64 * 1024 * 1024 {
        return Err(Error::msg("Too large."));
    }
    let dir = state.dir.join("data");
    std::fs::create_dir_all(&dir)?;
    let tmp = dir.join(format!("{name}.tmp"));
    std::fs::write(&tmp, text)?;
    std::fs::rename(tmp, dir.join(name))?;
    Ok(())
}

#[tauri::command]
pub fn store_delete(state: State<'_, AppState>, name: String) -> Result<()> {
    if !store_name_ok(&name) {
        return Err(Error::msg("Bad file name."));
    }
    let _ = std::fs::remove_file(state.dir.join("data").join(name));
    Ok(())
}

// ------------------------------------------------------------------ pickers

async fn pick(app: AppHandle, kind: &'static str) -> Result<Vec<PathBuf>> {
    let a = app.clone();
    let picked = tauri::async_runtime::spawn_blocking(move || -> Vec<PathBuf> {
        let d = a.dialog().file();
        let list = match kind {
            "folder" => d.blocking_pick_folder().map(|f| vec![f]).unwrap_or_default(),
            "folders" => d.blocking_pick_folders().unwrap_or_default(),
            "audio" => d.add_filter("Music", AUDIO).blocking_pick_files().unwrap_or_default(),
            "image" => d.add_filter("Pictures", &["jpg", "jpeg", "png", "webp"]).blocking_pick_file().map(|f| vec![f]).unwrap_or_default(),
            "cookies" => d.add_filter("cookies.txt", &["txt"]).blocking_pick_file().map(|f| vec![f]).unwrap_or_default(),
            _ => Vec::new(),
        };
        list.into_iter().filter_map(|f| f.into_path().ok()).collect()
    })
    .await
    .map_err(|e| Error::msg(e.to_string()))?;
    Ok(picked)
}

/// Picks folders ("folder", "folders") or music files ("audio"); what you pick may be used by Goblin from then on.
#[tauri::command]
pub async fn pick_paths(app: AppHandle, kind: String) -> Result<Vec<String>> {
    let kind: &'static str = match kind.as_str() {
        "folder" => "folder",
        "folders" => "folders",
        "audio" => "audio",
        _ => return Err(Error::msg("Unknown picker.")),
    };
    let picked = pick(app.clone(), kind).await?;
    let state = app.state::<AppState>();
    for p in &picked {
        grant(&state, p)?;
    }
    Ok(picked.into_iter().map(|p| p.to_string_lossy().into_owned()).collect())
}

/// Your own cover picture: copied into Goblin's temporary folder, so the original is never touched.
#[tauri::command]
pub async fn pick_image(app: AppHandle) -> Result<Option<String>> {
    let picked = pick(app.clone(), "image").await?;
    let Some(src) = picked.into_iter().next() else { return Ok(None) };
    let state = app.state::<AppState>();
    let dir = tmp_root(&state).join("covers");
    std::fs::create_dir_all(&dir)?;
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_else(|| "jpg".into());
    let n = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0);
    let dst = dir.join(format!("cover-{n}.{ext}"));
    std::fs::copy(&src, &dst)?;
    Ok(Some(dst.to_string_lossy().into_owned()))
}

#[derive(Serialize)]
pub struct CookieState {
    loaded: bool,
    name: String,
}

fn cookie_state(state: &AppState) -> Result<CookieState> {
    let s = state.settings()?;
    Ok(CookieState { loaded: cookies_file(state).is_file(), name: s.cookies_name.unwrap_or_else(|| "cookies.txt".into()) })
}

#[tauri::command]
pub fn cookies_info(state: State<'_, AppState>) -> Result<CookieState> {
    cookie_state(&state)
}

/// Loads a cookies.txt (Netscape format) into Goblin's own copy.
#[tauri::command]
pub async fn cookies_load(app: AppHandle) -> Result<CookieState> {
    let picked = pick(app.clone(), "cookies").await?;
    let state = app.state::<AppState>();
    if let Some(src) = picked.into_iter().next() {
        let text = std::fs::read_to_string(&src).map_err(|_| Error::msg("That file could not be read."))?;
        let looks_ok = text.lines().any(|l| l.starts_with("# Netscape") || l.split('\t').count() >= 7);
        if !looks_ok || text.len() > 4 * 1024 * 1024 {
            return Err(Error::msg("That doesn't look like a cookies.txt file (Netscape format)."));
        }
        std::fs::write(cookies_file(&state), text)?;
        let name = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "cookies.txt".into());
        state.update_settings(move |s| s.cookies_name = Some(name))?;
    }
    cookie_state(&state)
}

#[tauri::command]
pub fn cookies_delete(state: State<'_, AppState>) -> Result<CookieState> {
    let _ = std::fs::remove_file(cookies_file(&state));
    cookie_state(&state)
}

// ------------------------------------------------------------------ lyrics inside MP3s

/// Inserts a USLT frame (lyrics, UTF-16) into an MP3's ID3v2.3/2.4 tag. ffmpeg can't write a real USLT frame.
/// The LRC timestamps stay in the text, which Jellyfin reads as synced lyrics. Does nothing without an ID3v2 tag.
pub fn add_lyrics_bytes(d: &[u8], text: &str) -> Option<Vec<u8>> {
    if d.len() <= 10 || &d[0..3] != b"ID3" || !(d[3] == 3 || d[3] == 4) || d[5] & 0x40 != 0 {
        return None;
    }
    let v4 = d[3] == 4;
    let syncsafe = |b: &[u8]| b.iter().fold(0usize, |a, x| (a << 7) | (*x as usize & 0x7f));
    let size = syncsafe(&d[6..10]);
    if 10 + size > d.len() {
        return None;
    }
    let mut body = vec![0x01u8];
    body.extend_from_slice(b"eng");
    body.extend_from_slice(&[0xFF, 0xFE, 0x00, 0x00]); // empty description
    body.extend_from_slice(&[0xFF, 0xFE]);
    for u in text.encode_utf16() {
        body.extend_from_slice(&u.to_le_bytes());
    }
    let n = body.len();
    let mut frame = b"USLT".to_vec();
    if v4 {
        frame.extend_from_slice(&[((n >> 21) & 0x7f) as u8, ((n >> 14) & 0x7f) as u8, ((n >> 7) & 0x7f) as u8, (n & 0x7f) as u8]);
    } else {
        frame.extend_from_slice(&(n as u32).to_be_bytes());
    }
    frame.extend_from_slice(&[0, 0]);
    frame.extend_from_slice(&body);
    let new_size = size + frame.len();
    if new_size >= 1 << 28 {
        return None;
    }
    let mut out = d[0..6].to_vec();
    out.extend_from_slice(&[((new_size >> 21) & 0x7f) as u8, ((new_size >> 14) & 0x7f) as u8, ((new_size >> 7) & 0x7f) as u8, (new_size & 0x7f) as u8]);
    out.extend_from_slice(&frame);
    out.extend_from_slice(&d[10..]);
    Some(out)
}

#[tauri::command]
pub fn mp3_add_lyrics(state: State<'_, AppState>, path: String, text: String) -> Result<bool> {
    let p = allowed_path(&state, Path::new(&path))?;
    let d = std::fs::read(&p)?;
    match add_lyrics_bytes(&d, &text) {
        Some(out) => {
            std::fs::write(&p, out)?;
            Ok(true)
        }
        None => Ok(false),
    }
}

// ------------------------------------------------------------------ goblin:// links (bookmarklet)

fn pending_links() -> &'static Mutex<Vec<String>> {
    static L: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Vec::new()))
}

/// "goblin://add?url=<link>[&preset=<id>]" → the link (and preset), for the window.
pub fn read_link(raw: &str) -> Option<String> {
    let u = url::Url::parse(raw).ok()?;
    if u.scheme() != "goblin" {
        return None;
    }
    let link = u.query_pairs().find(|(k, _)| k == "url").map(|(_, v)| v.into_owned())?;
    let parsed = url::Url::parse(&link).ok()?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return None;
    }
    let preset = u.query_pairs().find(|(k, _)| k == "preset").map(|(_, v)| v.into_owned()).unwrap_or_default();
    Some(serde_json::json!({ "url": link, "preset": preset }).to_string())
}

pub fn incoming_links(app: &AppHandle, urls: Vec<String>) {
    let found: Vec<String> = urls.iter().filter_map(|u| read_link(u)).collect();
    if found.is_empty() {
        return;
    }
    if let Ok(mut p) = pending_links().lock() {
        p.extend(found.iter().cloned());
    }
    let _ = app.emit("goblin-link", ());
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Links that arrived through goblin:// (each one handed out once).
#[tauri::command]
pub fn links_take() -> Vec<String> {
    pending_links().lock().map(|mut p| std::mem::take(&mut *p)).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_dangerous_ytdlp_options() {
        let ok: Vec<String> = ["-J", "--flat-playlist", "--", "--exec"].map(String::from).to_vec();
        assert!(check_ytdlp_args(&ok).is_ok(), "after -- it's an address");
        for bad in ["--exec", "--exec=rm", "--netrc-cmd", "--external-downloader", "--plugin-dirs", "--cookies", "--config-location"] {
            assert!(check_ytdlp_args(&[bad.to_string(), "x".into()]).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_known_websites() {
        assert!(allowed_url("https://musicbrainz.org/ws/2/recording?query=x").is_some());
        assert!(allowed_url("https://ia800.us.archive.org/x.jpg").is_some());
        assert!(allowed_url("https://lh3.googleusercontent.com/abc=w1200").is_some());
        assert!(allowed_url("http://musicbrainz.org/").is_none(), "https only");
        assert!(allowed_url("https://evil.example/musicbrainz.org").is_none());
        assert!(allowed_url("https://musicbrainz.org.evil.example/").is_none());
        assert!(allowed_url("https://user:pw@musicbrainz.org/").is_none());
    }

    #[test]
    fn paths_never_climb_out() {
        assert!(clean_abs(Path::new("/a/b/../c")).is_none());
        assert_eq!(clean_abs(Path::new("/a/./b")).unwrap(), PathBuf::from("/a/b"));
        assert!(clean_abs(Path::new("relative/x")).is_none());
    }

    #[test]
    fn store_names() {
        assert!(store_name_ok("history.json"));
        assert!(store_name_ok("seen-abc123.txt"));
        assert!(!store_name_ok("../x.json"));
        assert!(!store_name_ok("settings.json"), "Rust's own settings are not the window's to write");
        assert!(!store_name_ok("x.exe"));
    }

    #[test]
    fn bookmarklet_links() {
        let l = read_link("goblin://add?url=https%3A%2F%2Fyoutu.be%2Fabc&preset=music").unwrap();
        assert!(l.contains("https://youtu.be/abc") && l.contains("music"));
        assert!(read_link("goblin://add?url=file%3A%2F%2F%2Fetc%2Fpasswd").is_none());
        assert!(read_link("https://add?url=https://x.y").is_none());
    }

    #[test]
    fn lyrics_frame() {
        // Minimal ID3v2.3 tag with no frames + 2 bytes of "audio".
        let mut f = b"ID3\x03\x00\x00\x00\x00\x00\x00".to_vec();
        f.extend_from_slice(&[0xFF, 0xFB]);
        let out = add_lyrics_bytes(&f, "[00:01.00]hi").unwrap();
        assert_eq!(&out[10..14], b"USLT");
        assert!(out.ends_with(&[0xFF, 0xFB]));
        assert!(add_lyrics_bytes(b"not an mp3 at all", "x").is_none());
    }

    #[test]
    fn unique_names() {
        let d = std::env::temp_dir().join(format!("goblin-uniq-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.mp3"), b"x").unwrap();
        assert_eq!(unique(&d.join("a.mp3")), d.join("a (2).mp3"));
        assert_eq!(unique(&d.join("b.mp3")), d.join("b.mp3"));
        std::fs::remove_dir_all(&d).unwrap();
    }
}
