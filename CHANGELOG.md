# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
[semantic versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Phase 1: the core package. Nothing is published to npm yet.

### Added

- **Translating with no API key**, which is now the default route. `i18n handoff`
  writes the brief a provider would have received, one file per screen, carrying
  the comment, placeholder meanings, nearby settled wording, glossary, style
  guide, and the CLDR plural categories the target language needs. A coding
  agent already working in the repo fills in the answer files. `i18n ingest`
  then validates every answer through the same `validateCandidate` the paid
  engine uses and writes only what passes, reporting each rejection with the
  correction to make.

  The point is that the free route is not the lenient route: a Russian plural
  written with English's two branches is rejected whoever wrote it. Provisioning
  a second, separately billed credential to reach the same model was a cost with
  nothing on the other side of it.

  Translation memory is applied during `handoff`, so a string whose text is
  already settled elsewhere is never handed to an agent for a second opinion.
  Re-ingesting after a correction reports the already-accepted strings as done
  rather than as stale. `--review` queues only what `check` found wrong.
  `paths.handoff` says where the briefs live, and they are safe to gitignore.


- **A Claude Code skill**, in `skill/localize/`. Symlink it into
  `~/.claude/skills/` once and every project on the machine can be localized by
  asking for the outcome instead of a command. It carries the first-run
  knowledge that is easy to get wrong: pick the importer by the file's shape and
  never by its name, read the project's own formatter before declaring
  capabilities, decide `policy.richText`, and prove the config produces findings
  about the code rather than about itself before showing anyone a number. Its
  `scripts/i18n.sh` resolves the toolkit from `I18N_KIT_HOME`, the project's
  `node_modules`, the repo it ships in, the usual working copy, or a fresh
  shallow clone, so it also works on a machine that has never seen the toolkit.

### Fixed

- `check` rendered a translation note as `undefined: undefined` whenever the
  note was a bare string rather than the `{kind, text}` the schema describes.
  The catalog is a file people and other tools write, so the one thing the note
  existed to say was exactly what got lost.
- The `provenance` schema required a `promptVersion` no writer has ever
  produced, and forbade the `kind` and `attempt` that every writer does. It now
  describes the three shapes the code actually writes, discriminated on `kind`:
  `provider` for a paid call, `agent` for a handoff answer, and `memory` for a
  reused string.
- The `$schema` and `$id` URLs that `init` wrote into every scaffolded config
  pointed at a repository that does not exist. They now point at the real one,
  so an editor can actually fetch the schema and complete the config.

### Added in the pass over a second real codebase

Pointing the kit at a project whose i18n layer was already built found more
defects in the kit than in the project. These are the fixes.

- **Per-target capability narrowing.** `targets.<name>.capabilities` declares the
  ICU subset a project's own formatter really supports, so `check` fails on the
  constructs that would throw at render time and stays quiet about the rest.
  Narrowing only: claiming a construct the adapter cannot write is a config
  error. The adapter registry is now the single source of known adapter names,
  instead of a second hardcoded list that could drift from it.
- **`policy.richText: "none"`.** For a project whose tags are resolved outside
  the message formatter, with a grammar narrower than ICU's. Without it, a
  correct string like `<browser>http://<LAN-IP>:8786</browser>` was reported as
  an unmatched closing tag, because ICU accepts `LAN-IP` as a tag name and the
  project's own parser deliberately does not.
- **`icu-json` export adapter.** Every importer needs a matching adapter or sync
  mode cannot close its loop: a project could have its English read in and its
  German translated, and nowhere to put the German. Writes back the layout and
  key the project already uses (`locales/<locale>/<area>.json`, the original
  dotted key, `{ message, description }` or bare strings), not the kit's own.
  `options.namespacePrefix` routes two apps in one repo to their own targets.

### Fixed in that pass

- **A price was corrupted on import.** The Chrome importer read the `$1` inside
  `$14.99` as a positional placeholder and produced `{arg1}4.99`, which would
  have shipped in every language. Chrome reads such a file the same way, so it
  is now reported as `IMPORT_DOLLAR_AMOUNT` and the text is left untouched
  rather than converted.
- **A one-word plural branch was read as a swallowed placeholder.** The
  apostrophe check scanned the raw source, where `one {it}` and `macos {Mac}`
  look like `{it}` and `{Mac}`. It now scans the parsed literal text, where a
  placeholder eaten by an ICU quoted literal actually lands. The real trap,
  `l'{name}`, is still caught.
- **An uninflected plural was an error.** `{count, plural, other {#d ago}}` is
  legal, correct, and the right wording for an abbreviated unit. It is now
  `PLURAL_UNINFLECTED` at `info`. Collapsing an *inflected* source to `other`
  alone is still `PLURAL_CATEGORY_MISSING` at `error`, and a Russian
  translation missing `few` and `many` still blocks.
- **The importer manufactured 213 of its own errors.** `icu-json` never wrote a
  `placeholders` block, so every imported message with an argument failed
  `check` immediately. It now declares the arguments it finds, leaving the
  missing *example* as the real gap. The parse falls back to a tag-ignoring one
  so a project with its own tag grammar does not lose a whole file's
  declarations to one message.
- **`icu-json` reads the `{ message, description }` shape**, which hand-written
  translators borrow from Chrome while keeping ICU text in `message`. Using the
  Chrome importer on one of those was what corrupted the price.
- **The translation gate judged plurals without the source.** A wording the
  author left uninflected read as a dropped branch, sending the model back to
  fix a string that was already right.

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
