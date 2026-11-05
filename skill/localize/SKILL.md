---
name: localize
description: Add, repair, or audit a language in any codebase using i18n-kit, with no API key and no extra cost. Use when the user asks to translate an app or ship it in another language, add a locale ("add German", "localize this in Spanish"), check or fix existing translations, audit localization quality, find missing or broken strings, or review localization that an agent produced. Also use before shipping a language, and to wire a localization gate into CI. Handles Android strings.xml, Chrome extension _locales, Apple .xcstrings and .strings, and ICU JSON catalogs.
---

# localize

Drives **i18n-kit**: it reads the string files a project already has, works out what is missing, hands you the context needed to translate it, mechanically validates what you write, and writes the native files back.

**You are the translator.** The default path needs no API key and costs nothing beyond this session, because the toolkit does the parts a model is bad at (knowing which plural forms Russian needs, proving a placeholder survived) and leaves the translating to you. There is a paid provider path as well, covered below, but it is the exception.

The one idea worth holding onto: nothing ships that could not be verified. A string that fails validation is stored with no text at all, so it falls back to the source language and shows up in `check`. An empty slot is a visible gap. A plausible wrong string is an invisible one.

## How to invoke it

```
bash ~/.claude/skills/localize/scripts/i18n.sh <command> [options]
```

Run it from the project root. The wrapper locates the toolkit, and clones it on first use if it has to. Never call `node .../i18n.mjs` directly, and never hand the user a toolkit command to run themselves. They asked for a skill so they would not have to remember any of this.

`--explain <CODE>` prints what any rule means and why it exists. Use it instead of guessing at a finding.

## Pick the path

**No `i18n/` directory in the project root?** This is a first run. Read [references/setup.md](references/setup.md) and follow it before running anything else. Do not skip it. Choosing the importer by directory name, or leaving the capability matrix at its default, produces a pile of findings that are the config's fault rather than the code's, and that is the first report the user ever sees.

**`i18n/` already there?** Routine run. Carry on below.

## Routine runs

Find out where things stand before changing anything:

```
bash ~/.claude/skills/localize/scripts/i18n.sh status
bash ~/.claude/skills/localize/scripts/i18n.sh check
```

### Add a language

**You do the translating.** There is no API key and no extra bill: the toolkit writes a brief, you translate it, and it validates your work. Do not reach for `translate` (the paid path) unless the user explicitly asks for it.

1. Add the locale tag to `locales.required` in `i18n/config.json`.
2. `import`, so the catalog matches the source files as they are right now.
3. `handoff --locales <tag>`. This writes `i18n/handoff/<tag>/` with a `README.md` of standing rules, one `batch-NN-*.md` brief per screen, and a matching `.answers.json` for each.
4. **Read every brief.** They carry what makes a translation correct rather than merely fluent: what the string is for, what each placeholder holds, the wording already settled on that screen, the glossary terms in play, the project's style guide, and the exact plural categories the language needs. Do not translate from the source text alone when the brief is sitting there.
5. Fill in each `.answers.json`: replace `"message": null` with your translation. Leave `null` for anything you cannot do confidently, which is then reported as a gap rather than guessed at. `note` stays `null` unless the *source* has a problem a reviewer should know about, and then it is `{"kind": "ambiguous"|"idiom"|"cultural"|"untranslatable-wordplay", "text": "..."}`.
6. `ingest --locale <tag> --model <your own model id>`.
7. **Read the rejections and fix them.** Each one names exactly what is wrong. Edit only those entries in the answer files, then run `ingest` again. Repeat until nothing is rejected. This loop is the whole point: expect to be rejected on your first pass at any language with more plural forms than English.
8. `check`, then `export`.

Being rejected is normal and is not a failure to report apologetically. Say what was caught and what you corrected.

### Repair a language that already exists

`handoff --review --locales <tag>` queues only the strings `check` finds problems in, rather than every untranslated one. Then the same fill-and-ingest loop.

### Before a release

`check --release` turns on the stricter severities that only matter when shipping.

### Audit work someone else did

`import` then `check`. This is the highest-value use of the skill: an agent can write whatever translation it likes, and still cannot get a Russian plural with two branches or a string that dropped its `{device}` past the gate.

## The paid path, which is the exception

`translate` calls a provider and bills per token. It needs `ANTHROPIC_API_KEY` in the environment. Use it only when the user asks for it, or when the volume is genuinely too large to do in-session (several thousand strings).

If you do use it: `translate --dry-run` first, show the user the cost, wait for a yes, and always pass `--max-spend`. If the key is missing, say so and offer `handoff` instead rather than engineering around it.

## Never

- **Never hand-edit a translation in the catalog.** Every translation stores a hash of its own bytes. Editing one marks it human-owned, and the toolkit will then refuse to regenerate it ever again. Use `review` or `retranslate`.
- **Never fill a missing translation with source-language text** to make `check` quieter.
- **Never overwrite a human translation.** That takes `retranslate --reason`, which is the user's call, not yours.
- **Never silence a finding by loosening the config** until you have read the project's own code and confirmed the config was wrong. If a finding looks like the project's fault, verify one instance in the code before you say so out loud.
- **Never translate a catalog that still has source errors.** Fix the English first: a broken source message produces a broken translation in every language at once.
- **Never edit a brief.** `handoff` overwrites them on the next run. Your work goes in the `.answers.json` files.

## Reporting back

The user manages localization but does not read code. So:

- No rule codes in the summary. `PLURAL_CATEGORY_MISSING` becomes "Russian needs four plural forms and this has two".
- Lead with what it means for shipping, then the numbers.
- **Report the rejections.** "4 of 12 were rejected and corrected on the second attempt" is the gate working, and it is the only evidence that the whole thing is worth anything. Hiding it makes the tool look like it did nothing.
- Say which strings a human still has to look at, and why.
- No em dashes. Short sentences.
