// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Dash2Dock Plus+
// Folder button on the dock, macOS "stack" style.
//
// A folder chosen in the preferences is shown as a button at the end of the
// Dash to Dock dock. Clicking it opens a list with the newest files of that
// folder (icon + name pill, like the Finder stacks); clicking an entry opens
// it with the default application.
//
// Nothing here touches Dash to Dock: the button is added next to the icon box
// and the magnification effect picks it up like any other icon.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

// The list only offers two lengths, see the preferences.
const MIN_ENTRIES = 5;
const MAX_ENTRIES = 10;
// The list is a column of rows; every row may be turned around its icon, which
// keeps the icons on one single column on the right while the name pills open
// to the left like the blades of a hand fan. This is the upper bound of the
// "folder-tilt" setting (0 keeps the names straight).
const MAX_TILT = 30.0;
// Space between the bounding boxes of two neighbouring rows.
const FAN_GAP = 6;
// Where the centre of a row icon is, from the right edge of the row.
const FAN_ICON_INSET = 15;
// Space left between the list and the dock: close to it, but the rows must not
// run into the dock background.
const DOCK_GAP = 10;
// Entries are sorted by modification time, so a huge folder would be read in
// full; stop after this many and show the newest ones instead.
const MAX_SCAN = 1000;
const ENTRY_ICON_SIZE = 30;
// Characters shown in the name pill before the name is ellipsized.
const LABEL_LENGTH = 26;
// Extra pixels around the folder icon that still count as a click on it.
const FAN_CLICK_MARGIN = 4;
// Space between the rows of the plain stack.
const ROW_SPACING = 2;

export class DockFolder {
    /**
     * @param {St.Widget} dash the Dash to Dock dash actor
     * @param {Gio.Settings} settings this extension's settings
     */
    constructor(dash, settings) {
        this._dash = dash;
        this._settings = settings;

        this._actor = null;
        this._button = null;
        this._icon = null;
        this._popup = null;
        this._opened = false;
        this._rows = [];

        this._sizeId = 0;
        this._visibilityId = 0;
        this._settingsId = this._settings.connect('changed', () =>
            this._sync());

        // The bridge between the dock and this object is not reliable for
        // input: Dash to Dock lays the icon out with one size and we scale it
        // with the magnifier, so a click on the *visible* icon can land
        // outside the button's allocation. The clicks are therefore caught on
        // the stage and hit tested against the transformed icon.
        this._pressedInside = false;
        this._stageId = global.stage.connect('captured-event',
            (actor, event) => this._onCapturedEvent(event));

        this._sync();
    }

    destroy() {
        if (this._stageId) {
            try {
                global.stage.disconnect(this._stageId);
            } catch (e) {
                // Ignore.
            }
            this._stageId = 0;
        }

        if (this._settingsId && this._settings) {
            try {
                this._settings.disconnect(this._settingsId);
            } catch (e) {
                // Ignore.
            }
            this._settingsId = 0;
        }

        this._destroyActor();
        this._dash = null;
        this._settings = null;
    }

    /** Create or remove the button, depending on the settings. */
    _sync() {
        if (!this._dash || !this._settings)
            return;

        const enabled = this._settings.get_boolean('folder-enabled');
        const path = this._settings.get_string('folder-path');

        if (enabled && path) {
            this._ensureActor();
            this._applyIcon();
        } else {
            this._destroyActor();
        }
    }

    /** @returns {number} the icon size used by the dock */
    _iconSize() {
        const size = this._dash?.iconSize;
        return size > 0 ? size : 48;
    }

    _ensureActor() {
        // Only Dash to Dock has an icon box next to its icons; without it the
        // button has nowhere to go (this is what happens when the dock is
        // another extension that fakes the "dashtodockContainer" name).
        if (!this._dash?._boxContainer) {
            if (!this._warnedNoBox) {
                this._warnedNoBox = true;
                console.warn('[dash2dock-plus] folder: no Dash to Dock icon ' +
                    'box, the folder button is not added');
            }
            return;
        }

        if (this._actor) {
            if (this._actor.get_parent() !== this._dash?._boxContainer)
                this._dash?._boxContainer?.add_child(this._actor);
            return;
        }

        // A button of ours may already be there: a dock recreated by Dash to
        // Dock leaves its old container behind, and the user ends up with two
        // folder icons. Only one is allowed.
        for (const child of this._dash._boxContainer.get_children()) {
            if (child.name === 'd2dm-folder-container')
                child.destroy();
        }

        this._icon = new St.Icon({
            icon_size: this._iconSize(),
            style_class: 'd2dm-folder-icon',
        });
        this._applyIcon();

        this._button = new St.Button({
            style_class: 'app-well-app d2dm-folder-button',
            can_focus: true,
            track_hover: true,
            accessible_name: 'Folder',
            x_expand: false,
            y_expand: false,
            child: this._icon,
        });
        // The magnification effect reads <container>.child.icon to find the
        // actor it has to scale, exactly like it does for Dash to Dock icons.
        this._button.icon = this._icon;

        this._actor = new St.Bin({
            name: 'd2dm-folder-container',
            style_class: 'dash-item-container',
            x_expand: false,
            y_expand: false,
            child: this._button,
        });

        // Dash to Dock emits this when the icons change size (settings,
        // monitor size, ...): ours has to follow.
        this._sizeId = this._dash.connect('icon-size-changed',
            () => this._syncIconSize());

        // The list has to go away with the dock (autohide).
        this._visibilityId = this._dash.connect('notify::visible', () => {
            if (!this._dash?.visible)
                this._close();
        });

        this._dash._boxContainer?.add_child(this._actor);

        try {
            this._ensurePopup();
        } catch (e) {
            console.error(`[dash2dock-plus] folder: cannot create the list ` +
                `(${e.message})`);
            console.error(e.stack ?? '');
        }
    }

    _destroyActor() {
        if (this._sizeId && this._dash) {
            try {
                this._dash.disconnect(this._sizeId);
            } catch (e) {
                // Ignore.
            }
            this._sizeId = 0;
        }

        if (this._visibilityId && this._dash) {
            try {
                this._dash.disconnect(this._visibilityId);
            } catch (e) {
                // Ignore.
            }
            this._visibilityId = 0;
        }

        this._destroyPopup();

        this._actor?.destroy();
        this._actor = null;
        this._button = null;
        this._icon = null;
        this._rows = [];
    }

    /**
     * Use the icon chosen in the preferences: the name of an icon of the theme,
     * or the absolute path of an image file.
     */
    _applyIcon() {
        if (!this._icon || !this._settings)
            return;

        let choice = 'folder-symbolic';
        try {
            choice = this._settings.get_string('folder-icon') || choice;
        } catch (e) {
            // Keep the default.
        }

        try {
            if (choice.startsWith('/')) {
                const file = Gio.File.new_for_path(choice);
                this._icon.gicon = new Gio.FileIcon({file});
            } else {
                this._icon.gicon = null;
                this._icon.icon_name = choice;
            }
        } catch (e) {
            console.warn(`[dash2dock-plus] folder: icon "${choice}" (${e.message})`);
        }
    }

    /** Keep our icon the same size as the icons of Dash to Dock. */
    _syncIconSize() {
        if (!this._icon)
            return;

        const size = this._iconSize();
        if (size > 0 && this._icon.icon_size !== size)
            this._icon.icon_size = size;
    }

    _destroyPopup() {
        this._opened = false;

        if (this._overviewId) {
            try {
                Main.overview.disconnect(this._overviewId);
            } catch (e) {
                // Ignore.
            }
            this._overviewId = 0;
        }
        this._popupHooked = false;

        if (!this._popup)
            return;

        try {
            this._popup.destroy();
        } catch (e) {
            // Ignore.
        }
        this._popup = null;
        this._rows = [];
    }

    /**
     * The list has to go away with the overview; hook that once.
     */
    _ensurePopup() {
        if (this._popupHooked)
            return;

        this._popupHooked = true;
        this._overviewId = Main.overview.connect('hiding', () => this._close());
    }

    /**
     * Handle the clicks of the folder icon and the closing of the list.
     *
     * @param {Clutter.Event} event the event
     * @returns {number} whether the event was handled
     */
    _onCapturedEvent(event) {
        const type = event.type();

        if (type === Clutter.EventType.KEY_PRESS) {
            if (this._isOpen() &&
                event.get_key_symbol() === Clutter.KEY_Escape) {
                this._close();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        }

        if (type !== Clutter.EventType.BUTTON_PRESS &&
            type !== Clutter.EventType.BUTTON_RELEASE)
            return Clutter.EVENT_PROPAGATE;

        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;

        const pressedInside = this._isOnButton(event);

        if (type === Clutter.EventType.BUTTON_PRESS) {
            this._pressedInside = pressedInside;

            if (!pressedInside) {
                // Inside the list: the row buttons handle it.
                if (this._isInMenu(event))
                    return Clutter.EVENT_PROPAGATE;

                this._close();
            }

            return Clutter.EVENT_PROPAGATE;
        }

        // Release: only a press and a release on the icon activate it.
        const activate = this._pressedInside && pressedInside;
        this._pressedInside = false;

        if (!activate)
            return Clutter.EVENT_PROPAGATE;

        this._toggle();

        // Let the event through: St.Button keeps its own pressed state in the
        // release, and nothing else acts on clicks over our container.
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * @param {Clutter.Event} event the event
     * @returns {boolean} whether the pointer is over the folder icon
     */
    _isOnButton(event) {
        return this._contains(event, this._icon, FAN_CLICK_MARGIN);
    }

    /**
     * @returns {boolean} whether the list is on screen
     */
    _isOpen() {
        return Boolean(this._opened && this._popup?.visible);
    }

    /**
     * @param {Clutter.Event} event the event
     * @returns {boolean} whether the pointer is over the open list
     */
    _isInMenu(event) {
        if (!this._isOpen())
            return false;

        if (this._rows.length)
            return this._rows.some(row => this._contains(event, row, 2));

        return this._contains(event, this._popup, 0);
    }

    /**
     * @param {Clutter.Event} event the event
     * @param {St.Widget} actor the actor to test against
     * @param {number} margin extra pixels around the actor
     * @returns {boolean} whether the pointer is over the actor
     */
    _contains(event, actor, margin) {
        if (!actor)
            return false;

        try {
            const [px, py] = event.get_coords();
            const [x, y] = actor.get_transformed_position();
            const [w, h] = actor.get_transformed_size();

            return px >= x - margin && px <= x + w + margin &&
                py >= y - margin && py <= y + h + margin;
        } catch (e) {
            return false;
        }
    }

    _toggle() {
        if (this._isOpen()) {
            this._close();
            return;
        }

        this._open();
    }

    _close() {
        this._opened = false;
        this._popup?.hide();
    }

    /**
     * The actor of Dash to Dock that draws the dock, background included: the
     * dash actor passed to us is inside it, and the background reaches further
     * up than the dash does.
     *
     * @returns {St.Widget} the outer actor of the dock
     */
    _dockActor() {
        const uiGroup = Main.layoutManager.uiGroup ?? Main.uiGroup;

        let actor = this._dash;
        let outer = this._dash;

        try {
            while (actor?.get_parent() && actor.get_parent() !== uiGroup) {
                actor = actor.get_parent();
                outer = actor;
            }
        } catch (e) {
            // Fall back to the dash.
        }

        return outer ?? this._dash;
    }

    /** Build the list and put it above the dock. */
    _open() {
        this._ensurePopup();

        // Rebuild before showing so that the list is positioned with its final
        // size (the folder may have changed in the meantime).
        try {
            this._rebuild();
        } catch (e) {
            console.error(`[dash2dock-plus] folder: cannot read the folder ` +
                `(${e.message})`);
            console.error(e.stack ?? '');
            return;
        }

        const popup = this._popup;
        if (!popup)
            return;

        // The popup is the last child of the ui group, above the dock.
        try {
            popup.get_parent()?.set_child_above_sibling(popup, null);
        } catch (e) {
            // Ignore.
        }

        const [, width] = popup.get_preferred_width(-1);
        const [, height] = popup.get_preferred_height(width);

        let x = 0;
        let y = 0;
        try {
            const [bx, by] = this._button.get_transformed_position();
            const [bw, bh] = this._button.get_transformed_size();

            // The dock itself (the actor of the background), not the dash
            // inside it: the background reaches further up than the dash, and
            // the list has to stay above the background.
            const dock = this._dockActor();
            const [dx, dy] = dock.get_transformed_position();
            const [dw] = dock.get_transformed_size();
            const side = this._dash?._position ?? St.Side.BOTTOM;

            if (side === St.Side.LEFT) {
                x = dx + dw + DOCK_GAP;
                y = by + bh - height;
            } else if (side === St.Side.RIGHT) {
                x = dx - width - DOCK_GAP;
                y = by + bh - height;
            } else {
                // The column of icons sits over the button, the last row just
                // above the dock.
                x = bx + bw / 2 - (width - FAN_ICON_INSET);
                y = dy - height - DOCK_GAP;
            }
        } catch (e) {
            console.warn(`[dash2dock-plus] folder: cannot place the list ` +
                `(${e.message})`);
        }

        // Keep it on screen.
        try {
            const index = Main.layoutManager.findIndexForActor(this._button);
            const monitor = Main.layoutManager.monitors[index] ??
                Main.layoutManager.primaryMonitor;

            if (monitor) {
                x = Math.max(monitor.x,
                    Math.min(x, monitor.x + monitor.width - width));
                y = Math.max(monitor.y,
                    Math.min(y, monitor.y + monitor.height - height));
            }
        } catch (e) {
            // Ignore: the position of the first try is good enough.
        }

        popup.set_position(Math.round(x), Math.round(y));
        popup.show();
        this._opened = true;
    }

    /**
     * Fill the popup with the current contents of the folder.
     */
    _rebuild() {
        this._popup?.destroy();
        this._popup = null;
        this._rows = [];

        // A plain widget of ours, dropped straight into the ui group: there is
        // no PopupMenu, no BoxPointer and no container with a theme class, so
        // nothing can paint a panel behind the list. The name pills are the
        // only thing that is drawn.
        const uiGroup = Main.layoutManager.uiGroup ?? Main.uiGroup;

        const path = this._settings.get_string('folder-path');
        const entries = path ? this._readFolder(path) : null;

        if (!path) {
            this._popup = this._message('No folder selected');
            uiGroup.add_child(this._popup);
            return;
        }

        if (entries === null) {
            this._popup = this._message('Folder not found');
            uiGroup.add_child(this._popup);
            return;
        }

        if (!entries.length) {
            this._popup = this._message('This folder is empty');
            uiGroup.add_child(this._popup);
            return;
        }

        // St.BoxLayout has no "spacing" property any more (GNOME 49+): spacing
        // is a style property, and St overwrites the layout spacing with it on
        // every style change. Set it inline so that the rows keep it even if
        // the stylesheet is not applied.
        const fan = new St.BoxLayout({vertical: true, style_class: 'd2dm-fan'});
        fan.set_style(`spacing: ${ROW_SPACING}px;`);

        const rows = entries.map(entry => {
            const row = this._createRow(entry);
            fan.add_child(row);
            return row;
        });

        uiGroup.add_child(fan);
        this._popup = fan;
        this._rows = rows;

        // The rows are measured here, once they are in their container.
        this._fan(fan, rows);
    }

    /**
     * Lay the rows out.
     *
     * The rows are a plain column: the icons are right aligned on one single
     * line, the newest entry on top and the oldest one against the dock. Every
     * row is turned around the centre of its own icon by the "folder-tilt"
     * setting (0 by default, i.e. a straight column), and the container gets
     * the padding that the rotation needs, so that nothing is painted outside
     * of the popup and every click lands on its row.
     *
     * @param {St.BoxLayout} fan container of the rows
     * @param {Array<St.Button>} rows the rows, newest first
     */
    _fan(fan, rows) {
        const n = rows.length;
        if (!n)
            return;

        const [, width] = fan.get_preferred_width(-1);
        if (!width)
            return;

        // Every row gets the width of the list: the icons then sit on one
        // single column on the right, whatever the length of the names. This
        // is done with an explicit width because the default cross axis
        // alignment of the rows is not the same on every Shell version.
        for (const row of rows) {
            row.set_width(width);
            row.entryBox?.set_width(width);
        }

        let tilt = 0;
        try {
            tilt = this._settings.get_double('folder-tilt');
        } catch (e) {
            // Keep the straight column.
        }
        tilt = Math.max(0, Math.min(MAX_TILT, tilt));

        const half = ENTRY_ICON_SIZE / 2;
        const iconX = width - FAN_ICON_INSET;

        // Geometry of every row relative to the centre of its icon: how far it
        // reaches up, down and to the sides once it is turned.
        const blades = rows.map((row, i) => {
            const angle = n > 1 ? tilt * (n - 1 - i) / (n - 1) : 0;
            const a = angle * Math.PI / 180;
            const cos = Math.cos(a);
            const sin = Math.sin(a);

            const rowWidth = row.get_preferred_width(-1)[1] || width;
            const rowHeight = row.get_preferred_height(-1)[1] || ENTRY_ICON_SIZE;
            const pillHeight = Math.max(ENTRY_ICON_SIZE, rowHeight - 4);
            const reach = Math.max(half, rowWidth - FAN_ICON_INSET);

            let up = half;
            let down = half;
            let right = half;

            // Corners of the name pill, turned around the icon.
            for (const [x, y] of [[-reach, -pillHeight / 2],
                [-reach, pillHeight / 2],
                [-(half + 8), -pillHeight / 2],
                [-(half + 8), pillHeight / 2]]) {
                const rx = x * cos - y * sin;
                const ry = x * sin + y * cos;

                up = Math.max(up, -ry);
                down = Math.max(down, ry);
                right = Math.max(right, rx);
            }

            return {angle, up, down, right, rowHeight};
        });

        // Where the rows sit in the plain stack, from the top of the list.
        const tops = [];
        let stack = 0;
        for (let i = 0; i < n; i++) {
            tops.push(stack);
            stack += blades[i].rowHeight + ROW_SPACING;
        }

        // Stack them by their bounding boxes, walking up from the oldest row:
        // the gaps the eye sees stay even and two rows never overlap.
        const centres = new Array(n).fill(0);
        for (let i = n - 2; i >= 0; i--) {
            centres[i] = centres[i + 1] -
                (blades[i + 1].down + FAN_GAP + blades[i].up);
        }

        // Move the whole list so that it starts at 0,0: the container is then
        // exactly as tall as the list and the last row can stand on the dock.
        const minY = Math.min(...centres.map((y, i) => y - blades[i].up));
        const maxY = Math.max(...centres.map((y, i) => y + blades[i].down));
        const maxX = Math.max(...blades.map(b => iconX + b.right));

        rows.forEach((row, i) => {
            row.set_pivot_point(iconX / width, 0.5);
            row.rotation_angle_z = blades[i].angle;
            row.translation_x = 0;
            row.translation_y = -minY + centres[i] -
                (tops[i] + blades[i].rowHeight / 2);

            // The icon is turned back so that it stays upright, like the icons
            // of the dock.
            if (row.entryIcon) {
                row.entryIcon.set_pivot_point(0.5, 0.5);
                row.entryIcon.rotation_angle_z = -blades[i].angle;
            }
        });

        // Only the space the turned pills need outside of the stack.
        const right = Math.max(0, Math.ceil(maxX - width));
        const bottom = Math.max(0, Math.ceil(maxY - minY - stack));

        fan.set_style(`padding: 0px ${right}px ${bottom}px 0px; ` +
            `spacing: ${ROW_SPACING}px;`);
    }

    /**
     * @param {string} text message shown instead of the list
     * @returns {St.Label} a small dark pill
     */
    _message(text) {
        return new St.Label({
            text,
            style_class: 'd2dm-fan-message',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
    }

    /**
     * One file: its icon on the right, its name in a dark pill on the left.
     *
     * @param {object} entry a file of the folder
     * @returns {St.Button} the row
     */
    _createRow(entry) {
        const params = {
            icon_size: ENTRY_ICON_SIZE,
            style_class: 'd2dm-fan-icon',
        };

        // Images and videos already thumbnailed by the file manager look much
        // closer to the reference; the icon of the file type is the fallback.
        const thumbnail = this._thumbnailFor(entry.file);
        if (thumbnail)
            params.gicon = thumbnail;
        else if (entry.icon)
            params.gicon = entry.icon;
        else
            params.icon_name = 'text-x-generic-symbolic';

        const icon = new St.Icon(params);

        const label = new St.Label({
            text: this._shorten(entry.name),
        });
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.line_wrap = false;
        label.set_style('color: #ffffff; font-size: 11pt;');

        const pill = new St.Bin({
            style_class: 'd2dm-fan-pill',
            child: label,
            y_align: Clutter.ActorAlign.CENTER,
        });
        pill.set_style(this._pillStyle(false));

        const box = new St.BoxLayout({
            style_class: 'd2dm-fan-row',
            x_align: Clutter.ActorAlign.FILL,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        // Pushes the pill and the icon to the right edge, so that the icons of
        // all the rows line up, like in the Finder.
        box.add_child(new St.Widget({x_expand: true}));
        box.add_child(pill);
        box.add_child(icon);

        const button = new St.Button({
            style_class: 'd2dm-fan-entry',
            can_focus: true,
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            child: box,
        });
        // The rotation is done on the row, and turns this icon back so that it
        // stays upright.
        button.entryIcon = icon;
        button.entryBox = box;
        button.set_style('background-color: transparent; padding: 0;');

        // The hover feedback is done here rather than in the stylesheet so
        // that it keeps working even if a theme overrides our rules.
        button.connect('notify::hover', () => {
            pill.set_style(this._pillStyle(button.hover));
        });

        button.connect('clicked', () => {
            this._close();
            this._openFile(entry.file);
        });

        return button;
    }

    /**
     * @param {boolean} hovered whether the row is hovered
     * @returns {string} the style of the name pill
     */
    _pillStyle(hovered) {
        const color = hovered ? 'rgba(48, 48, 48, 0.95)' : 'rgba(0, 0, 0, 0.78)';
        return `background-color: ${color}; border-radius: 16px; ` +
            'padding: 6px 14px; margin-right: 14px;';
    }

    /**
     * @param {string} name file name
     * @returns {string} the name, short enough for a pill
     */
    _shorten(name) {
        if (name.length <= LABEL_LENGTH)
            return name;
        return `${name.slice(0, LABEL_LENGTH)}…`;
    }

    /**
     * @param {Gio.File} file file to open with its default application
     */
    _openFile(file) {
        try {
            Gio.AppInfo.launch_default_for_uri(file.get_uri(), null);
        } catch (e) {
            console.error(`[dash2dock-plus] Could not open "${file.get_uri()}": ${e}`);
        }
    }

    /**
     * The thumbnail cache of the freedesktop thumbnail spec: the file manager
     * writes ~/.cache/thumbnails/<size>/<md5 of the uri>.png. Thumbnails are
     * never generated here, a missing one just falls back to the file icon.
     *
     * @param {Gio.File} file the file of the row
     * @returns {Gio.FileIcon|null} the thumbnail, or null if there is none
     */
    _thumbnailFor(file) {
        try {
            if (!file)
                return null;

            let hash = null;
            try {
                hash = GLib.compute_checksum_for_string(
                    GLib.ChecksumType.MD5, file.get_uri(), -1);
            } catch (e) {
                return null;
            }

            const base = GLib.build_filenamev(
                [GLib.get_user_cache_dir(), 'thumbnails']);

            // "large" is 256 px and "normal" 128 px, so prefer the bigger one.
            for (const size of ['large', 'normal']) {
                const path = GLib.build_filenamev([base, size, `${hash}.png`]);
                const thumb = Gio.File.new_for_path(path);
                if (thumb.query_exists(null))
                    return new Gio.FileIcon({file: thumb});
            }
        } catch (e) {
            // Ignore and fall back to the icon of the file type.
        }

        return null;
    }

    /**
     * @returns {number} how many entries the list shows
     */
    _count() {
        let count = MIN_ENTRIES;
        try {
            count = this._settings.get_int('folder-count');
        } catch (e) {
            // Keep the default.
        }

        return Math.max(MIN_ENTRIES, Math.min(MAX_ENTRIES, count));
    }

    /**
     * Read the folder, newest entries first.
     *
     * @param {string} path absolute path of the folder
     * @returns {Array<object>|null} the entries, or null if unreadable
     */
    _readFolder(path) {
        const dir = Gio.File.new_for_path(path);
        const entries = [];
        let enumerator = null;

        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::icon,standard::type,' +
                'time::modified',
                Gio.FileQueryInfoFlags.NONE, null);

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                const name = info.get_name();
                if (name.startsWith('.'))
                    continue;

                entries.push({
                    name,
                    icon: info.get_icon(),
                    file: dir.get_child(name),
                    isDir: info.get_file_type() === Gio.FileType.DIRECTORY,
                    modified: info.get_attribute_uint64('time::modified'),
                });

                if (entries.length >= MAX_SCAN)
                    break;
            }
        } catch (e) {
            return null;
        } finally {
            try {
                enumerator?.close(null);
            } catch (e) {
                // Ignore.
            }
        }

        // Newest first; files touched at the same second keep a stable order.
        entries.sort((a, b) => {
            if (a.modified !== b.modified)
                return b.modified - a.modified;
            return a.name.localeCompare(b.name);
        });

        return entries.slice(0, this._count());
    }
}
