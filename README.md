# i18n-kit

Point it at a codebase that already ships, and get a new language out of it.

> **Status: in development.** Nothing is published to npm yet. See [what works today](#what-works-today).

Most localization tooling asks you to choose between a hosted platform that owns your strings and a per-framework library that covers one platform. i18n-kit is neither. It reads the string files your project already has, fills the gaps with a translation provider of your choosing, checks every result mechanically, and writes the native files back.

The thing it will not do is quietly ship a translation it cannot verify.

## Why those two problems

Machine translation of UI strings fails in two ways that both reach users.

**A lost argument.** The model returns "An das Gerät senden" for "Send to {device}". It reads perfectly. The device name is gone. Nothing catches it, because nothing was looking.

**A plural that mirrors English.** English has two forms, so the model returns two. Russian needs four, and Russian users see "5 вкладки" where the language requires "5 вкладок" — wrong for 2, 3, 4, 22, 23 and so on forever.

Both are cheap to detect mechanically and expensive to find by reading. So they are detected, fed back as a specific correction, and asked again:

```
  rejected de batch.summary_title_from (attempt 1): PLACEHOLDER_MISMATCH
  accepted de batch.summary_title_from on attempt 2
  rejected ru batch.summary_title (attempt 1): PLURAL_CATEGORY_MISSING
  accepted ru batch.summary_title on attempt 2
```

A string that still fails after its last attempt is recorded with **no text at all**. It then falls back to the source language and `check` reports it. An empty slot is a visible gap; a plausible wrong string is an invisible one.

## Two ways to adopt it

**Sync mode (the default).** Your platform file stays the source of truth. Developers keep adding strings to `res/values/strings.xml` exactly as they do now; `i18n import` reads them and export writes only the other languages. Nothing about how the team works has to change.

```json
"source": {
  "mode": "sync",
  "from": [{ "importer": "android", "path": "android/app/src/main/res/values/strings.xml", "namespace": "android" }]
}
```

**Adopt mode.** The catalog becomes the source of truth and export writes the source file too. Right for a new project, and right eventually for an old one, but it is a migration.

Importers: `android` (`strings.xml`), `chrome` (`_locales/*/messages.json`), `apple` (`.xcstrings` and legacy `.strings`), `icu-json` (plain or nested ICU JSON, including react-intl's extracted shape).

An importer never guesses silently. `%2$s` carries no name, so it becomes `{arg2}` **and** says so, because a translator shown `{arg2}` cannot tell a device name from a person's name. Once you rename it in the catalog, the rename is reapplied on every future import and the warning goes quiet.

## What makes a translation good

Nothing in this list is about the model. It is all context, and it is all mechanical.

- **The comment.** "Open" is a verb or an adjective, a button or a status. That is why `check` refuses a new key without one.
- **Placeholder examples.** `{device}` is an unknown; `{device}`, for example "Phone", tells German which gender the surrounding article needs.
- **Consistency within a screen.** Strings are batched by screen, and each batch carries that screen's already-settled wording as binding precedent. Translated one at a time, you get "Senden" and "Abschicken" on the same dialog.
- **The glossary, split two ways.** A product name must appear verbatim, so violating it is an error. A preferred translation is advice at most, because German legitimately renders a glossary term as "Relays" or "Relay-Adresse" and an exact-match rule against an inflecting language produces noise that buries real findings.
- **A style guide, with per-language sections.** Whether German addresses the user as *du* or *Sie* is a project decision, is not derivable from anything, and is noticed by every reader.
- **Translation memory.** The same source text already settled elsewhere is reused, not re-asked. Free, and it stops one sentence coming back worded two ways.

## Never destroys human work

Every translation stores an exact hash of its own bytes. If the text no longer matches that hash, a person edited it, so it is human-owned from then on and nothing overwrites it. This is derived on every load, so it survives a fresh clone whether or not any previous run wrote it down.

The consequence, which is the point of the whole design:

```
error  STALE_MACHINE      ru   the source changed and this was not regenerated
warn   STALE_HUMAN_TEXT   de   your translation still ships, but a release should know
```

Replacing a human translation needs `i18n retranslate`, which requires a reason, records the previous text in the entry and the audit log, and writes a request into the catalog rather than acting on it. So the diff that authorizes losing a human translation is reviewable on its own, before any money is spent.

## Quickstart

```bash
npx @i18n-kit/core init
```

```bash
npx i18n import
```

```bash
npx i18n check
```

```bash
npx i18n translate --dry-run
```

`--dry-run` prices the run before it costs anything, and works with no credentials at all — estimating is what you do *before* setting a key up.

```
Would translate 114 string(s): 16,143 input tokens, roughly 5,381 output, about $0.17 on claude-opus-5-5.
```

Then `npx i18n translate --max-spend 1` and `npx i18n export`. Or `npx i18n sync`, which is all four in order and stops if the source has problems, because a bad source message produces a bad translation in every language at once.

## Commands

| Command | Network | Purpose |
|---|---|---|
| `import` | no | Read the platform string files into the catalog. |
| `check` | no | The gate. Structural, semantic, and capability validation. |
| `export` | no | Regenerate every platform file. |
| `pseudo` | no | Generate the `en-XA` expansion and `ar-XB` bidi stress locales. |
| `status` | no | Missing, stale, and failed counts per locale. |
| `add` `rename` `deprecate` `remove` | no | Key lifecycle. |
| `touch` | no | Declare a source edit cosmetic, so it does not trigger retranslation. |
| `normalize` | no | Re-canonicalize files after a manual merge. |
| `translate` | yes | Fill gaps. Never overwrites human text. |
| `review` | yes | Fix what `check` found wrong in translations that already exist. |
| `retranslate` | no | Record an audited request to replace a human translation. |
| `sync` | yes | Import, check, translate, export. |

Only `translate`, `review` and `sync` touch the network. That is why the check that everyone needs never requires the secret that only maintainers have, and why it runs on a pull request from a fork. The two workflow templates are split along the same line.

## Export targets

Each target declares what it can express, and that matrix drives lint rather than documentation. A message using a construct the target cannot represent is an error at check time, not a silent downgrade.

| | web | android | chrome | apple |
|---|---|---|---|---|
| plurals | ICU | one string per CLDR category | **none** | Xcode substitutions |
| `select` | yes | no | no | no |
| `=0` exact match | yes | no | no | no |
| plural offset | yes | no | no | no |
| rich text `<b>` | yes | no | no | no |
| number skeletons | yes | no | no | no |
| placeholders | named | positional | named | positional |

So `{count, plural, ...}` exports to Android as a `<plurals>` with four `<item>` elements in Russian and two in German, resolved per locale from CLDR. The same message against the Chrome target is a check error naming the key, because a Chrome extension has always written two keys and an `if`, and shipping the `other` branch to every count would be worse than failing.

Argument positions always come from the **source** message, never the translation. German reorders a sentence and Japanese moves the verb to the end; numbering `%1$s` from the translation would compile and then print the device name where the count belongs.

## What works today

Built, tested, and exercised end to end on a real Android project: the four importers, the catalog with its three-hash model, the check gate, the four export adapters, the translation engine with its validation-and-retry loop, review, the audited retranslate path, pseudo-locales, and the key lifecycle commands. 240 tests.

Not built:

- **No runtime formatter.** The catalogs and the generated files are real, but there is no `@i18n-kit/runtime` yet, so an app using sync mode keeps its own i18n library and reads the generated files as it always did. A project in adopt mode has files and no library to read them with.
- **No string extraction from source code.** An importer reads a string *file*. It does not find hardcoded strings in Swift or TypeScript, and heuristics for that sweep up log lines and miss template literals. Moving them out is manual work.
- **No review UI.** Corrections happen by editing a JSON file, which is fine for a developer and useless for a native speaker you want help from.
- **Only one provider adapter.** The engine takes any object with `translateBatch` and `estimate`; Anthropic is the one that ships.

## What it does not check

It proves a placeholder survived, a plural has the right branches for the language, a product name was left alone, and the result still parses. It cannot tell you a German sentence is stiff, or that the Russian is correct but reads like a translation. That needs a person who speaks it. Everything here is in service of making that person's time worth spending, not of replacing them.

## Content classes

How literal a translation should be is a different question from what register it uses, so it is its own field.

- **`ui`** (default) — faithful. Placeholders exact, length limits hard, glossary strictly enforced.
- **`marketing`** — transcreation. Idioms adapted, headlines rewritten for local readability, intent preserved over literal wording.
- **`legal`** — literal. Nothing softened or summarized.
- **`seo`** — search intent preserved, using the words that market actually searches for.

## Privacy

Only `translate`, `review` and `sync` make network calls. They send message text, comments, placeholder descriptions and examples, and matching glossary entries to the provider you configured. They never send code, file paths, or repository names. See [SECURITY.md](SECURITY.md).

## Requirements

Node 22 or newer.

## License

MIT
