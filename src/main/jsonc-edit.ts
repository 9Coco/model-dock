import { applyEdits, createScanner, SyntaxKind, type Edit } from 'jsonc-parser';

function jsoncComments(text: string): { text: string; offset: number; end: number }[] {
  const scanner = createScanner(text), comments: { text: string; offset: number; end: number }[] = [];
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.LineCommentTrivia || token === SyntaxKind.BlockCommentTrivia) {
      const offset = scanner.getTokenOffset(), end = offset + scanner.getTokenLength();
      comments.push({ text: text.slice(offset, end), offset, end });
    }
  }
  return comments;
}
/** jsonc-parser removes leading trivia when deleting a property. Keep user
 * comments at that edit position instead of discarding them with managed data. */
export function editJsonc(text: string, edits: Edit[]): string {
  const eol = text.match(/\r\n|\n/)?.[0] ?? '\n';
  const before = jsoncComments(text), after = jsoncComments(applyEdits(text, edits));
  const deficit = new Map<string, number>();
  for (const comment of before) deficit.set(comment.text, (deficit.get(comment.text) ?? 0) + 1);
  for (const comment of after) deficit.set(comment.text, (deficit.get(comment.text) ?? 0) - 1);
  const preserved = edits.map(edit => ({ ...edit }));
  const prefixes = edits.map(() => [] as string[]);
  for (const comment of before) {
    if ((deficit.get(comment.text) ?? 0) <= 0) continue;
    const index = edits.findIndex(edit => edit.offset <= comment.offset && edit.offset + edit.length >= comment.end);
    if (index < 0) continue;
    prefixes[index].push(comment.text);
    deficit.set(comment.text, deficit.get(comment.text)! - 1);
  }
  preserved.forEach((edit, index) => { if (prefixes[index].length) edit.content = `${prefixes[index].join(eol)}${eol}${edit.content}`; });
  let result = applyEdits(text, preserved);
  // Formatting edits can occasionally intersect only part of a block comment.
  // Preserve any remaining lost token safely outside the JSON structure.
  const remaining = new Map<string, number>();
  for (const comment of jsoncComments(result)) remaining.set(comment.text, (remaining.get(comment.text) ?? 0) + 1);
  const missing: string[] = [];
  for (const comment of before) {
    const count = remaining.get(comment.text) ?? 0;
    if (count > 0) remaining.set(comment.text, count - 1); else missing.push(comment.text);
  }
  if (missing.length) result = `${missing.join(eol)}${eol}${result}`;
  return result;
}
