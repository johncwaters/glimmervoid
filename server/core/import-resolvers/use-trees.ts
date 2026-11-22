type UseToken = { kind: 'name'; text: string } | { kind: 'open' } | { kind: 'close' } | { kind: 'comma' } | { kind: 'wildcard' };

interface UseTreeSyntax {
  tokenPattern: RegExp;
  separator: string;
  itemKeywords: ReadonlySet<string>;
}

const MAX_GROUP_DEPTH = 16;
const MAX_EXPANDED_PATHS = 1024;
const MAX_PATH_SEGMENTS = 64;
const BLOCK_COMMENT_END = '*/';
const PUNCTUATION_TOKEN_BY_TEXT: Record<string, UseToken> = { '{': { kind: 'open' }, '}': { kind: 'close' }, ',': { kind: 'comma' }, '*': { kind: 'wildcard' } };

const RUST_SYNTAX: UseTreeSyntax = {
  tokenPattern: /\s+|\/\/[^\n]*|(\/\*)|(?:r#)?([\p{L}_][\p{L}\p{N}_]*)|([{},*])|[\s\S]/uy,
  separator: '::',
  itemKeywords: new Set(),
};

const PHP_SYNTAX: UseTreeSyntax = {
  tokenPattern: /\s+|(?:\/\/|#)[^\n]*|(\/\*)|([\p{L}_][\p{L}\p{N}_]*)|([{},*])|[\s\S]/uy,
  separator: '\\',
  itemKeywords: new Set(['function', 'const']),
};

function tokensOf(text: string, syntax: UseTreeSyntax): UseToken[] {
  const tokens: UseToken[] = [];
  const pattern = new RegExp(syntax.tokenPattern);
  for (let position = 0; position < text.length; ) {
    pattern.lastIndex = position;
    const match = pattern.exec(text);
    if (!match) break;
    position = pattern.lastIndex;
    const [, blockCommentStart, name, punctuation] = match;
    if (blockCommentStart) {
      const commentEnd = text.indexOf(BLOCK_COMMENT_END, position);
      position = commentEnd === -1 ? text.length : commentEnd + BLOCK_COMMENT_END.length;
      continue;
    }
    if (name) tokens.push({ kind: 'name', text: name });
    if (punctuation) tokens.push(PUNCTUATION_TOKEN_BY_TEXT[punctuation]);
  }
  return tokens;
}

function expandedPathsOf(tokens: readonly UseToken[], syntax: UseTreeSyntax): string[][] {
  const paths: string[][] = [];
  const prefixes: string[][] = [[]];
  let current: string[] = [];
  let isSkippingItem = false;
  let isAliasNext = false;
  const emitCurrent = () => {
    const segments = [...(prefixes.at(-1) ?? []), ...current];
    if (segments.length > 1 && segments.at(-1) === 'self') segments.pop();
    if (current.length > 0 && !isSkippingItem && segments.length <= MAX_PATH_SEGMENTS && paths.length < MAX_EXPANDED_PATHS) paths.push(segments);
    current = [];
    isSkippingItem = false;
    isAliasNext = false;
  };
  for (const token of tokens) {
    switch (token.kind) {
      case 'name':
        if (isAliasNext) {
          isAliasNext = false;
          continue;
        }
        if (token.text === 'as') {
          isAliasNext = true;
          continue;
        }
        if ((current.length === 0 && syntax.itemKeywords.has(token.text)) || (prefixes.at(-1)?.length ?? 0) + current.length >= MAX_PATH_SEGMENTS) {
          isSkippingItem = true;
          continue;
        }
        current.push(token.text);
        continue;
      case 'open':
        if (prefixes.length > MAX_GROUP_DEPTH) return paths;
        prefixes.push([...(prefixes.at(-1) ?? []), ...current]);
        current = [];
        continue;
      case 'close':
        emitCurrent();
        if (prefixes.length > 1) prefixes.pop();
        continue;
      case 'comma':
      case 'wildcard':
        emitCurrent();
        continue;
    }
  }
  emitCurrent();
  return paths;
}

export function expandRustUseTree(useTreeText: string): string[] {
  return expandedPathsOf(tokensOf(useTreeText, RUST_SYNTAX), RUST_SYNTAX).map((segments) => segments.join(RUST_SYNTAX.separator));
}

export function expandPhpUseDeclaration(declarationText: string): string[] {
  const tokens = tokensOf(declarationText, PHP_SYNTAX);
  const firstName = tokens[0]?.kind === 'name' && tokens[0].text === 'use' ? 1 : 0;
  const declarationKeyword = tokens[firstName];
  if (declarationKeyword?.kind === 'name' && PHP_SYNTAX.itemKeywords.has(declarationKeyword.text)) return [];
  return expandedPathsOf(tokens.slice(firstName), PHP_SYNTAX).map((segments) => `${PHP_SYNTAX.separator}${segments.join(PHP_SYNTAX.separator)}`);
}
