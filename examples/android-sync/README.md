# Worked example: an Android project in sync mode

A project that already ships, with a hand-maintained `strings.xml`, adding German
and Russian without changing how anyone works.

Everything here is real output. Regenerate all of it with no API key:

```bash
node examples/android-sync/offline-translate.mjs
```

## The input

[`app/src/main/res/values/strings.xml`](app/src/main/res/values/strings.xml) is
hand-maintained and i18n-kit never writes to it. That is what sync mode means.
It contains every awkward case on purpose: a plural with text around it, an
argument the format cannot name, an argument named through `<xliff:g>`, a section
header comment, an apostrophe next to a placeholder, a literal percent sign, and
one `translatable="false"` string.

## 1. Import

```bash
npx i18n import
```

Ten strings become ICU. Two things are worth looking at in
[`i18n/source/app.json`](i18n/source/app.json).

The plural kept the sentence around it:

```
%1$d tab from %2$s   →   {count, plural, one {# tab from {senderDevice}} other {# tabs from {senderDevice}}}
```

And `%2$s` had no name, so the import said so rather than accepting it quietly:

> `batch_summary_title_from` argument 2 became `{arg2}`, because `%2$s` carries no
> name. Rename it in the catalog, or wrap it in `<xliff:g id="...">` in
> strings.xml. A translator shown `{arg2}` cannot tell a device name from a
> person's name.

Renaming it to `senderDevice` is recorded as `argRenames` on the entry, so the
next import reapplies it instead of reverting it, and the warning goes quiet. The
alternative is to add `<xliff:g>` in `strings.xml`, which improves the source for
everyone; `relay_move_done` and `relay_waiting` already do that, which is why
they imported as `{address}` and `{device}` with examples attached and raised
nothing.

## 2. Translate

The two deliberately wrong answers in `offline-translate.mjs` are the two faults
that actually reach users, and both are caught:

```
rejected de batch.summary_title_from (attempt 1): PLACEHOLDER_MISMATCH
accepted de batch.summary_title_from on attempt 2
rejected ru batch.summary_title (attempt 1): PLURAL_CATEGORY_MISSING
accepted ru batch.summary_title on attempt 2
```

The German dropped the sender device. It reads perfectly and loses information,
and no amount of proofreading in English finds it. The Russian came back with
English's two plural branches, which is wrong for 2, 3, 4, 22 and so on forever.

Neither was corrected by a human noticing. The retry carried the specific reason:

```
PLURAL_CATEGORY_MISSING: ru requires one, few, many, other for {count};
missing few, many. ru selects among one, few, many, other; every one needs
its own branch.
```

## 3. Export

```bash
npx i18n export
```

German gets two branches, Russian gets four, resolved per locale from CLDR rather
than copied from the source:

```xml
<!-- values-de/strings.xml -->
<plurals name="batch_summary_title">
    <item quantity="one">%1$d Tab empfangen</item>
    <item quantity="other">%1$d Tabs empfangen</item>
</plurals>

<!-- values-ru/strings.xml -->
<plurals name="batch_summary_title">
    <item quantity="one">Получена %1$d вкладка</item>
    <item quantity="few">Получено %1$d вкладки</item>
    <item quantity="many">Получено %1$d вкладок</item>
    <item quantity="other">Получено %1$d вкладок</item>
</plurals>
```

The resource names are the ones that were in `strings.xml`, not names derived
from the catalog keys, so `R.string` and `R.plurals` keep compiling and no call
site changes. `values/strings.xml` is untouched.

## 4. What check still says

```
Passed with 0 errors, 7 warnings, 0 notes.
```

The warnings are the judgement calls, which is what a warning is for. Russian
renders the glossary term "вкладка" in the genitive as "вкладок", which the
glossary check flags and a human confirms in a second:

> `"tab"` is preferred as `"вкладка"` in ru. Inflected forms are fine; check this
> is one.

A do-not-translate term like the product name would be an error instead, because
a proper noun does not inflect in the cases that matter and demanding it verbatim
is a fair test.

## 5. Try breaking it

Edit a German string in `i18n/translations/de/app.json` by hand, then:

```bash
npx i18n check
```

It is now human-owned, and `translate` will not touch it again. Change the
English source and check again: German drops to a warning that blocks only a
release, while an untouched machine translation of the same string is an error.
`i18n retranslate --key ... --locale de --reason "..."` is the only way back, and
it records the old text first.
