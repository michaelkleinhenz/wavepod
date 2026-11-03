# WavePod build entry points. Run `make help` for a list.
NPM ?= npm

.PHONY: help install build dev start demo test typecheck lint check vsthost vsthost-test dist dist-linux dist-win dist-mac clean distclean

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
	npx electron .

demo: build ## Launch with virtual devices only (no audio hardware needed)
	WAVEPOD_SIMULATED=1 npx electron .

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

dist-linux: build vsthost ## Package a Linux AppImage
	npx electron-builder --linux AppImage --publish never

dist-win: build vsthost ## Package a Windows NSIS installer
	npx electron-builder --win nsis --publish never

dist-mac: build vsthost ## Package a macOS DMG
	npx electron-builder --mac dmg --publish never

clean: ## Remove build output
	rm -rf dist release native/vsthost/build native/vsthost/bin

distclean: clean ## Remove build output and dependencies
	rm -rf node_modules
