import type { LanguageRegistration } from "@shikijs/core";

/**
 * Grammars for code languages Shiki ships none for (Agda, Dhall, EBNF, Idris), written here so the
 * highlighter (lib/code-highlighter.ts) colors them like the others: comments, strings, numbers,
 * keywords, types and operators. They are small TextMate grammars with the patterns as JavaScript
 * regular expressions (flags "dgu"), as the highlighter's precompiled engine needs: it compiles no
 * pattern written as a string.
 */

type Pattern = Record<string, unknown>;

const words = (list: string[]) => new RegExp(`(?<![\\p{L}\\p{N}_'])(?:${list.join("|")})(?![\\p{L}\\p{N}_'])`, "dgu");

/** `{- … -}` comments, which nest, and `--` to the end of the line (Haskell's family). */
const haskellComments = (lang: string): Record<string, Pattern> => ({
  comments: {
    patterns: [
      { begin: /\{-/dgu, end: /-\}/dgu, name: `comment.block.${lang}`, patterns: [{ include: "#comments" }] },
      { match: /--(?![!#$%&*+./<=>?@\\^|~:]).*/dgu, name: `comment.line.double-dash.${lang}` },
    ],
  },
});

const doubleQuoted = (lang: string): Pattern => ({
  begin: /"/dgu,
  end: /"/dgu,
  name: `string.quoted.double.${lang}`,
  patterns: [{ match: /\\./dgu, name: `constant.character.escape.${lang}` }],
});

const numbers = (lang: string): Pattern => ({ match: /(?<![\p{L}_])(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/dgu, name: `constant.numeric.${lang}` });

function grammar(name: string, displayName: string, patterns: Pattern[], repository: Record<string, Pattern>): LanguageRegistration {
  return { name, displayName, scopeName: `source.${name}`, patterns, repository } as unknown as LanguageRegistration;
}

const agda = grammar(
  "agda",
  "Agda",
  [
    { include: "#comments" },
    { begin: /\{-#/dgu, end: /#-\}/dgu, name: "meta.preprocessor.agda" },
    doubleQuoted("agda"),
    { match: /'(?:\\.|[^'\\])'/dgu, name: "string.quoted.single.agda" },
    numbers("agda"),
    {
      match: words([
        "abstract", "codata", "coinductive", "constructor", "data", "do", "eta-equality", "field", "forall", "hiding", "import", "in",
        "inductive", "infix", "infixl", "infixr", "instance", "interleaved", "let", "macro", "module", "mutual", "no-eta-equality",
        "open", "opaque", "overlap", "pattern", "postulate", "primitive", "private", "public", "quote", "record", "renaming",
        "rewrite", "syntax", "tactic", "to", "unfolding", "unquote", "using", "variable", "where", "with",
      ]),
      name: "keyword.other.agda",
    },
    { match: words(["Set\\d*", "Prop\\d*", "Setω"]), name: "support.type.agda" },
    { match: /[λ∀→←=:|\\]|->|<-/dgu, name: "keyword.operator.agda" },
    { match: /(?<![\p{L}\p{N}_'])\p{Lu}[\p{L}\p{N}_']*/dgu, name: "entity.name.type.agda" },
  ],
  haskellComments("agda"),
);

const idris = grammar(
  "idris",
  "Idris",
  [
    { match: /\|\|\|.*/dgu, name: "comment.line.documentation.idris" },
    { include: "#comments" },
    doubleQuoted("idris"),
    { match: /'(?:\\.|[^'\\])'/dgu, name: "string.quoted.single.idris" },
    numbers("idris"),
    {
      match: words([
        "auto", "case", "covering", "data", "default", "do", "else", "export", "forall", "if", "impossible", "implementation",
        "implicit", "import", "in", "infix", "infixl", "infixr", "interface", "let", "module", "mutual", "namespace", "of",
        "parameters", "partial", "postulate", "prefix", "private", "proof", "public", "record", "rewrite", "then", "total",
        "using", "where", "with",
      ]),
      name: "keyword.control.idris",
    },
    { match: /%\p{L}+/dgu, name: "meta.preprocessor.idris" },
    { match: /->|=>|<-|::|:|=|\\|\|/dgu, name: "keyword.operator.idris" },
    { match: /(?<![\p{L}\p{N}_'])\p{Lu}[\p{L}\p{N}_']*/dgu, name: "entity.name.type.idris" },
  ],
  haskellComments("idris"),
);

const dhall = grammar(
  "dhall",
  "Dhall",
  [
    { include: "#comments" },
    doubleQuoted("dhall"),
    { begin: /''/dgu, end: /''(?!')/dgu, name: "string.quoted.multi.dhall", patterns: [{ match: /'''|''\$\{/dgu, name: "constant.character.escape.dhall" }] },
    numbers("dhall"),
    { match: words(["let", "in", "if", "then", "else", "as", "using", "merge", "missing", "toMap", "with", "forall", "assert", "showConstructor"]), name: "keyword.control.dhall" },
    { match: words(["True", "False", "None", "Some"]), name: "constant.language.dhall" },
    {
      match: words(["Bool", "Natural", "Integer", "Double", "Text", "List", "Optional", "Type", "Kind", "Sort", "Date", "Time", "TimeZone", "Bytes"]),
      name: "support.type.dhall",
    },
    { match: /(?:https?:\/\/\S+|\.{0,2}\/[\w./-]+|env:\w+)/dgu, name: "markup.underline.link.dhall" },
    { match: /->|→|∀|λ|===|≡|\/\/\\\\|\/\/|⫽|\/\\|∧|⩓|::|\?|:|=|\+\+|#|\|\||&&|==|!=|\\/dgu, name: "keyword.operator.dhall" },
  ],
  haskellComments("dhall"),
);

const ebnf = grammar(
  "ebnf",
  "EBNF",
  [
    { begin: /\(\*/dgu, end: /\*\)/dgu, name: "comment.block.ebnf" },
    { begin: /"/dgu, end: /"/dgu, name: "string.quoted.double.ebnf" },
    { begin: /'/dgu, end: /'/dgu, name: "string.quoted.single.ebnf" },
    { begin: /\?/dgu, end: /\?/dgu, name: "string.other.special.ebnf" },
    // The rule a line defines: its name before "=" or "::=".
    { match: /^\s*([\p{L}_][\p{L}\p{N}_ -]*?)\s*(?=::=|=)/dgu, captures: { "1": { name: "entity.name.function.ebnf" } } },
    numbers("ebnf"),
    { match: /::=|[=|,;.\-*]/dgu, name: "keyword.operator.ebnf" },
    { match: /[[\]{}()]/dgu, name: "punctuation.section.ebnf" },
  ],
  {},
);

/** The grammars by language id (lib/code-languages), each as the highlighter loads one. */
export const LOCAL_GRAMMARS = { agda, dhall, ebnf, idris };
