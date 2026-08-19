import { App, Modal, Setting } from 'obsidian';

export class SubnoteNameModal extends Modal {
  private value = '';

  constructor(
    app: App,
    private readonly onSubmit: (name: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'New sub-note' });

    new Setting(contentEl)
      .setName('Name')
      .addText((text) => {
        text
          .setPlaceholder('Sub-note name')
          .onChange((value) => {
            this.value = value;
          });

        text.inputEl.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.submit();
          }
        });

        window.setTimeout(() => text.inputEl.focus(), 0);
      });

    new Setting(contentEl).addButton((button) =>
      button
        .setButtonText('Create')
        .setCta()
        .onClick(() => this.submit()),
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private submit(): void {
    const name = this.value.trim();
    if (!name) return;

    this.close();
    this.onSubmit(name);
  }
}
