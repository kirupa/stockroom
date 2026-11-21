---
for: [illustration]
summary: How Crumb & Co. figures look, for the blog, the menu boards, and the decks.
---

# Illustrations

Every figure teaches one thing. Before drawing anything, write down that one thing in a sentence.

## Before you draw

- Check the figure library for one that already does the job. Reuse beats redraw.
- Write the teaching point in one sentence.
- List the objects that appear. Every object should be something a customer would recognize.

## Objects, not words

- Draw the real object: a phone, an order ticket, the oven, a pastry box. Use the icons in `/icons` before drawing a new one.
- Never stand a labeled rectangle in for a thing that has a shape. "Kitchen" in a gray box is a rejection.
- Labels sit under or beside their object, in `--font-body`.

## Color

- Backgrounds are `--flour`.
- Outlines are `--crust` at `--figure-stroke` width.
- Fills are `--butter` or `--flour`.
- Arrows and the one thing you're pointing at are `--primary`.
- Nothing else. If a figure needs a color that isn't a token, it probably has too many things in it.

## Handwritten callouts

- Callouts use `--font-hand` in `--primary`.
- A callout is three to six words. If it needs more, it belongs in the text around the figure.
- One or two callouts per figure, at most.
- Every callout has an arrow. See arrows.md for where the arrow starts and how it bends.

## Layout

- Things that happen in order go left to right.
- Leave room. If arrows feel cramped, make the figure wider instead of bending the arrows harder.
- Text never touches an outline. Keep at least `--space` of room.

## Checks before review

- Only token colors appear in the SVG.
- Every arrow stops short of its target.
- Every label is at least 18px at the figure's final size.
- The figure has a `<title>` and a `<desc>` that says what it teaches.
