//! 关于信息与当前安装版本对应的发行记录。

use super::meta::fetch_tag_published_at;
use super::version::{current_version, parse_version};
use super::{COPYRIGHT, POWERED_BY, REPO_URL};

/// 关于对话框信息。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopAboutInfo {
    pub version: String,
    pub published_at: String,
    pub copyright: String,
    pub repo: String,
    pub powered_by: String,
}

fn release_tag(version: &str) -> Option<String> {
    let version = parse_version(version)?;
    if !version.build.is_empty() {
        return None;
    }
    let mut nightly = version.pre.as_str().split('.');
    if nightly.next() == Some("nightly") {
        let date = nightly.next()?;
        let commit = nightly.next()?.strip_prefix('g')?;
        if (version.major, version.minor, version.patch) != (0, 0, 0)
            || date.len() != 8
            || !date.bytes().all(|b| b.is_ascii_digit())
            || commit.len() != 7
            || !commit.bytes().all(|b| b.is_ascii_hexdigit())
            || nightly.next().is_some()
        {
            return None;
        }
        return Some(format!("nightly-{date}"));
    }
    Some(format!("v{version}"))
}

pub async fn about(app_handle: &tauri::AppHandle) -> DesktopAboutInfo {
    let version = current_version();
    let published_at = match release_tag(&version) {
        Some(tag) => fetch_tag_published_at(app_handle, &tag)
            .await
            .ok()
            .flatten()
            .unwrap_or_default(),
        None => String::new(),
    };
    DesktopAboutInfo {
        version,
        published_at,
        copyright: COPYRIGHT.to_string(),
        repo: REPO_URL.to_string(),
        powered_by: POWERED_BY.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_tag_tracks_the_installed_version_including_prereleases() {
        for (version, tag) in [
            ("0.22.3", "v0.22.3"),
            ("0.23.0", "v0.23.0"),
            ("0.23.0-beta.1", "v0.23.0-beta.1"),
            ("0.23.0-rc.2", "v0.23.0-rc.2"),
            ("0.0.0-nightly.20261008.g7731ffd", "nightly-20261008"),
        ] {
            assert_eq!(release_tag(version).as_deref(), Some(tag), "{version}");
        }
    }

    #[test]
    fn release_tag_rejects_unidentified_and_malformed_nightly_builds() {
        for version in [
            "unknown",
            "0.23.0+local",
            "0.0.0-nightly",
            "0.0.0-nightly.20261008",
            "0.0.0-nightly.20261008.g7731ffd.extra",
            "0.0.0-nightly.2026100.g7731ffd",
            "0.0.0-nightly.abcdefgh.g7731ffd",
            "0.0.0-nightly.20261008.gzzzzzzz",
            "0.23.0-nightly.20261008.g7731ffd",
        ] {
            assert_eq!(release_tag(version), None, "{version}");
        }
    }
}
