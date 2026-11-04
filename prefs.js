// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Dash2Dock Plus+
// Preferences.

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

// Where the donations go: shown at the end of the preferences and opened in
// the browser by the Donate button.
const DONATE_LINK = 'https://ko-fi.com/centerstorms';

// The icons offered for the folder button: name in the icon theme + label.
const ICONS = [
    ['folder-symbolic', 'Folder (symbolic)'],
    ['folder', 'Folder (coloured)'],
    ['folder-download-symbolic', 'Downloads (symbolic)'],
    ['folder-download', 'Downloads (coloured)'],
    ['folder-pictures-symbolic', 'Pictures (symbolic)'],
    ['folder-pictures', 'Pictures (coloured)'],
    ['folder-documents-symbolic', 'Documents (symbolic)'],
    ['folder-music-symbolic', 'Music (symbolic)'],
    ['folder-videos-symbolic', 'Videos (symbolic)'],
    ['starred-symbolic', 'Star (symbolic)'],
    ['user-home-symbolic', 'Home (symbolic)'],
];
const CUSTOM_ICON = 'Image from my computer…';

export default class Dash2DockPlusPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: 'Dock',
            icon_name: 'zoom-in-symbolic',
        });
        window.add(page);

        const group = new Adw.PreferencesGroup({
            title: 'Magnification',
            description: 'This is an add-on for Dash to Dock: the dock must be ' +
                'installed and enabled for the effect to show up.',
        });
        page.add(group);

        const enabled = new Adw.SwitchRow({
            title: 'Enable magnification',
            subtitle: 'Grow the icon under the pointer and push its ' +
                'neighbours aside.',
        });
        settings.bind('magnification-enabled', enabled, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        group.add(this._createScaleRow(settings,
            'magnification-strength', 'Strength',
            'How much the icon under the pointer grows ' +
                '(0.45 means 1.45 times the normal size).',
            0.05, 1.0, 0.01, 2));

        group.add(this._createScaleRow(settings,
            'magnification-radius', 'Influence radius',
            'How many icons around the pointer are affected, ' +
                'in icon widths.',
            1.0, 6.0, 0.1, 1));

        const highlight = new Adw.SwitchRow({
            title: 'Highlight the icon under the pointer',
            subtitle: 'Light rounded background that Dash to Dock paints ' +
                'behind the icon the pointer is over.',
        });
        settings.bind('hover-highlight', highlight, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(highlight);

        this._addFolderGroup(page, settings, window);
        this._addSupportGroup(page, window);

        window.search_enabled = true;
    }

    /**
     * @param {Adw.PreferencesPage} page the page to add the group to
     * @param {Gio.Settings} settings this extension's settings
     * @param {Adw.PreferencesWindow} window the preferences window
     */
    _addFolderGroup(page, settings, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Folder',
            description: 'Show the contents of a folder on the dock, like a ' +
                'stack on macOS: clicking the folder opens a list of its ' +
                'newest files, each with its icon and its name.',
        });
        page.add(group);

        const enabled = new Adw.SwitchRow({
            title: 'Show a folder on the dock',
            subtitle: 'A folder button is added at the end of the dock.',
        });
        settings.bind('folder-enabled', enabled, 'active',
            Gio.SettingsBindFlags.DEFAULT);
        group.add(enabled);

        const row = new Adw.ActionRow({
            title: 'Folder',
            subtitle: this._folderSubtitle(settings),
        });

        const choose = new Gtk.Button({
            label: 'Choose…',
            valign: Gtk.Align.CENTER,
        });
        choose.connect('clicked', () => this._chooseFolder(settings, window));
        row.add_suffix(choose);

        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Clear',
            valign: Gtk.Align.CENTER,
        });
        clear.add_css_class('flat');
        clear.connect('clicked', () => settings.set_string('folder-path', ''));
        row.add_suffix(clear);

        group.add(row);

        for (const iconRow of this._createIconRow(settings, window))
            group.add(iconRow);

        group.add(this._createScaleRow(settings,
            'folder-tilt', 'Fan angle',
            'How far the list opens like a hand fan. 0 keeps the names ' +
                'straight and the list compact; 15 to 30 turn the rows around ' +
                'their icon, like the blades of a fan.',
            0, 30, 1, 0));

        // Only two lengths are offered: a fan of five or of ten files.
        const counts = [5, 10];
        const count = new Adw.ComboRow({
            title: 'Files shown',
            subtitle: 'How many files the list shows, newest first.',
            model: Gtk.StringList.new(counts.map(value => `${value} files`)),
        });

        const current = settings.get_int('folder-count');
        count.selected = counts.indexOf(current) >= 0
            ? counts.indexOf(current)
            : counts.length - 1;

        count.connect('notify::selected', () => {
            const value = counts[count.selected];
            if (value && settings.get_int('folder-count') !== value)
                settings.set_int('folder-count', value);
        });

        // An older value (the list used to show any number) is snapped to one
        // of the two choices.
        if (!counts.includes(current))
            settings.set_int('folder-count', counts[count.selected]);

        group.add(count);

        const id = settings.connect('changed::folder-path', () => {
            row.subtitle = this._folderSubtitle(settings);
        });
        row.connect('destroy', () => settings.disconnect(id));
    }

    /**
     * The icon of the folder button: a grid of pictures of the icons of the
     * theme, plus a button that takes an image file of the computer. The
     * pictures are shown instead of their names, a name is not much help when
     * choosing a folder icon.
     *
     * @param {Gio.Settings} settings this extension's settings
     * @param {Adw.PreferencesWindow} window the preferences window
     * @returns {Adw.ActionRow} the row
     */
    _createIconRow(settings, window) {
        const row = new Adw.ActionRow({
            title: 'Folder icon',
            subtitle: 'Pick a picture, or use an image from your computer.',
        });

        // The picture of the current choice, on the row itself.
        const preview = new Gtk.Image({pixel_size: 32});
        row.add_prefix(preview);

        const change = new Gtk.Button({
            label: 'Change',
            valign: Gtk.Align.CENTER,
        });
        row.add_suffix(change);

        // The grid of pictures: four per line, so the window stays narrow.
        const grid = new Gtk.FlowBox({
            selection_mode: Gtk.SelectionMode.NONE,
            column_spacing: 6,
            row_spacing: 6,
            min_children_per_line: 4,
            max_children_per_line: 4,
            homogeneous: true,
            margin_top: 12,
            margin_bottom: 8,
            margin_start: 12,
            margin_end: 12,
        });

        // The image of the computer: its own button, with its name, so that it
        // cannot be mistaken for one more folder icon.
        const ownPicture = new Gtk.Image({
            pixel_size: 24,
            icon_name: 'folder-pictures-symbolic',
        });
        const ownLabel = new Gtk.Label({
            label: CUSTOM_ICON,
            xalign: 0,
            hexpand: true,
        });
        const ownBox = new Gtk.Box({spacing: 8});
        ownBox.append(ownPicture);
        ownBox.append(ownLabel);

        const own = new Gtk.Button({
            child: ownBox,
            margin_top: 2,
            margin_bottom: 6,
            margin_start: 6,
            margin_end: 6,
        });
        own.add_css_class('flat');
        own.set_tooltip_text('Use a PNG, JPEG, SVG or WebP image as the icon');

        const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
        content.append(grid);
        content.append(new Gtk.Separator({
            margin_top: 4,
            margin_start: 12,
            margin_end: 12,
        }));
        content.append(own);

        const popover = new Gtk.Popover({has_arrow: true, child: content});
        popover.set_parent(change);
        change.connect('clicked', () => popover.popup());
        change.connect('destroy', () => popover.unparent());

        // Only one of the pictures can be active: the buttons are one group.
        let lead = null;
        const picture = (iconName) => {
            const image = new Gtk.Image({pixel_size: 32});
            image.set_from_icon_name(iconName);

            const choice = new Gtk.ToggleButton({
                child: image,
                valign: Gtk.Align.CENTER,
                tooltip_text: iconName,
            });
            if (lead)
                choice.set_group(lead);
            else
                lead = choice;

            grid.append(choice);
            return choice;
        };

        const choices = ICONS.map(([name, label]) => {
            const choice = picture(name);
            choice.tooltip_text = label;
            choice.choiceValue = name;
            choice.connect('toggled', () => {
                if (!choice.active)
                    return;

                if (settings.get_string('folder-icon') !== name)
                    settings.set_string('folder-icon', name);

                popover.popdown();
            });
            return choice;
        });

        // A row of its own for the image of the computer: the button of the
        // grid is easy to miss, and there is one file to choose here, not a
        // list of pictures.
        const fileRow = new Adw.ActionRow({
            title: 'Icon from my computer',
        });

        const choose = new Gtk.Button({
            label: 'Choose Image…',
            valign: Gtk.Align.CENTER,
        });
        fileRow.add_suffix(choose);

        const reset = new Gtk.Button({
            icon_name: 'edit-clear-symbolic',
            tooltip_text: 'Go back to the pictures of the theme',
            valign: Gtk.Align.CENTER,
            visible: false,
        });
        reset.add_css_class('flat');
        fileRow.add_suffix(reset);

        const updateFileRow = () => {
            const value = settings.get_string('folder-icon') || '';
            const custom = value.startsWith('/');
            fileRow.subtitle = custom
                ? GLib.path_get_basename(value)
                : 'PNG, JPEG, SVG or WebP.';
            if (reset.visible !== custom)
                reset.visible = custom;
        };

        choose.connect('clicked', () => {
            popover.popdown();
            this._chooseIconFile(settings, window, sync);
        });
        reset.connect('clicked', () => {
            if (settings.get_string('folder-icon') !== ICONS[0][0])
                settings.set_string('folder-icon', ICONS[0][0]);
        });

        const sync = () => {
            const value = settings.get_string('folder-icon') || ICONS[0][0];
            const known = choices.find(choice => choice.choiceValue === value);

            if (known) {
                known.active = true;
                own.remove_css_class('suggested-action');
            } else {
                for (const choice of choices) {
                    if (choice.active)
                        choice.active = false;
                }

                const exists = value.startsWith('/') &&
                    GLib.file_test(value, GLib.FileTest.EXISTS);
                if (exists) {
                    try {
                        ownPicture.set_from_file(value);
                    } catch (e) {
                        ownPicture.set_from_icon_name('folder-pictures-symbolic');
                    }
                } else {
                    ownPicture.set_from_icon_name('folder-pictures-symbolic');
                }

                // The button of the image of the computer is the chosen one.
                own.add_css_class('suggested-action');
                own.queue_draw();
            }

            try {
                if (value.startsWith('/') &&
                    GLib.file_test(value, GLib.FileTest.EXISTS))
                    preview.set_from_file(value);
                else if (value.startsWith('/'))
                    preview.set_from_icon_name('folder-symbolic');
                else
                    preview.set_from_icon_name(value);
            } catch (e) {
                preview.set_from_icon_name('folder-symbolic');
            }

            updateFileRow();
        };

        own.connect('clicked', () => {
            popover.popdown();
            this._chooseIconFile(settings, window, sync);
        });

        sync();

        const id = settings.connect('changed::folder-icon', sync);
        row.connect('destroy', () => settings.disconnect(id));

        return [row, fileRow];
    }

    /**
     * Ask for an image file and use it as the icon of the folder button.
     *
     * @param {Gio.Settings} settings this extension's settings
     * @param {Adw.PreferencesWindow} window the preferences window
     * @param {Function} sync puts the row back on the current choice
     */
    _chooseIconFile(settings, window, sync) {
        const filter = new Gtk.FileFilter();
        filter.set_name('Images');
        filter.add_mime_type('image/png');
        filter.add_mime_type('image/jpeg');
        filter.add_mime_type('image/svg+xml');
        filter.add_mime_type('image/webp');

        const filters = new Gio.ListStore({item_type: Gtk.FileFilter.$gtype});
        filters.append(filter);

        const dialog = new Gtk.FileDialog({
            title: 'Choose the icon of the folder',
            modal: true,
            filters,
            default_filter: filter,
        });

        dialog.open(window, null, (source, result) => {
            let path = null;
            try {
                path = source.open_finish(result)?.get_path() ?? null;
            } catch (e) {
                // The dialog was cancelled: the previous choice stays.
            }

            if (path && settings.get_string('folder-icon') !== path)
                settings.set_string('folder-icon', path);

            // On a cancel the picture of the computer was left active by the
            // click: put the row back on the choice that is really used.
            sync();
        });
    }

    /**
     * The donation section, at the very end of the page.
     *
     * @param {Adw.PreferencesPage} page the page to add the group to
     * @param {Adw.PreferencesWindow} window the preferences window
     */
    _addSupportGroup(page, window) {
        const group = new Adw.PreferencesGroup({
            title: 'Support',
            description: 'Dash2Dock Plus+ is free software. If it makes your ' +
                'desktop nicer, you can buy me a coffee.',
        });
        page.add(group);

        const row = new Adw.ActionRow({
            title: 'Buy me a coffee on Ko-fi',
            subtitle: DONATE_LINK,
        });

        const donate = new Gtk.Button({
            label: 'Donate',
            valign: Gtk.Align.CENTER,
        });
        donate.add_css_class('suggested-action');
        donate.connect('clicked', () => {
            const launcher = new Gtk.UriLauncher({uri: DONATE_LINK});
            launcher.launch(window, null, (source, result) => {
                try {
                    source.launch_finish(result);
                } catch (e) {
                    // Nothing to do: the browser refused to open.
                }
            });
        });
        row.add_suffix(donate);

        group.add(row);
    }

    /**
     * @param {Gio.Settings} settings this extension's settings
     * @returns {string} the path of the chosen folder, or a hint
     */
    _folderSubtitle(settings) {
        const path = settings.get_string('folder-path');
        if (!path)
            return 'No folder selected';

        const home = GLib.get_home_dir();
        if (path === home)
            return '~';
        if (path.startsWith(`${home}/`))
            return `~${path.slice(home.length)}`;
        return path;
    }

    /**
     * @param {Gio.Settings} settings this extension's settings
     * @param {Adw.PreferencesWindow} window the preferences window
     */
    _chooseFolder(settings, window) {
        const dialog = new Gtk.FileDialog({
            title: 'Choose a folder',
            modal: true,
        });

        const path = settings.get_string('folder-path');
        if (path)
            dialog.set_initial_folder(Gio.File.new_for_path(path));

        dialog.select_folder(window, null, (source, result) => {
            try {
                const file = source.select_folder_finish(result);
                if (file)
                    settings.set_string('folder-path', file.get_path());
            } catch (e) {
                // The dialog was cancelled.
            }
        });
    }

    _createScaleRow(settings, key, title, subtitle, lower, upper, step, digits) {
        const row = new Adw.ActionRow({title, subtitle});

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({
                lower,
                upper,
                step_increment: step,
                page_increment: step * 10,
            }),
            digits,
            draw_value: true,
            value_pos: Gtk.PositionType.RIGHT,
            hexpand: true,
            width_request: 200,
            valign: Gtk.Align.CENTER,
        });

        scale.set_value(settings.get_double(key));
        scale.connect('value-changed', () => {
            settings.set_double(key, scale.get_value());
        });

        // Keep the slider in sync when the value is changed elsewhere.
        const id = settings.connect(`changed::${key}`, () => {
            const value = settings.get_double(key);
            if (Math.abs(scale.get_value() - value) > step / 2)
                scale.set_value(value);
        });

        scale.connect('destroy', () => settings.disconnect(id));

        row.add_suffix(scale);

        return row;
    }
}
