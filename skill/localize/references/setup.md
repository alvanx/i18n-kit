# First run in a new project

The goal of this page is one thing: a config that produces findings about the **project**, not about itself. Get this wrong and the first report the user reads is a list of your own mistakes.

Scaffold first, then fix the four things `init` cannot know:

```
bash ~/.claude/skills/localize/scripts/i18n.sh init
```

## 1. Find the string files by shape, never by name

| What the file actually looks like | Importer |
|---|---|
| `<resources><string name="x">…` | `android` |
| `_locales/<locale>/messages.json`, with a `placeholders` block using `$1` or `$NAME$` | `chrome` |
| `.xcstrings`, or legacy `.strings` | `apple` / `apple-strings` |
| Any other JSON: `{"key": "text"}`, `{"key": {"message": …, "description": …}}`, or nested | `icu-json` |

**The trap.** The `chrome` importer reads `$1` as a positional argument, because in a Chrome extension it is one. A web app whose JSON happens to use the `{message, description}` shape is not a Chrome extension. Point `chrome` at it and `$14.99` becomes `{arg1}4.99`, shipped in every language, in text nobody rereads once it is translated. Before choosing `chrome`, confirm both a `_locales/<locale>/` directory and a `placeholders` block. Otherwise it is `icu-json`.

Find the candidates:

```
find . \( -name "strings.xml" -o -name "*.xcstrings" -o -name "*.strings" -o -name "messages.json" \) -not -path "*/node_modules/*" -not -path "*/build/*" | head -40
```

```
find . -path "*locales*" -name "*.json" -not -path "*/node_modules/*" | head -40
```

Give each file its own `namespace`, and prefix it per platform (`ext_`, `con_`, `ios_`). The prefix is what lets one catalog feed several targets without their keys colliding, and `options.namespacePrefix` on a target is how export picks out its own strings again.

## 2. If there are no string files at all

Stop and say so plainly. The toolkit does not extract strings from source code, deliberately: heuristics sweep up log lines and error identifiers while missing half the real UI text, and a half-right extraction is worse than none.

So someone has to move the hardcoded text into a string file first. That is real work, roughly a screen at a time, and it is a separate job from translating. Offer to do it as its own task. Do not start it inside a localize run.

## 3. Read the project's own formatter, then narrow the capabilities

This is the step that gets skipped and the one that matters most.

Most shipping projects do not use full ICU. They carry a few hundred lines that handle the subset somebody needed. The default capability matrix assumes the format can do everything its adapter can, so if you leave it alone, `check` passes constructs the app will throw on at render time, in front of a user.

Find the formatter:

```
grep -rn "plural\|selectordinal\|select," --include=*.ts --include=*.tsx --include=*.swift --include=*.kt -l . | grep -v node_modules | head
```

Read the function that renders a message. Work out which of these it genuinely handles, and look for the line that rejects the rest:

- `plural`, `select`, `selectordinal`
- `=0` / `=1` exact match, and `offset`
- `{n, number}`, `{d, date}`, `{t, time}`
- skeletons such as `::currency/EUR`
- nesting depth
- rich text tags, `<b>…</b>`

A single `if (kind !== 'plural' && kind !== 'select') throw …` tells you everything: date, time, selectordinal and skeletons are all unsupported, whatever the docs say.

Then write it down, per target:

```json
"capabilities": {
  "selectordinal": false,
  "dateTimeArgs": false,
  "numberDateSkeletons": false
}
```

Narrowing only. Claiming a construct the adapter cannot write is rejected as a config error, because it would be a promise the writer breaks.

## 4. Decide `policy.richText`

Full ICU treats `<b>text</b>` as rich text. Many projects resolve tags in a separate layer with their own narrower grammar, and some do not support them at all.

If the project has its own tag handling, set this:

```json
"policy": { "richText": "none" }
```

Without it, the ICU parser rejects ordinary text like `http://<LAN-IP>:8786` as an unclosed tag. That is a finding about the parser, not about the string, and it will waste the user's attention.

## 5. Keep `source.mode` as `sync`

For any project that already ships, `sync` is correct: the platform's own string file stays the source of truth, developers keep adding strings exactly where they do now, and export writes only the other languages. `adopt` makes the catalog authoritative and rewrites the source file too. It is right eventually, and it is a migration, so it is never the first run.

## 6. A worked config

Two web targets out of one catalog, from a project whose formatter handles plural, select, `=N`, offset and plain numbers, and throws on the rest:

```json
{
  "schemaVersion": 1,
  "sourceLocale": "en",
  "locales": { "required": ["de", "ru"], "optional": [] },
  "policy": { "richText": "none" },
  "source": {
    "mode": "sync",
    "from": [
      { "importer": "icu-json", "path": "extension/src/locales/en/chooser.json", "namespace": "ext_chooser" },
      { "importer": "icu-json", "path": "console/src/locales/en/devices.json", "namespace": "con_devices" }
    ]
  },
  "targets": {
    "extension": {
      "adapter": "icu-json",
      "out": "extension/src/locales",
      "options": { "namespacePrefix": "ext_", "shape": "message-object", "layout": "locale-dir" },
      "capabilities": { "selectordinal": false, "dateTimeArgs": false, "numberDateSkeletons": false }
    },
    "console": {
      "adapter": "icu-json",
      "out": "console/src/locales",
      "options": { "namespacePrefix": "con_", "shape": "message-object", "layout": "locale-dir" },
      "capabilities": { "selectordinal": false, "dateTimeArgs": false, "numberDateSkeletons": false }
    }
  }
}
```

Point `out` at a scratch directory for the first run, diff the result against the real files, and only then point it at the project's own locale folder.

## 7. Prove the config before the user sees a single number

```
bash ~/.claude/skills/localize/scripts/i18n.sh import --dry-run
bash ~/.claude/skills/localize/scripts/i18n.sh import
bash ~/.claude/skills/localize/scripts/i18n.sh check
```

Sort every finding into "the project's problem" or "mine". On a healthy project with one language, expect exactly these:

- `MISSING_KEY` for every string in every target locale. That is the work to be done, not a defect.
- `DUPLICATE_SOURCE` where two keys hold the same English. Usually fine, sometimes a merge candidate.
- `PLURAL_UNINFLECTED` (info) where a wording is deliberately count-invariant, like `{count, plural, other {#d ago}}`. Correct English. Leave it.

Anything else, suspect the config first. `--explain <CODE>` says what a rule is for. And if a finding really does look like the project's fault, read the code and confirm one instance before telling the user their code is broken.
