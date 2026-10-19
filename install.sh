#!/bin/sh
# githippo installer
#   curl -fsSL https://raw.githubusercontent.com/AnxovatomicaES/githippo/main/install.sh | sh
#   … | sh -s -- --github        also back up to a private GitHub repo (uses your gh login)
set -e
VERSION="v3.9.3"

if ! command -v node >/dev/null 2>&1; then
  echo "githippo needs Node.js 20 or newer."
  echo "  macOS:  brew install node"
  echo "  other:  https://nodejs.org"
  exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 20 ]; then
  echo "githippo needs Node.js 20 or newer (found $(node -v))."
  exit 1
fi

echo "Installing githippo $VERSION…"
if ! npm i -g --no-audit --no-fund --loglevel=error "github:AnxovatomicaES/githippo#$VERSION"; then
  echo ""
  echo "npm couldn't install globally (often a permissions issue). Fix once, then re-run:"
  echo "  npm config set prefix ~/.npm-global && export PATH=\"\$HOME/.npm-global/bin:\$PATH\""
  exit 1
fi

githippo setup "$@"
