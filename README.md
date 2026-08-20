# Subnotes

Obsidian plugin for creating and managing lightweight sub-notes inside parent notes.

Current version: **0.3.0**

## Features

- Create sub-notes from the editor context menu or command palette.
- Choose between two sub-note types:
  - **File**: a normal Markdown file embedded in the parent note.
  - **Virtual**: Markdown stored directly inside the parent note.
- Include existing Markdown notes as sub-notes through a searchable picker.
- Edit sub-notes from their rendered card:
  - click the body for inline rendered editing;
  - use the edit icon to open the full editor.
- Rename the visible sub-note title without renaming the file.
- Use Markdown formatting in visible titles.
- Fold or unfold sub-notes, with a configurable default state.
- Use the same configurable callout color for file and virtual sub-notes.
- Store file sub-notes beside the parent note or in a fixed folder.
- Optionally add a configurable filename indicator, as prefix or suffix.
- Copy Markdown with embedded sub-note references resolved to raw content.
- Detect removed sub-note embeds and offer safe file cleanup.
- Handle file rename, move, and delete events.
- Switch the plugin interface between English and French.
- Configure built-in height/fade behavior or replace it with custom CSS.

## Markdown Format

File sub-note:

```md
> [!note]+ My sub-note
> ![[Files/[sub]My sub-note]]
```

Virtual sub-note:

```md
> [!subnote-virtual-id]+ My virtual sub-note
> Markdown content stays in the parent note.
```

## Settings

- Interface language: English or French.
- Creation and storage: default type, location, fixed folder, filename indicator.
- Display: default fold state, shared color, maximum embed height, overflow fade.
- Copy and cleanup: resolve sub-note contents on copy.
- Advanced CSS: custom CSS mode disables the built-in height and fade controls.

## Installation

Build the plugin, then copy these files into:

```text
<Vault>/.obsidian/plugins/subnotes/
```

Required files:

```text
main.js
manifest.json
styles.css
```

Reload Obsidian community plugins, then enable **Subnotes**.

## Development

```bash
npm install
npm run dev
npm run build
```

## Compatibility

- Obsidian minimum version: `1.0.0`
- Desktop-only: no

## License

GNU GPL v3. See `LICENSE`.
