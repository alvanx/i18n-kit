/**
 * The lint rule registry.
 *
 * Every finding the toolkit can produce is declared here with a base severity.
 * Two reasons this is a table rather than severities scattered through the
 * checker: a project can only RAISE a severity, which needs a base to compare
 * against, and `i18n check --explain <CODE>` can print why a rule exists.
 *
 * The severity contract, stated once:
 *   error - breaks at runtime, or ships visibly wrong text to a user
 *   warn  - a human should look at this before a release
 *   info  - worth knowing, never worth blocking on
 *
 * Rules marked `ratchet` are an error for keys that are new relative to the
 * merge base and a warning for the pre-existing backlog. That distinction is
 * the difference between a lint people adopt and one they switch off.
 */

/** @typedef {'error'|'warn'|'info'|'off'} Severity */

export const RULES = {
  // --- structural: the file itself is wrong -------------------------------
  SCHEMA_INVALID: {
    severity: 'error',
    desc: 'A catalog file does not match its schema.',
  },
  KEY_SHAPE: {
    severity: 'error',
    desc: 'A key is not two or more dot-separated lowercase segments. The grammar exists so keys convert to Android and Chrome resource names without collision.',
  },
  NAME_COLLISION: {
    severity: 'error',
    desc: 'Two keys collapse to the same platform resource name once dots become underscores, compared case-insensitively.',
  },

  // --- ICU correctness ----------------------------------------------------
  ICU_PARSE: {
    severity: 'error',
    desc: 'A message is not valid ICU MessageFormat.',
  },
  ICU_APOSTROPHE_EATS_ARG: {
    severity: 'error',
    desc: "An apostrophe before a brace opens an ICU quoted literal, so l'{name} silently swallows the placeholder. Use the typographic apostrophe, which is correct typography and not an escape character.",
  },
  HASH_ESCAPE: {
    severity: 'error',
    desc: 'A # appears outside a plural, or a literal # inside one was not escaped.',
  },
  NESTING_TOO_DEEP: {
    severity: 'error',
    desc: 'Nesting exceeds the supported depth of 3.',
  },

  // --- placeholders -------------------------------------------------------
  PLACEHOLDER_MISMATCH: {
    severity: 'error',
    desc: "A translation's argument set differs from the source's. This renders as undefined or throws at format time.",
  },
  PLACEHOLDER_UNDECLARED: {
    severity: 'error',
    desc: 'The message uses an argument that is not declared in placeholders.',
  },
  PLACEHOLDER_UNUSED: {
    severity: 'error',
    desc: 'A declared placeholder does not appear in the message.',
  },
  PLACEHOLDER_TYPE_CONFLICT: {
    severity: 'error',
    desc: 'The declared placeholder type contradicts how the message uses it, for example a string argument used as a plural selector.',
  },
  TAG_MISMATCH: {
    severity: 'error',
    desc: 'Rich-text tags differ in set or nesting between source and translation.',
  },

  // --- plurals ------------------------------------------------------------
  PLURAL_OTHER_MISSING: {
    severity: 'error',
    desc: 'ICU requires an "other" branch on every plural and select.',
  },
  PLURAL_CATEGORY_MISSING: {
    severity: 'error',
    desc: 'The target language needs a CLDR plural category this translation does not provide. Russian needs four, Arabic six.',
  },
  PLURAL_UNINFLECTED: {
    severity: 'info',
    desc: 'A plural with only an "other" branch. Right for an abbreviated unit, wrong for a word.',
  },
  PLURAL_STRUCTURE_MISMATCH: {
    severity: 'error',
    desc: 'The translation flattened a plural into a plain placeholder, or introduced one the source does not have.',
  },
  PLURAL_ZERO_IN_SOURCE: {
    severity: 'error',
    desc: 'English has no CLDR "zero" category, so a zero branch in an English source never fires. The author meant =0, or wants a separate key.',
  },
  PLURAL_CATEGORY_EXTRA: {
    severity: 'warn',
    desc: 'A plural branch for a category this language never selects. Dead on the web, noise on Android.',
  },

  // --- freshness ----------------------------------------------------------
  MISSING_KEY: {
    severity: 'error',
    desc: 'A required locale has no translation for this key.',
  },
  MISSING_KEY_OPTIONAL: {
    severity: 'warn',
    desc: 'An optional locale has no translation for this key. It will fall back at runtime.',
  },
  STALE_MACHINE: {
    severity: 'error',
    desc: 'The source changed and this machine translation was not regenerated. Run translate.',
  },
  STALE_HUMAN_STRUCTURAL: {
    severity: 'error',
    desc: 'The source changed its argument or plural contract under a human translation. The translation will now misformat, so a human must fix it regardless of who wrote it.',
  },
  STALE_HUMAN_TEXT: {
    severity: 'warn',
    releaseSeverity: 'error',
    desc: 'The source wording changed under a human translation. The human text keeps shipping, because slightly stale reviewed text beats English, but a release should not go out unaware of it.',
  },
  STALE_CONTEXT: {
    severity: 'info',
    desc: 'The comment or placeholder descriptions changed. The translation may be lower quality, which is never a reason to fail a build.',
  },
  HUMAN_EDITED: {
    severity: 'info',
    desc: 'A translation recorded as machine-written no longer matches its content hash, so it was promoted to human-owned and will not be overwritten.',
  },
  FAILED_ATTEMPT: {
    severity: 'error',
    desc: 'The last translation attempt failed validation and no text was written.',
  },

  // --- content and layout -------------------------------------------------
  MAX_LENGTH_EXCEEDED: {
    severity: 'error',
    desc: 'A declared maxLength was exceeded. The author asserted a hard constraint, so this is not advisory.',
  },
  TEXT_EXPANSION: {
    severity: 'warn',
    desc: 'A translation ran past the expansion budget for its source length. Measured in display width, so CJK counts correctly.',
  },
  UNTRANSLATED_IDENTICAL: {
    severity: 'warn',
    desc: 'The translation is byte-identical to the source. Legitimate for "OK" and brand names, suspicious otherwise.',
  },
  LEADING_TRAILING_WS: {
    severity: 'warn',
    desc: 'Leading or trailing whitespace, which several platforms silently trim.',
  },
  BIDI_ISOLATION: {
    severity: 'warn',
    desc: 'An RTL translation embeds a string placeholder without isolation, so an LTR value will scramble the surrounding text.',
  },

  // --- vocabulary ---------------------------------------------------------
  GLOSSARY_DNT_VIOLATION: {
    severity: 'error',
    desc: 'A do-not-translate glossary term does not appear verbatim in the translation.',
  },
  GLOSSARY_PREFERRED_MISS: {
    severity: 'warn',
    desc: 'A preferred translation for a glossary term was not used. Only ever a warning: inflecting languages legitimately produce Relays or Relay-Adresse.',
  },
  KEYWORD_LOST: {
    severity: 'error',
    desc: 'An SEO entry lost its primary keyword in translation.',
  },

  // --- authoring hygiene --------------------------------------------------
  COMMENT_MISSING: {
    severity: 'error',
    ratchet: true,
    desc: 'A message has no comment. Enforced for new keys, reported as a backlog count for pre-existing ones.',
  },
  ORPHAN_KEY: {
    severity: 'warn',
    desc: 'A translation exists for a key the source no longer defines.',
  },
  DEPRECATED_IN_USE: {
    severity: 'warn',
    desc: 'A deprecated key is still referenced.',
  },
  DUPLICATE_SOURCE: {
    severity: 'info',
    desc: 'Two keys have identical source text. Candidates for consolidation, or a sign one needs more context.',
  },

  // --- export and targets -------------------------------------------------
  UNSUPPORTED_FEATURE: {
    severity: 'error',
    desc: 'A message uses an ICU construct the target format cannot express. Exporting anyway would ship something lossy, so this fails instead.',
  },
  UNMAPPED_LOCALE: {
    severity: 'error',
    desc: 'A locale has no mapping for a target that needs one. Guessing here silently breaks Chinese and Serbian script variants.',
  },
  GENERATED_DRIFT: {
    severity: 'error',
    desc: 'Committed generated output does not match a fresh export.',
  },
  GENERATED_UNOWNED: {
    severity: 'error',
    desc: 'A file at a target output path carries no i18n-kit ownership marker. Refusing to overwrite what the tool did not write.',
  },

  // --- privacy ------------------------------------------------------------
  EXAMPLE_LOOKS_PERSONAL: {
    severity: 'warn',
    desc: 'A placeholder example resembles an email address, phone number, credential, or bank identifier. Examples are sent to the translation provider.',
  },
  SENSITIVE_UNTRANSLATED: {
    severity: 'warn',
    desc: 'An entry marked sensitive has no translation. It is excluded from provider requests by design and needs a human.',
  },

  // --- advisory from a model ----------------------------------------------
  MODEL_NOTE: {
    severity: 'info',
    desc: 'The translation model flagged the source as ambiguous, idiomatic, culturally specific, or built on wordplay that does not travel.',
  },
  QA_FINDING: {
    severity: 'info',
    desc: 'An i18n qa review raised a finding. Its own severity is carried on the finding.',
  },
}

/** Rule codes whose severity a project may not lower. */
const IMMUTABLE = new Set(
  Object.entries(RULES)
    .filter(([, r]) => r.severity === 'error')
    .map(([code]) => code),
)

/**
 * Resolve the severity of a rule for a given run.
 *
 * `overrides` comes from config. `release` selects the stricter severity that
 * some rules carry for release builds. A project may raise a warning or info to
 * an error, or silence it; it may not lower an error, because the error list is
 * defined as the set of things that break at runtime or ship wrong text.
 */
export function severityOf(code, { overrides = {}, release = false } = {}) {
  const rule = RULES[code]
  if (!rule) throw new Error(`Unknown rule code: ${code}`)

  const base = release && rule.releaseSeverity ? rule.releaseSeverity : rule.severity
  const override = overrides[code]
  if (override === undefined) return base
  if (IMMUTABLE.has(code) && override !== 'error') {
    throw new Error(
      `Rule ${code} is an error and cannot be lowered to "${override}". ` +
        `It describes something that breaks at runtime or ships wrong text.`,
    )
  }
  return override
}

export function isKnownRule(code) {
  return Object.hasOwn(RULES, code)
}
