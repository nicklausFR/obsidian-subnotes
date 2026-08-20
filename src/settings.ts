import { App, PluginSettingTab, Setting } from 'obsidian';
import { InterfaceLanguage, translate } from './i18n';
import SubnotesPlugin from './main';

export type SubnoteFolderMode = 'same-folder' | 'fixed-folder';
export type IndicatorPosition = 'prefix' | 'suffix';
export type DefaultFoldState = 'expanded' | 'collapsed';
export type SubnoteStorageType = 'virtual' | 'file';
export type SubnoteColor =
  | 'note'
  | 'info'
  | 'todo'
  | 'tip'
  | 'success'
  | 'question'
  | 'warning'
  | 'failure'
  | 'danger'
  | 'bug'
  | 'example'
  | 'quote';

export interface SubnotesSettings {
  interfaceLanguage: InterfaceLanguage;
  folderMode: SubnoteFolderMode;
  fixedFolder: string;
  indicatorEnabled: boolean;
  indicator: string;
  indicatorPosition: IndicatorPosition;
  defaultFoldState: DefaultFoldState;
  defaultStorageType: SubnoteStorageType;
  subnoteColor: SubnoteColor;
  maxEmbedHeight: number;
  overflowFadeSize: number;
  customCssEnabled: boolean;
  customCss: string;
  resolveSubnotesOnCopy: boolean;
  knownSubnotes: string[];
}

export const DEFAULT_SETTINGS: SubnotesSettings = {
  interfaceLanguage: 'en',
  folderMode: 'same-folder',
  fixedFolder: 'Files',
  indicatorEnabled: true,
  indicator: '[sub]',
  indicatorPosition: 'prefix',
  defaultFoldState: 'expanded',
  defaultStorageType: 'file',
  subnoteColor: 'note',
  maxEmbedHeight: 150,
  overflowFadeSize: 34,
  customCssEnabled: false,
  customCss: '',
  resolveSubnotesOnCopy: true,
  knownSubnotes: [],
};

export class SubnotesSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SubnotesPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    const text = (key: Parameters<typeof translate>[1]): string =>
      translate(this.plugin.settings.interfaceLanguage, key);
    containerEl.empty();

    this.addSection(text('settingsSectionInterface'));

    new Setting(containerEl)
      .setName(text('interfaceLanguageName'))
      .setDesc(text('interfaceLanguageDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('en', translate('en', 'languageName'))
          .addOption('fr', translate('fr', 'languageName'))
          .setValue(this.plugin.settings.interfaceLanguage)
          .onChange(async (value) => {
            this.plugin.settings.interfaceLanguage = value as InterfaceLanguage;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    this.addSection(text('settingsSectionCreation'));

    new Setting(containerEl)
      .setName(text('subnoteLocationName'))
      .setDesc(text('subnoteLocationDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('same-folder', text('sameFolderOption'))
          .addOption('fixed-folder', text('fixedFolderOption'))
          .setValue(this.plugin.settings.folderMode)
          .onChange(async (value) => {
            this.plugin.settings.folderMode = value as SubnoteFolderMode;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.folderMode === 'fixed-folder') {
      new Setting(containerEl)
        .setName(text('fixedFolderName'))
        .setDesc(text('fixedFolderDesc'))
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
      .setName(text('filenameIndicatorName'))
      .setDesc(text('filenameIndicatorDesc'))
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
        .setName(text('indicatorName'))
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
        .setName(text('indicatorPositionName'))
        .addDropdown((dropdown) =>
          dropdown
            .addOption('prefix', text('prefixOption'))
            .addOption('suffix', text('suffixOption'))
            .setValue(this.plugin.settings.indicatorPosition)
            .onChange(async (value) => {
              this.plugin.settings.indicatorPosition = value as IndicatorPosition;
              await this.plugin.saveSettings();
            }),
        );
    }

    new Setting(containerEl)
      .setName(text('defaultSubnoteTypeName'))
      .setDesc(text('defaultSubnoteTypeDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('virtual', text('virtualOption'))
          .addOption('file', text('fileOption'))
          .setValue(this.plugin.settings.defaultStorageType)
          .onChange(async (value) => {
            this.plugin.settings.defaultStorageType = value as SubnoteStorageType;
            await this.plugin.saveSettings();
          }),
      );

    this.addSection(text('settingsSectionDisplay'));

    new Setting(containerEl)
      .setName(text('defaultFoldStateName'))
      .setDesc(text('defaultFoldStateDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('expanded', text('expandedOption'))
          .addOption('collapsed', text('collapsedOption'))
          .setValue(this.plugin.settings.defaultFoldState)
          .onChange(async (value) => {
            this.plugin.settings.defaultFoldState = value as DefaultFoldState;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(text('subnoteColorName'))
      .setDesc(text('subnoteColorDesc'))
      .addDropdown((dropdown) =>
        dropdown
          .addOption('note', text('colorNoteOption'))
          .addOption('info', text('colorInfoOption'))
          .addOption('todo', text('colorTodoOption'))
          .addOption('tip', text('colorTipOption'))
          .addOption('success', text('colorSuccessOption'))
          .addOption('question', text('colorQuestionOption'))
          .addOption('warning', text('colorWarningOption'))
          .addOption('failure', text('colorFailureOption'))
          .addOption('danger', text('colorDangerOption'))
          .addOption('bug', text('colorBugOption'))
          .addOption('example', text('colorExampleOption'))
          .addOption('quote', text('colorQuoteOption'))
          .setValue(this.plugin.settings.subnoteColor)
          .onChange(async (value) => {
            this.plugin.settings.subnoteColor = value as SubnoteColor;
            await this.plugin.saveSettings();
          }),
      );

    if (!this.plugin.settings.customCssEnabled) {
      new Setting(containerEl)
        .setName(text('maxEmbedHeightName'))
        .setDesc(text('maxEmbedHeightDesc'))
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

      new Setting(containerEl)
        .setName(text('overflowFadeHeightName'))
        .setDesc(text('overflowFadeHeightDesc'))
        .addSlider((slider) =>
          slider
            .setLimits(10, 100, 2)
            .setValue(this.plugin.settings.overflowFadeSize)
            .setDynamicTooltip()
            .onChange(async (value) => {
              this.plugin.settings.overflowFadeSize = value;
              await this.plugin.saveSettings();
            }),
        );
    }

    this.addSection(text('settingsSectionCopy'));

    new Setting(containerEl)
      .setName(text('copySubnoteContentsName'))
      .setDesc(text('copySubnoteContentsDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.resolveSubnotesOnCopy)
          .onChange(async (value) => {
            this.plugin.settings.resolveSubnotesOnCopy = value;
            await this.plugin.saveSettings();
          }),
      );

    this.addSection(text('settingsSectionAdvanced'));

    new Setting(containerEl)
      .setName(text('customCssName'))
      .setDesc(text('customCssDesc'))
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.customCssEnabled)
          .onChange(async (value) => {
            this.plugin.settings.customCssEnabled = value;
            await this.plugin.saveSettings();
            this.display();
          }),
      );

    if (this.plugin.settings.customCssEnabled) {
      new Setting(containerEl)
        .setName(text('customCssCodeName'))
        .setDesc(text('customCssCodeDesc'))
        .addTextArea((textarea) => {
          textarea
            .setPlaceholder(text('customCssPlaceholder'))
            .setValue(this.plugin.settings.customCss)
            .onChange(async (value) => {
              this.plugin.settings.customCss = value;
              await this.plugin.saveSettings();
            });

          textarea.inputEl.rows = 10;
          textarea.inputEl.addClass('obsidian-subnotes-custom-css-input');
        });
    }
  }

  private addSection(text: string): void {
    this.containerEl.createEl('h3', {
      text,
      cls: 'obsidian-subnotes-settings-heading',
    });
  }
}
