#!/bin/sh
# Install the crawlproof CLI (npm: @profullstack/crawlproof): traffic, ads and
# money for every site you own, in a terminal.
#
#   curl -fsSL https://crawlproof.com/install.sh | sh
#
# Uses bun if present, otherwise npm (Node >= 22.6). When the global npm
# prefix is not writable it installs into ~/.local instead of asking for sudo.
# Re-running it upgrades to the latest release.
#
# The package is scoped: the unscoped `crawlproof` on npm is someone else's.
set -eu

PKG="@profullstack/crawlproof"
BIN="crawlproof"

say() { printf '%s\n' "$*"; }
die() { printf 'crawlproof install: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

say "Installing crawlproof (CrawlProof CLI)..."

if have bun; then
  # bun add -g writes into the nearest package.json above its global dir when
  # that dir has none (e.g. ~/package.json): give it its own first.
  BUN_GLOBAL="${BUN_INSTALL:-$HOME/.bun}/install/global"
  mkdir -p "$BUN_GLOBAL"
  [ -f "$BUN_GLOBAL/package.json" ] || printf '{}\n' > "$BUN_GLOBAL/package.json"
  bun add -g "$PKG@latest"
  BIN_DIR="${BUN_INSTALL:-$HOME/.bun}/bin"
elif have npm && have node; then
  node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=6)?0:1)' 2>/dev/null \
    || die "Node >= 22.6 required (found $(node -v)). Upgrade Node or install bun: https://bun.sh"
  prefix=$(npm config get prefix)
  modules="$prefix/lib/node_modules"
  [ -d "$modules" ] || modules="$prefix/lib"
  if [ -w "$modules" ] && [ -w "$prefix/bin" ]; then
    npm install -g "$PKG@latest"
    BIN_DIR="$prefix/bin"
  else
    BIN_DIR="$HOME/.local/bin"
    say "npm prefix $prefix is not writable; installing into $HOME/.local"
    npm install -g --prefix "$HOME/.local" "$PKG@latest"
  fi
else
  die "needs bun (https://bun.sh) or Node >= 22.6 with npm (https://nodejs.org)"
fi

say ""
if have "$BIN"; then
  say "crawlproof $("$BIN" --version 2>/dev/null || echo '') installed."
else
  say "crawlproof installed to $BIN_DIR, which is not on your PATH. Add it:"
  say "  export PATH=\"$BIN_DIR:\$PATH\""
fi
say ""
say "Next: create an API token at https://crawlproof.com/dashboard (Social -> API tokens), then"
say "  export CRAWLPROOF_TOKEN=crp_...   # or put { \"token\": \"crp_...\" } in ~/.crawlproof.json"
say "  crawlproof dashboard              # ROI, Traffic, Ads, Money, Spend"
say "  crawlproof stats example.com      # one site as text"
say "  crawlproof help                   # every command"
