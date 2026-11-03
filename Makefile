# SoundPod build entry points. Run `make help` for a list.
NPM ?= npm

.PHONY: help install build dev start demo test typecheck lint check dist dist-linux dist-win dist-mac clean distclean

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
	SOUNDPOD_SIMULATED=1 npx electron .

typecheck: node_modules ## Type-check all sources
	$(NPM) run typecheck

lint: typecheck ## Alias for typecheck

test: node_modules ## Run unit and engine tests
	$(NPM) test

check: typecheck test ## Typecheck and test (what CI runs)

dist: build ## Package for the current OS into release/
	npx electron-builder --publish never

dist-linux: build ## Package a Linux AppImage
	npx electron-builder --linux AppImage --publish never

dist-win: build ## Package a Windows NSIS installer
	npx electron-builder --win nsis --publish never

dist-mac: build ## Package a macOS DMG
	npx electron-builder --mac dmg --publish never

clean: ## Remove build output
	rm -rf dist release

distclean: clean ## Remove build output and dependencies
	rm -rf node_modules
