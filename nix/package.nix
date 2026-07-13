{
  bun,
  bun2nix,
  lib,
  makeWrapper,
  nodejs_22,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation {
  inherit (lib.importJSON ../package.json) version;
  pname = "meridian";

  src = lib.cleanSource ../.;

  nativeBuildInputs = [
    bun2nix.hook
    bun
    nodejs_22
    makeWrapper
  ];

  bunDeps = bun2nix.fetchBunDeps { bunNix = ../bun.nix; };

  bunInstallFlags = [ "--linker=hoisted" ];

  buildPhase = ''
    runHook preBuild
    bun run build
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p $out/lib/meridian
    cp -r dist node_modules plugin package.json $out/lib/meridian/

    makeWrapper ${lib.getExe nodejs_22} $out/bin/meridian \
      --add-flags "$out/lib/meridian/dist/cli.js"

    runHook postInstall
  '';

  # The dist/ output is pre-bundled JS run by node via a wrapper; there
  # are no native binaries or shebangs that need patching. Skipping
  # fixup also avoids unnecessary work on a large node_modules tree.
  dontFixup = true;

  meta = {
    description = "Local Anthropic API powered by your Claude Max subscription";
    homepage = "https://github.com/rynfar/meridian";
    license = lib.licenses.mit;
    mainProgram = "meridian";
    platforms = lib.platforms.unix;
  };
}
