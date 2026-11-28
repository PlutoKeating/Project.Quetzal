//! 升级提示与最低版本门控：Hub 在 `/v1/meta` 里说出它的版本与要求的最低客户端版本。

use std::cmp::Ordering;

/// 本机客户端的版本。
pub const CLIENT_VERSION: &str = env!("CARGO_PKG_VERSION");

/// 这台机器上的版本与 Hub 相比的处境。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum UpdateState {
    /// 已是最新，或者不知道（没接 Hub、Hub 没说）。
    Current,
    /// 有更新的版本，但现在的还能用。
    Available(String),
    /// 低于 Hub 要求的最低版本：同步暂停，直到升级。
    Required(String),
}

fn parse(version: &str) -> Option<(Vec<u64>, Vec<String>)> {
    let version = version.trim().trim_start_matches('v');
    if version.is_empty() {
        return None;
    }
    let (core, pre) = match version.split_once('-') {
        Some((core, pre)) => (core, pre.split('.').map(String::from).collect()),
        None => (version, Vec::new()),
    };
    let numbers: Option<Vec<u64>> = core.split('.').map(|n| n.parse().ok()).collect();
    Some((numbers?, pre))
}

/// 按语义化版本比较；带预发布后缀的低于同号正式版。无法解析时返回 `None`。
#[must_use]
pub fn compare_versions(a: &str, b: &str) -> Option<Ordering> {
    let (a_core, a_pre) = parse(a)?;
    let (b_core, b_pre) = parse(b)?;
    let len = a_core.len().max(b_core.len());
    for i in 0..len {
        let (x, y) = (
            a_core.get(i).copied().unwrap_or(0),
            b_core.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return Some(x.cmp(&y));
        }
    }
    match (a_pre.is_empty(), b_pre.is_empty()) {
        (true, true) => return Some(Ordering::Equal),
        (true, false) => return Some(Ordering::Greater),
        (false, true) => return Some(Ordering::Less),
        (false, false) => {}
    }
    for (x, y) in a_pre.iter().zip(b_pre.iter()) {
        let ordering = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(x), Ok(y)) => x.cmp(&y),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ordering != Ordering::Equal {
            return Some(ordering);
        }
    }
    Some(a_pre.len().cmp(&b_pre.len()))
}

/// 由 Hub 的元信息判断本机的处境。
#[must_use]
pub fn update_state(client: &str, server_version: &str, min_client_version: &str) -> UpdateState {
    if compare_versions(client, min_client_version) == Some(Ordering::Less) {
        return UpdateState::Required(String::from(min_client_version.trim()));
    }
    if compare_versions(client, server_version) == Some(Ordering::Less) {
        return UpdateState::Available(String::from(server_version.trim()));
    }
    UpdateState::Current
}

#[cfg(test)]
mod tests {
    use super::{UpdateState, compare_versions, update_state};
    use std::cmp::Ordering;

    #[test]
    fn prereleases_order_before_the_release_and_by_number() {
        assert_eq!(
            compare_versions("2.0.0-alpha.4", "2.0.0-alpha.5"),
            Some(Ordering::Less)
        );
        assert_eq!(
            compare_versions("2.0.0-alpha.10", "2.0.0-alpha.9"),
            Some(Ordering::Greater)
        );
        assert_eq!(
            compare_versions("2.0.0-alpha.5", "2.0.0"),
            Some(Ordering::Less)
        );
        assert_eq!(compare_versions("v2.1.0", "2.0.9"), Some(Ordering::Greater));
        assert_eq!(compare_versions("2.0.0", "2.0.0"), Some(Ordering::Equal));
        assert_eq!(compare_versions("", "2.0.0"), None);
    }

    #[test]
    fn the_hub_meta_decides_between_current_available_and_required() {
        assert_eq!(
            update_state("2.0.0-alpha.5", "2.0.0-alpha.5", ""),
            UpdateState::Current
        );
        assert_eq!(
            update_state("2.0.0-alpha.5", "2.0.0", ""),
            UpdateState::Available(String::from("2.0.0"))
        );
        assert_eq!(
            update_state("2.0.0-alpha.4", "2.0.0", "2.0.0-alpha.5"),
            UpdateState::Required(String::from("2.0.0-alpha.5"))
        );
        assert_eq!(
            update_state("2.0.0", "dev", "garbage"),
            UpdateState::Current
        );
    }
}
