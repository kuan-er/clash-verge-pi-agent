use super::{CmdResult, StringifyErr as _};
use crate::{
    config::{Config, IVerge},
    utils::dirs,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use serde_yaml_ng::Mapping;
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::LazyLock, time::Duration};
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    process::Command,
    sync::{Mutex, Semaphore, oneshot},
};

static AGENT_LOCK: Semaphore = Semaphore::const_new(1);
static CONFIG_LOCK: Mutex<()> = Mutex::const_new(());
static CANCELLATIONS: LazyLock<Mutex<HashMap<String, oneshot::Sender<()>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentChange {
    pub field: String,
    pub before: Value,
    pub after: Value,
}

async fn snapshot() -> CmdResult<Value> {
    let clash = Config::clash().await.data_arc();
    let verge = Config::verge().await.data_arc();
    let config = &clash.0;
    let runtime = Config::runtime().await.latest_arc();
    let dns = runtime.config.as_ref().and_then(|mapping| mapping.get("dns"));
    Ok(json!({
        "source": "native_app_settings",
        "mode": clash.get_mode().unwrap_or_else(|| "rule".into()),
        "ipv6": config.get("ipv6").and_then(|v| v.as_bool()).unwrap_or(true),
        "mixedPort": clash.get_mixed_port(),
        "httpPort": config.get("port").and_then(|v| v.as_u64()).unwrap_or(0),
        "socksPort": config.get("socks-port").and_then(|v| v.as_u64()).unwrap_or(0),
        "systemProxy": verge.enable_system_proxy.unwrap_or(false),
        "tun": verge.enable_tun_mode.unwrap_or(false),
        "dns": {
            "enable": dns.and_then(|v| v.get("enable")).and_then(|v| v.as_bool()),
            "enhancedMode": dns.and_then(|v| v.get("enhanced-mode")).and_then(|v| v.as_str()),
            "ipv6": dns.and_then(|v| v.get("ipv6")).and_then(|v| v.as_bool()),
        },
    }))
}

fn agent_script() -> CmdResult<PathBuf> {
    let packaged = dirs::app_resources_dir().stringify_err()?.join("network-agent.mjs");
    if packaged.exists() {
        return Ok(packaged);
    }
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/network-agent.mjs");
    if development.exists() {
        return Ok(development);
    }
    Err("Build the network assistant with pnpm agent:build first.".into())
}

fn env_file() -> CmdResult<PathBuf> {
    if let Some(path) = std::env::var_os("NETWORK_AGENT_ENV_FILE") {
        return Ok(path.into());
    }
    let local = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../.env");
    if cfg!(debug_assertions) && local.exists() {
        return Ok(local);
    }
    Ok(dirs::app_home_dir().stringify_err()?.join("network-agent.env"))
}

fn agent_node() -> CmdResult<PathBuf> {
    if let Some(path) = std::env::var_os("NETWORK_AGENT_NODE") {
        return Ok(path.into());
    }
    #[cfg(target_os = "macos")]
    {
        let executable = std::env::current_exe().stringify_err()?;
        if let Some(parent) = executable.parent() {
            let packaged = parent.join("network-agent-node");
            if packaged.exists() {
                return Ok(packaged);
            }
        }
    }
    Ok("node".into())
}

#[tauri::command]
pub async fn network_agent_chat(
    id: String,
    prompt: String,
    history: Value,
    on_event: Channel<Value>,
) -> CmdResult<Value> {
    let _permit = AGENT_LOCK
        .try_acquire()
        .map_err(|_| "A network diagnostic is already running.")?;
    let payload =
        json!({ "prompt": prompt, "history": history, "snapshot": snapshot().await?, "envFile": env_file()? });
    let mut command = Command::new(agent_node()?);
    command
        .arg(agent_script()?)
        .env(
            "NETWORK_AGENT_BACKUP_DIR",
            dirs::app_home_dir().stringify_err()?.join("network-agent-backups"),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(target_os = "windows")]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start Node.js: {e}. Install Node >=22.19 or set NETWORK_AGENT_NODE."))?;
    let mut stdin = child.stdin.take().ok_or("Agent stdin unavailable.")?;
    stdin.write_all(payload.to_string().as_bytes()).await.stringify_err()?;
    stdin.shutdown().await.stringify_err()?;
    drop(stdin);
    let stdout = child.stdout.take().ok_or("Agent stdout unavailable.")?;
    let (sender, receiver) = oneshot::channel();
    CANCELLATIONS.lock().await.insert(id.clone(), sender);
    let read = async {
        let mut lines = BufReader::new(stdout).lines();
        let mut result = None;
        while let Some(line) = lines.next_line().await.stringify_err()? {
            let event: Value = serde_json::from_str(&line).stringify_err()?;
            match event["type"].as_str() {
                Some("result") => result = Some(event["result"].clone()),
                Some("error") => return Err(event["error"].as_str().unwrap_or("Agent failed.").into()),
                _ => {
                    let _ = on_event.send(event);
                }
            }
        }
        let status = child.wait().await.stringify_err()?;
        if !status.success() {
            return Err("The network assistant exited unexpectedly.".into());
        }
        result.ok_or_else(|| "The network assistant returned no result.".into())
    };
    let result = tokio::select! {
        result = read => result,
        _ = receiver => Err("Diagnostic cancelled.".into()),
        _ = tokio::time::sleep(Duration::from_secs(180)) => Err("Diagnostic timed out.".into()),
    };
    CANCELLATIONS.lock().await.remove(&id);
    if child.try_wait().stringify_err()?.is_none() {
        if let Some(pid) = child.id() {
            // Let Pi abort its detached terminal children before terminating the worker.
            #[cfg(unix)]
            let _ = Command::new("/bin/kill")
                .args(["-TERM", &pid.to_string()])
                .status()
                .await;
            #[cfg(windows)]
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .creation_flags(0x08000000)
                .status()
                .await;
        }
        if tokio::time::timeout(Duration::from_secs(3), child.wait())
            .await
            .is_err()
        {
            let _ = child.kill().await;
        }
    }
    result
}

#[tauri::command]
pub async fn network_agent_cancel(id: String) {
    let sender = CANCELLATIONS.lock().await.remove(&id);
    if let Some(sender) = sender {
        let _ = sender.send(());
    }
}

async fn apply_change(change: &AgentChange) -> CmdResult {
    match change.field.as_str() {
        "mode" => {
            let mode = change
                .after
                .as_str()
                .filter(|v| ["rule", "global", "direct"].contains(v))
                .ok_or("Invalid proxy mode.")?;
            let mut patch = Mapping::new();
            patch.insert("mode".into(), mode.into());
            super::patch_clash_config(patch).await
        }
        "ipv6" => {
            let enabled = change.after.as_bool().ok_or("Expected a boolean value.")?;
            let mut patch = Mapping::new();
            patch.insert("ipv6".into(), enabled.into());
            super::patch_clash_config(patch).await
        }
        "systemProxy" | "tun" => {
            let enabled = change.after.as_bool().ok_or("Expected a boolean value.")?;
            let mut patch = IVerge::default();
            if change.field == "systemProxy" {
                patch.enable_system_proxy = Some(enabled);
            } else {
                patch.enable_tun_mode = Some(enabled);
            }
            super::patch_verge_config(patch).await
        }
        _ => Err("Unsupported network setting.".into()),
    }
}

#[tauri::command]
pub async fn network_agent_apply(change: AgentChange) -> CmdResult<Value> {
    let _guard = CONFIG_LOCK.lock().await;
    let valid = match change.field.as_str() {
        "mode" => change
            .after
            .as_str()
            .is_some_and(|v| ["rule", "global", "direct"].contains(&v)),
        "systemProxy" | "tun" | "ipv6" => change.after.is_boolean(),
        _ => false,
    };
    if !valid {
        return Err("Unsupported setting or value.".into());
    }
    if snapshot().await?.get(&change.field) != Some(&change.before) {
        return Err("Settings changed since this preview. Run the diagnosis again.".into());
    }
    let backup = dirs::app_home_dir().stringify_err()?.join("network-agent-undo.json");
    // Persist the inverse before changing connectivity, so a failed call remains recoverable.
    let inverse = AgentChange {
        field: change.field.clone(),
        before: change.after.clone(),
        after: change.before.clone(),
    };
    tokio::fs::write(&backup, serde_json::to_vec(&inverse).stringify_err()?)
        .await
        .stringify_err()?;
    apply_change(&change).await?;
    let current = snapshot().await?;
    if current.get(&change.field) != Some(&change.after) {
        return Err("The application could not activate this setting. Check core and service status.".into());
    }
    Ok(current)
}

#[tauri::command]
pub async fn network_agent_undo() -> CmdResult<Value> {
    let _guard = CONFIG_LOCK.lock().await;
    let path = dirs::app_home_dir().stringify_err()?.join("network-agent-undo.json");
    let change: AgentChange = serde_json::from_slice(&tokio::fs::read(&path).await.stringify_err()?).stringify_err()?;
    let current = snapshot().await?;
    if current.get(&change.field) == Some(&change.after) {
        tokio::fs::remove_file(path).await.stringify_err()?;
        return Ok(current);
    }
    if current.get(&change.field) != Some(&change.before) {
        return Err("This setting was changed again. Undo would overwrite a newer change.".into());
    }
    apply_change(&change).await?;
    tokio::fs::remove_file(path).await.stringify_err()?;
    snapshot().await
}

#[tauri::command]
pub async fn network_agent_status() -> CmdResult<Value> {
    let mut state = snapshot().await?;
    state["undoAvailable"] = dirs::app_home_dir()
        .stringify_err()?
        .join("network-agent-undo.json")
        .exists()
        .into();
    Ok(state)
}
