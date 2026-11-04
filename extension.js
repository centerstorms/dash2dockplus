// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Dash2Dock Plus+
// Companion extension for Dash to Dock: macOS-style icon magnification, an
// optional folder button on the dock and the hover highlight switch.
//
// This extension does not ship Dash to Dock: it looks for the dock actors that
// Dash to Dock adds to the stage and attaches to them, so all the Dash to Dock
// settings, preferences and features keep working untouched.

import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {DockFolder} from './folder.js';
import {DockMagnifier} from './magnification.js';

// Name of the toplevel actor Dash to Dock adds to the ui group (see
// DockedDash._init() in Dash to Dock's docking.js).
const DOCK_ACTOR_NAME = 'dashtodockContainer';

export default class Dash2DockPlusExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._docks = new Map();

        this._loadStylesheet();

        // Dash to Dock adds its docks to the ui group and removes them when
        // they are recreated (monitor changes, position changes, ...), so the
        // ui group children are the perfect place to hook into.
        this._uiGroup = Main.layoutManager.uiGroup ?? Main.uiGroup;
        this._childAddedId = this._uiGroup.connect(
            'child-added', (_group, actor) => this._attach(actor));
        this._childRemovedId = this._uiGroup.connect(
            'child-removed', (_group, actor) => this._detach(actor));

        // Dash to Dock may already be running when this extension is enabled.
        this._scan();
    }

    disable() {
        if (this._childAddedId) {
            this._uiGroup.disconnect(this._childAddedId);
            this._childAddedId = 0;
        }

        if (this._childRemovedId) {
            this._uiGroup.disconnect(this._childRemovedId);
            this._childRemovedId = 0;
        }

        for (const {magnifier, folder} of this._docks.values()) {
            // The folder button only exists when Dash to Dock is running: the
            // entry is null for the other docks.
            folder?.destroy();
            magnifier.destroy();
        }
        this._docks.clear();

        this._unloadStylesheet();

        this._uiGroup = null;
        this._settings = null;
    }

    /** Load our stylesheet into the Shell theme. */
    _loadStylesheet() {
        try {
            this._theme = St.ThemeContext.get_for_stage(global.stage).get_theme();
            this._stylesheet = this.dir.get_child('stylesheet.css');
            this._theme.load_stylesheet(this._stylesheet);
        } catch (e) {
            console.error(`[dash2dock-plus] Could not load the stylesheet: ${e}`);
            this._theme = null;
            this._stylesheet = null;
        }
    }

    _unloadStylesheet() {
        if (!this._theme || !this._stylesheet)
            return;

        try {
            this._theme.unload_stylesheet(this._stylesheet);
        } catch (e) {
            // Ignore.
        }

        this._theme = null;
        this._stylesheet = null;
    }

    _scan() {
        if (!this._uiGroup)
            return;

        for (const actor of this._uiGroup.get_children())
            this._attach(actor);
    }

    /**
     * Attach the effect and the folder button to a Dash to Dock dock.
     *
     * @param {Clutter.Actor} actor an ui group child
     */
    _attach(actor) {
        if (!actor || this._docks.has(actor))
            return;

        if (actor.name !== DOCK_ACTOR_NAME)
            return;

        // DockedDash exposes the inner Dash actor as "dash".
        const dash = actor.dash;
        if (!dash)
            return;

        // Other docks (dash2dock-lite does this) use the same actor name and
        // expose a "dash" too, but only Dash to Dock has the icon box that the
        // folder button is added to. The magnifier does not care and works on
        // any dash, the folder does.
        const isDashToDock = dash._boxContainer instanceof St.Widget;

        this._docks.set(actor, {
            magnifier: new DockMagnifier(dash, this._settings),
            folder: isDashToDock
                ? new DockFolder(dash, this._settings)
                : null,
        });
    }

    /**
     * @param {Clutter.Actor} actor an ui group child
     */
    _detach(actor) {
        const dock = this._docks.get(actor);
        if (!dock)
            return;

        this._docks.delete(actor);
        dock.folder?.destroy();
        dock.magnifier.destroy();
    }
}
