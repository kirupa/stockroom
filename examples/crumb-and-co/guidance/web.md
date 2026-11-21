---
for: [web]
summary: How pages on crumbandco.example are built, which components exist, and what every new page has to pass.
---

# Building pages

Every page on the site is plain HTML that pulls in two shared includes and two stylesheets. There is no framework, and we'd like to keep it that way.

## Page skeleton

Every page starts from the same skeleton:

1. `<!DOCTYPE html>`, `lang="en"`, and a viewport meta tag.
2. A `<title>` written as "Page name | Crumb & Co." and a one-sentence meta description.
3. `/css/tokens.css` first, then `/css/site.css`.
4. A `.page` wrapper that holds the header include, a single `<main id="main">`, and the footer include.
5. Page scripts go right before `</body>`.

The header and footer live in `/includes/header.html` and `/includes/footer.html`. Never copy their markup into a page. If the navigation needs a new link, change the header include, and every page gets it.

## Components

Use the components that already exist before writing new CSS. Each one is defined in `/css/site.css`:

- `.button` is the main action. `.button--quiet` is the secondary action. A page has one main action per screen.
- `.card` holds one menu item, with `.card__photo`, `.card__name`, `.card__blurb`, and `.card__price` inside it.
- `.menu-grid` lays out cards. It handles its own responsive columns.
- `.badge` sits in the top-left corner of a card. Use `.badge--fresh` and `.badge--sold-out`.
- `.field` wraps a label and its input. `.field__error` holds the error message for that input.
- `.hero` is the two-column intro at the top of the home page. Don't use it on other pages.

State classes start with `is-`, like `.is-sold-out`. JavaScript adds and removes them. Never style a state with an inline style.

## Design tokens

Every color, font, size, and radius comes from a token in `/css/tokens.css`. If you type a hex value in `site.css`, stop and find the token. If no token fits, ask before adding one, because the decks and figures use the same tokens.

- Text is `--ink`, secondary text is `--muted`, and headings are `--crust`.
- The page background is `--flour`.
- The one accent is `--primary`, with `--primary-ink` for text on top of it.
- Spacing is a multiple of `--space`.

## New pages

A new page needs all of these before it ships:

- The page skeleton above, with the right title format.
- A link from the header include if it belongs in the main navigation.
- Copy that follows voice.md.
- Every image has `width`, `height`, and alt text that says what's in the photo.
- It works in both themes. Toggle dark mode and look at every component.
- It works at 320px wide with no sideways scrolling.

## Fixing bugs

When something on the site looks broken, find out how many pages it touches before changing anything:

- For a broken image, check which pages reference the file, and whether the file was renamed.
- For a style that isn't applying, check that the class is defined in `site.css` and spelled the same way in the HTML or JavaScript.
- For anything in the header or footer, remember that the change lands on every page.

Change the smallest thing that fixes it. A fix that renames a class has to update every page and script that uses the class.

## Accessibility

- Every page has exactly one `<h1>`.
- Focus is always visible. The focus ring comes from `site.css`. Don't remove it.
- Text on `--primary` uses `--primary-ink`. Don't put `--muted` text on `--butter`, because the contrast is too low.
- Status messages, like the cart status, use `role="status"` so screen readers announce them.
