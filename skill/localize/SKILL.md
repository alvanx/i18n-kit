---
name: localize
description: Add, repair, or audit a language in any codebase using i18n-kit. Use when the user asks to translate an app or ship it in another language, add a locale ("add German", "localize this in Spanish"), check or fix existing translations, audit localization quality, find missing or broken strings, or review localization that an agent produced. Also use before shipping a language, and to wire a localization gate into CI. Handles Android strings.xml, Chrome extension _locales, Apple .xcstrings and .strings, and ICU JSON catalogs.
---

# localize

Drives **i18n-kit**: it reads the string files a project already has, fills the gaps with a translation provider, mechanically validates every result, and writes the native files back.

The one idea worth holding onto: it never ships a translation it could not verify. A string that fails validation is stored with no text at all, so it falls back to the source language and shows up in `check`. An empty slot is a visible gap. A plausible wrong string is an invisible one.

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

1. Add the locale tag to `locales.required` in `i18n/config.json`.
2. `import` so the catalog matches the source files as they are right now.
3. `translate --locales <tag> --dry-run`. Show the user the cost. Wait for a yes.
4. `translate --locales <tag> --max-spend <just above the estimate>`
5. `export`
6. `check`, then report.

### Repair a language that already exists

Use `review --locales <tag>`, not `translate`. `translate` skips anything already translated, so it will do nothing. `review` sends only the strings that have findings, and sends the finding along as the correction to make.

### Before a release

`check --release` turns on the stricter severities that only matter when shipping.

### Audit work an agent did

`import` then `check`. This is the highest-value use of the skill and what it is for: an agent can write whatever translation it likes, and still cannot get a Russian plural with two branches or a string that dropped its `{device}` past the gate.

## Money

Never run `translate`, `review`, or `retranslate` without a `--dry-run` first and the user's explicit yes to the number. Always pass `--max-spend`. The API key is read from `ANTHROPIC_API_KEY` in the environment and nowhere else; if it is missing, say so and stop rather than engineering around it.

## Never

- **Never hand-edit a translation in the catalog.** Every translation stores a hash of its own bytes. Editing one marks it human-owned, and the toolkit will then refuse to regenerate it ever again. Use `review` or `retranslate`.
- **Never fill a missing translation with source-language text** to make `check` quieter.
- **Never overwrite a human translation.** That takes `retranslate --reason`, which is the user's call, not yours.
- **Never silence a finding by loosening the config** until you have read the project's own code and confirmed the config was wrong. If a finding looks like the project's fault, verify one instance in the code before you say so out loud.
- **Never run `translate` on a catalog that still has source errors.** Fix the English first, or you pay to translate text that is already broken.

## Reporting back

The user manages localization but does not read code. So:

- No rule codes in the summary. `PLURAL_CATEGORY_MISSING` becomes "Russian needs four plural forms and this has two".
- Lead with what it means for shipping, then the numbers.
- **Report the rejections.** "4 of 12 were rejected and corrected on the second attempt" is the gate working, and it is the only evidence that the whole thing is worth anything. Hiding it makes the tool look like it did nothing.
- Say which strings a human still has to look at, and why.
- No em dashes. Short sentences.
