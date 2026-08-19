import { App, PluginSettingTab, Setting } from 'obsidian';
import SubnotesPlugin from './main';

export type SubnoteFolderMode = 'same-folder' | 'fixed-folder';
export type IndicatorPosition = 'prefix' | 'suffix';
export type DefaultFoldState = 'expanded' | 'collapsed';

export interface SubnotesSettings {
  folderMode: SubnoteFolderMode;
  fixedFolder: string;
  indicatorEnabled: boolean;
  indicator: string;
  indicatorPosition: IndicatorPosition;
  defaultFoldState: DefaultFoldState;
  maxEmbedHeight: number;
  resolveSubnotesOnCopy: boolean;
  knownSubnotes: string[];
}

export const DEFAULT_SETTINGS: SubnotesSettings = {
  folderMode: 'same-folder',
  fixedFolder: 'Files',
  indicatorEnabled: true,
  indicator: '[sub]',
  indicatorPosition: 'prefix',
  defaultFoldState: 'expanded',
  maxEmbedHeight: 150,
  resolveSubnotesOnCopy: true,
  knownSubnotes: [],
};

export class SubnotesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SubnotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName('Sub-note location')
      .setDesc('Store sub-notes beside the parent note or in a fixed folder.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('same-folder', 'Same folder as parent note')
          .addOption('fixed-folder', 'Fixed folder')
          .setValue(this.plugin.settings.folderMode)
          .onChange(async (value) => {
            this.plugin.settings.folderMode = value as SubnoteFolderMode;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.folderMode === 'fixed-folder') {
      new Setting(containerEl)
        .setName('Fixed folder')
        .setDesc('Path relative to the vault root, for example Files/Subnotes.')
        .addText((text) =>
          text
            .setPlaceholder('Files')
            .setValue(this.plugin.settings.fixedFolder)
            .onChange(async (value) => {
              this.plugin.settings.fixedFolder = value.trim();
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Filename indicator')
      .setDesc('Add an indicator such as [sub] to sub-note filenames.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.indicatorEnabled)
          .onChange(async (value) => {
            this.plugin.settings.indicatorEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.indicatorEnabled) {
      new Setting(containerEl)
        .setName('Indicator')
        .addText((text) =>
          text
            .setPlaceholder('[sub]')
            .setValue(this.plugin.settings.indicator)
            .onChange(async (value) => {
              this.plugin.settings.indicator = value.trim();
              await this.plugin.saveSettings();
            }),
        );

      new Setting(containerEl)
        .setName('Indicator position')
        .addDropdown((dropdown) =>
          dropdown
            .addOption('prefix', 'Prefix')
            .addOption('suffix', 'Suffix')
            .setValue(this.plugin.settings.indicatorPosition)
            .onChange(async (value) => {
              this.plugin.settings.indicatorPosition = value as IndicatorPosition;
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName('Default fold state')
      .setDesc('Initial state each time the parent note is opened.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('expanded', 'Expanded')
          .addOption('collapsed', 'Collapsed')
          .setValue(this.plugin.settings.defaultFoldState)
          .onChange(async (value) => {
            this.plugin.settings.defaultFoldState = value as DefaultFoldState;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Copy sub-note contents')
      .setDesc('When copying Markdown, replace sub-note embeds with their raw Markdown content.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.resolveSubnotesOnCopy)
          .onChange(async (value) => {
            this.plugin.settings.resolveSubnotesOnCopy = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Maximum embed height')
      .setDesc('Maximum visible height before vertical scrolling.')
      .addSlider((slider) =>
        slider
          .setLimits(60, 800, 10)
          .setValue(this.plugin.settings.maxEmbedHeight)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.maxEmbedHeight = value;
            await this.plugin.saveSettings();
          }),
      );
  }
}
