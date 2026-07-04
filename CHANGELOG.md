# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.3] - 2026-07-04

### Added

- Add public type declarations for the JSR entrypoint.

### Changed

- Include the README in published JSR package artifacts.
- Update the README import example to use the JSR package specifier.

## [0.1.2] - 2024-09-17

### Added

- Add supports for WebAssembly's Globals
- Add `oninit` callback to custom module imports to know when the module is instatiated

### Fixed

- Fix a bug where the buffer sent from the sandbox was larger than expected
- Fix a bug where the `task` might throws if the callback given wasn't returning a promise

## [0.1.1] - 2024-12-02

### Added

- Add initial commit

<!-- ISSUES -->

<!-- VERSIONS -->
[Unreleased]: https://github.com/dusk-network/exu/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/dusk-network/exu/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/dusk-network/exu/releases/tag/v0.1.2
[0.1.1]: https://github.com/dusk-network/exu/releases/tag/v0.1.1
