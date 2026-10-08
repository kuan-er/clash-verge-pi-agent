use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};
use serde_yaml_ng::{Mapping, Value};
use sha2::{Digest as _, Sha256};
use std::collections::{BTreeMap, HashSet};

use crate::utils::dirs;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChainPlan {
    pub exit_node: String,
    pub transit_group: String,
    pub probe_url: String,
    pub traffic_group: Option<String>,
}

pub async fn read_plans() -> Result<BTreeMap<String, ChainPlan>> {
    let path = dirs::app_home_dir()?.join("network-agent-chains.json");
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error.into()),
    }
}

pub async fn save_plans(plans: &BTreeMap<String, ChainPlan>) -> Result<()> {
    let path = dirs::app_home_dir()?.join("network-agent-chains.json");
    let temporary = path.with_extension("json.tmp");
    tokio::fs::write(&temporary, serde_json::to_vec(plans)?).await?;
    tokio::fs::rename(temporary, path).await?;
    Ok(())
}

pub fn probe_url(raw: &str) -> Result<()> {
    let url = reqwest::Url::parse(raw)?;
    if !["https", "http"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !(url.path() == "/204"
            || (matches!(url.host_str(), Some("www.google.com" | "www.gstatic.com")) && url.path() == "/generate_204"))
    {
        bail!("Use a credential-free HTTP(S) /204 URL on the exit server.");
    }
    Ok(())
}

fn sequence<'a>(config: &'a Mapping, key: &str) -> &'a [Value] {
    config.get(key).and_then(Value::as_sequence).map_or(&[], Vec::as_slice)
}

fn named<'a>(items: &'a [Value], name: &str) -> Option<&'a Value> {
    items
        .iter()
        .find(|item| item.get("name").and_then(Value::as_str) == Some(name))
}

fn visit(name: &str, edges: &BTreeMap<String, Vec<String>>, path: &mut HashSet<String>) -> Result<()> {
    if !path.insert(name.into()) {
        bail!("The transit path contains a proxy cycle.");
    }
    if let Some(next) = edges.get(name) {
        for child in next {
            visit(child, edges, path)?;
        }
    }
    path.remove(name);
    Ok(())
}

pub fn apply_plan(config: &mut Mapping, plan: &ChainPlan) -> Result<()> {
    probe_url(&plan.probe_url)?;
    let proxies = sequence(config, "proxies");
    let groups = sequence(config, "proxy-groups");
    if named(proxies, &plan.exit_node).is_none() {
        bail!("Exit node is missing. Add it to this profile before configuring a chain.");
    }
    let transit = named(groups, &plan.transit_group).ok_or_else(|| anyhow::anyhow!("Transit group is missing."))?;
    if transit.get("type").and_then(Value::as_str) != Some("select") {
        bail!("Choose a select group for transit optimization.");
    }
    if ["include-all", "include-all-proxies"]
        .iter()
        .any(|key| transit.get(*key).and_then(Value::as_bool) == Some(true))
    {
        bail!("The transit group includes the exit itself. Use a separate transit selector.");
    }
    if let Some(traffic) = &plan.traffic_group
        && (traffic == &plan.transit_group
            || named(groups, traffic)
                .and_then(|group| group.get("type"))
                .and_then(Value::as_str)
                != Some("select"))
    {
        bail!("Choose a separate select group for outgoing traffic.");
    }
    let mut edges = BTreeMap::new();
    for proxy in proxies {
        if let Some(name) = proxy.get("name").and_then(Value::as_str) {
            let dialer = if name == plan.exit_node {
                Some(plan.transit_group.as_str())
            } else {
                proxy.get("dialer-proxy").and_then(Value::as_str)
            };
            edges.insert(name.to_owned(), dialer.into_iter().map(str::to_owned).collect());
        }
    }
    for group in groups {
        if let Some(name) = group.get("name").and_then(Value::as_str) {
            let mut children = group
                .get("proxies")
                .and_then(Value::as_sequence)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>();
            for provider in group
                .get("use")
                .and_then(Value::as_sequence)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
            {
                if let Some(dialer) = config
                    .get("proxy-providers")
                    .and_then(|p| p.get(provider))
                    .and_then(|p| p.get("override"))
                    .and_then(|p| p.get("dialer-proxy"))
                    .and_then(Value::as_str)
                {
                    children.push(dialer.to_owned());
                }
            }
            if plan.traffic_group.as_deref() == Some(name) {
                children.push(plan.exit_node.clone());
            }
            edges.insert(name.to_owned(), children);
        }
    }
    visit(&plan.exit_node, &edges, &mut HashSet::new())?;
    if let Some(proxies) = config.get_mut("proxies").and_then(Value::as_sequence_mut) {
        for proxy in proxies {
            if proxy.get("name").and_then(Value::as_str) == Some(plan.exit_node.as_str())
                && let Some(proxy) = proxy.as_mapping_mut()
            {
                proxy.insert("dialer-proxy".into(), plan.transit_group.clone().into());
            }
        }
    }
    if let Some(groups) = config.get_mut("proxy-groups").and_then(Value::as_sequence_mut) {
        for group in groups {
            let name = group.get("name").and_then(Value::as_str).unwrap_or_default().to_owned();
            if let Some(group) = group.as_mapping_mut() {
                if name == plan.transit_group {
                    group.insert("url".into(), plan.probe_url.clone().into());
                    group.insert("expected-status".into(), Value::from(204));
                }
                if plan.traffic_group.as_deref() == Some(name.as_str()) {
                    let members = group
                        .entry(Value::from("proxies"))
                        .or_insert_with(|| Value::Sequence(Vec::new()));
                    let members = members
                        .as_sequence_mut()
                        .ok_or_else(|| anyhow::anyhow!("Invalid traffic group members."))?;
                    if !members.contains(&Value::from(plan.exit_node.clone())) {
                        members.push(plan.exit_node.clone().into());
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn safe_state(config: &Mapping, profile_id: &str, plan: Option<&ChainPlan>) -> Result<Json> {
    let fingerprint = Sha256::digest(serde_json::to_vec(config)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let nodes = sequence(config, "proxies")
        .iter()
        .map(|p| {
            json!({
                    "name": p.get("name").and_then(Value::as_str),
                    "type": p.get("type").and_then(Value::as_str),
            "dialerProxy": p.get("dialer-proxy").and_then(Value::as_str),
            "suggestedProbeUrl": if p.get("server").and_then(Value::as_str) == Some("154.40.137.121") {
                Some("https://154.40.137.121:8443/204")
            } else { None },
                })
        })
        .collect::<Vec<_>>();
    let groups = sequence(config, "proxy-groups")
        .iter()
        .map(|g| {
            json!({
                "name": g.get("name").and_then(Value::as_str),
                "type": g.get("type").and_then(Value::as_str),
        "members": g.get("proxies").and_then(Value::as_sequence).into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>(),
        "providers": g.get("use").and_then(Value::as_sequence).into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>(),
                "probeUrl": g.get("url").and_then(Value::as_str).filter(|url| probe_url(url).is_ok()),
            })
        })
        .collect::<Vec<_>>();
    Ok(json!({
        "version": { "profileId": profile_id, "fingerprint": fingerprint, "plan": plan },
        "nodes": nodes, "groups": groups,
        "defaultProbeUrl": "https://154.40.137.121:8443/204",
    }))
}

#[cfg(test)]
#[allow(clippy::expect_used, reason = "tests assert by panicking")]
mod tests {
    use super::*;

    fn config() -> Mapping {
        serde_yaml_ng::from_str("proxies:\n- {name: hk, type: anytls, password: private}\n- {name: us, type: anytls, password: private}\nproxy-groups:\n- {name: transit, type: select, proxies: [hk]}\n- {name: traffic, type: select, proxies: [hk]}\n").expect("fixture")
    }

    fn plan() -> ChainPlan {
        ChainPlan {
            exit_node: "us".into(),
            transit_group: "transit".into(),
            probe_url: "https://exit.example/204".into(),
            traffic_group: Some("traffic".into()),
        }
    }

    #[test]
    fn links_exit_and_probe_without_exposing_credentials() {
        let mut config = config();
        apply_plan(&mut config, &plan()).expect("valid chain");
        assert_eq!(
            named(sequence(&config, "proxies"), "us").expect("exit")["dialer-proxy"],
            "transit"
        );
        assert_eq!(
            named(sequence(&config, "proxy-groups"), "transit").expect("transit")["url"],
            "https://exit.example/204"
        );
        let state = safe_state(&config, "profile", Some(&plan())).expect("snapshot");
        assert!(!state.to_string().contains("private"));
        assert_eq!(
            named(sequence(&config, "proxies"), "us").expect("exit")["password"],
            "private"
        );
    }

    #[test]
    fn rejects_exit_in_transit_and_credential_urls() {
        let mut config = config();
        config.get_mut("proxy-groups").expect("groups")[0]["proxies"] = Value::Sequence(vec!["us".into()]);
        assert!(apply_plan(&mut config, &plan()).is_err());
        assert!(probe_url("https://user:secret@exit.example/204").is_err());
        assert!(probe_url("https://exit.example/204?token=secret").is_err());
    }
}
