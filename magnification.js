// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-
// SPDX-License-Identifier: GPL-2.0-or-later
//
// Dash to Dock Magnification
// macOS-style icon magnification for Dash to Dock.
//
// The effect is attached to the dash actor that Dash to Dock creates, it does
// not modify the Dash to Dock code: it only uses the actors of the dock that
// are reachable from the dash.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

// Time between two animation steps. ~66 fps, cheap enough even on battery.
const TICK_MS = 15;
// How fast the current value catches up with the target (0..1).
const SPRING = 0.32;
// Below this difference we snap to the target and stop animating.
const EPSILON = 0.002;
// How much of the available space is used to spread the icons apart.
const SPREAD_FACTOR = 1.0;
// While the pointer is inside the dock the required bar size changes by less
// than a pixel when the pointer moves between two icons, and by a few pixels
// when it moves further away. The bar grows as soon as an icon would leave it,
// but only gives room back once this much of it is unused, so it stays put
// while the pointer moves between icons instead of creeping along with them.
const BAR_GROW_SLACK = 0.5;
const BAR_SHRINK_SLACK = 4;
// How far (in pixels) the pointer may be outside the normal dock bar and
// still trigger the effect. Keep this small: the bar already has padding.
const HOVER_MARGIN = 6;
// Used when the settings key is missing for some reason.
const DEFAULT_STRENGTH = 0.45;
const DEFAULT_RADIUS = 3.0;

export class DockMagnifier {
    /**
     * @param {St.Widget} dash the Dash to Dock dash actor
     * @param {Gio.Settings} settings this extension's settings
     */
    constructor(dash, settings) {
        this._dash = dash;
        this._settings = settings;
        this._timeoutId = 0;
        this._pointerX = -1;
        this._pointerY = -1;
        this._active = false;
        this._hoverHighlight = null;

        // Resolved lazily: the dash may not be fully added to the dock yet.
        this._actorsReady = false;
        this._viewport = null;
        this._clipHolder = null;
        this._slideContainer = null;
        this._slideXId = 0;
        this._defaultOffscreenRedirect =
            dash?.offscreen_redirect ?? Clutter.OffscreenRedirect.ALWAYS;

        // The dock background, grown along with the icons (macOS style).
        this._background = null;
        this._backgroundState = null;
        this._backgroundBase = null;
        this._backgroundMargins = null;
        this._frozenSize = null;

        // Smoothed size of the bar along the dock axis, and the size it is
        // heading for. The gap between the two keeps the bar from twitching
        // while the pointer moves between two icons (see BAR_GROW_SLACK).
        this._barGrow = {left: 0, right: 0, top: 0, bottom: 0};
        this._barTarget = {left: 0, right: 0, top: 0, bottom: 0};

        this._motionId = global.stage.connect('motion-event', () => {
            this.queueUpdate();
            return Clutter.EVENT_PROPAGATE;
        });

        this._settingsChangedId = this._settings.connect('changed', () => {
            this._applyHoverHighlight();
            this._reset();
            this.queueUpdate();
        });

        this._applyHoverHighlight();

        this.queueUpdate();
    }

    /** Switch the Dash to Dock hover highlight on or off. */
    _applyHoverHighlight() {
        try {
            const on = this._settings.get_boolean('hover-highlight');
            if (on)
                this._dash.remove_style_class_name('d2dm-no-hover-highlight');
            else
                this._dash.add_style_class_name('d2dm-no-hover-highlight');

            this._hoverHighlight = on;

            this._updateHighlightStyles(this._collectItems());
        } catch (e) {
            // The dash is already gone.
        }
    }

    /**
     * Remove the light background that the Shell theme or Dash to Dock paints
     * on the icons. A stylesheet is not enough: both of them also use inline
     * styles (the backlit running indicator does), which only an inline style
     * can override.
     *
     * @param {Array<object>} items the items of the dock
     */
    _updateHighlightStyles(items) {
        const hide = this._hoverHighlight === false;

        for (const {container, iconActor} of items) {
            if (!container)
                continue;

            // Cached: an item is recreated (and the cache dropped with it) on
            // every dash redisplay.
            let actors = container._d2dmGlowActors;
            if (!actors) {
                actors = [container, container.child, iconActor];

                const stack = [...container.get_children()];
                while (stack.length) {
                    const actor = stack.pop();
                    if (!actor)
                        continue;

                    stack.push(...actor.get_children());

                    if (typeof actor.has_style_class_name === 'function' &&
                        actor.has_style_class_name('overview-icon'))
                        actors.push(actor);
                }

                container._d2dmGlowActors = actors;
            }

            for (const actor of actors) {
                if (!actor || typeof actor.set_style !== 'function')
                    continue;

                if (hide) {
                    const style = 'background-color: transparent; ' +
                        'background-image: none; box-shadow: none; ' +
                        'border-color: transparent;';

                    if (actor.style === style)
                        continue;

                    try {
                        actor.set_style(style);
                        actor._d2dmStyleCleared = true;
                    } catch (e) {
                        // The actor is already gone.
                    }
                } else if (actor._d2dmStyleCleared) {
                    delete actor._d2dmStyleCleared;

                    try {
                        actor.set_style(null);
                    } catch (e) {
                        // The actor is already gone.
                    }
                }
            }
        }
    }

    destroy() {
        // Disconnect from the stage first: nothing may keep this object alive
        // once the dock is gone.
        if (this._motionId) {
            try {
                global.stage.disconnect(this._motionId);
            } catch (e) {
                // Ignore.
            }
            this._motionId = 0;
        }

        if (this._settingsChangedId && this._settings) {
            try {
                this._settings.disconnect(this._settingsChangedId);
            } catch (e) {
                // Ignore.
            }
            this._settingsChangedId = 0;
        }

        if (this._slideXId && this._slideContainer) {
            try {
                this._slideContainer.disconnect(this._slideXId);
            } catch (e) {
                // The slider may already be destroyed.
            }
            this._slideXId = 0;
        }

        this._stop();

        try {
            this._reset();
        } catch (e) {
            // The dock has already been destroyed.
        }

        try {
            this._setActive(false);
        } catch (e) {
            // Ignore.
        }

        try {
            this._endBackground();
        } catch (e) {
            // Ignore.
        }

        this._background = null;
        this._viewport = null;
        this._clipHolder = null;
        this._slideContainer = null;
        this._settings = null;

        if (this._dash) {
            try {
                this._dash.remove_style_class_name('d2dm-no-hover-highlight');
            } catch (e) {
                // Ignore.
            }
        }
        this._dash = null;
    }

    /**
     * Resolve the actors of the dock that the effect needs. They are looked up
     * lazily because the dock is still being built when the effect is created,
     * and Dash to Dock may move the dash around.
     */
    _ensureActors() {
        if (this._actorsReady)
            return true;

        try {
            const dash = this._dash;
            const holder = dash?.get_parent();
            if (!holder)
                return false;

            // The slide container of Dash to Dock clips this actor, which is
            // what keeps the slided-out part of the dock hidden. It also clips
            // icons that grow past the dock, so the clip is disabled while the
            // effect is active (see _beginOverflow()).
            this._clipHolder = holder;
            this._viewport = this._findViewport();

            const parent = holder.get_parent();
            this._slideContainer =
                parent && typeof parent.slideX === 'number' ? parent : null;

            if (this._slideContainer && !this._slideXId) {
                this._slideXId = this._slideContainer.connect(
                    'notify::slide-x', () => {
                        if (this._active && !this._slideFullyShown())
                            this._setActive(false);
                    });
            }

            this._actorsReady = true;
            return true;
        } catch (e) {
            // The dock is being destroyed.
            return false;
        }
    }

    /**
     * The scrollable viewport of the dash scroll view (an StBoxLayout, which
     * extends StViewport). It paints a rectangular clip around the dock
     * unless "clip-to-view" is disabled.
     */
    _findViewport() {
        // Skip the icon box itself: every StBoxLayout is an StViewport, but
        // only the scrollable one (the one with adjustments) clips.
        let actor = this._dash?._box?.get_parent() ?? null;
        while (actor) {
            if (typeof actor.clip_to_view === 'boolean' &&
                (actor.hadjustment || actor.vadjustment))
                return actor;
            actor = actor.get_parent();
        }
        return null;
    }

    /**
     * The magnification may only draw outside of the dock while the dock is
     * fully slided in, otherwise the hidden part would show up on the
     * neighbouring monitor.
     */
    _slideFullyShown() {
        if (!this._slideContainer)
            return true;

        try {
            const slideX = this._slideContainer.slideX;
            return slideX === undefined || slideX >= 0.999;
        } catch (e) {
            return true;
        }
    }

    /**
     * Turn the clipping of every actor between the icons and the stage on or
     * off, so that the magnified icons and the grown bar can be painted
     * outside the dock.
     *
     * @param {boolean} active whether the icons may overflow
     */
    _setActive(active) {
        this._ensureActors();

        active = !!active && this._slideFullyShown();

        if (this._active === active)
            return;
        this._active = active;

        if (this._viewport) {
            try {
                this._viewport.clip_to_view = !active;
            } catch (e) {
                // Ignore viewports that are already gone.
            }
        }

        if (active)
            this._beginOverflow();
        else
            this._endOverflow();
    }

    _beginOverflow() {
        const holder = this._clipHolder;
        if (holder) {
            try {
                // Dash to Dock calls child.set_clip() from its slide
                // container. Shadow the method on this instance so that the
                // clip is not applied again, without patching Dash to Dock.
                if (!holder._d2dmSetClip) {
                    holder._d2dmSetClip = holder.set_clip;
                    holder.set_clip = () => {};
                }
                holder.remove_clip();
            } catch (e) {
                // Ignore.
            }
        }

        // The dash uses an offscreen redirect ("always"), whose texture is
        // sized from the configured paint volume, i.e. the dock allocation.
        // Painting directly is required while the effect overflows.
        if (this._dash) {
            try {
                this._defaultOffscreenRedirect =
                    this._dash.offscreen_redirect;
                this._dash.offscreen_redirect = Clutter.OffscreenRedirect.NEVER;
            } catch (e) {
                // Ignore.
            }
        }

        this._beginBackground();
    }

    _endOverflow() {
        const holder = this._clipHolder;
        if (holder) {
            try {
                if (holder._d2dmSetClip) {
                    delete holder.set_clip;
                    delete holder._d2dmSetClip;
                }
                // Let the slide container apply its clip again.
                holder.queue_relayout();
            } catch (e) {
                // Ignore.
            }
        }

        if (this._dash) {
            try {
                this._dash.offscreen_redirect = this._defaultOffscreenRedirect;
            } catch (e) {
                // Ignore.
            }
        }

        this._endBackground();
    }

    /**
     * Take over the dock background so that it can grow together with the
     * icons, like the macOS dock does.
     *
     * The bar is detached from the dock layout (fixed position) while the
     * effect is active, otherwise the layout would clamp it to the size of
     * the dock and it could not grow at all.
     */
    _beginBackground() {
        if (this._backgroundState)
            return;

        const dash = this._dash;
        const background = dash?._background;
        if (!background || !background.visible)
            return;

        this._background = background;
        this._backgroundState = {
            xExpand: background.x_expand,
            yExpand: background.y_expand,
            xAlign: background.x_align,
            yAlign: background.y_align,
            fixed: background.fixed_position_set,
        };
        this._backgroundBase = {
            x: background.x,
            y: background.y,
            width: background.width,
            height: background.height,
        };
        this._barGrow = {left: 0, right: 0, top: 0, bottom: 0};
        this._barTarget = {left: 0, right: 0, top: 0, bottom: 0};

        let margins = {left: 0, top: 0, right: 0, bottom: 0};
        try {
            const node = background.get_theme_node();
            if (node) {
                margins = {
                    left: Math.max(0, node.get_margin(St.Side.LEFT)),
                    top: Math.max(0, node.get_margin(St.Side.TOP)),
                    right: Math.max(0, node.get_margin(St.Side.RIGHT)),
                    bottom: Math.max(0, node.get_margin(St.Side.BOTTOM)),
                };
            }
        } catch (e) {
            // Ignore themes that are being unloaded.
        }
        this._backgroundMargins = margins;

        // The bar may only grow visually. Freeze the size of the dash actor,
        // otherwise the background would resize the dock itself, which moves
        // the struts, the autohide barrier, the input region and the icons.
        try {
            this._frozenSize = {width: dash.width, height: dash.height};
            dash.set_size(this._frozenSize.width, this._frozenSize.height);

            // A layout child can never be allocated more than the space the
            // dash gives it, which would clamp the bar to the size of the
            // dock. Position the background explicitly instead: it then gets
            // all the room it needs and stays out of the dock's layout.
            background.fixed_position_set = true;
            background.x_expand = false;
            background.y_expand = false;
            background.x_align = Clutter.ActorAlign.START;
            background.y_align = Clutter.ActorAlign.START;
        } catch (e) {
            // Ignore.
        }
    }

    /**
     * Stretch the background along the dock so that it covers every icon,
     * including the magnified ones and the ones that have been pushed aside.
     * The thickness of the bar never changes, so the bar can never move
     * perpendicular to the dock.
     *
     * @param {Array<object>} items the current icons
     * @param {boolean} inside whether the pointer is inside the dock
     * @returns {boolean} whether the bar is still being resized
     */
    _updateBackground(items, inside) {
        const background = this._background;
        const base = this._backgroundBase;
        if (!background || !base)
            return false;

        const dash = this._dash;
        const bounds = this._computeBounds(items);
        const [dashX, dashY] = dash.get_transformed_position();

        const required = {
            left: Math.max(0, base.x - (bounds.left - dashX)),
            right: Math.max(0,
                (bounds.right - dashX) - (base.x + base.width)),
            top: Math.max(0, base.y - (bounds.top - dashY)),
            bottom: Math.max(0,
                (bounds.bottom - dashY) - (base.y + base.height)),
        };

        if (!this._barGrow)
            this._barGrow = {left: 0, right: 0, top: 0, bottom: 0};
        if (!this._barTarget)
            this._barTarget = {...this._barGrow};

        // Dead zone while the pointer is inside the dock: the required size
        // only changes by a fraction of a pixel while the pointer moves
        // between two icons, so the bar would otherwise creep along with the
        // icons. Grow as soon as an icon is about to leave the bar, but only
        // give room back once a noticeable amount of it is unused, so the bar
        // stays exactly as long as the icons need it without flickering.
        const target = this._barTarget;
        for (const key of ['left', 'right', 'top', 'bottom']) {
            if (!inside) {
                target[key] = required[key];
            } else if (required[key] > target[key] + BAR_GROW_SLACK) {
                target[key] = required[key];
            } else if (required[key] < target[key] - BAR_SHRINK_SLACK) {
                target[key] = required[key];
            }
        }

        let barMoving = false;
        const grow = this._barGrow;
        for (const key of ['left', 'right', 'top', 'bottom']) {
            if (target[key] > grow[key]) {
                // Growing: follow the icons exactly, they are animated
                // already, so an icon can never leave the bar.
                grow[key] = target[key];
            } else if (grow[key] - target[key] < 0.5) {
                grow[key] = target[key];
            } else {
                grow[key] += (target[key] - grow[key]) * SPRING;
                barMoving = true;
            }
        }

        const left = Math.round(grow.left);
        const right = Math.round(grow.right);
        const top = Math.round(grow.top);
        const bottom = Math.round(grow.bottom);

        // Rectangle of the stretched bar, in dash coordinates. It only grows
        // along the dock: the thickness of the bar never changes, so it can
        // never move perpendicular to the dock.
        let x = base.x;
        let y = base.y;
        let width = base.width;
        let height = base.height;

        if (dash._isHorizontal) {
            width = base.width + left + right;
            x = base.x - left;
        } else {
            height = base.height + top + bottom;
            y = base.y - top;
        }

        try {
            const margins = this._backgroundMargins ?? {
                left: 0, top: 0, right: 0, bottom: 0,
            };
            width = Math.ceil(width);
            height = Math.ceil(height);

            // The fixed position also defines how much room the layout gives
            // the actor: it spans from the fixed position to the edge of the
            // dash. Shift it further out when the bar needs more room than
            // that, and undo the shift with the translation.
            let fixedX = x - margins.left;
            let fixedY = y - margins.top;
            const shiftX = Math.max(0,
                x + width - dash.width + margins.right);
            const shiftY = Math.max(0,
                y + height - dash.height + margins.bottom);
            fixedX -= shiftX;
            fixedY -= shiftY;

            background.fixed_x = fixedX;
            background.fixed_y = fixedY;
            background.width = width;
            background.height = height;

            // Clutter mirrors the horizontal alignment for RTL actors, even
            // for a fixed position: compute where the bar really ends up.
            if (background.get_text_direction() ===
                Clutter.TextDirection.RTL) {
                background.translation_x =
                    x - (dash.width - width - margins.right);
            } else {
                background.translation_x = shiftX;
            }
            background.translation_y = shiftY;
        } catch (e) {
            // Ignore backgrounds that are already gone.
        }

        return barMoving;
    }

    /** Give the background back to the normal dock layout. */
    _endBackground() {
        const state = this._backgroundState;
        const background = this._background;
        const dash = this._dash;

        this._backgroundState = null;
        this._backgroundBase = null;
        this._backgroundMargins = null;
        this._background = null;
        this._frozenSize = null;
        this._barGrow = {left: 0, right: 0, top: 0, bottom: 0};
        this._barTarget = {left: 0, right: 0, top: 0, bottom: 0};

        if (background) {
            try {
                background.fixed_position_set = state?.fixed ?? false;
                background.x_expand = state?.xExpand ?? false;
                background.y_expand = state?.yExpand ?? true;
                background.x_align = state?.xAlign ?? Clutter.ActorAlign.FILL;
                background.y_align = state?.yAlign ?? Clutter.ActorAlign.FILL;
                background.translation_x = 0;
                background.translation_y = 0;
                background.width = -1;
                background.height = -1;
            } catch (e) {
                // Ignore.
            }
        }

        if (dash) {
            try {
                dash.set_size(-1, -1);
                dash.queue_relayout();
            } catch (e) {
                // Ignore.
            }
        }
    }

    /** Ask for an animation step at the next tick. */
    queueUpdate() {
        if (this._timeoutId || !this._dash?.mapped)
            return;

        this._timeoutId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, TICK_MS, () => this._onTick());
    }

    _stop() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
    }

    _onTick() {
        let keepRunning = false;
        try {
            keepRunning = this._update();
        } catch (e) {
            console.error(`[dash-to-dock-magnify] ${e}`);
        }

        if (!keepRunning) {
            this._timeoutId = 0;
            return GLib.SOURCE_REMOVE;
        }
        return GLib.SOURCE_CONTINUE;
    }

    _getStrength() {
        try {
            const value = this._settings.get_double('magnification-strength');
            return value > 0 ? value : DEFAULT_STRENGTH;
        } catch (e) {
            return DEFAULT_STRENGTH;
        }
    }

    _getRadius() {
        try {
            const value = this._settings.get_double('magnification-radius');
            return value > 0 ? value : DEFAULT_RADIUS;
        } catch (e) {
            return DEFAULT_RADIUS;
        }
    }

    _getEnabled() {
        try {
            return this._settings.get_boolean('magnification-enabled');
        } catch (e) {
            return true;
        }
    }

    /**
     * Collect the icon containers of the dash together with their
     * untranslated (base) geometry in stage coordinates.
     */
    _collectItems() {
        const dash = this._dash;
        if (!dash?._box)
            return [];

        const containers = [...dash._box.get_children()];

        // The "show applications" button is a sibling of the icon box, either
        // inside the box container (docked with the app icons) or inside the
        // dash container (pinned to the edge of the dock). Include it wherever
        // it is, so that it is scaled and pushed aside like every other icon
        // instead of being overlapped by the magnified neighbour.
        const showApps = dash._showAppsIcon;
        if (showApps && showApps.get_parent() && !containers.includes(showApps))
            containers.push(showApps);

        // Our own folder button is a sibling of the icon box as well.
        for (const child of dash._boxContainer?.get_children() ?? []) {
            if (child === dash._box || containers.includes(child))
                continue;
            if (child.child?.icon)
                containers.push(child);
        }

        const items = [];
        for (const container of containers) {
            if (!container || container.animatingOut || !container.visible)
                continue;

            const iconActor = container.child?.icon ?? container.icon;
            if (!iconActor)
                continue;

            const [tx, ty] = container.get_transformed_position();
            const [tw, th] = container.get_transformed_size();

            // Remove our own offset to always work on the real position.
            const x = tx - (container.translation_x || 0);
            const y = ty - (container.translation_y || 0);

            items.push({
                container,
                iconActor,
                x, y, w: tw, h: th,
                // Size of the icon itself (without the dock padding), used
                // for the influence radius.
                iw: iconActor.width > 0 ? iconActor.width : tw,
                ih: iconActor.height > 0 ? iconActor.height : th,
                cx: x + tw / 2,
                cy: y + th / 2,
            });
        }

        return items;
    }

    _applyPivots(items) {
        const position = this._dash._position;

        const pivots = {
            [St.Side.BOTTOM]: [0.5, 1.0],
            [St.Side.TOP]: [0.5, 0.0],
            [St.Side.LEFT]: [0.0, 0.5],
            [St.Side.RIGHT]: [1.0, 0.5],
        };
        const [px, py] = pivots[position] ?? [0.5, 1.0];
        const key = `${position}`;

        for (const {iconActor} of items) {
            // Icons are recreated on every dash redisplay, so the pivot has to
            // be applied per actor rather than once per dock.
            if (iconActor._d2dmPivotKey === key)
                continue;

            try {
                iconActor.set_pivot_point(px, py);
                iconActor._d2dmPivotKey = key;
            } catch (e) {
                // Ignore actors that don't support pivots.
            }
        }
    }

    /**
     * Bounding box of every icon in stage coordinates, including the current
     * scale and the offsets that push the neighbours aside.
     *
     * @param {Array<object>} items the current icons
     * @returns {{left: number, top: number, right: number, bottom: number}}
     */
    _computeBounds(items) {
        const scales = items.map(item => item.container._d2dmScale ?? 1);
        const offsets = items.map(item => item.container._d2dmOffset ?? 0);
        return this._boundsForLayout(items, scales, offsets);
    }

    /**
     * Bounding box of every icon for an explicit scale/offset layout.
     *
     * @param {Array<object>} items the current icons
     * @param {Array<number>} scales scale of every icon
     * @param {Array<number>} offsets offset of every icon
     * @returns {{left: number, top: number, right: number, bottom: number}}
     */
    _boundsForLayout(items, scales, offsets) {
        const horizontal = this._dash._isHorizontal;
        const position = this._dash._position;

        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;

        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const scale = scales[i];
            const offset = offsets[i];
            const growW = item.w * (scale - 1);
            const growH = item.h * (scale - 1);

            let l = item.x;
            let t = item.y;
            let r = item.x + item.w;
            let b = item.y + item.h;

            if (horizontal) {
                // Horizontal growth is centred, the vertical one starts at
                // the dock edge (the pivot point of the icons).
                l += offset - growW / 2;
                r += offset + growW / 2;
                if (position === St.Side.TOP)
                    b += growH;
                else
                    t -= growH;
            } else {
                t += offset - growH / 2;
                b += offset + growH / 2;
                // Vertical docks grow towards the inside of the screen.
                if (position === St.Side.LEFT)
                    r += growW;
                else
                    l -= growW;
            }

            left = Math.min(left, l);
            top = Math.min(top, t);
            right = Math.max(right, r);
            bottom = Math.max(bottom, b);
        }

        return {left, top, right, bottom};
    }

    /**
     * Scales and offsets of every icon for a given pointer position.
     *
     * @param {Array<object>} items the current icons
     * @param {number} pointer pointer position along the dock axis
     * @param {number} strength magnification strength
     * @param {number} radiusPx influence radius in pixels
     * @param {number} iconSize size of an icon
     * @param {boolean} horizontal whether the dock is horizontal
     * @returns {{scales: Array<number>, offsets: Array<number>}}
     */
    _computeLayout(items, pointer, strength, radiusPx, iconSize, horizontal) {
        const count = items.length;
        const scales = new Array(count).fill(1);
        const offsets = new Array(count).fill(0);
        const centers = items.map(item => horizontal ? item.cx : item.cy);

        for (let i = 0; i < count; i++) {
            const distance = Math.abs(pointer - centers[i]);
            if (distance >= radiusPx)
                continue;

            // Smoothstep falloff: 1 at the pointer, 0 at the radius edge.
            const t = 1 - distance / radiusPx;
            scales[i] = 1 + strength * (t * t * (3 - 2 * t));
        }

        // The dock is stretched locally around the pointer, so an icon is
        // moved by the integral of the extra size between the pointer and
        // itself. This is continuous: unlike an "icon under the pointer"
        // anchor, nothing jumps when the pointer sits right between two icons.
        let cell = 0;
        let cellDistance = Infinity;
        for (let i = 0; i < count; i++) {
            const distance = Math.abs(pointer - centers[i]);
            if (distance < cellDistance) {
                cellDistance = distance;
                cell = i;
            }
        }

        const pitch = iconSize;

        // Edges of the cell (Voronoi area) of the icon under the pointer.
        const cellLeft = cell > 0
            ? (centers[cell - 1] + centers[cell]) / 2
            : centers[cell] - pitch / 2;
        const cellRight = cell < count - 1
            ? (centers[cell] + centers[cell + 1]) / 2
            : centers[cell] + pitch / 2;

        for (let i = 0; i < count; i++) {
            let sum;

            if (i === cell) {
                sum = (scales[cell] - 1) * (centers[cell] - pointer);
            } else if (i > cell) {
                sum = (scales[cell] - 1) * (cellRight - pointer);
                for (let j = cell + 1; j < i; j++)
                    sum += (scales[j] - 1) * pitch;
                sum += (scales[i] - 1) * pitch / 2;
            } else {
                sum = (scales[cell] - 1) * (pointer - cellLeft);
                for (let j = i + 1; j < cell; j++)
                    sum += (scales[j] - 1) * pitch;
                sum += (scales[i] - 1) * pitch / 2;
                sum = -sum;
            }

            offsets[i] = sum * SPREAD_FACTOR;
        }

        return {scales, offsets};
    }

    /**
     * Rectangle of the normal (unmagnified) dock bar in stage coordinates.
     *
     * @param {Array<object>} items the current icons
     * @returns {{x: number, y: number, width: number, height: number}|null}
     */
    _readBarRect(items) {
        const background = this._dash?._background;
        if (background && background.visible) {
            try {
                const [x, y] = background.get_transformed_position();
                const [width, height] = background.get_transformed_size();
                if (width > 0 && height > 0)
                    return {x, y, width, height};
            } catch (e) {
                // Fall through to the icons.
            }
        }

        let left = Infinity;
        let top = Infinity;
        let right = -Infinity;
        let bottom = -Infinity;

        for (const item of items) {
            left = Math.min(left, item.x);
            top = Math.min(top, item.y);
            right = Math.max(right, item.x + item.w);
            bottom = Math.max(bottom, item.y + item.h);
        }

        if (!isFinite(left))
            return null;

        return {x: left, y: top, width: right - left, height: bottom - top};
    }

    /**
     * Is the pointer close enough to the dock for the effect to be visible?
     *
     * The area is the normal bar plus the current (possibly magnified) icons,
     * with a small margin. Using the bar instead of the icon containers is
     * important: the containers include the dock padding, which would trigger
     * the effect several dozen pixels away from the dock.
     *
     * @param {Array<object>} items the current icons
     * @param {number} px pointer x in stage coordinates
     * @param {number} py pointer y in stage coordinates
     * @returns {boolean}
     */
    _isInsideDock(items, px, py) {
        const bounds = this._computeBounds(items);
        // Use the current bar: while the effect is active it is the grown one,
        // which gives the hysteresis that keeps the stretched state stable.
        const bar = this._readBarRect(items);

        let left = bounds.left;
        let top = bounds.top;
        let right = bounds.right;
        let bottom = bounds.bottom;

        if (bar) {
            left = Math.min(left, bar.x);
            top = Math.min(top, bar.y);
            right = Math.max(right, bar.x + bar.width);
            bottom = Math.max(bottom, bar.y + bar.height);
        }

        return px >= left - HOVER_MARGIN && px <= right + HOVER_MARGIN &&
            py >= top - HOVER_MARGIN && py <= bottom + HOVER_MARGIN;
    }

    _reset() {
        const dash = this._dash;
        let containers;
        try {
            containers = [...(dash?._box?.get_children() ?? [])];
            const showApps = dash?._showAppsIcon;
            if (showApps && !containers.includes(showApps))
                containers.push(showApps);

            // The folder button is a sibling of the icon box and is scaled by
            // the effect too, so it has to be reset like every other icon.
            for (const child of dash?._boxContainer?.get_children() ?? []) {
                if (child === dash._box || containers.includes(child))
                    continue;
                if (child.child?.icon)
                    containers.push(child);
            }
        } catch (e) {
            return;
        }
        if (!containers)
            return;

        for (const container of containers) {
            if (container._d2dmScale === undefined &&
                container._d2dmOffset === undefined)
                continue;

            container._d2dmScale = 1;
            container._d2dmOffset = 0;
            container.translation_x = 0;
            container.translation_y = 0;

            const iconActor = container.child?.icon ?? container.icon;
            try {
                iconActor?.set_scale(1, 1);
            } catch (e) {
                // Ignore.
            }
        }
    }

    /**
     * One animation step. Returns true while the animation must keep running.
     */
    _update() {
        const dash = this._dash;
        if (!this._settings || !dash?.mapped || !dash._box) {
            this._setActive(false);
            return false;
        }

        if (!this._ensureActors())
            return false;

        const items = this._collectItems();
        if (!items.length) {
            this._setActive(false);
            return false;
        }

        const enabled = this._getEnabled();
        const [px, py] = global.get_pointer();

        const moved = px !== this._pointerX || py !== this._pointerY;
        this._pointerX = px;
        this._pointerY = py;

        const horizontal = dash._isHorizontal;

        this._applyPivots(items);
        this._updateHighlightStyles(items);

        const strength = enabled ? this._getStrength() : 0;
        const radius = this._getRadius();
        const inside = enabled && strength > 0 &&
            this._slideFullyShown() && this._isInsideDock(items, px, py);

        // Sort along the dock axis so that spreading works in both
        // LTR and RTL layouts.
        items.sort((a, b) => horizontal ? a.cx - b.cx : a.cy - b.cy);

        let iconSize = 0;
        for (const item of items)
            iconSize = Math.max(iconSize, horizontal ? item.iw : item.ih);
        if (iconSize <= 0)
            return false;

        const radiusPx = radius * iconSize;
        let scales = new Array(items.length).fill(1);
        let offsets = new Array(items.length).fill(0);

        if (inside) {
            ({scales, offsets} = this._computeLayout(items, horizontal ? px : py,
                strength, radiusPx, iconSize, horizontal));
        }

        let moving = false;

        for (let i = 0; i < items.length; i++) {
            const {container, iconActor} = items[i];

            let currentScale = container._d2dmScale ?? 1;
            let currentOffset = container._d2dmOffset ?? 0;

            // When disabled or outside the dock, relax back to normal.
            let targetScale = scales[i];
            let targetOffset = offsets[i];

            if (!inside) {
                targetScale = 1;
                targetOffset = 0;
            }

            currentScale += (targetScale - currentScale) * SPRING;
            currentOffset += (targetOffset - currentOffset) * SPRING;

            if (Math.abs(currentScale - targetScale) < EPSILON)
                currentScale = targetScale;
            else
                moving = true;

            if (Math.abs(currentOffset - targetOffset) < EPSILON)
                currentOffset = targetOffset;
            else
                moving = true;

            container._d2dmScale = currentScale;
            container._d2dmOffset = currentOffset;

            try {
                iconActor.set_scale(currentScale, currentScale);
            } catch (e) {
                // Ignore actors that can't be scaled.
            }

            if (horizontal)
                container.translation_x = currentOffset;
            else
                container.translation_y = currentOffset;
        }

        // Keep the overflow enabled while the icons are still shrinking back,
        // otherwise they would be clipped mid-animation.
        this._setActive(inside || moving);

        let barMoving = false;
        if (this._active)
            barMoving = this._updateBackground(items, inside);

        // Keep running while something is still animating, or while the
        // pointer keeps moving over the dock.
        return moving || barMoving || (inside && moved);
    }
}
