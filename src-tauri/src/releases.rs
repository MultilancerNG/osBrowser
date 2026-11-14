//! StakeMode preview updates are manual and come only from the private project release page.
//! No upstream AliasMode updater endpoint or signing key is used by this product.

use crate::update_attempt::LastUpdateResult;

pub const MANUAL_RELEASE_URL: &str =
    "https://github.com/solomongs/AliasMode-Game/releases";
const MANUAL_UPDATE_MESSAGE: &str =
    "StakeMode preview updates are installed manually from https://github.com/solomongs/AliasMode-Game/releases. Download the StakeMode installer, close the application, and install it over the existing version.";

#[derive(Default)]
pub struct UpdateCoordinator;

#[tauri::command]
pub async fn check_for_updates() -> Result<serde_json::Value, String> {
    Err(MANUAL_UPDATE_MESSAGE.to_owned())
}

#[tauri::command]
pub fn last_update_result() -> Result<Option<LastUpdateResult>, String> {
    Ok(None)
}

#[tauri::command]
pub async fn update_now() -> Result<(), String> {
    Err(MANUAL_UPDATE_MESSAGE.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_updates_use_the_project_release_page() {
        assert_eq!(MANUAL_RELEASE_URL, "https://github.com/solomongs/AliasMode-Game/releases");
        assert!(MANUAL_UPDATE_MESSAGE.contains(MANUAL_RELEASE_URL));
        assert!(MANUAL_UPDATE_MESSAGE.contains("StakeMode installer"));
        assert_eq!(last_update_result().unwrap(), None);
    }
}
