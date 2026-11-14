# Tauri NSIS template

Copyright (c) 2017 - Present Tauri Apps Contributors.

This directory contains the Tauri CLI 2.11.4 installer template under Apache-2.0 OR MIT. Both exact upstream license files are included.

Upstream: https://github.com/tauri-apps/tauri/blob/8909f221d1515955fc843808032bdc5d62209c96/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi

Tag: `tauri-cli-v2.11.4`

Commit: `8909f221d1515955fc843808032bdc5d62209c96`

Original SHA-256: `20f4ecc730defb71f1342eaeaec4021df13be3d843abba0effe88ea5835fa079`

Modified SHA-256: `51ad10e1aad64dd8766ffc96ffc5a44b8c161337e5cd2c441ad5afbb1c1841d5`

StakeMode modification: move the additional plugin directory registration before the installer hooks include, using the same Handlebars `additional_plugins_path` value. This allows the early GUI initialization hook to invoke the process discovery plugin during NSIS compilation. The hook still blocks installation without terminating matching applications. Signed plugin registration retains upstream order. No other upstream installer behavior is changed.

`provenance.json` records the exact source and file hashes. The regression test reconstructs the original template and checks its pinned SHA-256, and requires plugin registration before hooks. When upgrading Tauri CLI, review this relocation against its new exact template and rerun native installer acceptance.
