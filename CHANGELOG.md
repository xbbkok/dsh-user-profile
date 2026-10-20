# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-10-20

First public release.

### Added

- Settings → **Profile** section (slot `settings.section`, id `profile`, order `-30`)
  with username, avatar upload, live preview, Save and Reset.
- Sidebar overlay: the custom avatar and name replace the platform identity on the
  account trigger (`button[data-signed-out]`), with exact restoration on reset.
- Host half: `GET/POST /user-profile`, atomic JSON persistence under
  `<DSH_HOME>/plugins-data/dsh-user-profile/`, and a mount heartbeat.
- Validation: 32 code points for names with control characters stripped; PNG/JPEG/WebP
  `data:` URLs only (SVG rejected), size-capped; cross-origin writes refused.
- Locale dictionaries (`zh`, `en`) registered through the DSH locale service.
- Bundle declaration (`dsh.bundle.patch`) so `dsh plugin add` mounts the plugin.
- 19 offline checks covering the HTTP handler, the bundle shape, slot registration
  and the chip overlay under jsdom.

[1.0.0]: https://github.com/xbbkok/dsh-user-profile/releases/tag/v1.0.0
