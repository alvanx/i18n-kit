# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Phase 1: the core package. Nothing is published to npm yet.

### Added

- **Catalog format.** ICU MessageFormat in a JSON envelope, one authored source
  file per namespace and one file per locale per namespace. JSON Schemas ship
  alongside for editor autocomplete.
- **The three-hash model.** `sourceHash` and `contextHash` are normalized so a
  smart-quote sweep costs nothing; `contentHash` is exact bytes so a human's
  typographic correction is detected rather than erased. A translation recorded
  as machine-written whose text no longer matches its content hash is promoted
  to human-owned on load and never overwritten.
- **Derived staleness.** `stale-structural`, `stale-text`, and `stale-context`
  are computed by comparing the current source against the existing
  translation, not stored on the entry where the two could disagree.
- **The check gate.** One local pass, no network and no API key, so it runs on
  fork pull requests. Severity depends on who wrote a translation: a stale
  machine translation is an error, a human one behind on wording is a warning
  and blocks only a release, and a human one whose argument contract broke is an
  error regardless.
- **CLDR plural handling.** Required categories resolved per locale from
  `Intl.PluralRules` rather than a table. A `zero` branch is an error in an
  English source, where it never fires, and required in Arabic.
- **Adapter contract with a capability matrix.** A construct a target cannot
  express fails at check time instead of exporting something lossy. The web ICU
  JSON adapter ships first, with a generated `.d.ts` that types each key's
  arguments, not just its name.
- **Key lifecycle commands.** `add`, `rename`, `deprecate`, `remove`, `touch`,
  and `normalize`. `add` refuses a key that still has translations from a
  previous life unless told explicitly to drop them.
- **Pseudo-locales.** `en-XA` expands and accents to find clipping and
  hardcoded strings; `ar-XB` flips direction to find mirroring and isolation
  faults. Both preserve ICU structure exactly, including number and date
  skeletons.
- **Deterministic output.** Canonical JSON with code-point-sorted keys, written
  atomically and only when the bytes actually change. Generated files carry an
  ownership marker, and export refuses to overwrite a file that lacks one.
- **Golden-file fixture** covering plurals beside other arguments, a plural
  inside a select, selectordinal, offsets, exact matches, rich text, repeated
  arguments, and number and date skeletons.
- Workflow templates, split so the check that everyone needs never requires the
  secret that only maintainers have.

### Not yet built

The runtime formatter (phase 2), the provider-neutral translation engine and
the `qa` review command (phase 3), and the Chrome, Android, and Apple adapters
(phase 4).
