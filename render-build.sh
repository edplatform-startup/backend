#!/usr/bin/env bash
# Exit on error
set -o errexit

echo "Installing TeX Live packages..."
apt-get update
apt-get install -y \
  texlive-latex-recommended \
  texlive-latex-extra \
  texlive-fonts-recommended \
  texlive-science \
  texlive-pictures \
  texlive-lang-english \
  ghostscript

echo "Installing Node dependencies and building..."
npm ci --include=dev --prefer-online --no-audit --no-fund --progress=false --foreground-scripts=false
npm run build
