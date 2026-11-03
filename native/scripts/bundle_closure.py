#!/usr/bin/env python3
"""The shared-library closure of the ProSE tool on macOS and Windows, for bundle-prose.sh.

    bundle_closure.py macho <exe> <out> [--search DIR]... [--install-path PATH]
    bundle_closure.py macho-verify <out>
    bundle_closure.py pe <exe> <out> [--search DIR]... [--redist DIR]... [--install-path PATH]
    bundle_closure.py pe-verify <out> [--system DIR]

macho (macOS): copies <exe> to <out>/bin/ProSE and every dylib it loads, directly or not, to
<out>/lib/<name> (the system's, /usr/lib and /System, are left out), then rewrites them: every
reference to a bundled dylib becomes @rpath/<name>, each dylib's id @rpath/<name>, the old LC_RPATHs
are dropped and one is added, @loader_path/../lib for the tool and @loader_path for the dylibs. Then
strip -x and an ad-hoc signature (codesign -s -: arm64 runs no unsigned code, and install_name_tool
breaks the linker's signature). References are resolved as dyld does: @rpath through the LC_RPATHs of
the loading image and those that loaded it, @loader_path, @executable_path, absolute paths; the
--search folders by name come last (the build tree's own libraries). Exactly one OpenMP runtime
(libomp) has to be among them.

pe (Windows): copies <exe> to <out>/bin and every DLL it imports, directly or not, beside it: those
found in the exe's folder or the --search folders, and the Visual C++ runtime (msvcp140, vcruntime140,
vcomp140, ...) from the --redist folders (Microsoft's app-local deployment of the redistributable).
API sets (api-ms-*, ext-ms-*) and the DLLs of Windows (System32) are left out. Exactly one OpenMP
runtime (vcomp140.dll) has to be among them. Windows has no RPATH: the folder of the exe is the first
place it looks.

--install-path: OpenMS looks for share/OpenMS at its compiled-in install prefix before it looks next to
the tool; that string is overwritten in the bundled OpenMS library, at the same length, with a path that
cannot exist (see bundle-prose.sh).

The verify commands check a bundle (also one inside a package): macho-verify that every reference is
the system's or @rpath/<a bundled dylib>, the LC_RPATHs are the two above, the signatures are valid,
and prints the newest minimum macOS among the files; pe-verify that every import is bundled or the
system's.
"""

import argparse
import os
import re
import shutil
import struct
import subprocess
import sys
from pathlib import Path

OPENMP = re.compile(r"^(lib)?(omp|iomp5|iomp5md|gomp|vcomp)[0-9]*(\.|-|_|$)", re.I)


def die(message):
    sys.exit(f"error: {message}")


def run(*args):
    return subprocess.run(args, check=True, capture_output=True, text=True).stdout


def patch_install_path(path, old, new_prefix):
    """Overwrites the C string `old` (exactly once in `path`) with `new_prefix` padded with '/'."""
    old_b = old.encode()
    new_b = new_prefix.encode()
    if len(old_b) < len(new_b):
        die(f"the install path {old!r} is shorter than {new_prefix!r}")
    new_b += b"/" * (len(old_b) - len(new_b))
    data = Path(path).read_bytes()
    count = data.count(b"\0" + old_b + b"\0")
    if count != 1:
        die(f"{path}: expected the install path {old} once as a string of its own, found it {count} times")
    data = data.replace(b"\0" + old_b + b"\0", b"\0" + new_b + b"\0")
    if old_b in data:
        die(f"{path} still holds {old}")
    Path(path).write_bytes(data)
    print(f"  compiled-in install path {old} overwritten in {Path(path).name}")


# --- Mach-O --------------------------------------------------------------------------------------

SYSTEM_MACHO = ("/usr/lib/", "/System/")


def macho_deps(path):
    """The install names `path` loads (not its own id)."""
    own = run("otool", "-D", str(path)).splitlines()[1:]
    lines = run("otool", "-L", str(path)).splitlines()[1:]
    deps = [line.strip().split(" (compatibility")[0] for line in lines if line.strip()]
    return [d for d in deps if d not in own]


def macho_load_commands(path):
    """(LC_RPATH paths, minimum macOS) of `path`."""
    rpaths, minos, current = [], None, None
    for line in run("otool", "-l", str(path)).splitlines():
        words = line.split()
        if not words:
            continue
        if words[0] == "cmd":
            current = words[1]
        elif current == "LC_RPATH" and words[0] == "path":
            rpaths.append(words[1])
        elif current == "LC_BUILD_VERSION" and words[0] == "minos":
            minos = words[1]
        elif current == "LC_VERSION_MIN_MACOSX" and words[0] == "version":
            minos = words[1]
    return rpaths, minos


def expand(path, loader, exe):
    return path.replace("@loader_path", str(loader.parent)).replace(
        "@executable_path", str(exe.parent)
    )


def macho_resolve(dep, loader, chain_rpaths, exe, search):
    if dep.startswith("@rpath/"):
        rest = dep[len("@rpath/"):]
        for rpath, owner in chain_rpaths:
            candidate = Path(expand(rpath, owner, exe)) / rest
            if candidate.is_file():
                return candidate
    elif dep.startswith(("@loader_path/", "@executable_path/")):
        candidate = Path(expand(dep, loader, exe))
        if candidate.is_file():
            return candidate
    elif Path(dep).is_file():
        return Path(dep)
    for folder in search:
        candidate = Path(folder) / Path(dep).name
        if candidate.is_file():
            return candidate
    return None


def macho_bundle(args):
    exe = Path(args.exe).resolve()
    out = Path(args.out)
    (out / "bin").mkdir(parents=True, exist_ok=True)
    (out / "lib").mkdir(parents=True, exist_ok=True)
    exe_rpaths, _ = macho_load_commands(exe)
    # realpath -> bundled name; per image: its original references -> bundled name
    names, refs = {}, {}
    todo = [(exe, [(r, exe) for r in exe_rpaths])]
    seen = set()
    while todo:
        image, chain = todo.pop()
        if image in seen:
            continue
        seen.add(image)
        refs[image] = {}
        for dep in macho_deps(image):
            if dep.startswith(SYSTEM_MACHO):
                continue
            found = macho_resolve(dep, image, chain, exe, args.search)
            if found is None:
                die(f"{image.name} loads {dep}, which was not found")
            real = found.resolve()
            name = names.setdefault(real, Path(dep).name)
            refs[image][dep] = name
            own_rpaths, _ = macho_load_commands(real)
            todo.append((real, [(r, real) for r in own_rpaths] + chain))

    if len(set(names.values())) != len(names):
        die(f"two libraries of one name: {sorted(names.values())}")
    omp = sorted(n for n in names.values() if OPENMP.match(n))
    if omp != ["libomp.dylib"]:
        die(f"expected exactly one OpenMP runtime, libomp.dylib; the closure has: {omp or 'none'}")

    targets = {exe: out / "bin" / "ProSE"}
    for real, name in names.items():
        targets[real] = out / "lib" / name
    for source, target in targets.items():
        shutil.copyfile(source, target)
        os.chmod(target, 0o755 if target.parent.name == "bin" else 0o644)
    if args.install_path:
        openms = out / "lib" / "libOpenMS.dylib"
        if not openms.is_file():
            die("libOpenMS.dylib is not in the closure")
        patch_install_path(openms, args.install_path, "/dev/null")

    for source, target in targets.items():
        os.chmod(target, 0o755)
        try:
            # the old LC_RPATHs one at a time (one given twice would fail a single call; a duplicate
            # LC_RPATH stops dyld on arm64)
            while True:
                rpaths, _ = macho_load_commands(target)
                if not rpaths:
                    break
                run("install_name_tool", "-delete_rpath", rpaths[0], str(target))
            command = ["install_name_tool"]
            for dep, name in refs.get(source, {}).items():
                command += ["-change", dep, f"@rpath/{name}"]
            if target.parent.name == "lib":
                command += ["-id", f"@rpath/{target.name}"]
            command += ["-add_rpath", "@loader_path/../lib" if target.parent.name == "bin" else "@loader_path"]
            run(*command, str(target))
        except subprocess.CalledProcessError as e:
            die(f"install_name_tool {target.name}: {e.stderr.strip()}")
        run("strip", "-x", str(target))
        run("codesign", "--force", "--sign", "-", str(target))
        os.chmod(target, 0o755 if target.parent.name == "bin" else 0o644)
    print(f"  {len(names)} dylibs, OpenMP runtime: {omp[0]}")
    macho_check(out)


def macho_check(out):
    out = Path(out)
    lib = out / "lib"
    bundled = {p.name for p in lib.iterdir() if p.is_file()}
    files = [out / "bin" / "ProSE"] + sorted(lib.iterdir())
    newest = (0,)
    for f in files:
        for dep in macho_deps(f):
            if dep.startswith(SYSTEM_MACHO):
                continue
            if not (dep.startswith("@rpath/") and dep[len("@rpath/"):] in bundled):
                die(f"{f.name} loads {dep}, which is neither the system's nor bundled")
        rpaths, minos = macho_load_commands(f)
        want = ["@loader_path/../lib"] if f.parent.name == "bin" else ["@loader_path"]
        if rpaths != want:
            die(f"{f.name} has the LC_RPATHs {rpaths}, not {want}")
        if minos:
            newest = max(newest, tuple(int(x) for x in minos.split(".")))
        try:
            run("codesign", "--verify", str(f))
        except subprocess.CalledProcessError as e:
            die(f"{f.name}: invalid signature: {e.stderr.strip()}")
    omp = [n for n in bundled if OPENMP.match(n)]
    if omp != ["libomp.dylib"]:
        die(f"expected exactly one OpenMP runtime, libomp.dylib; the bundle has: {omp or 'none'}")
    minimum = ".".join(str(x) for x in newest)
    print(f"  checked {len(files)} Mach-O files: references, rpaths, signatures; minimum macOS {minimum}")
    return minimum


# --- PE ------------------------------------------------------------------------------------------

API_SET = re.compile(r"^(api|ext)-ms-", re.I)
VC_RUNTIME = re.compile(r"^(msvcp140.*|vcruntime140.*|vcomp140.*|concrt140|vccorlib140)\.dll$", re.I)


def pe_imports(path):
    """The DLL names `path` imports (the import table and the delay-load table)."""
    data = Path(path).read_bytes()
    if data[:2] != b"MZ":
        die(f"{path} is not a PE file")
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0":
        die(f"{path} is not a PE file")
    sections_count = struct.unpack_from("<H", data, pe + 6)[0]
    optional_size = struct.unpack_from("<H", data, pe + 20)[0]
    optional = pe + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    directories = optional + (112 if magic == 0x20B else 96)
    sections = []
    for i in range(sections_count):
        at = optional + optional_size + 40 * i
        vsize, va, rawsize, rawptr = struct.unpack_from("<IIII", data, at + 8)
        sections.append((va, max(vsize, rawsize), rawptr))

    def offset(rva):
        for va, size, raw in sections:
            if va <= rva < va + size:
                return rva - va + raw
        return None

    def string(rva):
        at = offset(rva)
        return data[at:data.index(b"\0", at)].decode("ascii", "replace")

    names = []
    import_rva = struct.unpack_from("<I", data, directories + 8)[0]
    if import_rva:
        at = offset(import_rva)
        while at is not None:
            fields = struct.unpack_from("<IIIII", data, at)
            if not any(fields):
                break
            names.append(string(fields[3]))
            at += 20
    delay_rva = struct.unpack_from("<I", data, directories + 13 * 8)[0]
    if delay_rva:
        at = offset(delay_rva)
        while at is not None:
            fields = struct.unpack_from("<8I", data, at)
            if not any(fields):
                break
            names.append(string(fields[1]))
            at += 32
    return names


def find_in(folders, name):
    for folder in folders:
        folder = Path(folder)
        if not folder.is_dir():
            continue
        for candidate in folder.iterdir():
            if candidate.name.lower() == name.lower() and candidate.is_file():
                return candidate
    return None


def system_dirs(extra):
    root = os.environ.get("SystemRoot", r"C:\Windows")
    return [Path(root) / "System32", Path(root)] + [Path(d) for d in extra]


def pe_bundle(args):
    exe = Path(args.exe).resolve()
    out = Path(args.out) / "bin"
    out.mkdir(parents=True, exist_ok=True)
    own = [exe.parent] + [Path(d) for d in args.search]
    system = system_dirs([])
    bundled = {exe.name.lower(): exe}
    todo = [exe]
    while todo:
        image = todo.pop()
        for name in pe_imports(image):
            key = name.lower()
            if key in bundled or API_SET.match(name):
                continue
            found = find_in(own, name)
            if found is None and VC_RUNTIME.match(name):
                found = find_in(args.redist, name)
                if found is None:
                    die(f"{image.name} imports {name}, which is not in the redistributable folders {args.redist}")
            if found is None:
                if find_in(system, name) is not None:
                    continue
                die(f"{image.name} imports {name}, which was not found")
            bundled[key] = found
            todo.append(found)
    for found in bundled.values():
        shutil.copyfile(found, out / found.name)
    omp = sorted(n for n in bundled if OPENMP.match(n))
    if omp != ["vcomp140.dll"]:
        die(f"expected exactly one OpenMP runtime, vcomp140.dll; the closure has: {omp or 'none'}")
    if args.install_path:
        openms = out / "OpenMS.dll"
        if not openms.is_file():
            die("OpenMS.dll is not in the closure")
        # OpenMS does not probe its install prefix on Windows (File.cpp, OPENMS_WINDOWSPLATFORM: CMake's
        # default prefix is the wrong "(x86)" tree), so the string is normally not compiled in; if it is,
        # it is overwritten ('<' cannot be part of a Windows path: no folder of that name exists)
        if args.install_path.encode() in openms.read_bytes():
            patch_install_path(openms, args.install_path, "<no-install-path>")
        else:
            print(f"  the install path {args.install_path} is not in OpenMS.dll (not probed on Windows)")
    utf8_code_page(out / exe.name)
    print(f"  {len(bundled) - 1} DLLs: {', '.join(sorted(f.name for k, f in bundled.items() if k != exe.name.lower()))}")
    print(f"  OpenMP runtime: {omp[0]}")
    pe_check(Path(args.out), [])


UTF8_MANIFEST = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <activeCodePage xmlns="http://schemas.microsoft.com/SMI/2019/WindowsSettings">UTF-8</activeCodePage>
    </windowsSettings>
  </application>
</assembly>
"""


def utf8_code_page(exe):
    """Merges activeCodePage UTF-8 into the exe's manifest (mt.exe, Windows SDK): OpenMS takes its narrow
    strings, paths among them, for UTF-8, but a Windows process gets its arguments and narrow file APIs
    in the ANSI code page, so a path such as C:\\Users\\Jörg\\... would reach it as other bytes. With
    the UTF-8 code page (Windows 10 1903 and later) both agree."""
    exe = Path(exe)
    manifest = exe.with_name("utf8.manifest")
    manifest.write_text(UTF8_MANIFEST, encoding="utf-8")
    base = ["mt.exe", "-nologo", "-manifest", str(manifest)]
    try:
        try:
            run(*base, f"-inputresource:{exe};#1", f"-outputresource:{exe};#1")
        except subprocess.CalledProcessError:
            # (no manifest in the exe yet)
            run(*base, f"-outputresource:{exe};#1")
        extracted = exe.with_name("extracted.manifest")
        run("mt.exe", "-nologo", f"-inputresource:{exe};#1", f"-out:{extracted}")
        text = extracted.read_text(encoding="utf-8", errors="replace")
        extracted.unlink()
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        die(f"mt.exe could not set the UTF-8 code page of {exe.name}: {getattr(e, 'stderr', e)}")
    finally:
        manifest.unlink()
    if "activeCodePage" not in text or "UTF-8" not in text:
        die(f"{exe.name}'s manifest has no UTF-8 activeCodePage:\n{text}")
    print(f"  {exe.name}: activeCodePage UTF-8 in its manifest")


def pe_check(out, extra_system):
    folder = Path(out) / "bin"
    present = {p.name.lower() for p in folder.iterdir() if p.is_file()}
    system = system_dirs(extra_system)
    files = [p for p in folder.iterdir() if p.suffix.lower() in (".exe", ".dll")]
    for f in files:
        for name in pe_imports(f):
            if name.lower() in present or API_SET.match(name):
                continue
            if VC_RUNTIME.match(name):
                die(f"{f.name} imports {name}, the Visual C++ runtime, which is not bundled")
            if find_in(system, name) is None:
                die(f"{f.name} imports {name}, which is neither bundled nor the system's")
    print(f"  checked {len(files)} PE files: every import is bundled or the system's")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("macho", "pe"):
        p = sub.add_parser(name)
        p.add_argument("exe")
        p.add_argument("out")
        p.add_argument("--search", action="append", default=[])
        p.add_argument("--install-path")
        if name == "pe":
            p.add_argument("--redist", action="append", default=[])
    sub.add_parser("macho-verify").add_argument("out")
    p = sub.add_parser("pe-verify")
    p.add_argument("out")
    p.add_argument("--system", action="append", default=[])
    args = parser.parse_args()
    if args.command == "macho":
        macho_bundle(args)
    elif args.command == "macho-verify":
        macho_check(args.out)
    elif args.command == "pe":
        pe_bundle(args)
    else:
        pe_check(Path(args.out), args.system)


if __name__ == "__main__":
    main()
