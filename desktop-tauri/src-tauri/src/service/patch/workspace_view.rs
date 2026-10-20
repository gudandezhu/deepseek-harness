use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const PATCH_MARKER: &str = "dsh-tauri: tolerate workspace view state written by a newer core";

const GROUP_EXPANSION_ORIGINAL: &str =
    "d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));";
const SESSION_ORDER_ORIGINAL: &str =
    "d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)));";

const GROUP_EXPANSION_PATCHED: &str =
    "d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion ?? {}).filter(([key]) => retained.has(key))); /* dsh-tauri: tolerate workspace view state written by a newer core */";
const SESSION_ORDER_PATCHED: &str =
    "d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount ?? {}).filter(([key]) => retained.has(key))); /* dsh-tauri: tolerate workspace view state written by a newer core */";

const WORKSPACE_CLIENT_JS: &str = "node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js";

const RETENTION_STATEMENTS: [(&str, &str); 2] = [
    (GROUP_EXPANSION_ORIGINAL, GROUP_EXPANSION_PATCHED),
    (SESSION_ORDER_ORIGINAL, SESSION_ORDER_PATCHED),
];

fn patch_source(source: &str) -> PatchOutcome {
    if source.contains(PATCH_MARKER) {
        return PatchOutcome::AlreadyPatched;
    }
    let mut patched = source.to_string();
    let mut relaxed = 0usize;
    for (original, replacement) in RETENTION_STATEMENTS {
        if source.contains(original) {
            patched = patched.replacen(original, replacement, 1);
            relaxed += 1;
        }
    }
    if relaxed == 0 {
        return PatchOutcome::AnchorMissing;
    }
    PatchOutcome::Patched(patched)
}

pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, WORKSPACE_CLIENT_JS, patch_source)
}
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, WORKSPACE_CLIENT_JS, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = "retainAccountKeys: (d, workspaceKeys) => {\n    const retained = new Set(workspaceKeys);\n    d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));\n    d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)));\n    delete d.sessionUpdatedAtByAccount;\n},\n";

    #[test]
    fn relaxes_retained_keys_and_preserves_deleted_state() {
        let PatchOutcome::Patched(patched) = patch_source(FIXTURE) else {
            panic!("expected patched source");
        };
        assert!(patched.contains("Object.entries(d.groupExpansion ?? {})"));
        assert!(patched.contains("Object.entries(d.sessionOrderByAccount ?? {})"));
        assert!(patched.contains("delete d.sessionUpdatedAtByAccount;"));
        assert_eq!(
            patched
                .matches("filter(([key]) => retained.has(key)))")
                .count(),
            2
        );
        assert_eq!(patched.matches(PATCH_MARKER).count(), 2);
    }

    #[test]
    fn patches_each_supported_statement_independently() {
        for statement in [
            "d.groupExpansion = Object.fromEntries(Object.entries(d.groupExpansion).filter(([key]) => retained.has(key)));",
            "d.sessionOrderByAccount = Object.fromEntries(Object.entries(d.sessionOrderByAccount).filter(([key]) => retained.has(key)));",
        ] {
            let PatchOutcome::Patched(patched) = patch_source(statement) else {
                panic!("expected Patched");
            };
            assert_eq!(patched.matches(" ?? {}").count(), 1);
            assert_eq!(patched.matches(PATCH_MARKER).count(), 1);
        }
    }

    #[test]
    fn patch_is_idempotent() {
        let PatchOutcome::Patched(patched) = patch_source(FIXTURE) else {
            panic!("expected Patched");
        };
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn skips_when_retention_statements_are_gone() {
        let rewritten = "retainAccountKeys: (d) => { delete d.groupExpansion; },";
        assert_eq!(patch_source(rewritten), PatchOutcome::AnchorMissing);
    }

    #[test]
    fn leaves_lookalike_from_entries_untouched() {
        let lookalike = "d.sessionOrderByAccount = Object.fromEntries(Object.entries(source.members).map(([key, members]) => {";
        let source = format!("{FIXTURE}{lookalike}");
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected Patched");
        };
        assert!(patched.ends_with(lookalike));
        assert!(!patched.contains("Object.entries(source.members ?? {})"));
    }
}
