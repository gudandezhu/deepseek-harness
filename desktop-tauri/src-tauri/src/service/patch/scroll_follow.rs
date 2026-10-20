use std::path::Path;

use crate::utils::{patch_core_file, patch_dsh, PatchOutcome};

const CLIENT: &str = "node_modules/@deepseek-ai/dsh-client-ui-chat/lib/client.js";
const CLASS: &str = "var ScrollFollow = class ScrollFollow {";
const METHOD: &str = "toBottom(element, metrics, behavior) {";
const ORIGINAL: &str = r#"toBottom(element, metrics, behavior) {
				this.following = true;
				if (metrics.top === metrics.floor) return this.jump(element, metrics, metrics.floor);
				if (behavior === "instant" && this.animating) {
					if (this.target !== metrics.floor) {
						this.target = metrics.floor;
						element.scrollTo({
							top: metrics.floor,
							behavior: "smooth"
						});
					}
					return metrics;
				}
				if (behavior === "instant" || !this.animating && this.nearBottom(metrics)) return this.jump(element, metrics, metrics.floor);
				if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return this.jump(element, metrics, metrics.floor);
				if (this.target === null) {
					this.target = metrics.floor;
					element.scrollTo({
						top: metrics.floor,
						behavior: "smooth"
					});
				}
				return metrics;
			}"#;
const PATCHED: &str = r#"toBottom(element, metrics, behavior) {
				this.following = true;
				if (typeof document !== "undefined" && document.documentElement.hasAttribute("data-reduce-motion") || typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return this.jump(element, metrics, metrics.floor);
				if (metrics.top === metrics.floor) return this.jump(element, metrics, metrics.floor);
				if (behavior === "instant" && this.animating) {
					if (this.target !== metrics.floor) {
						this.target = metrics.floor;
						element.scrollTo({
							top: metrics.floor,
							behavior: "smooth"
						});
					}
					return metrics;
				}
				if (behavior === "instant" || !this.animating && this.nearBottom(metrics)) return this.jump(element, metrics, metrics.floor);
				if (this.target === null) {
					this.target = metrics.floor;
					element.scrollTo({
						top: metrics.floor,
						behavior: "smooth"
					});
				}
				return metrics;
			}"#;

fn patch_source(source: &str) -> PatchOutcome {
    if source.matches(CLASS).count() != 1 || source.matches(METHOD).count() != 1 {
        return PatchOutcome::AnchorMissing;
    }
    match (
        source.matches(ORIGINAL).count(),
        source.matches(PATCHED).count(),
    ) {
        (0, 1) => PatchOutcome::AlreadyPatched,
        (1, 0) => PatchOutcome::Patched(source.replacen(ORIGINAL, PATCHED, 1)),
        _ => PatchOutcome::AnchorMissing,
    }
}

pub fn apply_at(core_dir: &Path) -> Result<(), String> {
    patch_core_file(core_dir, CLIENT, patch_source)
}

pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    patch_dsh(app_handle, CLIENT, patch_source)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    const FIXTURE: &str = include_str!("../../../../test/fixtures/scroll-follow-alpha5.txt");

    #[test]
    fn patches_the_released_class_once() {
        let source = format!("before\n{FIXTURE}\nafter");
        let PatchOutcome::Patched(patched) = patch_source(&source) else {
            panic!("expected Patched");
        };
        assert_eq!(patched.matches(PATCHED).count(), 1);
        assert_eq!(patched.replacen(PATCHED, ORIGINAL, 1), source);
        assert_eq!(patch_source(&patched), PatchOutcome::AlreadyPatched);
    }

    #[test]
    fn rejects_missing_changed_or_ambiguous_anchors() {
        let guard = r#"if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return this.jump(element, metrics, metrics.floor);"#;
        let patched = FIXTURE.replacen(ORIGINAL, PATCHED, 1);
        for source in [
            String::new(),
            FIXTURE.replace("metrics", "geometry"),
            FIXTURE.replace(CLASS, "class Follow {"),
            FIXTURE.replace(guard, ""),
            format!("{}\n{guard}", FIXTURE.replace(guard, "")),
            FIXTURE.replace(guard, "").replace(
                "interrupt(element, metrics) {",
                &format!("interrupt(element, metrics) {{\n{guard}"),
            ),
            format!("{FIXTURE}\n{FIXTURE}"),
            format!("{patched}\n{patched}"),
            format!("{patched}\n{FIXTURE}"),
            format!("{FIXTURE}\n{patched}"),
            patched.replace("hasAttribute", "getAttribute"),
            FIXTURE.replace('\n', "\r\n"),
        ] {
            assert_eq!(patch_source(&source), PatchOutcome::AnchorMissing);
        }
    }

    #[test]
    fn applies_to_an_isolated_core_and_executes_the_result() {
        let core = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        let target = core.path().join(CLIENT);
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, FIXTURE).unwrap();
        apply_at(core.path()).unwrap();
        let first = std::fs::read_to_string(&target).unwrap();
        assert_eq!(patch_source(&first), PatchOutcome::AlreadyPatched);
        apply_at(core.path()).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), first);

        let script = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../test/fixtures/scroll-follow-contract.mjs");
        let mut child = Command::new("node")
            .arg(script)
            .arg(&target)
            .stdin(Stdio::null())
            .spawn()
            .expect("node is required for the patched JavaScript contract");
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(
                    status.success(),
                    "patched JavaScript contract failed: {status}"
                );
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("patched JavaScript contract timed out");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn leaves_missing_or_unsupported_core_files_unchanged() {
        let core = tempfile::tempdir_in(env!("CARGO_MANIFEST_DIR")).unwrap();
        apply_at(core.path()).unwrap();
        let target = core.path().join(CLIENT);
        assert!(!target.exists());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, "upstream changed").unwrap();
        apply_at(core.path()).unwrap();
        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            "upstream changed"
        );
    }
}
