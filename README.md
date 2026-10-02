# i18n-kit

One authored catalog. Every platform's native string files. No translation vendor.

> **Status: in development.** Phase 1 (core) is being built. Nothing is published to npm yet.

Most localization tooling makes you choose between a hosted platform that owns your strings and a per-framework library that only covers one platform. i18n-kit is neither. You author messages once, in ICU MessageFormat with a comment on every string, and it generates the native string files for web, browser extensions, Android, and Apple. Translation is a pluggable provider, not a service you sign up for.

## What it does

- **One source of truth.** `i18n/source/*.json` is authored. Everything under `build/` is generated and marked as such.
- **Never destroys human work.** Every translation stores an exact hash of itself. If the text no longer matches, a human edited it, and the tool marks it human-owned and stops touching it. Replacing one is an explicit, audited command.
- **Fails loudly instead of shipping lossy output.** Each export target declares what it can express. A message using a construct the target cannot represent is an error at check time, not a silent downgrade.
- **Real plural rules.** CLDR categories per locale, so Russian gets four forms and Arabic gets six, rather than an `n === 1` ternary.
- **Costs scale with new text only.** Unchanged strings are never re-sent to a provider, and a run has a hard spend ceiling.

## Packages

| Package | Job | Network |
|---|---|---|
| `@i18n-kit/core` | Catalog schema, validation, hashing, key lifecycle, export adapters, the CLI | none |
| `@i18n-kit/runtime` | Formatting messages in the app, with typed placeholder arguments | none |
| `@i18n-kit/translate` | Provider-neutral translation and QA orchestration | yes |

`core` never imports `translate`. Validating and exporting a catalog needs no model and no network, so `i18n check` runs on any pull request, including from a fork, with no secret in scope.

## Quickstart

```bash
npx @i18n-kit/core init
```

Authored layout:

```
i18n/
  config.json
  glossary.json
  style.md                    # tone guidance, injected into translation prompts
  source/app.json             # the source-language catalog
  translations/de/app.json    # one file per locale per namespace
```

A message:

```json
"transfer.confirm_title": {
  "message": "Send {count, plural, one {# tab} other {# tabs}} to {device}?",
  "comment": "Confirmation dialog title, shown before a send starts.",
  "context": "dialog-title",
  "class": "ui",
  "placeholders": {
    "count":  { "type": "number", "example": 3, "desc": "Tabs queued for this send." },
    "device": { "type": "string", "example": "Ben's iPhone", "desc": "User-chosen device name.", "doNotTranslate": true }
  },
  "maxLength": { "value": 60, "measure": "display-width", "appliesTo": "translation" }
}
```

Then:

```bash
npx i18n check      # validate. no network, no key.
npx i18n export     # write every platform's files
npx i18n status     # what is missing, stale, or failed, per locale
```

## Commands

| Command | Network | Purpose |
|---|---|---|
| `check` | no | The gate. Structural, semantic, and capability validation. |
| `export` | no | Regenerate every platform file. |
| `pseudo` | no | Generate the `en-XA` expansion and `ar-XB` bidi stress locales. |
| `status` | no | Missing, stale, and failed counts per locale. |
| `add` `rename` `deprecate` `remove` | no | Key lifecycle. Keys are immutable once shipped. |
| `touch` | no | Declare a source edit cosmetic, so it does not trigger retranslation. |
| `normalize` | no | Re-canonicalize files after a manual merge. |
| `translate` | yes | Fill gaps. Never overwrites human text. |
| `qa` | yes | Review existing translations. Proposes corrections, never applies them. |
| `retranslate` | yes | The audited override, one key and one locale at a time. |

## Content classes

How literal a translation should be is not the same question as what register it uses, so it is its own field.

- **`ui`** (default) — faithful. Placeholders exact, length limits hard, glossary strictly enforced.
- **`marketing`** — transcreation. Idioms adapted, headlines rewritten for local readability, CTA intent and brand voice preserved over literal wording.
- **`seo`** — search intent preserved. Keyword prominence maintained, meta descriptions keep their click-through language, alt text reads naturally.

## What is not here

- **No heuristic string extraction from source code.** Scraping user-visible text out of a codebase finds log lines and misses template literals. Keys are authored in the catalog; a lint reports call sites referencing keys that do not exist, and keys nothing references.
- **No hosted service, account, or dashboard.**
- **No review UI.** If you need non-technical reviewers editing translations in a browser, this is not that tool, and `qa` plus a pull request is the closest it gets.

## Privacy

Only `translate`, `retranslate`, and `qa` make network calls. They send message text, comments, placeholder descriptions and examples, and matching glossary entries to whichever provider you configured. They never send code, file paths, or repository names. Mark an entry `"sensitive": true` to exclude it from every provider request. See [SECURITY.md](SECURITY.md).

## Requirements

Node 22 or newer.

## License

MIT
