# Obsidian Subnotes

Obsidian plugin for creating, embedding, and managing lightweight sub-notes inside parent notes.

Current version: **0.2.5**

## Features

- Create a new sub-note from the editor context menu:
  - `Sub-notes → Nouvelle sub`
- Include an existing Markdown note as a sub-note:
  - `Sub-notes → Inclure une sub-note`
  - searchable note picker
  - existing/legacy notes are supported
- Choose where new sub-notes are stored:
  - same folder as the parent note
  - fixed folder
- Optional configurable filename indicator:
  - prefix or suffix
  - for example `[sub]My note`
- Existing notes use their filename as the default visible title.
- Change the visible title without renaming the underlying file.
- Collapsible sub-notes:
  - one fold/unfold control on the left of the title
  - configurable default state: expanded or collapsed
- Open a sub-note directly in edit mode from its edit button.
- Configurable maximum embed height with a single vertical scrollbar.
- Optional copy behavior:
  - when copying Markdown containing sub-notes, embedded sub-note references can be replaced by the actual raw Markdown content of those sub-notes
- Linked deletion handling:
  - detects removal of a sub-note embed
  - keeps the file when it is still referenced elsewhere
  - otherwise asks before moving the sub-note file to the Obsidian trash
- Handles file rename and move events.

## Example

A sub-note is stored in the parent Markdown as a normal Obsidian callout/embed:

```md
> [!note]+ My sub-note
> ![[Files/[sub]My sub-note]]
```

The referenced Markdown file remains a normal Obsidian note.

## Settings

Current settings include:

- sub-note location
- fixed folder
- filename indicator
- indicator position
- default fold state
- maximum embed height
- copy sub-note contents

## Installation

### Manual

Build the plugin, then copy these files into:

```text
<Vault>/.obsidian/plugins/obsidian-subnotes/
```

Required files:

```text
main.js
manifest.json
styles.css
```

Restart Obsidian or reload community plugins, then enable **Obsidian Subnotes**.

## Development

Install dependencies:

```bash
npm install
```

Development build:

```bash
npm run dev
```

Production build:

```bash
npm run build
```

## Compatibility

- Obsidian minimum version: `1.0.0`
- Desktop-only: no
