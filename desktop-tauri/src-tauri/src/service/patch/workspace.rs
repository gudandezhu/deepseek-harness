//! 保留显式关联到源工作区的工作树会话，不改变其隔离 cwd 与目录校验。

use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const PATCH_MARKER: &str = "dsh-tauri-worktree: relaxed explicit workspace membership";
// 0.2.1-alpha.5 将 sessionPath 比较改为 candidateMatches，需整组匹配避免局部放宽。
const MEMBERSHIP_LAYOUTS: [(&str, &str); 2] = [
    (
        "return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);",
        "const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path);",
    ),
    (
        "return this.record.sessionIds.filter((id) => this.host.candidateMatches(id, this.record.path));",
        "const sessionIds = changed.sessionIds.filter((id) => this.host.candidateMatches(id, changed.path));",
    ),
];
const GETTER_PATCHED: &str = "return this.record.sessionIds; /* dsh-tauri-worktree: relaxed explicit workspace membership */";
const ATTACH_ORIGINAL: &str = "if (cwd !== this.record.path) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd resolves to '${cwd}'`);";
const ATTACH_PATCHED: &str = "/* dsh-tauri-worktree: relaxed explicit workspace membership */";
const MUTATE_PATCHED: &str = "const sessionIds = changed.sessionIds; /* dsh-tauri-worktree: relaxed explicit workspace membership */";
const WORKSPACE_INDEX_JS: &str = "node_modules/@deepseek-ai/dsh-workspace/lib/index.js";

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    let Some((getter, mutate)) = MEMBERSHIP_LAYOUTS.iter().find(|(getter, mutate)| {
        source.contains(getter) && source.contains(mutate) && source.contains(ATTACH_ORIGINAL)
    }) else {
        return PatchOutcome::AnchorMissing;
    };
    let patched = source
        .replacen(getter, GETTER_PATCHED, 1)
        .replacen(ATTACH_ORIGINAL, ATTACH_PATCHED, 1)
        .replacen(mutate, MUTATE_PATCHED, 1);
    PatchOutcome::Patched(patched)
}

pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, WORKSPACE_INDEX_JS, patch_source)
}
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, WORKSPACE_INDEX_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    const LEGACY_SOURCE: &str = r#"
get sessionIds() {
    return this.record.sessionIds.filter((id) => this.host.sessionPath(id) === this.record.path);
}
async attachSession(sessionId) {
    if (header.cwd === void 0) throw new Error("missing cwd");
    const cwd = await realpathNormalize(header.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
    if (cwd !== this.record.path) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd resolves to '${cwd}'`);
    this.host.rememberSessionPath(sessionId, cwd);
}
async mutate(fn) {
    const changed = fn(current);
    const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path);
}
"#;
    const ALPHA_SOURCE: &str = r#"
get sessionIds() {
    return this.record.sessionIds.filter((id) => this.host.candidateMatches(id, this.record.path));
}
async attachSession(sessionId) {
    if (header.cwd === void 0) throw new Error("missing cwd");
    const cwd = await realpathNormalize(header.cwd);
    if (!(await stat(cwd)).isDirectory()) throw new Error("not a directory");
    if (cwd !== this.record.path) throw new Error(`cannot attach session '${sessionId}' to workspace '${this.record.path}': its cwd resolves to '${cwd}'`);
    this.host.rememberSessionPath(sessionId, cwd);
}
async mutate(fn) {
    const changed = fn(current);
    const sessionIds = changed.sessionIds.filter((id) => this.host.candidateMatches(id, changed.path));
}
"#;

    #[test]
    fn patches_all_three_membership_guards_in_supported_layouts() {
        for source in [LEGACY_SOURCE, ALPHA_SOURCE] {
            let PatchOutcome::Patched(patched) = patch_source(source) else {
                panic!("expected patched source: {source}");
            };
            assert!(patched.contains("return this.record.sessionIds;"));
            assert!(patched.contains("const sessionIds = changed.sessionIds;"));
            assert!(!patched.contains(".filter("));
            assert!(!patched.contains("if (cwd !== this.record.path)"));
            assert!(
                patched.contains("if (header.cwd === void 0) throw new Error(\"missing cwd\");")
            );
            assert!(patched.contains("const cwd = await realpathNormalize(header.cwd);"));
            assert!(patched.contains(
                "if (!(await stat(cwd)).isDirectory()) throw new Error(\"not a directory\");"
            ));
            assert!(patched.contains("this.host.rememberSessionPath(sessionId, cwd);"));
        }
    }

    #[test]
    fn patch_is_idempotent_in_supported_layouts() {
        for source in [LEGACY_SOURCE, ALPHA_SOURCE] {
            let PatchOutcome::Patched(patched) = patch_source(source) else {
                panic!("expected patched source: {source}");
            };
            assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
        }
    }

    #[test]
    fn skips_partial_upstream_layout() {
        for source in [LEGACY_SOURCE, ALPHA_SOURCE] {
            for line in source.lines().filter(|line| {
                line.contains(".filter(") || line.contains("if (cwd !== this.record.path)")
            }) {
                assert_eq!(
                    patch_source(&source.replace(line, "")),
                    PatchOutcome::AnchorMissing
                );
            }
        }
    }

    #[test]
    fn skips_mixed_upstream_layout() {
        let mixed = ALPHA_SOURCE.replace(
            "this.host.candidateMatches(id, changed.path)",
            "this.host.sessionPath(id) === changed.path",
        );
        assert_eq!(patch_source(&mixed), PatchOutcome::AnchorMissing);
    }
}
