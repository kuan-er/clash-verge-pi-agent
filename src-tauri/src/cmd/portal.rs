use super::{CmdResult, coded_error};
use crate::{
    config::{Config, IVerge, PrfItem, PrfOption, profiles},
    core::{handle, timer::Timer},
    feat,
    utils::{dirs, server},
};
use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::time::Duration;
use tauri::Url;
use tokio::fs;

const PORTAL_URL: &str = "https://154.40.137.121:8443";

#[derive(Deserialize, Serialize)]
struct Account {
    token: String,
}

fn client() -> Result<reqwest::Client> {
    Ok(reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()?)
}

fn subscription_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw)?;
    if url.origin() != Url::parse(PORTAL_URL)?.origin()
        || url.path() != "/subscription.yaml"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !url
            .query_pairs()
            .any(|(key, value)| key == "token" && value.len() == 43)
    {
        bail!("Use your personal configuration from the pash user portal.");
    }
    Ok(url)
}

async fn store_account(token: &str) -> Result<()> {
    let path = dirs::app_home_dir()?.join("pash-account.json");
    let temporary = path.with_extension("json.tmp");
    let mut options = fs::OpenOptions::new();
    options.create(true).truncate(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&temporary).await?;
    use tokio::io::AsyncWriteExt as _;
    file.write_all(&serde_json::to_vec(&Account {
        token: token.to_owned(),
    })?)
    .await?;
    file.sync_all().await?;
    fs::rename(temporary, path).await?;
    Ok(())
}

pub(crate) async fn activate_portal_profile(raw: &str) -> Result<()> {
    let url = subscription_url(raw)?;
    for _ in 0..60 {
        if server::commands_ready() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    if !server::commands_ready() {
        bail!("pash is still starting. Try activating your configuration again.");
    }
    let existing = Config::profiles()
        .await
        .latest_arc()
        .items
        .as_ref()
        .and_then(|items| items.iter().find(|item| item.url.as_deref() == Some(url.as_str())))
        .and_then(|item| item.uid.clone());
    let uid = if let Some(uid) = existing {
        super::profile::update_profile(uid.clone(), None)
            .await
            .map_err(|error| anyhow::anyhow!(error.detail))?;
        uid
    } else {
        let mut item = PrfItem::from_url(
            url.as_str(),
            Some(&"pash 美国".into()),
            None,
            Some(&PrfOption {
                with_proxy: Some(false),
                allow_auto_update: Some(true),
                update_interval: Some(1440),
                timeout_seconds: Some(20),
                ..Default::default()
            }),
        )
        .await
        .map_err(|_| anyhow::anyhow!("Unable to retrieve your personal pash configuration"))?;
        profiles::profiles_append_item_safe(&mut item).await?;
        profiles::profiles_save_file_safe().await?;
        item.uid.context("Imported profile has no ID")?
    };
    let outcome = super::profile::patch_profiles_config_by_profile_index(uid.clone())
        .await
        .map_err(|error| anyhow::anyhow!(error.detail))?;
    if !outcome.is_valid() {
        bail!("The network configuration could not be activated: {outcome}");
    }
    feat::patch_verge(
        &IVerge {
            enable_system_proxy: Some(true),
            ..Default::default()
        },
        false,
    )
    .await?;
    Timer::global().refresh().await?;
    handle::Handle::notify_profile_changed(&uid);
    handle::Handle::refresh_clash();
    handle::Handle::refresh_verge();
    Ok(())
}

#[tauri::command]
pub async fn portal_login(username: String, password: String) -> CmdResult<Value> {
    if username.len() > 64 || password.len() > 256 {
        return Err(coded_error("PORTAL_LOGIN_FAILED", "用户名或密码格式有误"));
    }
    let response = client()
        .map_err(|_| coded_error("PORTAL_LOGIN_FAILED", "无法连接用户平台"))?
        .post(format!("{PORTAL_URL}/api/client/login"))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await
        .map_err(|_| coded_error("PORTAL_LOGIN_FAILED", "无法连接用户平台，请检查网络后重试"))?;
    if !response.status().is_success() {
        return Err(coded_error("PORTAL_LOGIN_FAILED", "登录失败，请检查密码和账户状态"));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| coded_error("PORTAL_LOGIN_FAILED", "用户平台响应有误"))?;
    let url = data["subscriptionUrl"]
        .as_str()
        .ok_or_else(|| coded_error("PORTAL_LOGIN_FAILED", "个人配置缺失"))?;
    let token = data["sessionToken"]
        .as_str()
        .filter(|token| token.len() == 43)
        .ok_or_else(|| coded_error("PORTAL_LOGIN_FAILED", "登录凭据缺失"))?;
    activate_portal_profile(url).await.map_err(|_| {
        coded_error(
            "PORTAL_CONFIG_FAILED",
            "已登录，但配置应用失败，请重试或在订阅页检查配置",
        )
    })?;
    store_account(token)
        .await
        .map_err(|_| coded_error("PORTAL_LOGIN_FAILED", "无法保存登录状态"))?;
    Ok(json!({ "user": data["user"], "configured": true }))
}

#[tauri::command]
pub async fn portal_account() -> CmdResult<Value> {
    let path = dirs::app_home_dir()
        .map_err(|error| coded_error("PORTAL_ACCOUNT_FAILED", error))?
        .join("pash-account.json");
    let Ok(bytes) = fs::read(path).await else {
        return Ok(Value::Null);
    };
    let account: Account =
        serde_json::from_slice(&bytes).map_err(|_| coded_error("PORTAL_ACCOUNT_FAILED", "登录状态有误，请重新登录"))?;
    let response = client()
        .map_err(|_| coded_error("PORTAL_ACCOUNT_FAILED", "无法连接用户平台"))?
        .get(format!("{PORTAL_URL}/api/me"))
        .bearer_auth(account.token)
        .send()
        .await
        .map_err(|_| coded_error("PORTAL_ACCOUNT_FAILED", "暂时无法读取账户用量"))?;
    if response.status() == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(Value::Null);
    }
    if !response.status().is_success() {
        return Err(coded_error("PORTAL_ACCOUNT_FAILED", "暂时无法读取账户用量"));
    }
    let data: Value = response
        .json()
        .await
        .map_err(|_| coded_error("PORTAL_ACCOUNT_FAILED", "账户响应有误"))?;
    Ok(json!({ "user": data["user"], "configured": true, "nodeHealthy": data["nodeHealthy"] }))
}

#[tauri::command]
pub async fn portal_logout() -> CmdResult {
    let path = dirs::app_home_dir()
        .map_err(|error| coded_error("PORTAL_ACCOUNT_FAILED", error))?
        .join("pash-account.json");
    if let Ok(bytes) = fs::read(&path).await
        && let Ok(account) = serde_json::from_slice::<Account>(&bytes)
        && let Ok(client) = client()
    {
        let _ = client
            .post(format!("{PORTAL_URL}/api/logout"))
            .bearer_auth(account.token)
            .json(&json!({}))
            .send()
            .await;
    }
    if path.exists() {
        fs::remove_file(path)
            .await
            .map_err(|error| coded_error("PORTAL_ACCOUNT_FAILED", error))?;
    }
    Ok(())
}
