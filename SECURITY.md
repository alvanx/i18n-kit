# Security

## What leaves your machine

`i18n check`, `export`, `status`, `pseudo`, and every key-lifecycle command are **fully local**. They make no network calls and need no API key. This is deliberate: it means `check` can run on a pull request from a fork, where repository secrets are not available.

Three commands talk to a translation provider: `translate`, `retranslate`, and `qa`. They send:

- the source message text and its translation, where one exists
- the comment, context, and class
- placeholder names, types, descriptions, and examples
- glossary entries whose term appears in the batch
- the contents of `style.md`

They do **not** send source code, file paths, repository names, git history, environment variables, or catalog entries outside the current batch.

## Keeping text away from a provider

Mark an entry `"sensitive": true` and it is excluded from every provider request. `check` reports it as awaiting human translation rather than as missing, so it does not silently look like an error.

Placeholder **examples** are the likeliest place for real data to leak, since they are written to give a model concrete context. `check` warns when an example looks like an email address, phone number, credential, or bank identifier. Set `policy.placeholderExamples: "forbidden"` to reject examples entirely.

Your provider's data retention is a matter between you and them. `provider.dataRetentionAcknowledged` must be set to `true` before the first network run, as a deliberate speed bump.

## Untrusted input

Catalog text is model input, and anyone who can open a pull request can put instructions inside a "string". The defenses:

- the provider is called with a forced output schema, so a response can only be translations
- the returned key set is checked against the requested set, and a response containing keys that were not requested is discarded whole
- no side-effecting tools are ever in scope during a translation call
- source text is delimited as data in the prompt

The blast radius is bounded to bad translation text, which then still has to pass validation before it is written. Nothing that fails validation is ever saved.

## Logging

Default output records counts, keys, rule codes, and costs. It does not print message text. `--verbose` includes text and says so before it does.

## Secrets

The provider API key is read from an environment variable only. It is never read from a config file and never accepted as a command-line flag, where it would land in shell history and process listings.

The two shipped GitHub Actions workflows are split for this reason: `i18n-check.yml` runs on every pull request with no secret in scope, and `i18n-translate.yml` runs only on the default branch or on demand, and opens a pull request rather than pushing. Do not merge them, and do not use `pull_request_target` to work around fork restrictions: that executes untrusted code with the key available.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository. Please do not file a public issue for anything that could expose a user's API key or catalog contents.
