# Dash2Dock Plus+

macOS-style icon magnification for **Dash to Dock**, plus a folder stack and a
switch for the dock's hover highlight.

It is a companion extension: Dash to Dock stays installed and untouched, and all
of its settings keep working.

## Support

Dash2Dock Plus+ is free software, written in my spare time. If it makes your
desktop nicer, you can buy me a coffee:

[![Buy me a coffee on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/centerstorms)

<https://ko-fi.com/centerstorms>

The same link is at the end of the extension preferences.

## Features

* **Magnification** — the icon under the pointer grows, its neighbours move
  aside so that they never overlap, and the effect fades out smoothly within a
  radius you choose.
* **The dock bar grows with the icons** — the bar stretches along the dock to
  follow the icons, and only as far as they need it. Its thickness never
  changes, so it never moves perpendicular to the dock.
* **Hover highlight switch** — the light rounded background that Dash to Dock
  paints behind the icon under the pointer can be switched off (Dash to Dock has
  no setting for it).
* **Folder on the dock** — a folder of your choice is shown as a button at the
  end of the dock. Clicking it opens a list of the newest files of that folder,
  each with its thumbnail and name, right-aligned and sitting just above the
  dock.
* **5 or 10 entries** — the length of the folder list is a preference; the files
  are sorted newest first.
* **Icon picker** — the folder button uses one of a grid of built-in icons, or
  any image file from your computer.

Everything is a switch or a slider in the preferences window: nothing has to be
edited by hand.

## Requirements

* GNOME Shell **45 → 51**, on Wayland or X11
* **Dash to Dock** (`dash-to-dock@micxgx.gmail.com`), installed and enabled —
  this extension adds the effect to it and does not ship it

## Installation

### From extensions.gnome.org

Install [Dash to Dock](https://extensions.gnome.org/extension/307/dash-to-dock/)
first, then Dash2Dock Plus+ from extensions.gnome.org, and log out and back in.

### From this repository

```sh
git clone <repo-url> \
    ~/.local/share/gnome-shell/extensions/dash2dockplus@centerstorms
glib-compile-schemas \
    ~/.local/share/gnome-shell/extensions/dash2dockplus@centerstorms/schemas
gnome-extensions enable dash2dockplus@centerstorms
```

On Wayland a log out and back in is required. On X11, `Alt+F2`, `r`, `Enter`.

### Build the extensions.gnome.org bundle

The repository is also the source of the bundle:

```sh
./build.sh
# Bundle : dist/dash2dockplus@centerstorms.shell-extension.zip
# SHA256 : ...
```

`build.sh` packs only the files of the extension (the development files are
excluded), rewrites `metadata.json` from `ego.conf`, compiles the schema with
`--strict`, verifies the archive and prints its SHA256. The build is
reproducible: the same sources give the same archive.

## Preferences

* **Enable magnification** — on or off.
* **Strength** — how much the icon under the pointer grows (0.45 means 1.45
  times the normal size).
* **Influence radius** — how many icons around the pointer are affected, in
  icon widths.
* **Highlight the icon under the pointer** — the hover highlight of Dash to
  Dock.
* **Show a folder on the dock** — the folder button, its folder, the number of
  entries (5 or 10) and its icon.

The settings are also reachable with `gsettings`, in the schema
`org.gnome.shell.extensions.dash-to-dock-magnify`.

## Known limitations

* The grown part of the bar and of the icons is painted but not clickable: the
  input region of the dock still follows the normal dock allocation.
* The magnified icons are painted above the dock, so they are drawn over
  windows that overlap the dock area.
* If Dash to Dock is disabled, the dock part does nothing.
* Icons are scaled by the GPU, so bitmap application icons can look slightly
  soft at maximum magnification.
* The folder button lives inside the dock, so it scrolls with the icons when the
  dock is full; it is not pinned to the screen edge.

## Technical notes

How the effect works, which actors it touches and why, the clips it lifts and
the constants that tune it are documented in
[README-MAGNIFICATION.md](README-MAGNIFICATION.md).

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).
