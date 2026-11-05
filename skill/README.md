# The `localize` skill

A Claude Code skill that drives this toolkit, so nobody has to remember a command.

Install it once, for every project on the machine:

```bash
ln -s "$PWD/skill/localize" ~/.claude/skills/localize
```

Then, in any project, ask for what you want rather than for a command:

- "add German to this app"
- "check our Russian translations"
- "is this localization any good?"
- "/localize"

The agent does the translating itself, through `handoff` and `ingest`, so there is no API key to provision and nothing billed twice. The toolkit's job is the part a model is bad at: knowing that Russian needs four plural forms where English has two, and proving that `{device}` survived the trip. An answer that fails validation is rejected with the specific reason and never written.

The skill decides whether this is a first run (and then reads `references/setup.md`, which covers choosing the right importer and declaring what the project's own formatter can render) or a routine one, runs the right commands, and reports in plain language. If the user explicitly asks for the paid provider path instead, it prices the run with `--dry-run` and waits for a yes before spending anything.

`scripts/i18n.sh` is the only entry point it uses. That script finds the toolkit in this order: `I18N_KIT_HOME`, the project's own `node_modules`, the repo this skill ships in, `~/Coding Projects/i18n-kit`, and finally a shallow clone into `~/.cache/i18n-kit`. So the skill also works on a machine that has never seen the toolkit.
