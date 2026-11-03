The monospace fonts of the app, bundled so that the webview does not fall back to a wider system
monospace. Both are under the SIL Open Font License 1.1, and both are shipped as their publishers
release them (no file here is modified).

- Tailwind's font-mono (accessions, file names): Liberation Mono 2.1.5, the font the web app's
  reference screenshots rendered font-mono with (headless Chromium, Playwright SIF).
  LiberationMono-Regular.ttf and LiberationMono-Bold.ttf are the unmodified files of the upstream
  release liberation-fonts-ttf-2.1.5.tar.gz
  (https://github.com/liberationfonts/liberation-fonts/files/7261482/liberation-fonts-ttf-2.1.5.tar.gz);
  LiberationMono-LICENSE.txt is that release's LICENSE. "Liberation" is a Reserved Font Name: the
  files must not be modified (subset, converted) under that name.
    sha256 f2b83c763e8afd21709333370bed4774337fae82267937e2b5aea7e2fbd922c1  LiberationMono-Regular.ttf
    sha256 bd62a0672d0b9b6710b01df434c80ad54fa5f0835207eb7b17b7a761463067bb  LiberationMono-Bold.ttf

- Peptide sequences (--font-sequence: PeptideSequence, the fragment ladder, the ion table, the coverage
  map, the protein panel): Inconsolata 3.001 (no Reserved Font Name), 0.5 em wide like the font the
  reference screenshots fell back to there, so sequences take about the same width.
  Inconsolata-Regular-latin.woff and Inconsolata-Bold-latin.woff are the files
  files/inconsolata-latin-400-normal.woff and files/inconsolata-latin-700-normal.woff of the npm
  package @fontsource/inconsolata 5.3.0, unchanged (byte for byte); Inconsolata-LICENSE.txt is that
  package's LICENSE.
    sha256 9bfa42c71b7469f505c7a1b1ee488e0dcbc856f3202e57d4f99faf03ffc95040  Inconsolata-Regular-latin.woff
    sha256 1ff14da468eec1acd05e688f0cee1dceb084b39dec30dca582d41bc3d9c78ca8  Inconsolata-Bold-latin.woff
