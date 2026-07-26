mod geometry;
mod lifecycle;

use geometry::{clamp_logical_height, corner_origin, Point, Size, WorkArea};
use lifecycle::{
    close_request_recovery, internal_intent_from_args, observe_handler_result,
    report_handler_failure, target_visibility, window_intent, CloseRequestRecovery, HostEvent,
    InternalIntent, WindowIntent,
};
use serde::Serialize;
use std::{
    ffi::{CStr, OsStr},
    fs::OpenOptions,
    io::Read,
    mem,
    os::unix::{ffi::OsStrExt, fs::OpenOptionsExt},
    path::{Path, PathBuf},
    ptr,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewWindow, WindowEvent,
};

const CORNER_LABEL: &str = "corner";
const SHOW_MENU_ID: &str = "show-corner";
const HIDE_MENU_ID: &str = "hide-corner";
const QUIT_MENU_ID: &str = "quit-visual-host";
const CORNER_COMPACT_WIDTH: f64 = 360.0;
const CORNER_COMPACT_HEIGHT: f64 = 126.0;
const CORNER_EXPANDED_HEIGHT: f64 = 620.0;
const CORNER_SIGNAL_MAX_BYTES: u64 = 1_048_576;
const CORNER_SIGNAL_FILE: &str = "corner-signal-v1.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeHostFacts {
    version: String,
    platform: String,
    arch: String,
    window_visible: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectionReadV1 {
    schema_version: u8,
    availability: &'static str,
    contents: Option<String>,
    reason: Option<String>,
}

fn facts(version: &str, window_visible: bool) -> NativeHostFacts {
    NativeHostFacts {
        version: version.to_owned(),
        platform: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        window_visible,
    }
}

fn corner_window<R: Runtime>(manager: &impl Manager<R>) -> Result<WebviewWindow<R>, String> {
    manager
        .get_webview_window(CORNER_LABEL)
        .ok_or_else(|| "The VibeHub corner window is unavailable.".to_owned())
}

fn reposition_to_corner<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No visible monitor work area is available.".to_owned())?;
    let work = monitor.work_area();
    let window_size = window.outer_size().map_err(|error| error.to_string())?;
    let origin = corner_origin(
        WorkArea {
            origin: Point {
                x: work.position.x,
                y: work.position.y,
            },
            size: Size {
                width: work.size.width,
                height: work.size.height,
            },
        },
        Size {
            width: window_size.width,
            height: window_size.height,
        },
        16,
    );
    window
        .set_position(PhysicalPosition::new(origin.x, origin.y))
        .map_err(|error| error.to_string())
}

fn corner_signal_path(home: &Path) -> PathBuf {
    home.join("Library")
        .join("Application Support")
        .join("VibeHub")
        .join(CORNER_SIGNAL_FILE)
}

fn unavailable(reason: String) -> ProjectionReadV1 {
    ProjectionReadV1 {
        schema_version: 1,
        availability: "unavailable",
        contents: None,
        reason: Some(reason),
    }
}

fn effective_user_home() -> Result<PathBuf, String> {
    let uid = unsafe { libc::geteuid() };
    let suggested = unsafe { libc::sysconf(libc::_SC_GETPW_R_SIZE_MAX) };
    let size = if suggested > 0 {
        usize::try_from(suggested).unwrap_or(16_384).max(1_024)
    } else {
        16_384
    };
    let mut buffer = vec![0_u8; size];
    let mut password: libc::passwd = unsafe { mem::zeroed() };
    let mut result = ptr::null_mut();
    let status = unsafe {
        libc::getpwuid_r(
            uid,
            &mut password,
            buffer.as_mut_ptr().cast(),
            buffer.len(),
            &mut result,
        )
    };
    if status != 0 || result.is_null() || password.pw_dir.is_null() {
        return Err(format!(
            "Effective-user home lookup failed for uid {uid} with status {status}."
        ));
    }
    let bytes = unsafe { CStr::from_ptr(password.pw_dir) }.to_bytes();
    Ok(PathBuf::from(OsStr::from_bytes(bytes)))
}

fn read_corner_signal_file(path: &Path) -> ProjectionReadV1 {
    let mut file = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
    {
        Ok(value) => value,
        Err(error) => {
            return unavailable(format!(
                "Corner Signal projection is unavailable at {}: {error}",
                path.display()
            ));
        }
    };
    let metadata = match file.metadata() {
        Ok(value) => value,
        Err(error) => {
            return unavailable(format!("Corner Signal metadata is unavailable: {error}"))
        }
    };
    if !metadata.is_file() {
        return unavailable(format!(
            "Corner Signal projection path is not a regular file: {}",
            path.display()
        ));
    }
    let mut bytes = Vec::with_capacity((CORNER_SIGNAL_MAX_BYTES + 1) as usize);
    if let Err(error) = file
        .by_ref()
        .take(CORNER_SIGNAL_MAX_BYTES + 1)
        .read_to_end(&mut bytes)
    {
        return unavailable(format!(
            "Corner Signal projection could not be read: {error}"
        ));
    }
    if bytes.len() as u64 > CORNER_SIGNAL_MAX_BYTES {
        return unavailable(format!(
            "Corner Signal projection exceeds the {} byte read limit.",
            CORNER_SIGNAL_MAX_BYTES
        ));
    }
    match String::from_utf8(bytes) {
        Ok(contents) => ProjectionReadV1 {
            schema_version: 1,
            availability: "available",
            contents: Some(contents),
            reason: None,
        },
        Err(error) => unavailable(format!(
            "Corner Signal projection is not valid UTF-8: {error}"
        )),
    }
}

fn apply_window_intent<R: Runtime>(
    window: &WebviewWindow<R>,
    intent: WindowIntent,
    focus_when_shown: bool,
) -> Result<(), String> {
    if target_visibility(intent) {
        reposition_to_corner(window)?;
        window.show().map_err(|error| error.to_string())?;
        if focus_when_shown {
            window.set_focus().map_err(|error| error.to_string())?;
        }
    } else {
        window.hide().map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn native_host_facts(app: AppHandle) -> Result<NativeHostFacts, String> {
    let window = corner_window(&app)?;
    let visible = window.is_visible().map_err(|error| error.to_string())?;
    Ok(facts(&app.package_info().version.to_string(), visible))
}

#[tauri::command]
fn read_corner_signal() -> ProjectionReadV1 {
    match effective_user_home() {
        Ok(home) => read_corner_signal_file(&corner_signal_path(&home)),
        Err(error) => unavailable(error),
    }
}

#[tauri::command]
fn show_corner(app: AppHandle) -> Result<(), String> {
    apply_window_intent(&corner_window(&app)?, WindowIntent::Show, true)
}

#[tauri::command]
fn hide_corner(app: AppHandle) -> Result<(), String> {
    apply_window_intent(&corner_window(&app)?, WindowIntent::Hide, false)
}

#[tauri::command]
fn set_corner_expanded(app: AppHandle, expanded: bool) -> Result<(), String> {
    let window = corner_window(&app)?;
    let previous_size = window.outer_size().map_err(|error| error.to_string())?;
    let requested = if expanded {
        CORNER_EXPANDED_HEIGHT
    } else {
        CORNER_COMPACT_HEIGHT
    };
    let monitor = window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten())
        .ok_or_else(|| "No visible monitor work area is available.".to_owned())?;
    let height = clamp_logical_height(
        requested,
        CORNER_COMPACT_HEIGHT,
        monitor.work_area().size.height,
        monitor.scale_factor(),
    );
    window
        .set_size(LogicalSize::new(CORNER_COMPACT_WIDTH, height))
        .map_err(|error| error.to_string())?;
    if let Err(position_error) = reposition_to_corner(&window) {
        return match window.set_size(previous_size) {
            Ok(()) => Err(position_error),
            Err(rollback_error) => Err(format!(
                "{position_error}; restoring the previous window size also failed: {rollback_error}"
            )),
        };
    }
    Ok(())
}

#[tauri::command]
fn quit_visual_host(app: AppHandle) {
    app.exit(0);
}

fn apply_internal_intent(app: AppHandle, intent: InternalIntent, event: HostEvent) {
    match intent {
        InternalIntent::Show => {
            let result = show_corner(app.clone()).and_then(|_| {
                corner_window(&app)?
                    .eval("window.dispatchEvent(new Event('vibehub:projection-refresh'))")
                    .map_err(|error| error.to_string())
            });
            observe_handler_result(event, result);
        }
        InternalIntent::Quit => app.exit(0),
    }
}

fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, SHOW_MENU_ID, "Show Corner", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, HIDE_MENU_ID, "Hide Corner", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, QUIT_MENU_ID, "Quit Visual Host", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &quit])?;
    TrayIconBuilder::with_id("vibehub-visual-host")
        .title("VH")
        .tooltip("VibeHub Visual Host")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            SHOW_MENU_ID => {
                observe_handler_result(HostEvent::TrayShow, show_corner(app.clone()));
            }
            HIDE_MENU_ID => {
                observe_handler_result(HostEvent::TrayHide, hide_corner(app.clone()));
            }
            QUIT_MENU_ID => {
                debug_assert_eq!(window_intent(HostEvent::TrayQuit), None);
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        // Tauri plugins initialize in registration order; single-instance must be first.
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if let Some(intent) = internal_intent_from_args(&args) {
                apply_internal_intent(app.clone(), intent, HostEvent::SingleInstanceWake);
            }
        }))
        .invoke_handler(tauri::generate_handler![
            native_host_facts,
            read_corner_signal,
            show_corner,
            hide_corner,
            set_corner_expanded,
            quit_visual_host
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);
            setup_tray(app)?;
            if let Some(intent) =
                internal_intent_from_args(&std::env::args().collect::<Vec<String>>())
            {
                apply_internal_intent(app.handle().clone(), intent, HostEvent::InitialShow);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == CORNER_LABEL {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    let intent = window_intent(HostEvent::CloseRequested)
                        .expect("close requests always have a window intent");
                    debug_assert!(!target_visibility(intent));
                    match close_request_recovery(window.hide().map_err(|error| error.to_string())) {
                        CloseRequestRecovery::PreventCloseAfterHide => api.prevent_close(),
                        CloseRequestRecovery::TerminateHost {
                            exit_code,
                            operation,
                            message,
                        } => {
                            report_handler_failure(operation, &message);
                            window.app_handle().exit(exit_code);
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("VibeHub visual host failed");
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn native_facts_are_host_only_and_truthful() {
        let value = facts("0.1.0", false);
        assert_eq!(value.version, "0.1.0");
        assert_eq!(value.platform, "macos");
        assert_eq!(value.arch, "aarch64");
        assert!(!value.window_visible);
    }

    #[test]
    fn stable_projection_path_is_not_caller_controlled() {
        assert_eq!(
            corner_signal_path(Path::new("/Users/tester")),
            PathBuf::from(
                "/Users/tester/Library/Application Support/VibeHub/corner-signal-v1.json"
            )
        );
    }

    #[test]
    fn projection_reader_reports_missing_and_reads_only_bounded_utf8() {
        let root =
            std::env::temp_dir().join(format!("vibehub-corner-signal-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create test projection directory");
        let target = root.join(CORNER_SIGNAL_FILE);
        let missing = read_corner_signal_file(&target);
        assert_eq!(missing.availability, "unavailable");
        assert_eq!(missing.contents, None);

        fs::write(&target, "{\"schemaVersion\":1}\n").expect("write projection");
        let available = read_corner_signal_file(&target);
        assert_eq!(available.availability, "available");
        assert_eq!(
            available.contents.as_deref(),
            Some("{\"schemaVersion\":1}\n")
        );

        fs::write(&target, vec![b'x'; (CORNER_SIGNAL_MAX_BYTES + 1) as usize])
            .expect("write oversized projection");
        assert_eq!(read_corner_signal_file(&target).availability, "unavailable");

        fs::write(&target, [0xff, 0xfe]).expect("write invalid utf8");
        assert_eq!(read_corner_signal_file(&target).availability, "unavailable");

        let real = root.join("real.json");
        fs::write(&real, "{}").expect("write symlink target");
        let link = root.join("link.json");
        std::os::unix::fs::symlink(&real, &link).expect("create projection symlink");
        assert_eq!(read_corner_signal_file(&link).availability, "unavailable");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn effective_home_ignores_spoofed_home_environment() {
        let before = effective_user_home().expect("resolve effective-user home");
        let previous = std::env::var_os("HOME");
        std::env::set_var("HOME", "/tmp/spoofed-vibehub-home");
        let after = effective_user_home().expect("resolve effective-user home again");
        match previous {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }
        assert_eq!(after, before);
        assert_ne!(after, PathBuf::from("/tmp/spoofed-vibehub-home"));
    }
}
