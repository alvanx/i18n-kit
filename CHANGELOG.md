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

- **Importers**, so the toolkit works on a codebase that already ships: Android
  `strings.xml`, Chrome `_locales`, Apple `.xcstrings` and legacy `.strings`,
  and plain or nested ICU JSON. An argument the platform format cannot name
  becomes `arg2` *and* raises a finding; a plural shape the importer does not
  recognize is reported rather than flattened to its `other` branch.
- **Sync mode**, where the platform's own file stays the source of truth and
  only the other languages are generated. Re-import merges rather than
  overwrites: argument renames recorded in the catalog are reapplied every
  time, and a key that disappears is deprecated rather than deleted.
- **The Android, Chrome, and Apple adapters.** Android explodes a plural into
  one whole string per CLDR category for the target locale, so Russian gets
  four branches where English has two. Apple writes every locale into one
  `.xcstrings` with plurals in Xcode's substitution form. Chrome declares that
  it cannot express a plural at all, which is a check error naming the key
  instead of a file that ships the `other` branch to every count.
- **`@i18n-kit/translate`**: the engine. Work is selected so that a human-owned
  translation is never queued and an already-settled identical source string is
  reused rather than re-sent. Batches are grouped by screen and carry that
  screen's settled wording as precedent. Every answer is validated, and a
  rejection is fed back as the specific correction needed rather than a bare
  retry. A string that still fails is recorded with no text, so it falls back
  visibly instead of shipping wrong.
- **`i18n review`**, which works from the checker's own output so the two cannot
  disagree about what is wrong with a locale. It ignores untranslated strings:
  absence is `translate`'s job, and conflating them spends money by surprise.
- **`i18n retranslate`**, the audited door past human ownership. It requires a
  reason, records the previous text, and writes a request into the catalog
  rather than acting on it, so the diff that authorizes the loss is reviewable
  on its own.
- **Cost control.** `--dry-run` prices a run and works with no credentials,
  falling back to a character-based estimate and saying so. `--max-spend` is
  checked before each request rather than after.

### Fixed

- The capability matrix could not tell a plain `{n, number}` from a
  `::currency/EUR` skeleton, so a format that can express the first and not the
  second had to reject both.
- Converting a platform string could reintroduce the ICU apostrophe trap:
  `l'{name}` silently swallows the placeholder, and the escaping ran in the
  wrong order to prevent it.
- An XML entity with no definition aborted a whole `strings.xml` import instead
  of reporting the one string it appeared in.
- An Android string ending in a placeholder was wrapped in literal quotes,
  which Android would have kept as part of the string.
- A review finding in one locale queued the same key in every locale.

### Not yet built

The runtime formatter, string extraction from source code, a review UI, and
provider adapters beyond Anthropic.
