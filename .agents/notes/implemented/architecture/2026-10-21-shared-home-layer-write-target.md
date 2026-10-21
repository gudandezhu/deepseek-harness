# Agent Note: Edit shared home-layer entries in the home patch

Status: implemented

English | [中文](2026-10-21-shared-home-layer-write-target.zh.md)

## Problem

Desktop and CLI profiles share provider routes and the default model through `$DSH_HOME/cordis.patch.yml`, the home layer applied above every profile patch. Settings forms read only the profile layer: `ConfigEditor.configuration()` composed bundle and profile patches, and `edit()` wrote the profile patch and refused any entry the home patch shadowed.

The Models page therefore listed a provider whose route came from the live Config while its model list came from an empty settings layer. Selecting a model in chat worked; the same model was invisible in Settings, and editing provider values failed with `overridden by a higher layer`. One document drove requests while another was the only one the form could read or write.

## Decision

**The document that defines an entry is the document the form edits.** When the home patch carries a config row for an entry, that row is the form's user layer: `configuration()` reports its config as `override`, the config composed below it (bundles plus profile patch) as `inherited`, and `edit()` writes the home patch. Every other entry keeps the profile patch as its write target.

- **Describe.** The Models page now reads `providers.<route>.models` from the home row, so a route declared in the shared layer shows the models that chat can select. Inherited values come from the composition beneath the home layer, so Reset removes the home row's `config` and falls back to the profile or bundle value.
- **Write.** `ConfigEditor.edit()` selects the home document when the home patch has an `id` row with a `config`, and the profile document otherwise. A home write holds the home document's own writer lock, not the profile manifest lock, because every profile shares it. The candidate is validated against the complete patch list with the edited document substituted through `readProfilePatches(..., homePatches)`; a command-line overlay that still shadows the entry keeps the write refused. A failed reconciliation restores the edited document.
- **Scope.** The rule applies to every settings entry, not only model providers: the home patch is the explicit shared layer the [profile-owned configuration note](2026-09-19-profile-owned-live-configuration.md) named for reintroduced cross-profile preferences, and sharing stays visible to the forms that edit it.
- **Desktop config shortcut.** The Models page's "open configuration file" action opens `$DSH_HOME/cordis.patch.yml`, the file its edits reach, instead of the removed `settings.yaml`.

## Alternatives considered

**Show home values read-only and keep the profile as the only write target.** Display would be correct, but editing a shared provider would still require hand-editing the file, and the form would remain a second reader that cannot maintain the value it shows.

**Move provider routes into every profile patch.** This needs no core change, but desktop and CLI then maintain separate copies and the same model can drift between them — the split the home layer exists to remove.

**Make the home layer lower priority than the profile patch.** Profile edits would apply, but shared values would silently stop applying when a profile row existed, and the home file would no longer be one authoritative place.

**Write every setting to the home patch.** That would make unrelated per-profile configuration global. The target follows the entry, so only entries already declared in the home document become shared.

## Consequences

A route or model declared in the shared home document is visible and editable in the desktop Models page, and the edit lands in the same file the CLI reads. Profile-specific values remain profile-local. A Reset on a shared entry deletes the home row's config rather than duplicating the below-home value into another file.

The trade-off costs:

- An entry defined in the home patch can no longer be overridden per profile through the form; profiles can still carry a row, but the home layer wins until its row is removed.
- The settings page edits a global document for those entries, so one user's change reaches every profile on the machine.
- The home patch must stay a sequence of patch rows with unique or last-wins ids, the format the loader already requires.

## Testing

[configuration.spec.ts](../../../../packages/settings/settings/tests/configuration.spec.ts) writes a home row, asserts `user` and `base` in the descriptor, edits through Settings, checks the home document changed while the profile document did not, and resets the value to the bundle default by removing the home row's config.
