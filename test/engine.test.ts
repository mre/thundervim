/// <reference types="node" />
import test from "node:test";
import assert from "node:assert";
import * as vim from "../src/engine.ts";
import type { State } from "../src/engine.ts";

// ---- helpers ---------------------------------------------------------------

// Build a normalized key event from a compact spec:
//   'a'         -> plain key 'a'
//   '<Esc>'     -> Escape
//   '<C-r>'     -> Ctrl-r
function ev(spec: string): vim.KeyEvent {
  if (spec === "<Esc>") return { key: "Escape" };
  if (spec === "<CR>" || spec === "<Enter>") return { key: "Enter" };
  const m = /^<C-(.)>$/.exec(spec);
  if (m) return { key: m[1], ctrl: true };
  return { key: spec };
}

// Feed a sequence of key specs. A plain string is treated as one key per char.
function feed(state: State, seq: string | string[]): State {
  const specs = Array.isArray(seq) ? seq : seq.split("");
  for (const s of specs) vim.handleKey(state, ev(s));
  return state;
}

// Start a state already in Normal mode with the cursor at `cursor`.
function normal(text: string, cursor = 0): State {
  const s = vim.createState(text, cursor);
  s.mode = vim.MODE.NORMAL;
  s.cursor = vim.clampNormal(text, cursor);
  return s;
}

// ---- motions ---------------------------------------------------------------

test("h/l stay within the line", () => {
  const s = normal("hello", 0);
  feed(s, "lll");
  assert.strictEqual(s.cursor, 3);
  feed(s, "llllll"); // clamps at last char
  assert.strictEqual(s.cursor, 4);
  feed(s, "hhhhhh"); // clamps at line start
  assert.strictEqual(s.cursor, 0);
});

test("word motions w/b/e", () => {
  const s = normal("foo bar baz", 0);
  feed(s, "w");
  assert.strictEqual(s.cursor, 4);
  feed(s, "w");
  assert.strictEqual(s.cursor, 8);
  feed(s, "e");
  assert.strictEqual(s.cursor, 10);
  feed(s, "b");
  assert.strictEqual(s.cursor, 8);
});

test("0, ^ and $", () => {
  const s = normal("  hi there", 5);
  feed(s, "0");
  assert.strictEqual(s.cursor, 0);
  feed(s, "^");
  assert.strictEqual(s.cursor, 2);
  feed(s, "$");
  assert.strictEqual(s.cursor, 9);
});

test("counts multiply motions", () => {
  const s = normal("abcdefgh", 0);
  feed(s, "3l");
  assert.strictEqual(s.cursor, 3);
  feed(s, "2l");
  assert.strictEqual(s.cursor, 5);
});

test("j/k keep desired column", () => {
  const s = normal("long line here\nx\nanother long line", 5);
  feed(s, "j"); // short line -> clamp to its last char
  assert.strictEqual(s.cursor, 15);
  feed(s, "j"); // restore column 5 on the long line
  const lineStart = "long line here\nx\n".length;
  assert.strictEqual(s.cursor, lineStart + 5);
});

test("gg and G", () => {
  const s = normal("one\ntwo\nthree", 0);
  feed(s, "G");
  assert.strictEqual(vim.lineStartAt(s.text, s.cursor), "one\ntwo\n".length);
  feed(s, ["g", "g"]);
  assert.strictEqual(s.cursor, 0);
});

// ---- insert entry ----------------------------------------------------------

test("i enters insert without moving", () => {
  const s = normal("abc", 1);
  feed(s, "i");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.cursor, 1);
});

test("a moves right then inserts", () => {
  const s = normal("abc", 1);
  feed(s, "a");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.cursor, 2);
});

test("A jumps to end of line", () => {
  const s = normal("abc\ndef", 0);
  feed(s, "A");
  assert.strictEqual(s.cursor, 3);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("o opens a line below", () => {
  const s = normal("abc\ndef", 1);
  feed(s, "o");
  assert.strictEqual(s.text, "abc\n\ndef");
  assert.strictEqual(s.cursor, 4);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("O opens a line above", () => {
  const s = normal("abc\ndef", 5);
  feed(s, "O");
  assert.strictEqual(s.text, "abc\n\ndef");
  assert.strictEqual(s.cursor, 4);
});

// ---- delete / change / yank / paste ---------------------------------------

test("x deletes the character under the cursor", () => {
  const s = normal("hello", 1);
  feed(s, "x");
  assert.strictEqual(s.text, "hllo");
  assert.strictEqual(s.cursor, 1);
});

test("x with count", () => {
  const s = normal("hello", 0);
  feed(s, "3x");
  assert.strictEqual(s.text, "lo");
});

test("dw deletes a word", () => {
  const s = normal("foo bar baz", 0);
  feed(s, "dw");
  assert.strictEqual(s.text, "bar baz");
  assert.strictEqual(s.cursor, 0);
});

test("de deletes to end of word (inclusive)", () => {
  const s = normal("foo bar", 0);
  feed(s, "de");
  assert.strictEqual(s.text, " bar");
});

test("dd deletes a whole line", () => {
  const s = normal("one\ntwo\nthree", 4);
  feed(s, "dd");
  assert.strictEqual(s.text, "one\nthree");
});

test("dd on the last line consumes the preceding newline", () => {
  const s = normal("one\ntwo", 4);
  feed(s, "dd");
  assert.strictEqual(s.text, "one");
});

test("2dd deletes two lines", () => {
  const s = normal("a\nb\nc\nd", 0);
  feed(s, ["2", "d", "d"]);
  assert.strictEqual(s.text, "c\nd");
});

test("D deletes to end of line", () => {
  const s = normal("hello world", 5);
  feed(s, "D");
  assert.strictEqual(s.text, "hello");
});

test("cw changes a word and enters insert", () => {
  const s = normal("foo bar", 0);
  feed(s, "cw");
  assert.strictEqual(s.text, " bar");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("yy then p pastes a line below", () => {
  const s = normal("one\ntwo", 0);
  feed(s, ["y", "y"]);
  feed(s, "p");
  assert.strictEqual(s.text, "one\none\ntwo");
});

test("yw then p pastes charwise after cursor", () => {
  const s = normal("foo bar", 0);
  feed(s, ["y", "w"]); // yanks "foo "
  feed(s, "p");
  assert.strictEqual(s.text, "ffoo oo bar");
});

test("dd then p round-trips a line", () => {
  const s = normal("one\ntwo\nthree", 0);
  feed(s, ["d", "d"]); // delete "one"
  feed(s, "p"); // paste below current line (two)
  assert.strictEqual(s.text, "two\none\nthree");
});

test("r replaces a single character", () => {
  const s = normal("cat", 0);
  feed(s, ["r", "b"]);
  assert.strictEqual(s.text, "bat");
  assert.strictEqual(s.cursor, 0);
});

test("r<CR> replaces a space with a newline and lands on the new line", () => {
  const s = normal("foo bar", 3); // on the space
  feed(s, ["r", "<CR>"]);
  assert.strictEqual(s.text, "foo\nbar");
  assert.strictEqual(s.cursor, 4); // first column of the new line
});

test("r<CR> replaces the character under the cursor with a newline", () => {
  const s = normal("abXcd", 2); // on 'X'
  feed(s, ["r", "<CR>"]);
  assert.strictEqual(s.text, "ab\ncd");
  assert.strictEqual(s.cursor, 3);
});

test("count r<CR> replaces several chars with one newline", () => {
  const s = normal("abcdef", 0);
  feed(s, ["3", "r", "<CR>"]);
  assert.strictEqual(s.text, "\ndef");
  assert.strictEqual(s.cursor, 1);
});

test("r<CR> does nothing when the count runs past the line end", () => {
  const s = normal("ab\ncd", 0);
  feed(s, ["5", "r", "<CR>"]); // only 2 chars on the line
  assert.strictEqual(s.text, "ab\ncd");
});

// ---- undo / redo -----------------------------------------------------------

test("u undoes and Ctrl-r redoes a delete", () => {
  const s = normal("hello", 0);
  feed(s, "x");
  assert.strictEqual(s.text, "ello");
  feed(s, "u");
  assert.strictEqual(s.text, "hello");
  feed(s, ["<C-r>"]);
  assert.strictEqual(s.text, "ello");
});

test("native editor rebase clears stale Vim undo and redo history", () => {
  const s = normal("abc", 0);
  feed(s, "xx");
  feed(s, "u");
  assert.strictEqual(s.text, "bc");
  assert.strictEqual(s.undoStack.length, 1);
  assert.strictEqual(s.redoStack.length, 1);

  vim.rebaseFromEditor(s, "native text", 11);
  assert.strictEqual(s.undoStack.length, 0);
  assert.strictEqual(s.redoStack.length, 0);
  feed(s, "u");
  assert.strictEqual(s.text, "native text");
  feed(s, ["<C-r>"]);
  assert.strictEqual(s.text, "native text");
});

test("text-equal editor rebase preserves Vim undo history", () => {
  const s = normal("abc", 0);
  feed(s, "x");
  vim.rebaseFromEditor(s, "bc", 1);
  feed(s, "u");
  assert.strictEqual(s.text, "abc");
});

test("undo granularity is per command (dd is one undo)", () => {
  const s = normal("a\nb\nc", 0);
  feed(s, ["d", "d"]);
  feed(s, ["d", "d"]);
  assert.strictEqual(s.text, "c");
  feed(s, "u");
  assert.strictEqual(s.text, "b\nc");
  feed(s, "u");
  assert.strictEqual(s.text, "a\nb\nc");
});

// ---- visual mode -----------------------------------------------------------

test("visual v + l + d deletes the selection (inclusive)", () => {
  const s = normal("hello", 0);
  feed(s, "v");
  feed(s, "l"); // select "he"
  feed(s, "d");
  assert.strictEqual(s.text, "llo");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
});

test("visual line V + d deletes whole lines", () => {
  const s = normal("one\ntwo\nthree", 4);
  feed(s, "V");
  feed(s, "d");
  assert.strictEqual(s.text, "one\nthree");
});

test("visual y yanks and returns to normal, p pastes", () => {
  const s = normal("abcdef", 0);
  feed(s, "v");
  feed(s, "ll"); // select "abc"
  feed(s, "y");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
  assert.strictEqual(s.cursor, 0);
  feed(s, "p");
  assert.strictEqual(s.text, "aabcbcdef");
});

// ---- Escape / insert handoff ----------------------------------------------

test("Escape from insert moves cursor left and returns to normal", () => {
  const s = vim.createState("hello", 5); // insert mode, cursor at end
  feed(s, ["<Esc>"]);
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
  assert.strictEqual(s.cursor, 4);
});

test("engine does not handle plain keys in insert mode", () => {
  const s = vim.createState("", 0);
  const r = vim.handleKey(s, ev("a"));
  assert.strictEqual(r.handled, false);
});

test("normal mode swallows stray printable keys", () => {
  const s = normal("abc", 0);
  const r = vim.handleKey(s, ev("z"));
  assert.strictEqual(r.handled, true);
  assert.strictEqual(s.text, "abc");
});

// ---- text objects ----------------------------------------------------------

test("ciw changes the inner word", () => {
  const s = normal("foo bar baz", 5); // on 'a' of bar
  feed(s, "ciw");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.text, "foo  baz");
  assert.strictEqual(s.cursor, 4);
});

test("daw deletes a word including trailing space", () => {
  const s = normal("foo bar baz", 4); // on 'b' of bar
  feed(s, "daw");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
  assert.strictEqual(s.text, "foo baz");
});

test("ci( changes inside parentheses", () => {
  const s = normal("call(a, b)", 6); // inside parens
  feed(s, ["c", "i", "("]);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.text, "call()");
  assert.strictEqual(s.cursor, 5);
});

test("ci( works from the cursor on the opening paren", () => {
  const s = normal("call(a, b)", 4); // on '('
  feed(s, ["c", "i", "("]);
  assert.strictEqual(s.text, "call()");
});

test('di" deletes inside double quotes', () => {
  const s = normal('say "hi" now', 6); // inside quotes
  feed(s, ["d", "i", '"']);
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
  assert.strictEqual(s.text, 'say "" now');
});

test("da( deletes around parentheses", () => {
  const s = normal("x(y)z", 2); // inside
  feed(s, ["d", "a", "("]);
  assert.strictEqual(s.text, "xz");
});

test("ci( picks the innermost of nested pairs", () => {
  const s = normal("a(b(c)d)e", 4); // on 'c' inside inner pair
  feed(s, ["c", "i", "("]);
  assert.strictEqual(s.text, "a(b()d)e");
});

test("ci{ works via the B alias too", () => {
  const s = normal("fn { body }", 6);
  feed(s, ["c", "i", "B"]);
  assert.strictEqual(s.text, "fn {}");
});

test("visual i( selects inside parentheses", () => {
  const s = normal("call(a, b)", 6);
  feed(s, ["v", "i", "("]);
  assert.strictEqual(s.mode, vim.MODE.VISUAL);
  assert.strictEqual(s.anchor, 5);
  assert.strictEqual(s.cursor, 8); // last char inside parens ('b')
  feed(s, "d");
  assert.strictEqual(s.text, "call()");
});

test("yiw yanks the inner word without changing text", () => {
  const s = normal("foo bar", 0);
  feed(s, "yiw");
  assert.strictEqual(s.text, "foo bar");
  assert.strictEqual(s.register.text, "foo");
  assert.strictEqual(s.register.linewise, false);
});

test("dip deletes the inner paragraph", () => {
  const s = normal("a\nb\n\nc", 0);
  feed(s, ["d", "i", "p"]);
  assert.strictEqual(s.text, "\n\nc");
});

test("das deletes a sentence with its trailing space", () => {
  const s = normal("One two. Three four. Five six.", 0);
  feed(s, ["d", "a", "s"]);
  assert.strictEqual(s.text, "Three four. Five six.");
});

test("dis deletes the inner sentence, keeping surrounding space", () => {
  const s = normal("One two. Three four. Five six.", 0);
  feed(s, ["d", "i", "s"]);
  assert.strictEqual(s.text, " Three four. Five six.");
});

test("das on a middle sentence", () => {
  const s = normal("One two. Three four. Five six.", 10); // inside 'Three four.'
  feed(s, ["d", "a", "s"]);
  assert.strictEqual(s.text, "One two. Five six.");
});

test("das on the last sentence takes the leading space", () => {
  const s = normal("One two. Three four. Five six.", 22); // inside 'Five six.'
  feed(s, ["d", "a", "s"]);
  assert.strictEqual(s.text, "One two. Three four.");
});

test("a sentence ends after closing quotes/brackets", () => {
  const s = normal('He said "Hi!" Then left.', 0);
  feed(s, ["d", "a", "s"]);
  assert.strictEqual(s.text, "Then left.");
});

test("a sentence does not cross a blank line", () => {
  const s = normal("First para.\n\nSecond para.", 0);
  feed(s, ["d", "a", "s"]);
  assert.strictEqual(s.text, "\n\nSecond para.");
});

test("cas changes a sentence and enters insert", () => {
  const s = normal("One two. Three four.", 0);
  feed(s, ["c", "a", "s"]);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.text, "Three four.");
});

test("visual as selects the sentence", () => {
  const s = normal("One two. Three four.", 2);
  feed(s, ["v", "a", "s"]);
  feed(s, "d");
  assert.strictEqual(s.text, "Three four.");
});

// ---- sentence motions ( and ) ----------------------------------------------

test(") moves to the start of the next sentence", () => {
  const s = normal("One two. Three four. Five six.", 0);
  feed(s, [")"]);
  assert.strictEqual(s.cursor, 9);
  feed(s, [")"]);
  assert.strictEqual(s.cursor, 21);
  feed(s, [")"]); // past the last sentence -> end of buffer
  assert.strictEqual(s.cursor, 29);
});

test("( moves back to the sentence start", () => {
  const s = normal("One two. Three four. Five six.", 24);
  feed(s, ["("]);
  assert.strictEqual(s.cursor, 21);
  feed(s, ["("]);
  assert.strictEqual(s.cursor, 9);
  feed(s, ["("]);
  assert.strictEqual(s.cursor, 0);
});

test("2) skips two sentences", () => {
  const s = normal("One two. Three four. Five six.", 0);
  feed(s, ["2", ")"]);
  assert.strictEqual(s.cursor, 21);
});

test("d) deletes to the start of the next sentence", () => {
  const s = normal("One two. Three four. Five six.", 0);
  feed(s, ["d", ")"]);
  assert.strictEqual(s.text, "Three four. Five six.");
});

test(") stops at a blank line", () => {
  const s = normal("A cat.\n\nA dog.", 0);
  feed(s, [")"]);
  assert.strictEqual(s.cursor, 7); // the blank line
  feed(s, [")"]);
  assert.strictEqual(s.cursor, 8); // start of the next paragraph
});

// ---- f/F/t/T and ; , -------------------------------------------------------

test("f moves to the next occurrence on the line", () => {
  const s = normal("foo.bar.baz", 0);
  feed(s, ["f", "."]);
  assert.strictEqual(s.cursor, 3);
  feed(s, ["f", "."]);
  assert.strictEqual(s.cursor, 7);
});

test("f with a count skips occurrences", () => {
  const s = normal("a.b.c.d", 0);
  feed(s, ["2", "f", "."]);
  assert.strictEqual(s.cursor, 3);
});

test("f stays put when the char is not on the line", () => {
  const s = normal("abc", 0);
  feed(s, ["f", "z"]);
  assert.strictEqual(s.cursor, 0);
});

test("F searches backward", () => {
  const s = normal("foo.bar.baz", 10);
  feed(s, ["F", "."]);
  assert.strictEqual(s.cursor, 7);
});

test("t stops before the char; T stops after", () => {
  const s = normal("a.b.c", 0);
  feed(s, ["t", "."]);
  assert.strictEqual(s.cursor, 0); // just before the first dot at 1
  const s2 = normal("a.b.c", 4);
  feed(s2, ["T", "."]);
  assert.strictEqual(s2.cursor, 4); // just after the dot at 3
});

test("df deletes up to and including the target (inclusive)", () => {
  const s = normal("foo(bar)baz", 0);
  feed(s, ["d", "f", ")"]);
  assert.strictEqual(s.text, "baz");
});

test("dt deletes up to but not including the target", () => {
  const s = normal("foo(bar)baz", 0);
  feed(s, ["d", "t", ")"]);
  assert.strictEqual(s.text, ")baz");
});

test("ct changes up to the target and enters insert", () => {
  const s = normal("hello, world", 0);
  feed(s, ["c", "t", ","]);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  assert.strictEqual(s.text, ", world");
});

test("; repeats the last find, , reverses it", () => {
  const s = normal("a.b.c.d", 0);
  feed(s, ["f", "."]);
  assert.strictEqual(s.cursor, 1);
  feed(s, ";");
  assert.strictEqual(s.cursor, 3);
  feed(s, ";");
  assert.strictEqual(s.cursor, 5);
  feed(s, ",");
  assert.strictEqual(s.cursor, 3);
});

test("; steps over an adjacent match after t", () => {
  const s = normal("a.b.c.d", 0);
  feed(s, ["t", "."]);
  assert.strictEqual(s.cursor, 0);
  feed(s, ";");
  assert.strictEqual(s.cursor, 2); // before the second dot at 3
});

test("find works as a visual-mode motion", () => {
  const s = normal("foo(bar)baz", 0);
  feed(s, ["v", "f", ")"]);
  assert.strictEqual(s.mode, vim.MODE.VISUAL);
  assert.strictEqual(s.anchor, 0);
  assert.strictEqual(s.cursor, 7);
  feed(s, "d");
  assert.strictEqual(s.text, "baz");
});

// ---- dot-repeat ------------------------------------------------------------

// Simulate the adapter: while in Insert mode the native editor inserts `typed`
// at the cursor; on Escape the adapter reports the typed text to the engine.
function insertTyped(state: State, typed: string): void {
  state.text =
    state.text.slice(0, state.cursor) + typed + state.text.slice(state.cursor);
  state.cursor += typed.length;
  vim.finishInsert(state, typed);
  vim.handleKey(state, ev("<Esc>"));
}

test(". repeats x", () => {
  const s = normal("abcd", 0);
  feed(s, "x");
  feed(s, ".");
  feed(s, ".");
  assert.strictEqual(s.text, "d");
});

test(". with a count substitutes the recorded count", () => {
  const s = normal("abcdef", 0);
  feed(s, "x"); // -> bcdef
  feed(s, "3."); // 3x -> ef
  assert.strictEqual(s.text, "ef");
});

test(". repeats dw", () => {
  const s = normal("foo bar baz", 0);
  feed(s, "dw");
  feed(s, ".");
  assert.strictEqual(s.text, "baz");
});

test(". reuses the recorded count for 2dd", () => {
  const s = normal("a\nb\nc\nd\ne", 0);
  feed(s, ["2", "d", "d"]); // -> c d e
  feed(s, "."); // repeats 2dd -> e
  assert.strictEqual(s.text, "e");
});

test(". repeats r", () => {
  const s = normal("aaaa", 0);
  feed(s, "rx"); // xaaa
  feed(s, "l");
  feed(s, "."); // replace char under cursor with x
  assert.strictEqual(s.text, "xxaa");
});

test(". repeats p", () => {
  const s = normal("abc", 0);
  feed(s, "yy");
  feed(s, "p"); // abc / abc
  feed(s, ".");
  assert.strictEqual(s.text, "abc\nabc\nabc");
});

test(". repeats a change-word including the typed text", () => {
  const s = normal("foo bar", 0);
  feed(s, "cw");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
  insertTyped(s, "X"); // -> "X bar"
  assert.strictEqual(s.text, "X bar");
  feed(s, "w"); // onto "bar"
  feed(s, ".");
  assert.strictEqual(s.text, "X X");
});

test(". repeats o and the typed text", () => {
  const s = normal("hello", 0);
  feed(s, "o");
  insertTyped(s, "world");
  feed(s, ".");
  assert.strictEqual(s.text, "hello\nworld\nworld");
});

test(". repeats A with the appended text", () => {
  const s = normal("ab", 0);
  feed(s, "A");
  insertTyped(s, "!");
  feed(s, ".");
  assert.strictEqual(s.text, "ab!!");
});

test(". repeats the last change, not an intervening undo", () => {
  const s = normal("abcd", 0);
  feed(s, "x"); // bcd
  feed(s, "u"); // back to abcd
  feed(s, "."); // repeats x, not the undo
  assert.strictEqual(s.text, "bcd");
});

test(". does nothing before any change is recorded", () => {
  const s = normal("abc", 0);
  feed(s, ".");
  assert.strictEqual(s.text, "abc");
});

test(". repeats a text-object change with typed text", () => {
  const s = normal("a(foo)b(bar)c", 0);
  feed(s, ["f", "("]); // -> index 1
  feed(s, ["c", "i", "("]); // delete foo, insert
  insertTyped(s, "X"); // a(X)b(bar)c
  assert.strictEqual(s.text, "a(X)b(bar)c");
  feed(s, ["f", "("]); // onto the second (
  feed(s, "."); // replay ci( + X
  assert.strictEqual(s.text, "a(X)b(X)c");
});

// ---- J (join lines) --------------------------------------------------------

test("J joins the next line with a space", () => {
  const s = normal("foo\nbar", 0);
  feed(s, "J");
  assert.strictEqual(s.text, "foo bar");
  assert.strictEqual(s.cursor, 3);
});

test("J strips leading whitespace of the joined line", () => {
  const s = normal("foo\n   bar", 0);
  feed(s, "J");
  assert.strictEqual(s.text, "foo bar");
});

test("J does not double a space when the line already ends in one", () => {
  const s = normal("foo \nbar", 0);
  feed(s, "J");
  assert.strictEqual(s.text, "foo bar");
});

test("3J joins three lines", () => {
  const s = normal("a\nb\nc", 0);
  feed(s, ["3", "J"]);
  assert.strictEqual(s.text, "a b c");
  assert.strictEqual(s.cursor, 3);
});

test("J on the last line is a no-op", () => {
  const s = normal("only", 0);
  feed(s, "J");
  assert.strictEqual(s.text, "only");
});

test(". repeats J", () => {
  const s = normal("x\ny\nz", 0);
  feed(s, "J"); // "x y\nz"
  assert.strictEqual(s.text, "x y\nz");
  feed(s, "."); // join again -> "x y z"
  assert.strictEqual(s.text, "x y z");
});

test("visual J joins all selected lines", () => {
  const s = normal("a\nb\nc\nd", 0);
  feed(s, ["V", "j", "j", "J"]); // select 3 lines, join
  assert.strictEqual(s.text, "a b c\nd");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
});

// ---- case change -----------------------------------------------------------

test("~ toggles the char under the cursor and advances", () => {
  const s = normal("hello", 0);
  feed(s, "~");
  assert.strictEqual(s.text, "Hello");
  assert.strictEqual(s.cursor, 1);
});

test("3~ toggles three chars", () => {
  const s = normal("hello", 0);
  feed(s, ["3", "~"]);
  assert.strictEqual(s.text, "HELlo");
  assert.strictEqual(s.cursor, 3);
});

test("gUiw uppercases the inner word", () => {
  const s = normal("foo bar", 0);
  feed(s, ["g", "U", "i", "w"]);
  assert.strictEqual(s.text, "FOO bar");
});

test("guiw lowercases the inner word", () => {
  const s = normal("FOO BAR", 0);
  feed(s, ["g", "u", "i", "w"]);
  assert.strictEqual(s.text, "foo BAR");
});

test("g~iw toggles the inner word", () => {
  const s = normal("Foo", 0);
  feed(s, ["g", "~", "i", "w"]);
  assert.strictEqual(s.text, "fOO");
});

test("gU$ uppercases to end of line", () => {
  const s = normal("abc def", 4);
  feed(s, ["g", "U", "$"]);
  assert.strictEqual(s.text, "abc DEF");
});

test("gUU uppercases the whole line", () => {
  const s = normal("foo\nbar", 0);
  feed(s, ["g", "U", "U"]);
  assert.strictEqual(s.text, "FOO\nbar");
});

test(". repeats gUiw on the next word", () => {
  const s = normal("foo bar baz", 0);
  feed(s, ["g", "U", "i", "w"]); // FOO bar baz
  feed(s, "w");
  feed(s, "."); // FOO BAR baz
  assert.strictEqual(s.text, "FOO BAR baz");
});

test("visual U uppercases the selection", () => {
  const s = normal("foo bar", 0);
  feed(s, ["v", "l", "l", "U"]);
  assert.strictEqual(s.text, "FOO bar");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
});

test("visual u lowercases the selection", () => {
  const s = normal("FOO BAR", 0);
  feed(s, ["v", "l", "l", "u"]);
  assert.strictEqual(s.text, "foo BAR");
});

test("visual g~ toggles the selection", () => {
  const s = normal("Foo", 0);
  feed(s, ["v", "l", "l", "g", "~"]);
  assert.strictEqual(s.text, "fOO");
});

// ---- indent / dedent -------------------------------------------------------

test(">> indents the line by one shiftwidth", () => {
  const s = normal("foo", 0);
  feed(s, [">", ">"]);
  assert.strictEqual(s.text, "    foo");
  assert.strictEqual(s.cursor, 4);
});

test("<< dedents the line", () => {
  const s = normal("    foo", 4);
  feed(s, ["<", "<"]);
  assert.strictEqual(s.text, "foo");
});

test("<< removes only up to one shiftwidth of leading space", () => {
  const s = normal("      foo", 6); // 6 spaces
  feed(s, ["<", "<"]);
  assert.strictEqual(s.text, "  foo"); // 2 left
});

test("2>> indents two lines", () => {
  const s = normal("a\nb\nc", 0);
  feed(s, ["2", ">", ">"]);
  assert.strictEqual(s.text, "    a\n    b\nc");
});

test(">j indents the two spanned lines", () => {
  const s = normal("a\nb\nc", 0);
  feed(s, [">", "j"]);
  assert.strictEqual(s.text, "    a\n    b\nc");
});

test(">ip indents the paragraph", () => {
  const s = normal("a\nb\n\nc", 0);
  feed(s, [">", "i", "p"]);
  assert.strictEqual(s.text, "    a\n    b\n\nc");
});

test(">> leaves an empty line untouched", () => {
  const s = normal("", 0);
  feed(s, [">", ">"]);
  assert.strictEqual(s.text, "");
});

test("visual > indents the selected lines once", () => {
  const s = normal("a\nb", 0);
  feed(s, ["V", "j", ">"]);
  assert.strictEqual(s.text, "    a\n    b");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
});

test("visual 2> uses the count as a shiftwidth multiplier", () => {
  const s = normal("a", 0);
  feed(s, ["v", "2", ">"]);
  assert.strictEqual(s.text, "        a"); // 8 spaces
});

test(". repeats >>", () => {
  const s = normal("a\nb", 0);
  feed(s, [">", ">"]); // "    a\nb"
  feed(s, "j");
  feed(s, "."); // indent line b too
  assert.strictEqual(s.text, "    a\n    b");
});

// ---- % (matching bracket) --------------------------------------------------

test("% jumps from an opening bracket to its match", () => {
  const s = normal("a(bc)d", 1);
  feed(s, "%");
  assert.strictEqual(s.cursor, 4);
});

test("% jumps from a closing bracket back to its match", () => {
  const s = normal("a(bc)d", 4);
  feed(s, "%");
  assert.strictEqual(s.cursor, 1);
});

test("% scans forward on the line when not on a bracket", () => {
  const s = normal("ab(cd)e", 0);
  feed(s, "%");
  assert.strictEqual(s.cursor, 5);
});

test("% respects nesting", () => {
  const s = normal("(a(b)c)", 0);
  feed(s, "%");
  assert.strictEqual(s.cursor, 6);
});

test("% matches across lines", () => {
  const s = normal("(\n)", 0);
  feed(s, "%");
  assert.strictEqual(s.cursor, 2);
});

test("d% deletes through the matching bracket inclusively", () => {
  const s = normal("x(yz)w", 1);
  feed(s, ["d", "%"]);
  assert.strictEqual(s.text, "xw");
});

test("% is a no-op when there is no bracket on the line", () => {
  const s = normal("abc", 0);
  feed(s, "%");
  assert.strictEqual(s.cursor, 0);
});

// ---- gq (reflow) -----------------------------------------------------------

test("gqq wraps a long line at textwidth", () => {
  const s = normal("aaaa bbbb cccc dddd eeee", 0);
  s.textwidth = 14;
  feed(s, ["g", "q", "q"]);
  assert.strictEqual(s.text, "aaaa bbbb cccc\ndddd eeee");
});

test("gqip reflows the whole paragraph", () => {
  const s = normal("one two three\nfour five six\nseven", 0);
  s.textwidth = 12;
  feed(s, ["g", "q", "i", "p"]);
  assert.strictEqual(s.text, "one two\nthree four\nfive six\nseven");
});

test("gq preserves a quote leader on every wrapped line", () => {
  const s = normal("> aaaa bbbb cccc dddd", 0);
  s.textwidth = 12;
  feed(s, ["g", "q", "q"]);
  assert.strictEqual(s.text, "> aaaa bbbb\n> cccc dddd");
});

test("gq lets a word longer than textwidth stand on its own line", () => {
  const s = normal("hi supercalifragilistic bye", 0);
  s.textwidth = 10;
  feed(s, ["g", "q", "q"]);
  assert.strictEqual(s.text, "hi\nsupercalifragilistic\nbye");
});

test("gqip stops at a blank line separating paragraphs", () => {
  const s = normal("aaaa bbbb cccc\n\ndddd eeee", 0);
  s.textwidth = 9;
  feed(s, ["g", "q", "i", "p"]);
  assert.strictEqual(s.text, "aaaa bbbb\ncccc\n\ndddd eeee");
});

test("visual gq reflows the selected lines", () => {
  const s = normal("aaaa bbbb cccc dddd", 0);
  s.textwidth = 12;
  feed(s, ["V", "g", "q"]);
  assert.strictEqual(s.text, "aaaa bbbb\ncccc dddd");
  assert.strictEqual(s.mode, vim.MODE.NORMAL);
});

test("visual gq wraps list items with hanging indents", () => {
  const s = normal("- aaaa bbbb cccc dddd\n- eeee ffff gggg hhhh", 0);
  s.textwidth = 12;
  feed(s, ["V", "j", "g", "q"]);
  assert.strictEqual(
    s.text,
    "- aaaa bbbb\n  cccc dddd\n- eeee ffff\n  gggg hhhh",
  );
});

test("visual gq preserves numbered items and existing continuations", () => {
  const s = normal(
    "1. one two three\n   four five\n2. six seven eight nine",
    0,
  );
  s.textwidth = 14;
  feed(s, ["V", "j", "j", "g", "q"]);
  assert.strictEqual(
    s.text,
    "1. one two\n   three four\n   five\n2. six seven\n   eight nine",
  );
});

test(". repeats gqip", () => {
  const s = normal("aaaa bbbb cccc dddd\n\neeee ffff gggg hhhh", 0);
  s.textwidth = 12;
  feed(s, ["g", "q", "i", "p"]);
  assert.strictEqual(s.text, "aaaa bbbb\ncccc dddd\n\neeee ffff gggg hhhh");
  feed(s, "G");
  feed(s, ".");
  assert.strictEqual(s.text, "aaaa bbbb\ncccc dddd\n\neeee ffff\ngggg hhhh");
});

// ---- s / S / X -------------------------------------------------------------

test("s deletes the char under the cursor and enters Insert", () => {
  const s = normal("abc", 1);
  feed(s, "s");
  assert.strictEqual(s.text, "ac");
  assert.strictEqual(s.cursor, 1);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("3s deletes three chars, bounded to the line", () => {
  const s = normal("abcdef\nghi", 4);
  feed(s, ["3", "s"]);
  assert.strictEqual(s.text, "abcd\nghi");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("S changes the whole line, keeping the blank line", () => {
  const s = normal("abc\ndef", 1);
  feed(s, "S");
  assert.strictEqual(s.text, "\ndef");
  assert.strictEqual(s.cursor, 0);
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("2S changes two lines", () => {
  const s = normal("one\ntwo\nthree", 0);
  feed(s, ["2", "S"]);
  assert.strictEqual(s.text, "\nthree");
  assert.strictEqual(s.mode, vim.MODE.INSERT);
});

test("X deletes the char before the cursor", () => {
  const s = normal("abc", 2);
  feed(s, "X");
  assert.strictEqual(s.text, "ac");
  assert.strictEqual(s.cursor, 1);
});

test("X stops at the start of the line", () => {
  const s = normal("ab\ncd", 4); // 'd', column 1
  feed(s, ["5", "X"]);
  assert.strictEqual(s.text, "ab\nd");
  assert.strictEqual(s.cursor, 3);
});

test("X is a no-op at column 0", () => {
  const s = normal("abc", 0);
  feed(s, "X");
  assert.strictEqual(s.text, "abc");
  assert.strictEqual(s.cursor, 0);
});

// ---- ge / gE ---------------------------------------------------------------

test("ge moves to the end of the previous word", () => {
  const s = normal("foo bar baz", 8); // on 'b' of baz
  feed(s, ["g", "e"]);
  assert.strictEqual(s.cursor, 6); // 'r' of bar
  feed(s, ["g", "e"]);
  assert.strictEqual(s.cursor, 2); // 'o' of foo
});

test("ge from mid-word lands on the previous word end", () => {
  const s = normal("foo bar", 5); // 'a' of bar
  feed(s, ["g", "e"]);
  assert.strictEqual(s.cursor, 2); // 'o' of foo
});

test("dge deletes back through the previous word end inclusively", () => {
  const s = normal("foo bar baz", 8);
  feed(s, ["d", "g", "e"]);
  assert.strictEqual(s.text, "foo baaz");
});

test("gE treats punctuation as part of the word", () => {
  const s = normal("foo.bar baz", 8); // 'b' of baz
  feed(s, ["g", "E"]);
  assert.strictEqual(s.cursor, 6); // 'r', end of 'foo.bar'
});

// ---- * / # -----------------------------------------------------------------

test("* jumps to the next occurrence of the word under the cursor", () => {
  const s = normal("foo bar foo baz foo", 0);
  feed(s, "*");
  assert.strictEqual(s.cursor, 8);
  feed(s, "n");
  assert.strictEqual(s.cursor, 16);
});

test("# searches backward for the word under the cursor", () => {
  const s = normal("foo bar foo baz foo", 16); // last foo
  feed(s, "#");
  assert.strictEqual(s.cursor, 8);
});

test("* matches whole words only", () => {
  const s = normal("foo foobar foo", 0);
  feed(s, "*");
  assert.strictEqual(s.cursor, 11); // skips 'foobar'
});

test("* from a non-word char uses the next word on the line", () => {
  const s = normal("(( foo )) foo", 0);
  feed(s, "*");
  assert.strictEqual(s.cursor, 10); // second 'foo'
});

// ---- search ----------------------------------------------------------------

test("setSearch jumps to the next match; n steps with wrap", () => {
  const s = normal("foo bar foo baz foo", 0);
  vim.setSearch(s, "foo", 1);
  assert.strictEqual(s.cursor, 8);
  vim.searchNext(s, false);
  assert.strictEqual(s.cursor, 16);
  const info = vim.searchNext(s, false);
  assert.strictEqual(s.cursor, 0);
  assert.strictEqual(info.wrapped, true);
});

test("N searches in the opposite direction", () => {
  const s = normal("a foo b foo c", 0);
  vim.setSearch(s, "foo", 1);
  assert.strictEqual(s.cursor, 2);
  vim.searchNext(s, false);
  assert.strictEqual(s.cursor, 8);
  vim.searchNext(s, true);
  assert.strictEqual(s.cursor, 2);
});

test("? searches backward", () => {
  const s = normal("x y x y x", 8);
  vim.setSearch(s, "x", -1);
  assert.strictEqual(s.cursor, 4);
});

test("smartcase: lowercase query is case-insensitive", () => {
  assert.strictEqual(vim.computeMatches("Foo foo FOO", "foo").length, 3);
});

test("smartcase: an uppercase letter makes the query case-sensitive", () => {
  const m = vim.computeMatches("Foo foo FOO", "Foo");
  assert.strictEqual(m.length, 1);
  assert.strictEqual(m[0].start, 0);
});

test("empty query reuses the last search", () => {
  const s = normal("a b a b a", 0);
  vim.setSearch(s, "a", 1);
  assert.strictEqual(s.cursor, 4);
  vim.setSearch(s, "", 1);
  assert.strictEqual(s.cursor, 8);
});

test("n does nothing when no search is set", () => {
  const s = normal("abc", 0);
  feed(s, "n");
  assert.strictEqual(s.cursor, 0);
});

test("Escape clears the search highlight flag", () => {
  const s = normal("a foo", 0);
  vim.setSearch(s, "foo", 1);
  assert.strictEqual(s.hlsearch, true);
  feed(s, ["<Esc>"]);
  assert.strictEqual(s.hlsearch, false);
});
