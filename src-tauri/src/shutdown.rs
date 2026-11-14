use crate::sidecar::SidecarSupervisor;
use reqwest::{redirect::Policy, Client};
use serde::Deserialize;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use std::time::Duration;
use tauri::{AppHandle, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

#[derive(Default)]
struct CloseState {
    in_progress: AtomicBool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivityHealth {
    ok: bool,
    product: String,
    version: String,
    instance: String,
    pid: u32,
    active_browser_count: usize,
}

fn verified_activity_count(bytes: &[u8], instance: &str, pid: u32) -> Result<usize, String> {
    let record: ActivityHealth = serde_json::from_slice(bytes)
        .map_err(|_| "profile activity is unavailable".to_owned())?;
    if !record.ok || record.product != "StakeMode" || record.version != env!("CARGO_PKG_VERSION")
        || record.instance != instance || record.pid != pid || record.active_browser_count > 256
    {
        return Err("profile activity did not match the owned desktop instance".to_owned());
    }
    Ok(record.active_browser_count)
}

async fn active_browser_count(origin: &str, sidecar: &SidecarSupervisor) -> Result<usize, String> {
    let client = Client::builder()
        .no_proxy()
        .redirect(Policy::none())
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(format!("{origin}/ui/api/health"))
        .send()
        .await
        .map_err(|error| error.to_string())?;
    if !response.status().is_success() || response.content_length().unwrap_or(0) > 65536 {
        return Err("profile activity is unavailable".to_owned());
    }
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() > 65536 {
        return Err("profile activity is unavailable".to_owned());
    }
    verified_activity_count(&bytes, sidecar.instance_nonce(), sidecar.pid())
}

#[derive(Clone, Copy)]
enum CleanupAction {
    Exit,
    Restart,
}

pub(crate) async fn graceful_sidecar_cleanup(sidecar: &SidecarSupervisor) -> Result<(), String> {
    sidecar.request_shutdown()?;
    sidecar.wait_for_shutdown().await
}

pub(crate) fn exit_after_cleanup_failure(
    app: AppHandle,
    sidecar: &SidecarSupervisor,
    error: String,
) {
    exit_after_cleanup_failure_message(
        app,
        sidecar,
        "StakeMode shutdown failed",
        format!("StakeMode could not confirm safe browser cleanup. {error}"),
    );
}

pub(crate) fn exit_after_update_cleanup_failure(
    app: AppHandle,
    sidecar: &SidecarSupervisor,
    error: String,
) {
    exit_after_cleanup_failure_message(
        app,
        sidecar,
        "StakeMode update not installed",
        format!(
            "StakeMode could not confirm safe browser cleanup, so the update was not installed. The current version remains installed. {error}"
        ),
    );
}

fn exit_after_cleanup_failure_message(
    app: AppHandle,
    sidecar: &SidecarSupervisor,
    title: &str,
    message: String,
) {
    let _ = sidecar.kill_owned();
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(move |_| app.exit(1));
}

fn finish_after_cleanup(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    action: CleanupAction,
) {
    let _ = window.hide();
    tauri::async_runtime::spawn(async move {
        match graceful_sidecar_cleanup(&sidecar).await {
            Ok(()) => match action {
                CleanupAction::Exit => app.exit(0),
                CleanupAction::Restart => app.request_restart(),
            },
            Err(error) => exit_after_cleanup_failure(app, &sidecar, error),
        }
    });
}

#[tauri::command]
pub fn restart_after_mode_change(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: tauri::State<'_, SidecarSupervisor>,
) {
    finish_after_cleanup(app, window, sidecar.inner().clone(), CleanupAction::Restart);
}

fn ask_to_close(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    state: Arc<CloseState>,
    active: Result<usize, String>,
) {
    let message = match active {
        Ok(count) => format!(
            "{count} browser session{} active. StakeMode will save session state and close the browser{} before exiting.",
            if count == 1 { " is" } else { "s are" },
            if count == 1 { "" } else { "s" },
        ),
        Err(_) => "Browser activity could not be confirmed. StakeMode will save session state and close any active browsers before exiting.".to_owned(),
    };
    app.dialog()
        .message(message)
        .title("Close StakeMode?")
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::YesNo)
        .show(move |confirmed| {
            if confirmed {
                finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
            } else {
                state.in_progress.store(false, Ordering::Release);
            }
        });
}

pub fn install_close_handler(
    app: AppHandle,
    window: WebviewWindow,
    sidecar: SidecarSupervisor,
    origin: String,
) {
    let state = Arc::new(CloseState::default());
    window.clone().on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if state.in_progress.swap(true, Ordering::AcqRel) {
                return;
            }
            let app = app.clone();
            let window = window.clone();
            let sidecar = sidecar.clone();
            let state = state.clone();
            let origin = origin.clone();
            tauri::async_runtime::spawn(async move {
                let active = active_browser_count(&origin, &sidecar).await;
                if matches!(active, Ok(0)) {
                    finish_after_cleanup(app, window, sidecar, CleanupAction::Exit);
                } else {
                    ask_to_close(app, window, sidecar, state, active);
                }
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::verified_activity_count;

    #[test]
    fn activity_health_is_bound_to_the_owned_sidecar_and_product() {
        let health = serde_json::json!({"ok":true,"product":"StakeMode","version":env!("CARGO_PKG_VERSION"),"instance":"owned-nonce","pid":42,"activeBrowserCount":2});
        let bytes = serde_json::to_vec(&health).unwrap();
        assert_eq!(verified_activity_count(&bytes, "owned-nonce", 42).unwrap(), 2);
        assert!(verified_activity_count(&bytes, "other-nonce", 42).is_err());
        assert!(verified_activity_count(&bytes, "owned-nonce", 43).is_err());
        for (key, value) in [("product", serde_json::json!("other")), ("version", serde_json::json!("0.0.0")), ("ok", serde_json::json!(false)), ("activeBrowserCount", serde_json::json!(257))] {
            let mut changed = health.clone(); changed[key] = value;
            assert!(verified_activity_count(&serde_json::to_vec(&changed).unwrap(), "owned-nonce", 42).is_err());
        }
        assert!(verified_activity_count(br#"{"profiles":[]}"#, "owned-nonce", 42).is_err());
    }
}
