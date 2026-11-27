# Return fold

A single ribbon lifts like a breath and settles onto a flat foot. Following the fold back to its starting point echoes how an item in the library leads back to its conversation.

## Artwork

- `AppIcon.icon` is the editable Icon Composer document. Its two 1024 px SVG layers trace an original generated study. `Assets/Return.svg` shapes the teal underside and foot. `Assets/Fold.svg` carries the pale front face and citron edge. The document defines the background, glass material and appearance colors.
- `Return.xcassets` represents the same layered design as an asset catalog. The day and night stacks use different teal backgrounds. The monochrome stack uses two gray values so the turn stays visible under a system tint. The catalog references the same two SVGs. When editing colors, stacking or material settings, update both the catalog and the Composer document.
- `MenuBar.xcassets` contains the 18 pt `Tray` and `TrayWaiting` vector templates. Both share the wide opening and flat foot. The waiting template adds a separate upper-left dot. AppKit supplies the foreground color.

## Build

From the repository root, run `sh app/Icon/compile.sh --refresh` with Xcode configured to regenerate the compiled resources. It invokes `actool` on the Composer document and the menu bar catalog. If the document reader is unavailable, it compiles the layered asset catalog and menu bar catalog together.

`Compiled.tar.xz` contains the resulting `Assets.car` and the ten-size `AppIcon.icns`. The app build uses that archive when the sources match `sources.sha256`, and recompiles changed sources before packaging. In the bundle, `CFBundleIconName` selects the layered asset named `AppIcon` and `CFBundleIconFile` identifies its standalone fallback.

The checked-in compilation uses the asset catalog. On the build host, Icon Composer’s `ictool --export-image` and the `actool` document path both failed to open an `.icon` package, including Xcode’s stock template. Foundation reported that Launch Services document-type information was unavailable. The catalog compiled with native Aqua, Dark Aqua and tintable stack records.
