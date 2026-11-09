# WavePod build entry points. Run `make help` for a list.
NPM ?= npm

.PHONY: help install build dev start demo test typecheck lint check vsthost vsthost-test dist dist-linux dist-win dist-mac icons desktop-install desktop-uninstall release clean distclean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

node_modules: package.json package-lock.json
	$(NPM) ci
	@touch node_modules

install: node_modules ## Install dependencies

build: node_modules ## Bundle main, preload and renderer into dist/
	$(NPM) run build

dev: node_modules ## Rebuild on change (run `make start` in another terminal)
	$(NPM) run dev

start: build ## Build and launch the app
	node scripts/start.mjs

demo: build ## Launch with virtual devices only (no audio hardware needed)
	WAVEPOD_SIMULATED=1 node scripts/start.mjs

typecheck: node_modules ## Type-check all sources
	$(NPM) run typecheck

lint: typecheck ## Alias for typecheck

test: node_modules ## Run unit and engine tests
	$(NPM) test

check: typecheck test ## Typecheck and test (what CI runs)

VSTHOST_BUILD ?= native/vsthost/build
CMAKE ?= cmake

vsthost: ## Build the VST3 plug-in host (fetches Steinberg's VST3 SDK; needs CMake and a C++ compiler)
	$(CMAKE) -S native/vsthost -B $(VSTHOST_BUILD) -DCMAKE_BUILD_TYPE=Release
	$(CMAKE) --build $(VSTHOST_BUILD) --config Release --target wavepod-vsthost

vsthost-test: ## Build the VST3 host plus the SDK's sample plug-ins, then run the tests against them
	$(CMAKE) -S native/vsthost -B $(VSTHOST_BUILD) -DCMAKE_BUILD_TYPE=Release -DWAVEPOD_VST3_SAMPLES=ON
	$(CMAKE) --build $(VSTHOST_BUILD) --config Release --target wavepod-vsthost test_plugins
	$(NPM) test

dist: build vsthost ## Package for the current OS into release/
	npx electron-builder --publish never

dist-linux: build vsthost ## Package a Linux AppImage and a .deb (the .deb brings an AppArmor profile for Ubuntu 24.04+)
	npx electron-builder --linux AppImage deb --publish never

dist-win: build vsthost ## Package a Windows NSIS installer
	npx electron-builder --win nsis --publish never

dist-mac: build vsthost ## Package a macOS DMG
	npx electron-builder --mac dmg --publish never

icons: ## Re-render the PNG/ICO icons from build/icon.svg (needs Playwright, ImageMagick)
	node scripts/render-icons.mjs

# GNOME/freedesktop launcher for the current user. Point WAVEPOD_EXEC at the AppImage, e.g.
#   make desktop-install WAVEPOD_EXEC=$$HOME/Applications/WavePod.AppImage
WAVEPOD_EXEC ?= wavepod
XDG_DATA_HOME ?= $(HOME)/.local/share
ICON_SIZES := 16 24 32 48 64 128 256 512

desktop-install: ## Add WavePod to the GNOME app grid (WAVEPOD_EXEC=/path/to/WavePod.AppImage)
	install -d "$(XDG_DATA_HOME)/applications"
	sed 's|^Exec=wavepod|Exec="$(WAVEPOD_EXEC)"|' build/linux/wavepod.desktop > "$(XDG_DATA_HOME)/applications/wavepod.desktop"
	for s in $(ICON_SIZES); do \
	  install -Dm644 build/icons/$${s}x$${s}.png "$(XDG_DATA_HOME)/icons/hicolor/$${s}x$${s}/apps/wavepod.png"; \
	done
	install -Dm644 build/icon.svg "$(XDG_DATA_HOME)/icons/hicolor/scalable/apps/wavepod.svg"
	-update-desktop-database "$(XDG_DATA_HOME)/applications" 2>/dev/null
	-gtk-update-icon-cache -q -t "$(XDG_DATA_HOME)/icons/hicolor" 2>/dev/null

desktop-uninstall: ## Remove the launcher added by desktop-install
	rm -f "$(XDG_DATA_HOME)/applications/wavepod.desktop" "$(XDG_DATA_HOME)/icons/hicolor/scalable/apps/wavepod.svg"
	for s in $(ICON_SIZES); do rm -f "$(XDG_DATA_HOME)/icons/hicolor/$${s}x$${s}/apps/wavepod.png"; done

# Bumps package.json to VERSION, commits, tags vVERSION and pushes both; the tag runs release.yml.
release: ## Cut a release: set version, commit, tag and push (VERSION=x.y.z)
	@test -n "$(VERSION)" || { echo "usage: make release VERSION=x.y.z"; exit 1; }
	scripts/release.sh "$(VERSION)"

clean: ## Remove build output
	rm -rf dist release native/vsthost/build native/vsthost/bin

distclean: clean ## Remove build output and dependencies
	rm -rf node_modules
